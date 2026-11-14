/**
 * loop extension: scheduled prompts for pi.
 *
 * Aligned with Claude Code 2.1.88's cron subsystem (spec:
 * .pi/spec/20261027-194442-loop-claude-alignment/plan.md):
 *
 * - `/loop` is a PROMPT TEMPLATE (loop.md, distributed via
 *   resources_discover); argument parsing is model-driven, exactly like
 *   claude's bundled loop skill. There is deliberately no code command
 *   named "loop" — an extension command would silently shadow the
 *   template (pi dispatch priority: extension command > skill > prompt
 *   template). An `input` event short-circuit handles only the empty
 *   `/loop` case to save a model round-trip.
 * - Three tools: loop_create / loop_list / loop_delete (claude's
 *   CronCreate/CronList/CronList). Standard 5-field cron, full grammar.
 * - Scheduling truth is the cron grid: 1s tick, per-minute cron
 *   evaluation, deterministic jitter (recurring +10% capped 15m;
 *   one-shot -90s on :00/:30), 7-day auto-expiry for recurring tasks.
 * - Execution carrier: prompt injection into the CURRENT session
 *   (sendMessage display:false + triggerTurn), marked by a custom
 *   session entry ("✻ Running scheduled task ..."). Fires only while
 *   the session is idle; busy → deferred to a later tick, never lost.
 * - Storage split: durable:false lives in a process Map and dies with
 *   the session; durable:true lives in .pi/loop-tasks.json (version 2).
 * - Two independent locks, mirroring claude's split:
 *     owner lease (.pi/loop-tasks.lock, identity + PID liveness)
 *       decides WHO fires durable tasks;
 *     write mutual exclusion is a short read-modify-write + atomic
 *       rename critical section, independent of the lease.
 * - Missed one-shots found at startup are deleted from the file and
 *   surfaced as an "ask the user first" notification (claude parity).
 *
 * Known, accepted windows (same as claude): a crash after injection but
 * before the durable delete can run a one-shot twice; a concurrent
 * create lost to a racing read-modify-write is overwritten
 * (last-write-wins). Both are documented in the spec.
 * - File layout: store.ts owns task-file persistence (tolerant read,
 *   verified atomic write, v1→v2 migration); owner-lease.ts owns the
 *   scheduler owner lease (identity lock + PID liveness); cron.ts the
 *   cron grammar; renderers.ts the tool renderers. This file keeps the
 *   tick scheduler, injection carrier, tools, and registration.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";
import {
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
    cronToHuman,
    findMissedTasks,
    jitteredNextCronRunMs,
    nextCronRunMs,
    oneShotJitteredNextCronRunMs,
    parseCronDetailed,
    parseCronExpression,
} from "./cron.ts";
import { releaseOwnerLockAt, tryAcquireOwnerLockAt } from "./owner-lease.ts";
import {
    loopCreateRenderers,
    loopDeleteRenderers,
    loopListRenderers,
    type LoopCreateDetails,
    type LoopDeleteDetails,
    type LoopListDetails,
    type LoopListJob,
} from "./renderers.ts";
import {
    messageOf,
    migrateTaskFile as migrateTaskFileAt,
    mutateTaskFile as mutateTaskFileAt,
    readTaskFile as readTaskFileAt,
    type ReadResult,
} from "./store.ts";
import type { LoopEnv, StoredTask } from "./types.ts";

export { legacyToStored } from "./store.ts";

// ─── Constants ────────────────────────────────────────────────────

/** Scheduler tick (claude parity). Cron granularity is 1 minute. */
const TICK_MS = 1000;
/** How often a non-owner probes the owner lease. */
const LOCK_PROBE_MS = 5000;
/** Stored-job cap (claude parity). */
const MAX_JOBS = 50;
/** Recurring tasks auto-expire after this age (fire one last time, then delete). */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** activeTaskIds TTL: last-resort clearing if no agent_settled ever arrives. */
const ACTIVE_TTL_MS = 60 * 60 * 1000;

