/**
 * loop store: durable task file persistence.
 *
 * Tolerant read, verified atomic write, and the v1 → v2 migration for
 * .pi/loop-tasks.json. Every function takes the repo root explicitly (no
 * module state), so tests target a scratch directory without hooks.
 *
 * Moved out of index.ts; only the env-singleton lookup became a
 * parameter. The critical-section semantics (read-modify-write + atomic
 * rename + post-write verification) are race-documented in
 * .pi/spec/20261027-194442-loop-claude-alignment/plan.md — do not "improve"
 * them here without re-reading that spec.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import type { LoopFile, StoredTask } from "./types.ts";

/** Shared error helpers (also imported by index.ts and owner-lease.ts). */
export function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function errnoCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function tasksFilePath(repoRoot: string): string {
    return path.join(repoRoot, ".pi", "loop-tasks.json");
}

// ─── Validation (tolerant read; invalid shapes are preserved) ─────

export function isStoredTask(value: unknown): value is StoredTask {
    const task = value as StoredTask | undefined;
    return (
        !!task &&
        typeof task.id === "string" &&
        typeof task.cron === "string" &&
        typeof task.prompt === "string" &&
        typeof task.createdAt === "number" &&
        (task.lastFiredAt === undefined || typeof task.lastFiredAt === "number") &&
        (task.recurring === undefined || typeof task.recurring === "boolean")
    );
}

/** Accept v1-shaped entries (intervalMs scheduling truth) defensively. */
export function legacyToStored(value: Record<string, unknown>): StoredTask | undefined {
    const cron = value.cron;
    if (typeof cron !== "string" || typeof value.id !== "string") return undefined;
    if (typeof value.prompt !== "string" || typeof value.createdAt !== "number") {
        return undefined;
    }
    // Recurring legacy tasks get lastFiredAt = now (anti-thundering-herd:
    // otherwise every migrated job fires immediately on the next tick).
    return {
        id: value.id,
        cron,
        prompt: value.prompt,
        createdAt: value.createdAt,
        ...(value.recurring === true ? { recurring: true, lastFiredAt: Date.now() } : {}),
    };
}

export type ReadResult = {
    /** Shape-valid entries (invalid cron strings included — never dropped). */
    valid: StoredTask[];
    /** Shape-invalid entries, preserved verbatim for write-back. */
    rest: unknown[];
};

/**
 * Read the task file. A missing file = no tasks. Unparseable JSON or a
 * malformed file throws (the caller never overwrites a file it could not
 * read). Shape-invalid entries survive in `rest` so a write-back never
 * silently erases them. Legacy v1 entries are converted on read.
 */
export async function readTaskFile(repoRoot: string): Promise<ReadResult> {
    const filePath = tasksFilePath(repoRoot);
    let raw: string;
    try {
        raw = await readFile(filePath, "utf8");
    } catch (error) {
        if (errnoCode(error) === "ENOENT") return { valid: [], rest: [] };
        throw new Error(`cannot read ${filePath}: ${messageOf(error)}`, {
            cause: error,
        });
    }
    let parsed: { version?: unknown; tasks?: unknown };
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`${filePath} is corrupt JSON: ${messageOf(error)}`, {
            cause: error,
        });
    }
    if (!parsed || !Array.isArray(parsed.tasks)) {
        throw new Error(`${filePath} is malformed: 'tasks' is not an array`);
    }
    const valid: StoredTask[] = [];
    const rest: unknown[] = [];
    for (const entry of parsed.tasks) {
        if (isStoredTask(entry)) {
            valid.push(entry);
            continue;
        }
        // null / primitives are not conversion candidates (legacyToStored
        // dereferences .cron): land them in rest verbatim, never throw.
        const converted =
            entry !== null && typeof entry === "object"
                ? legacyToStored(entry as Record<string, unknown>)
                : undefined;
        if (converted) valid.push(converted);
        else rest.push(entry);
    }
    return { valid, rest };
}

/** Atomic write: unique temp name (pid + random — two processes sharing a
 * fixed .tmp would rename onto each other's half-written file), then rename.
 * Also used by the owner lease's adopt path and the migration. */
export async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
}

/**
 * Read-modify-write over the durable task file. Runs INSIDE the process
 * mutation queue only — the owner lease is deliberately NOT consulted
 * (lease decides who FIRES, never who writes; a lease-gated write path
 * deadlocks against the owner's own heartbeat). Cross-process races resolve
 * last-write-wins: a concurrent create can be lost (claude parity), but a
 * corrupt or unreadable file is never overwritten — read errors throw.
 *
 * Post-write verification re-reads and byte-compares; a mismatch (another
 * process won the rename race) retries with a fresh base, up to 3 attempts.
 */
export async function mutateTaskFile(
    repoRoot: string,
    mutator: (tasks: StoredTask[], rest: unknown[]) => void,
): Promise<boolean> {
    const filePath = tasksFilePath(repoRoot);
    return withFileMutationQueue(filePath, async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
            const { valid, rest } = await readTaskFile(repoRoot);
            mutator(valid, rest);
            const payload: LoopFile = { version: 2, tasks: [...valid, ...rest] };
            const contents = `${JSON.stringify(payload, null, 2)}\n`;
            await atomicWriteFile(filePath, contents);
            try {
                if ((await readFile(filePath, "utf8")) === contents) {
                    return true;
                }
            } catch (error) {
                // "Vanished post-write" (external cleanup removed it) counts
                // as done; any other read failure means the write is NOT
                // verified and must not be reported as success.
                if (errnoCode(error) === "ENOENT") return true;
                throw error;
            }
        }
        return false;
    });
}

// ─── v1 → v2 migration ────────────────────────────────────────────

/**
 * Called on session_start: if the task file is not version 2, rewrite it
 * as v2 (cron was already the display truth for the three legacy templates;
 * recurring lastFiredAt stamps to now to avoid a migrated-fire stampede).
 * Correctness comes from version checking + content idempotence, not from
 * a cross-process queue: two windows may each migrate once and the last
 * write wins — the result is still a valid v2 file with the same tasks.
 */
export async function migrateTaskFile(repoRoot: string): Promise<void> {
    const filePath = tasksFilePath(repoRoot);
    let raw: string;
    try {
        raw = await readFile(filePath, "utf8");
    } catch (error) {
        if (errnoCode(error) === "ENOENT") return;
        throw error;
    }
    let parsed: { version?: unknown };
    try {
        parsed = JSON.parse(raw);
    } catch {
        return; // corrupt: leave it; readTaskFile/mutate will fail loudly
    }
    if (parsed?.version === 2) return;
    const { valid, rest } = await readTaskFile(repoRoot);
    // All entries are pre-v2 here: normalize strictly (strip intervalMs/
    // failureCount/lastError/paused), stamping recurring lastFiredAt = now
    // so a migrated file does not fire-stampede on the next tick.
    const migrated = valid.map((task) => ({
        id: task.id,
        cron: task.cron,
        prompt: task.prompt,
        createdAt: task.createdAt,
        ...(task.recurring ? { recurring: true as const, lastFiredAt: Date.now() } : {}),
    }));
    const payload: LoopFile = { version: 2, tasks: [...migrated, ...rest] };
    await atomicWriteFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}
