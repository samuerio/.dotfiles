/**
 * loop owner lease: WHO fires durable tasks.
 *
 * Identity lock (.pi/loop-tasks.lock, sessionId + PID liveness) with a
 * mtime heartbeat. Deliberately independent of task-file persistence (see
 * store.ts): the lease decides who FIRES, never who writes. Cross-module
 * state (cachedCtx, isOwner) stays in index.ts and is injected here as
 * plain parameters/callbacks, keeping this module directly testable.
 *
 * Moved out of index.ts; only the env singleton, currentSessionId()
 * and safeNotify(cachedCtx, ...) lookups became parameters.
 */
import { readFile, mkdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { atomicWriteFile, errnoCode, messageOf } from "./store.ts";
import type { OwnerLock } from "./types.ts";

/** Owner heartbeat on the lock file (corrupt-file liveness signal only). */
const HEARTBEAT_MS = 15_000;
/** Corrupt-lock mtime younger than this is treated as alive (no steal). */
const CORRUPT_LOCK_LIVE_MS = 60_000;

let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
/** Notify a lock-write failure once per process (the probe re-runs every 5s). */
let lockErrorNotified = false;

export function lockFilePath(repoRoot: string): string {
    return path.join(repoRoot, ".pi", "loop-tasks.lock");
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return errnoCode(error) === "EPERM";
    }
}

async function readOwnerLock(repoRoot: string): Promise<OwnerLock | undefined> {
    try {
        const raw = await readFile(lockFilePath(repoRoot), "utf8");
        const parsed = JSON.parse(raw) as Partial<OwnerLock>;
        if (
            typeof parsed.sessionId === "string" &&
            typeof parsed.pid === "number" &&
            typeof parsed.acquiredAt === "number"
        ) {
            return parsed as OwnerLock;
        }
        return undefined;
    } catch {
        return undefined; // missing or corrupt
    }
}

function startHeartbeat(repoRoot: string): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        void utimes(lockFilePath(repoRoot), new Date(), new Date()).catch(() => {});
    }, HEARTBEAT_MS);
    heartbeatTimer.unref();
}

function stopHeartbeat(): void {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
    }
}

/**
 * Acquire or confirm the scheduler owner lease (exported for lease tests:
 * same-process re-acquire / foreign-pid guard).
 *   ① lock already ours (same sessionId after /reload, or the file names
 *     THIS process's pid after a same-process session replacement) → true,
 *     rewriting the payload to the current sessionId + live pid;
 *   ② another LIVE pid → false (probe again in 5s);
 *   ③ dead pid → unlink and re-create;
 *   ④ corrupt file → mtime-guarded unlink and re-create (the heartbeat
 *     keeps a live owner's mtime fresh, so a live owner is never stolen;
 *     mtime is ONLY consulted here, never on a parseable lock).
 */
export async function tryAcquireOwnerLockAt(
    repoRoot: string,
    sessionId: string,
    /** Never-throws notify (index passes safeNotify over its cached ctx). */
    notify: (message: string) => void,
): Promise<boolean> {
    const writeExclusive = async (): Promise<boolean> => {
        try {
            await mkdir(path.dirname(lockFilePath(repoRoot)), { recursive: true });
            await writeFile(
                lockFilePath(repoRoot),
                `${JSON.stringify({ sessionId, pid: process.pid, acquiredAt: Date.now() })}\n`,
                { flag: "wx", mode: 0o600 },
            );
            return true;
        } catch (error) {
            // Only EEXIST means "someone holds the lock". Every other errno
            // (EACCES, EROFS, ENOSPC) must surface instead of degrading to
            // "never owner" with the durable scheduler silently paused.
            if (errnoCode(error) === "EEXIST") return false;
            throw error;
        }
    };

    const adopt = (): void => {
        lockErrorNotified = false;
        startHeartbeat(repoRoot);
    };

    const reportLockError = (error: unknown): void => {
        console.error("[loop] owner lock write failed:", error);
        if (lockErrorNotified) return;
        lockErrorNotified = true;
        notify(
            `[loop] cannot write owner lock (${messageOf(error)}); durable scheduling paused`,
        );
    };

    try {
        if (await writeExclusive()) {
            adopt();
            return true;
        }
    } catch (error) {
        reportLockError(error);
        return false;
    }

    const existing = await readOwnerLock(repoRoot);
    if (existing && (existing.sessionId === sessionId || existing.pid === process.pid)) {
        // Idempotent re-acquire. Covers both: /reload (same session id,
        // possibly a new pid after module re-evaluation) AND same-process
        // session replacement (/new, /fork, switch — the shutdown release
        // may have failed, leaving the file naming OUR live pid under the
        // previous session id). Rewrite the payload so other sessions see
        // the current session id plus a live pid and don't steal it.
        await atomicWriteFile(
            lockFilePath(repoRoot),
            `${JSON.stringify({ sessionId, pid: process.pid, acquiredAt: existing.acquiredAt })}\n`,
        ).catch(() => {});
        adopt();
        return true;
    }

    if (existing && processAlive(existing.pid)) return false;

    if (!existing) {
        // Corrupt/missing since the wx failure: steal only if the mtime is
        // stale (a live owner's heartbeat refreshes it every 15s).
        try {
            const info = await stat(lockFilePath(repoRoot));
            if (Date.now() - info.mtimeMs < CORRUPT_LOCK_LIVE_MS) return false;
        } catch {
            return false; // vanished between wx and stat: retry next probe
        }
    }

    await unlink(lockFilePath(repoRoot)).catch(() => {});
    try {
        if (await writeExclusive()) {
            adopt();
            return true;
        }
    } catch (error) {
        reportLockError(error);
    }
    return false; // another session won the recovery race
}

export function releaseOwnerLockAt(repoRoot: string, sessionId: string): void {
    stopHeartbeat();
    // Callers snapshot sessionId synchronously BEFORE this call
    // (session_shutdown clears their cached context around it).
    void (async () => {
        try {
            const existing = await readOwnerLock(repoRoot);
            // A stolen lock must not be deleted by us.
            if (
                !existing ||
                (existing.sessionId !== sessionId && existing.pid !== process.pid)
            ) {
                return;
            }
            await unlink(lockFilePath(repoRoot));
        } catch {
            // already gone
        }
    })();
}