const USAGE =
    "Usage: /loop [interval] <prompt>\n" +
    "\n" +
    "Run a prompt or slash command on a recurring interval.\n" +
    "\n" +
    "Intervals: Ns, Nm, Nh, Nd (e.g. 5m, 30m, 2h, 1d). Minimum granularity is 1 minute; day intervals have no step below 1 day (Nd caps at 31d).\n" +
    "If no interval is specified, defaults to 10m.\n" +
    "\n" +
    "Examples:\n" +
    "  /loop 5m /babysit-prs\n" +
    "  /loop 30m check the deploy\n" +
    "  /loop 1h /standup 1\n" +
    "  /loop check the deploy          (defaults to 10m)\n" +
    "  /loop check the deploy every 20m\n" +
    "\n" +
    "Each fire is injected into THIS session's context while it is idle.\n" +
    "Manage: loop_list to view, loop_delete to cancel.";

// ─── Module state (per module evaluation; /reload re-evaluates) ───

let api: ExtensionAPI | undefined;
let env: LoopEnv | undefined;
let cachedCtx: ExtensionContext | undefined;
let tickTimer: ReturnType<typeof setTimeout> | undefined;
let probeTimer: ReturnType<typeof setInterval> | undefined;
/** skip-if-running guard for the tick chain. */
let ticking = false;
let shuttingDown = false;
let isOwner = false;
/** Durable tasks with an injected fire whose delete has not landed yet. */
const inFlight = new Set<string>();
/** Ids already surfaced as missed — prevents re-asking on every tick. */
const missedAsked = new Set<string>();
/** Ids with a live injected run (settle+idle clears; TTL is the backstop). */
const activeTaskIds = new Map<string, number>();
/** Session-only tasks (durable: false). Never touch the disk. */
const sessionTasks = new Map<string, StoredTask>();
/**
 * nextFireAt cache entry: id → { cron, anchor, next }. Recomputed when the
 * cron or the anchor (lastFiredAt ?? createdAt) changes; evicted when the id
 * disappears from a tick's seen set; cleared on owner takeover.
 */
type NextFireAtEntry = { cron: string; anchor: number; next: number };
const nextFireAt = new Map<string, NextFireAtEntry>();
/** Notify a task-file read error once per broken-file episode. */
let readErrorNotified = false;

// ─── Small helpers ────────────────────────────────────────────────

function randomId(): string {
    const bytes = randomBytes(4);
    const id = bytes.toString("hex");
    // First char forced to a hex letter so an id can never look like a
    // leading interval token (\d+[smhd]) in a /loop invocation.
    return "abcdef"[bytes[0] % 6] + id.slice(1);
}

/** Truncate to one display line (claude list format uses 80 chars). */
function truncate80(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > 80 ? `${flat.slice(0, 80)}...` : flat;
}

/**
 * notify that never throws. ctx.ui is a getter over assertActive(), so on a
 * stale context notify itself raises; scheduler-internal errors must not
 * escape the tick callback (pi has no unhandledRejection handler).
 */
function safeNotify(
    ctx: ExtensionContext | undefined,
    message: string,
    type: "info" | "warning" | "error" = "info",
): void {
    if (!ctx) return;
    try {
        ctx.ui.notify(message, type);
    } catch (error) {
        console.error(`[loop] notify failed: ${messageOf(error)}`);
    }
}

/** "Oct 28 6:30am" style fire time for the marker entry (claude format). */
function formatCronFireTime(d: Date): string {
    return d
        .toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
        })
        .replace(/,? at |, /, " ")
        .replace(/ ([AP]M)/, (_, ampm: string) => ampm.toLowerCase());
}

// ─── Repo-local environment ───────────────────────────────────────

/**
 * Repo root = dirname of `git rev-parse --git-common-dir` (absolute): the
 * MAIN repo root, so every worktree of the same repo shares one task file
 * and one owner lock. --show-toplevel would give the worktree root instead
 * (project isolation) and is deliberately NOT used. Non-git directories
 * fall back to the session cwd. Probed once per module evaluation.
 */
async function probeRepoRoot(cwd: string): Promise<string> {
    try {
        const result = await api!.exec("git", [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
        ]);
        const out = result.stdout.trim();
        if (result.code === 0 && out) return path.dirname(out);
    } catch {
        // fall through to cwd
    }
    return cwd;
}

// ─── Storage bindings (env-bound shims over ./store.ts) ───────────

/**
 * The storage logic itself lives in store.ts (task file: tolerant read,
 * verified atomic write, v1→v2 migration) and owner-lease.ts (scheduler
 * owner lease). These shims keep the existing call signatures: env.repoRoot
 * is read at CALL time so __testReset can redirect the module to a scratch
 * directory, and the tests keep importing from index.ts.
 */

/** Tolerant read: shape-valid entries + unparseable originals preserved. */
export async function readTaskFile(): Promise<ReadResult> {
    return readTaskFileAt(env!.repoRoot);
}

/** Verified read-modify-write critical section (store.ts semantics). */
export async function mutateTaskFile(
    mutator: (tasks: StoredTask[], rest: unknown[]) => void,
): Promise<boolean> {
    return mutateTaskFileAt(env!.repoRoot, mutator);
}

/** v1 → v2 migration (idempotent; runs on session_start). */
export async function migrateTaskFile(): Promise<void> {
    return migrateTaskFileAt(env!.repoRoot);
}

/** Drop every task whose id is in `ids` in a single write (no-op when
 * none match). */
function removeTasksByIds(ids: Iterable<string>): Promise<boolean> {
    const idSet = new Set(ids);
    return mutateTaskFile((tasks) => {
        for (let i = tasks.length - 1; i >= 0; i--) {
            if (idSet.has(tasks[i].id)) tasks.splice(i, 1);
        }
    });
}

// ─── Owner lease bindings (over ./owner-lease.ts) ─────────────────

let testSessionId: string | undefined;

function currentSessionId(): string {
    if (testSessionId) return testSessionId;
    try {
        return cachedCtx?.sessionManager.getSessionId() ?? `${process.pid}`;
    } catch {
        return `${process.pid}`;
    }
}

/**
 * Acquire or confirm the scheduler owner lease. On success marks this
 * module's isOwner; lease internals (heartbeat, corrupt-file liveness,
 * steal windows) live in owner-lease.ts. Exported for lease tests:
 * same-process re-acquire / foreign-pid guard.
 */
export async function tryAcquireOwnerLock(): Promise<boolean> {
    const acquired = await tryAcquireOwnerLockAt(
        env!.repoRoot,
        currentSessionId(),
        (message) => safeNotify(cachedCtx, message, "error"),
    );
    if (acquired) isOwner = true;
    return acquired;
}

/** Release; snapshots sessionId synchronously (see owner-lease.ts). */
function releaseOwnerLock(): void {
    releaseOwnerLockAt(env!.repoRoot, currentSessionId());
}

// ─── Injection (current-session carrier) ──────────────────────────

function fireTask(task: StoredTask, ctx: ExtensionContext): boolean {
    try {
        api!.appendEntry("loop-marker", {
            label: `✻ Running scheduled task (${formatCronFireTime(new Date())})`,
            taskId: task.id,
        });
    } catch (error) {
        console.error("[loop] marker append failed:", messageOf(error));
    }
    try {
        // Idle → start a turn now. If the session became busy between the
        // tick-level gate and this send, queue as a followUp that still
        // TRIGGERS a turn: deliverAs alone only queues while streaming and
        // would strand the prompt in history unread (compaction-only
        // sessions are not idle but not streaming either).
        const options = ctx.isIdle()
            ? { triggerTurn: true }
            : { triggerTurn: true, deliverAs: "followUp" as const };
        api!.sendMessage(
            { customType: "loop-run", content: task.prompt, display: false },
            options,
        );
    } catch (error) {
        // Never escapes the tick callback. Returning false tells the caller
        // to keep the task (one-shot stays on disk; the next tick retries).
        console.error("[loop] inject failed:", messageOf(error));
        return false;
    }
    activeTaskIds.set(task.id, Date.now());
    return true;
}

/** Missed one-shot notification: ask-first prompt with an injection-safe
 * code fence (one longer than any backtick run in the prompt body). */
export function buildMissedTaskNotification(missed: StoredTask[]): string {
    const plural = missed.length > 1;
    const header =
        `The following one-shot scheduled task${plural ? "s were" : " was"} missed while pi was not running. ` +
        `${plural ? "They have" : "It has"} already been removed from .pi/loop-tasks.json.\n\n` +
        `Do NOT execute ${plural ? "these prompts" : "this prompt"} yet. ` +
        `First ask the user whether to run ${plural ? "each one" : "it"} now. ` +
        `Only execute if the user confirms.`;

    const blocks = missed.map((t) => {
        const meta = `[${cronToHuman(t.cron)}, created ${new Date(t.createdAt).toLocaleString()}]`;
        const runs: string[] = t.prompt.match(/`+/g) ?? [];
        const longestRun = runs.reduce<number>(
            (max, run) => Math.max(max, run.length),
            0,
        );
        const fence = "`".repeat(Math.max(3, longestRun + 1));
        return `${meta}\n${fence}\n${t.prompt}\n${fence}`;
    });

    return `${header}\n\n${blocks.join("\n\n")}`;
}

/**
 * Missed one-shot catch-up, run when ownership is gained. Delete from the
 * file first, then surface the ask-first notification. missedAsked plus
 * nextFireAt=Infinity prevent the tick loop from re-asking (or executing)
 * while the notification is pending or the delete failed.
 */
async function surfaceMissedTasks(): Promise<void> {
    if (!isOwner || !env) return;
    let missed: StoredTask[];
    try {
        missed = findMissedTasks((await readTaskFile()).valid, Date.now()).filter(
            (t) => !missedAsked.has(t.id) && !inFlight.has(t.id),
        );
    } catch (error) {
        console.error("[loop] missed-task scan failed:", messageOf(error));
        return;
    }
    if (missed.length === 0) return;

    for (const task of missed) {
        missedAsked.add(task.id);
        // Block normal firing while the ask-first prompt is pending.
        nextFireAt.set(task.id, { cron: task.cron, anchor: task.createdAt, next: Infinity });
    }
    const missedIds = missed.map((task) => task.id);
    const removed = await removeTasksByIds(missedIds).catch((error) => {
        console.error("[loop] failed to remove missed tasks:", messageOf(error));
        return false;
    });
    if (!removed) {
        safeNotify(
            cachedCtx,
            "[loop] failed to remove missed one-shot task(s) from disk; they will not be re-asked this session",
            "warning",
        );
    }
    if (cachedCtx) {
        api!.sendMessage(
            {
                customType: "loop-run",
                content: buildMissedTaskNotification(missed),
                display: false,
            },
            { triggerTurn: true },
        );
    }
}

// ─── Scheduler core ───────────────────────────────────────────────

/** Recurring task aged past MAX_AGE_MS: fire one last time, then delete. */
function isRecurringTaskAged(task: StoredTask, nowMs: number): boolean {
    return task.recurring === true && nowMs - task.createdAt >= MAX_AGE_MS;
}

function scheduleTick(delayMs: number): void {
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = setTimeout(() => {
        void runTick();
    }, delayMs);
    tickTimer.unref();
}

/**
 * Top-rescheduling chain: the next tick is scheduled before the body runs,
 * so a throwing body only delays the chain, never kills it.
 */
async function runTick(): Promise<void> {
    scheduleTick(TICK_MS);
    if (ticking) return;
    ticking = true;
    try {
        await tickBody();
    } catch (error) {
        console.error("[loop] tick error:", error);
    } finally {
        ticking = false;
    }
}

function computeEntry(task: StoredTask): NextFireAtEntry {
    const anchor = task.recurring
        ? (task.lastFiredAt ?? task.createdAt)
        : task.createdAt;
    const raw = task.recurring
        ? jitteredNextCronRunMs(task.cron, anchor, task.id)
        : oneShotJitteredNextCronRunMs(task.cron, anchor, task.id);
    // Monotonic assertion (defensive only — NOT a DST guarantee): the grid
    // walk always returns a value strictly after the anchor.
    let next = raw ?? Infinity;
    if (Number.isFinite(next) && next < anchor) next = anchor + 60_000;
    return { cron: task.cron, anchor, next };
}

async function tickBody(): Promise<void> {
    if (!env || !cachedCtx || shuttingDown) return;
    const ctx = cachedCtx;
    // Idle gate (claude isLoading parity): while a turn runs, fire nothing.
    // Due one-shots are not deleted — they simply wait for a later tick.
    if (!ctx.isIdle()) return;
    const now = Date.now();

    // TTL backstop for activeTaskIds (agent_settled+idle is the real path).
    for (const [id, addedAt] of activeTaskIds) {
        if (now - addedAt > ACTIVE_TTL_MS) activeTaskIds.delete(id);
    }

    const seen = new Set<string>();
    const firedRecurring: string[] = [];

    const processTask = (task: StoredTask, isSession: boolean): void => {
        seen.add(task.id);
        if (inFlight.has(task.id)) return;
        if (activeTaskIds.has(task.id)) return;
        if (!parseCronExpression(task.cron)) return; // invalid cron: skip silently

        const anchor = task.recurring
            ? (task.lastFiredAt ?? task.createdAt)
            : task.createdAt;
        let entry = nextFireAt.get(task.id);
        // Recompute only when the disk anchor moved FORWARD: a recurring
        // fire whose lastFiredAt write-back failed must keep the in-memory
        // reschedule instead of recomputing from the stale anchor, which
        // yields a past timestamp and would re-fire every tick.
        if (!entry || entry.cron !== task.cron || anchor > entry.anchor) {
            entry = computeEntry(task);
            nextFireAt.set(task.id, entry);
        }
        if (now < entry.next) return;

        const fired = fireTask(task, ctx);

        const aged = isRecurringTaskAged(task, now);
        if (task.recurring && !aged) {
            // Reschedule from now (not from next) to avoid rapid catch-up
            // after a blocked session; jitter keeps us off :00 every cycle.
            const raw = jitteredNextCronRunMs(task.cron, now, task.id) ?? Infinity;
            entry.anchor = now;
            entry.next = Number.isFinite(raw) && raw > now ? raw : now + 60_000;
            if (isSession) {
                // Session tasks are process-private: stamp lastFiredAt in
                // memory so the next tick's cache-key check (anchor =
                // lastFiredAt ?? createdAt) matches the reschedule, instead
                // of recomputing from the stale createdAt anchor and
                // re-firing every turn.
                const stored = sessionTasks.get(task.id);
                if (stored) stored.lastFiredAt = now;
            } else if (fired) {
                firedRecurring.push(task.id);
            }
            // A recurring fire whose injection failed keeps the reschedule
            // (retrying each tick would hot-loop); it fires again at its
            // next cron match.
            return;
        }

        // One-shot (or aged) task. Nothing is deleted until the injection
        // landed: never delete what was never delivered.
        if (!fired) return;
        if (isSession) {
            // Session task: synchronous memory removal.
            sessionTasks.delete(task.id);
            nextFireAt.delete(task.id);
            return;
        }
        // Durable task: inject FIRST, then delete. If the delete fails the
        // task survives on disk for the next tick (inFlight holds until the
        // write settles); a crash between inject and delete can re-run it
        // once — accepted (claude parity).
        inFlight.add(task.id);
        nextFireAt.delete(task.id);
        void removeTasksByIds([task.id])
            .catch((error) => {
                console.error(
                    `[loop] failed to remove fired task ${task.id}: ${messageOf(error)}`,
                );
            })
            .finally(() => inFlight.delete(task.id));
    };

    // Durable tasks fire only in the owner. Read fresh each tick (no
    // snapshot cache): the file is small and this kills the whole class of
    // stale-snapshot bugs.
    if (isOwner) {
        let fileTasks: StoredTask[] = [];
        try {
            fileTasks = (await readTaskFile()).valid;
            readErrorNotified = false;
        } catch (error) {
            if (!readErrorNotified) {
                readErrorNotified = true;
                safeNotify(
                    ctx,
                    `[loop] task file error: ${messageOf(error)} (retrying each tick)`,
                    "error",
                );
            }
            console.error("[loop] task file read failed:", error);
        }
        for (const task of fileTasks) processTask({ ...task }, false);

        // Batched lastFiredAt write-back for recurring fires this tick.
        if (firedRecurring.length > 0) {
            for (const id of firedRecurring) inFlight.add(id);
            void mutateTaskFile((tasks) => {
                for (const task of tasks) {
                    if (firedRecurring.includes(task.id)) task.lastFiredAt = now;
                }
            })
                .catch((error) => {
                    console.error(
                        `[loop] failed to persist lastFiredAt: ${messageOf(error)}`,
                    );
                })
                .finally(() => {
                    for (const id of firedRecurring) inFlight.delete(id);
                });
        }
    }

    // Session-only tasks: process-private, no lock, no file.
    for (const task of [...sessionTasks.values()]) processTask({ ...task }, true);

    for (const id of nextFireAt.keys()) {
        if (!seen.has(id)) nextFireAt.delete(id);
    }
}

/** Stop the probe loop; called when ownership is gained. */
function stopProbe(): void {
    if (probeTimer) {
        clearInterval(probeTimer);
        probeTimer = undefined;
    }
}

function startProbe(): void {
    if (probeTimer) return;
    probeTimer = setInterval(() => {
        void (async () => {
            if (shuttingDown || isOwner) {
                stopProbe();
                return;
            }
            if (await tryAcquireOwnerLock()) {
                stopProbe();
                nextFireAt.clear(); // re-anchor from lastFiredAt ?? createdAt
                await surfaceMissedTasks().catch((error) => {
                    console.error("[loop] missed-task surface failed:", error);
                });
            }
        })().catch((error) => console.error("[loop] probe error:", error));
    }, LOCK_PROBE_MS);
    probeTimer.unref();
}

// ─── Tools ────────────────────────────────────────────────────────

const CRON_INVALID = (cron: string, error: string) =>
    `Invalid cron expression '${cron}': ${error}. Expected 5 fields: M H DoM Mon DoW.`;

async function totalJobCount(): Promise<number> {
    let fileCount = 0;
    try {
        fileCount = (await readTaskFile()).valid.length;
    } catch {
        // Unreadable file: count only session tasks; the write path will
        // surface the real error if a durable create is attempted.
    }
    return sessionTasks.size + fileCount;
}

function createResultText(task: StoredTask, durable: boolean): string {
    const where = durable
        ? "Persisted to .pi/loop-tasks.json"
        : "Session-only (not written to disk, dies when this session exits)";
    if (task.recurring) {
        return (
            `Scheduled recurring job ${task.id} (${cronToHuman(task.cron)}). ${where}. ` +
            `Auto-expires after 7 days. Use loop_delete to cancel sooner. ` +
            `Fires are injected into the current session's context while it is idle ` +
            `(each fire adds to this conversation).`
        );
    }
    return (
        `Scheduled one-shot task ${task.id} (${cronToHuman(task.cron)}). ${where}. ` +
        `It will fire once then auto-delete. ` +
        `Fires are injected into the current session's context while it is idle.`
    );
}

// ─── Extension registration ───────────────────────────────────────

export default function (pi: ExtensionAPI) {
    // Worktree-task children auto-discover this extension too (~/.pi is a
    // symlink into this repo); a task runner session must not drive the
    // scheduler or inject prompts into its own throwaway session.
    if (process.env.PI_WORKTREE_TASK_CHILD === "1") return;

    api = pi;

    // Distribute the /loop prompt template (same directory as this file).
    pi.on("resources_discover", () => {
        const templatePath = path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            "loop.md",
        );
        return existsSync(templatePath) ? { promptPaths: [templatePath] } : {};
    });

    // Empty `/loop` short-circuit: show usage without burning a model turn.
    // Everything else (including `/loop <anything>`) goes to the template.
    pi.on("input", (event, ctx) => {
        if (event.text.trim() !== "/loop") return { action: "continue" };
        try {
            ctx.ui.notify(USAGE, "info");
        } catch {
            // stale context — ignore
        }
        return { action: "handled" };
    });

    // Marker entry for injected fires (visible in the transcript, never
    // sent to the model — the prompt itself arrives via sendMessage).
    pi.registerEntryRenderer<{ label?: string }>(
        "loop-marker",
        (entry, _options, theme) => {
            const label = entry.data?.label ?? "✻ Running scheduled task";
            return new Text(theme.fg("dim", label), 0, 0);
        },
    );

    pi.registerTool({
        name: "loop_create",
        label: "Create Loop Job",
        description:
            "Schedule a prompt to be injected into the current session's context at a future " +
            "time — recurring on a cron schedule, or once at a specific time. Uses standard " +
            "5-field cron in local time: M H DoM Mon DoW (e.g. \"*/5 * * * *\", \"30 14 28 2 *\", " +
            "\"0 9 * * 1-5\"). Avoid minute 0/30 when the request is approximate. Pass durable: " +
            "true to persist to .pi/loop-tasks.json (survives restarts); default false is " +
            "session-only. recurring: false fires once at the next match then auto-deletes " +
            "(\"remind me at 3pm\"). Jobs only fire while the session is idle (busy → deferred, " +
            "never lost). Recurring tasks auto-expire after 7 days. Each fire adds to the " +
            "current conversation's context. Cancel with loop_delete. Max 50 jobs.",
        parameters: Type.Object({
            cron: Type.String({
                description:
                    "Standard 5-field cron expression in local time: \"M H DoM Mon DoW\" (e.g. \"*/5 * * * *\" = every 5 minutes, \"30 14 * * *\" = every day at 2:30pm local). Every cron match fires while the session is idle.",
            }),
            prompt: Type.String({
                description: "The prompt to enqueue at each fire time.",
            }),
            recurring: Type.Optional(
                Type.Boolean({
                    description:
                        "true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for \"remind me at X\" one-shot requests with pinned minute/hour/dom/month.",
                }),
            ),
            durable: Type.Optional(
                Type.Boolean({
                    description:
                        "true = persist to .pi/loop-tasks.json and survive restarts. false (default) = in-memory only, dies when this session ends. Use true only when the user asks for the task to persist across sessions.",
                }),
            ),
        }),
        annotations: { openWorldHint: true },
        ...loopCreateRenderers,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            // Non-interactive runs (print/json/rpc) have no idle-loop to
            // fire into: refuse rather than promise a schedule that never
            // executes.
            if (ctx.mode !== "tui") {
                throw new Error(
                    "loop scheduling requires an interactive session (-p/RPC cannot fire scheduled prompts)",
                );
            }
            const cron = params.cron.trim();
            const parsedCron = parseCronDetailed(cron);
            if ("error" in parsedCron) throw new Error(CRON_INVALID(cron, parsedCron.error));
            if (nextCronRunMs(cron, Date.now()) === null) {
                throw new Error(
                    `Cron expression '${cron}' does not match any calendar date in the next year.`,
                );
            }
            const prompt = params.prompt.trim();
            if (!prompt) throw new Error("prompt must not be empty");
            const durable = params.durable ?? false;
            const recurring = params.recurring ?? true;

            if ((await totalJobCount()) >= MAX_JOBS) {
                throw new Error(`Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.`);
            }

            const task: StoredTask = {
                id: randomId(),
                cron,
                prompt,
                createdAt: Date.now(),
                ...(recurring ? { recurring: true as const } : {}),
            };

            if (durable) {
                let written = false;
                try {
                    written = await mutateTaskFile((tasks) => {
                        tasks.push({ ...task });
                    });
                } catch (error) {
                    throw new Error(`loop task file error: ${messageOf(error)}`);
                }
                if (!written) {
                    throw new Error(
                        "loop task file is contended (write verification failed 3 times); retry",
                    );
                }
            } else {
                sessionTasks.set(task.id, { ...task });
            }

            const firstFireAt =
                (recurring
                    ? jitteredNextCronRunMs(task.cron, Date.now(), task.id)
                    : oneShotJitteredNextCronRunMs(task.cron, Date.now(), task.id)) ?? null;
            return {
                content: [{ type: "text", text: createResultText(task, durable) }],
                details: {
                    id: task.id,
                    cron: task.cron,
                    recurring,
                    durable,
                    nextFireAt: firstFireAt,
                } satisfies LoopCreateDetails,
            };
        },
    });

    pi.registerTool({
        name: "loop_list",
        label: "List Loop Jobs",
        description:
            "List all scheduled loop jobs with id, human-readable schedule, recurrence, " +
            "durability, and prompt. Covers durable jobs (.pi/loop-tasks.json) and this " +
            "session's session-only jobs. Read-only.",
        parameters: Type.Object({}),
        annotations: { readOnlyHint: true },
        ...loopListRenderers,
        async execute() {
            let fileTasks: StoredTask[];
            try {
                fileTasks = (await readTaskFile()).valid;
            } catch (error) {
                throw new Error(`loop task file error: ${messageOf(error)}`);
            }
            // Details ride in the session/HTML export forever; cap the
            // prompt at the same preview the model-facing line uses.
            const toJob = (task: StoredTask, durable: boolean): LoopListJob => ({
                id: task.id,
                cron: task.cron,
                recurring: task.recurring ?? false,
                durable,
                prompt: truncate80(task.prompt),
                createdAt: task.createdAt,
            });
            const jobs: LoopListJob[] = [
                ...fileTasks.map((task) => toJob(task, true)),
                ...[...sessionTasks.values()].map((task) => toJob(task, false)),
            ];
            const lines = jobs.map((job) => {
                const schedule = parseCronExpression(job.cron)
                    ? cronToHuman(job.cron)
                    : "invalid cron";
                const scope = job.durable ? "" : " [session-only]";
                return `${job.id} — ${schedule}${job.recurring ? " (recurring)" : " (one-shot)"}${scope}: ${truncate80(job.prompt)}`;
            });
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: { jobs } satisfies LoopListDetails,
            };
        },
    });

    pi.registerTool({
        name: "loop_delete",
        label: "Delete Loop Job",
        description:
            "Cancel a scheduled loop job by id (from loop_list). Removes durable jobs from " +
            ".pi/loop-tasks.json and session-only jobs from memory. An in-progress injected " +
            "turn is not interrupted.",
        parameters: Type.Object({
            id: Type.String({
                description: "Job ID returned by loop_create.",
            }),
        }),
        annotations: { destructiveHint: true },
        ...loopDeleteRenderers,
        async execute(_toolCallId, params) {
            const id = params.id.trim();

            // Existence check BEFORE any write: an unknown id must not
            // touch the disk (claude validateInput parity). Snapshot where
            // the job lived, so the renderer can show "cancelled ·
            // session|durable".
            const isSessionTask = sessionTasks.has(id);
            const scope = isSessionTask ? "session" : "durable";
            if (!isSessionTask) {
                let onDisk = false;
                try {
                    onDisk = (await readTaskFile()).valid.some((task) => task.id === id);
                } catch (error) {
                    throw new Error(`loop task file error: ${messageOf(error)}`);
                }
                if (!onDisk) throw new Error(`No scheduled job with id '${id}'.`);
            }

            sessionTasks.delete(id);
            // Only durable-origin deletes touch the task file: a
            // session-only job must neither lock the file queue nor
            // (re)create a missing task file, and a failure there must not
            // mask the successful in-memory removal. The id was already
            // found either in memory (→ session) or in the file (→ durable).
            if (scope === "session") {
                nextFireAt.delete(id);
                missedAsked.delete(id);
                activeTaskIds.delete(id);
                return {
                    content: [{ type: "text", text: `Cancelled job ${id}.` }],
                    details: { id, scope } satisfies LoopDeleteDetails,
                };
            }
            if (!inFlight.has(id)) {
                const removed = await removeTasksByIds([id]).catch((error) => {
                    throw new Error(`loop task file error: ${messageOf(error)}`);
                });
                if (!removed) {
                    throw new Error(
                        "loop task file is contended (write verification failed 3 times); retry",
                    );
                }
            }

            nextFireAt.delete(id);
            missedAsked.delete(id);
            activeTaskIds.delete(id);
            return {
                content: [{ type: "text", text: `Cancelled job ${id}.` }],
                details: { id, scope } satisfies LoopDeleteDetails,
            };
        },
    });

    pi.on("session_start", async (_event, ctx) => {
        cachedCtx = ctx;
        shuttingDown = false;

        if (!env) {
            env = { repoRoot: await probeRepoRoot(ctx.cwd) };
        }

        // Migration is idempotent and cheap; run it in every mode. The
        // scheduler itself stays interactive-only.
        try {
            await migrateTaskFile();
        } catch (error) {
            safeNotify(ctx, `[loop] task file migration failed: ${messageOf(error)}`, "error");
            console.error("[loop] migration failed:", error);
        }

        if (ctx.mode !== "tui") return; // no scheduler, no lock, no injection

        if (await tryAcquireOwnerLock()) {
            nextFireAt.clear();
            await surfaceMissedTasks().catch((error) => {
                console.error("[loop] missed-task surface failed:", error);
            });
        } else {
            startProbe();
        }
        scheduleTick(TICK_MS);
    });

    // ctx is invalidated ONLY here: session_shutdown covers every replacement
    // path (switch/fork/new/reload all emit it, followed by session_start).
    pi.on("session_shutdown", () => {
        shuttingDown = true;
        if (tickTimer) {
            clearTimeout(tickTimer);
            tickTimer = undefined;
        }
        stopProbe();
        if (isOwner) {
            isOwner = false;
            releaseOwnerLock(); // snapshots sessionId synchronously
        }
        cachedCtx = undefined;
    });

    // activeTaskIds clears when the agent settles AND the session is idle;
    // if more queued work follows (still not idle), the entries survive so
    // a due task cannot overlap the still-draining queue.
    pi.on("agent_settled", () => {
        if (activeTaskIds.size > 0 && cachedCtx?.isIdle()) activeTaskIds.clear();
    });
}

// ─── Test hooks (not used by the extension runtime) ───────────────

export function __testAddSessionTask(task: StoredTask): void {
    sessionTasks.set(task.id, { ...task });
}

/** Point the module at a scratch repo root and clear scheduler state. */
export function __testReset(options?: { repoRoot?: string; sessionId?: string }): void {
    env = options?.repoRoot ? { repoRoot: options.repoRoot } : undefined;
    testSessionId = options?.sessionId;
    cachedCtx = undefined;
    isOwner = false;
    shuttingDown = false;
    readErrorNotified = false;
    inFlight.clear();
    missedAsked.clear();
    activeTaskIds.clear();
    sessionTasks.clear();
    nextFireAt.clear();
}
