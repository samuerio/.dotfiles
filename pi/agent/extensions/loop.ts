/**
 * loop extension: scheduled prompts for pi.
 *
 * Behavior mirrors Claude Code's cron surface (/loop skill +
 * CronCreate/CronDelete/CronList), with a different execution carrier: at
 * fire time the task is dispatched via background-task.ts's
 * dispatchBackgroundTask, spawning an isolated child pi in tmux (remain-on-
 * exit, stays alive until Closed from /background-tasks).
 *
 * Scheduling truth is intervalMs, not cron: nextFireAt = lastFiredAt +
 * intervalMs. Cron strings are display/validation only, so there is no grid
 * and no boundary double-fire. Creation records lastFiredAt = createdAt, so
 * the first fire happens one interval after creation (both /loop and
 * loop_create are tick-driven; /loop <id> run injects a one-off into the
 * current session without touching the schedule).
 *
 * Multi-session arbitration: .pi/loop-tasks.lock beside the task file, held
 * only across the ms-scale claim/finalize sections (never across dispatch),
 * ownership judged by mtime staleness (90s) with heartbeat touch. Every
 * read-modify-write runs under the lock plus withFileMutationQueue.
 *
 * Task-file reads fail loudly (only a missing file yields []): a degraded
 * empty snapshot combined with the full write-back would silently erase
 * every job. Jobs auto-disable after MAX_FAILURES consecutive dispatch
 * failures so a deterministic failure cannot leak runs every tick.
 *
 * Spec: .pi/spec/20261019-143615-pi-loop-extension/plan.md
 */

import { createHash, randomBytes } from "node:crypto";
import {
    mkdir,
    readdir,
    readFile,
    rename,
    stat,
    unlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";
import {
    withFileMutationQueue,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    dispatchBackgroundTask,
    TaskAliasConflictError,
} from "./background-task.ts";

// ─── Constants ────────────────────────────────────────────────────

/** Scheduler tick. Minimum task granularity is 1 minute, so fire latency ≤ 30s. */
const TICK_MS = 30_000;
/** Lock heartbeat while held (non-load-bearing; the lock never spans dispatch). */
const HEARTBEAT_MS = 15_000;
/** Lock mtime older than this is stealable (catches SIGKILLed holders). */
const STALE_MS = 90_000;
/** Lock acquisition: 50ms spins for at most 1s. Critical sections are ms-scale. */
const LOCK_SPIN_MS = 50;
const LOCK_SPIN_TRIES = 20;
/** Stored-job cap. */
const MAX_JOBS = 50;
/** Concurrent live runs (run dir with a live tmux session). */
const MAX_RUNS = 10;
/** Consecutive dispatch failures that disable a job (stops retry leaks). */
const MAX_FAILURES = 3;

/** Minute intervals that divide 60 evenly (the only every-N-minutes crons that tile an hour). */
const MINUTE_LADDER = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30] as const;
/** Hour intervals that divide 24 evenly. */
const HOUR_LADDER = [1, 2, 3, 4, 6, 8, 12] as const;

const INTERVAL_TOKEN = /^(\d+)([smhd])$/;
const DEFAULT_INTERVAL = { n: 10, unit: "m" as const };

const WORKTREE_SH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "background-task",
    "worktree.sh",
);

// ─── Types ────────────────────────────────────────────────────────

interface LoopTask {
    /** 8-hex job id. */
    id: string;
    /** Scheduling truth: nextFireAt = lastFiredAt + intervalMs. */
    intervalMs: number;
    /** Display/validation only (e.g. every-5-minutes cron string). */
    cron: string;
    prompt: string;
    createdAt: number;
    lastFiredAt: number;
    recurring: boolean;
    /** Consecutive dispatch failures; reaching MAX_FAILURES disables the job. */
    failureCount?: number;
    /** Most recent dispatch error message; cleared on the next successful fire. */
    lastError?: string;
    /** Paused via /loop <id> pause: skipped by the scheduler until resumed. */
    paused?: boolean;
}

interface LoopFile {
    version: 1;
    tasks: LoopTask[];
}

interface LoopEnv {
    repoRoot: string;
    /** .pi/background-tasks under repoRoot (run dirs + tmux socket live here). */
    tasksDir: string;
    socketPath: string;
}

type ParsedInterval = {
    intervalMs: number;
    cron: string;
    /** Set when the requested interval was rounded down; used for the notify. */
    roundedFrom?: string;
};

type DispatchOutcome =
    | { ok: true; alias: string }
    | { ok: false; error: string };

// ─── Module state (per module evaluation; /reload re-evaluates) ───

let api: ExtensionAPI | undefined;
let env: LoopEnv | undefined;
let cachedCtx: ExtensionContext | undefined;
let tickTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
/** skip-if-running guard for the tick chain. */
let ticking = false;
let shuttingDown = false;
let lockHeld = false;
/** Dedupe: notify once per cap-blocked episode, not every tick. */
let capBlocked = false;
/** Dedupe: notify a task-file read error once per broken-file episode. */
let readErrorNotified = false;
// ─── Small helpers ────────────────────────────────────────────────

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function errnoCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function hhmmss(): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** MAX_INTERVAL_MS caps user-requested intervals: anything beyond a year is
 * almost certainly an id-like token (see randomId) or a typo, never intent. */
const MAX_INTERVAL_MS = 366 * 24 * 3_600_000;

function randomId(): string {
    const id = randomBytes(4).toString("hex");
    // First char forced to a hex letter so an id can never match the
    // interval token regex ^(\d+)([smhd])$: without this, an id like
    // "1234567d" would make "/loop <id> run" parse as a 3400-year interval.
    return "abcdef"[randomBytes(1)[0] % 6] + id.slice(1);
}

/** Flatten whitespace and truncate to one display line. */
function previewText(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > 60 ? `${flat.slice(0, 60)}...` : flat;
}

/** Human delay: "now", "7m", "2h30m", "1d4h". */
function formatDelay(ms: number): string {
    if (ms <= 0) return "now";
    const totalMinutes = Math.round(ms / 60_000);
    if (totalMinutes < 60) return `${totalMinutes}m`;
    const hours = Math.floor(totalMinutes / 60);
    if (hours < 24) {
        const rest = totalMinutes - hours * 60;
        return rest > 0 ? `${hours}h${rest}m` : `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    const restHours = hours - days * 24;
    return restHours > 0 ? `${days}d${restHours}h` : `${days}d`;
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

// ─── Repo-local environment (mirrors background-task's getTasksEnv) ──

function tasksFilePath(): string {
    return path.join(env!.repoRoot, ".pi", "loop-tasks.json");
}

function lockFilePath(): string {
    return path.join(env!.repoRoot, ".pi", "loop-tasks.lock");
}

async function probeEnv(): Promise<LoopEnv | undefined> {
    const result = await api!.exec("bash", [WORKTREE_SH, "root-path"]);
    if (result.code !== 0) return undefined;
    const repoRoot = result.stdout.trim();
    if (!repoRoot) return undefined;
    const tasksDir = path.join(repoRoot, ".pi", "background-tasks");
    return { repoRoot, tasksDir, socketPath: path.join(tasksDir, "tmux.sock") };
}

// ─── Interval parsing (/loop) ─────────────────────────────────────

function intervalSpec(
    n: number,
    unit: "m" | "h" | "d",
): { intervalMs: number; cron: string } {
    if (unit === "m") return { intervalMs: n * 60_000, cron: `*/${n} * * * *` };
    if (unit === "h") return { intervalMs: n * 3_600_000, cron: `0 */${n} * * *` };
    return { intervalMs: n * 86_400_000, cron: `0 0 */${n} * *` };
}

function largestLE(ladder: readonly number[], n: number): number {
    let best = ladder[0];
    for (const value of ladder) {
        if (value <= n && value > best) best = value;
    }
    return best;
}

/**
 * Normalize a requested interval to the nearest expressible one, rounding
 * DOWN to the largest ladder value ≤ the request (7m → 6m, 90m → 1h,
 * 36h → 1d). Seconds collapse up to whole minutes (minimum granularity).
 */
function normalizeInterval(rawN: number, rawUnit: string): ParsedInterval {
    const original = `${rawN}${rawUnit}`;
    let n = rawN;
    let unit = rawUnit as "s" | "m" | "h" | "d";

    if (unit === "s") {
        n = Math.max(1, Math.ceil(n / 60));
        unit = "m";
    }
    if (unit === "m" && n >= 1440) {
        n = Math.floor(n / 1440);
        unit = "d";
    } else if (unit === "h" && n >= 24) {
        n = Math.floor(n / 24);
        unit = "d";
    } else if (unit === "m" && n >= 60) {
        const hours = n / 60;
        if (Number.isInteger(hours) && 24 % hours === 0) return intervalSpec(hours, "h");
        const rounded = largestLE(HOUR_LADDER, Math.floor(hours));
        return { ...intervalSpec(rounded, "h"), roundedFrom: original };
    }

    if (unit === "m") {
        if ((MINUTE_LADDER as readonly number[]).includes(n)) return intervalSpec(n, "m");
        const rounded = largestLE(MINUTE_LADDER, n);
        return { ...intervalSpec(rounded, "m"), roundedFrom: original };
    }
    if (unit === "h") {
        if (24 % n === 0) return intervalSpec(n, "h");
        const rounded = largestLE(HOUR_LADDER, n);
        return { ...intervalSpec(rounded, "h"), roundedFrom: original };
    }
    return intervalSpec(n, "d");
}

function normalizeUnitWord(word: string): "s" | "m" | "h" | "d" | undefined {
    const lower = word.toLowerCase();
    if (/^s/.test(lower)) return "s";
    if (/^m/.test(lower)) return "m";
    if (/^h/.test(lower)) return "h";
    if (/^d/.test(lower)) return "d";
    return undefined;
}

const USAGE =
    "Usage: /loop [interval] <prompt>\n" +
    "  interval: 5m, 2h, 1d, every 20m, every 5 minutes (minimum 1m, defaults to 10m)";

/** Reserved /loop first tokens (subcommand verbs; never treated as prompt text). */
/** Manage verbs operate on an existing job id; "list" is reserved but takes
 * no id. Single source of truth for parsing, dispatch, and typing. */
const MANAGE_VERBS = ["delete", "run", "pause", "resume"] as const;
type ManageVerb = (typeof MANAGE_VERBS)[number];
const SUBCOMMAND_WORDS = new Set<string>([...MANAGE_VERBS, "list"]);

/**
 * Three rules (Claude Code parity): leading `<N><unit>` token wins; else a
 * trailing `every <N><unit|unit-word>` is stripped from the prompt; else
 * default 10m with the whole input as prompt. Empty prompt and sub-floor
 * intervals (< 1m) are usage errors, never snap-ups.
 */
function parseLoopArgs(
    raw: string,
): { interval?: ParsedInterval; prompt: string; error?: string } {
    const text = raw.trim();
    if (!text) return { prompt: "" };

    const firstToken = text.split(/\s+/, 1)[0];
    const lead = INTERVAL_TOKEN.exec(firstToken);
    if (lead) {
        const prompt = text.slice(firstToken.length).trim();
        if (!prompt) return { prompt: "" };
        return intervalFor(Number(lead[1]), lead[2], prompt);
    }

    const every =
        /^([\s\S]*?)\s*every\s+(\d+)\s*([a-z]+)\s*$/i.exec(text);
    if (every) {
        const unit = normalizeUnitWord(every[3]);
        if (unit) {
            const prompt = every[1].trim();
            if (!prompt) return { prompt: "" };
            return intervalFor(Number(every[2]), unit, prompt);
        }
    }

    return {
        interval: normalizeInterval(DEFAULT_INTERVAL.n, DEFAULT_INTERVAL.unit),
        prompt: text,
    };
}

/**
 * Reject sub-floor requests: 0 of any unit and under 60s are below the 1m
 * minimum granularity and must not snap up to the most aggressive tier.
 */
function intervalFor(
    n: number,
    unit: string,
    prompt: string,
): { interval?: ParsedInterval; prompt: string; error?: string } {
    if (n < 1 || (unit === "s" && n < 60)) {
        return { prompt, error: `interval must be at least 1m (got ${n}${unit})` };
    }
    const interval = normalizeInterval(n, unit);
    if (interval.intervalMs > MAX_INTERVAL_MS) {
        return { prompt, error: `interval must be at most 366d (got ${n}${unit})` };
    }
    return { interval, prompt };
}

// ─── Cron subset (loop_create validation) ─────────────────────────

/** intervalMs for the cron subset /loop can express, else undefined. */
function cronToIntervalMs(cron: string): number | undefined {
    const everyMinutes = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
    if (everyMinutes) {
        const n = Number(everyMinutes[1]);
        if (n >= 1 && n <= 59 && 60 % n === 0) return n * 60_000;
        return undefined;
    }
    const everyHours = /^0 \*\/(\d+) \* \* \*$/.exec(cron);
    if (everyHours) {
        const n = Number(everyHours[1]);
        if (n >= 1 && 24 % n === 0) return n * 3_600_000;
        return undefined;
    }
    const everyDays = /^0 0 \*\/(\d+) \* \*$/.exec(cron);
    if (everyDays) {
        const n = Number(everyDays[1]);
        // Same 366d cap /loop enforces, so both creation paths agree.
        if (n >= 1 && n * 86_400_000 <= MAX_INTERVAL_MS) return n * 86_400_000;
        return undefined;
    }
    return undefined;
}

const CRON_HINT =
    "Unsupported cron. Use one of: */N * * * * (N divides 60), " +
    "0 */H * * * (H divides 24), 0 0 */N * * (every N days), " +
    "or the /loop command for arbitrary intervals (e.g. /loop 7m <prompt>).";

// ─── Task file IO under the lock ──────────────────────────────────

function isValidTask(value: unknown): value is LoopTask {
    const task = value as LoopTask | undefined;
    return (
        !!task &&
        typeof task.id === "string" &&
        typeof task.intervalMs === "number" &&
        task.intervalMs > 0 &&
        typeof task.cron === "string" &&
        typeof task.prompt === "string" &&
        typeof task.createdAt === "number" &&
        typeof task.lastFiredAt === "number" &&
        typeof task.recurring === "boolean" &&
        (task.failureCount === undefined ||
            (typeof task.failureCount === "number" && task.failureCount >= 0)) &&
        (task.lastError === undefined || typeof task.lastError === "string") &&
        (task.paused === undefined || typeof task.paused === "boolean")
    );
}

/** Jobs at MAX_FAILURES consecutive dispatch failures stop firing. */
function isDisabled(task: LoopTask): boolean {
    return (task.failureCount ?? 0) >= MAX_FAILURES;
}

/** Scheduler eligibility: not disabled and not paused. Used by BOTH the due
 * filter and the claim loop (the claim loop is the second line of defense). */
function isSchedulable(task: LoopTask): boolean {
    return !isDisabled(task) && !task.paused;
}

/**
 * Read the task file. Fails loudly on every error except a missing file:
 * returning [] on a read/parse failure plus mutateTasks' full write-back
 * would silently erase every job. Missing file = first creation = [].
 */
async function readTasks(): Promise<LoopTask[]> {
    const filePath = tasksFilePath();
    let raw: string;
    try {
        raw = await readFile(filePath, "utf8");
    } catch (error) {
        if (errnoCode(error) === "ENOENT") return [];
        throw new Error(`[loop] cannot read ${filePath}: ${messageOf(error)}`, {
            cause: error,
        });
    }
    let parsed: Partial<LoopFile>;
    try {
        parsed = JSON.parse(raw) as Partial<LoopFile>;
    } catch (error) {
        throw new Error(`[loop] ${filePath} is corrupt JSON: ${messageOf(error)}`, {
            cause: error,
        });
    }
    if (!parsed || !Array.isArray(parsed.tasks)) {
        throw new Error(`[loop] ${filePath} is malformed: 'tasks' is not an array`);
    }
    parsed.tasks.forEach((task, index) => {
        if (!isValidTask(task)) {
            throw new Error(`[loop] ${filePath} entry ${index} is invalid`);
        }
    });
    return parsed.tasks;
}

async function writeTasks(tasks: LoopTask[]): Promise<void> {
    const filePath = tasksFilePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const payload: LoopFile = { version: 1, tasks };
    await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    await rename(temporaryPath, filePath);
}

async function lockIsStale(): Promise<boolean> {
    try {
        const info = await stat(lockFilePath());
        return Date.now() - info.mtimeMs > STALE_MS;
    } catch {
        // Vanished between the failed wx and the stat: treat as free.
        return true;
    }
}

function startHeartbeat(): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        void utimes(lockFilePath(), new Date(), new Date()).catch(() => {});
    }, HEARTBEAT_MS);
    heartbeatTimer.unref();
}

function stopHeartbeat(): void {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
    }
}

async function acquireLock(): Promise<boolean> {
    await mkdir(path.join(env!.repoRoot, ".pi"), { recursive: true });
    const deadline = Date.now() + LOCK_SPIN_TRIES * LOCK_SPIN_MS;
    for (;;) {
        try {
            await writeFile(
                lockFilePath(),
                `${JSON.stringify({ pid: process.pid })}\n`,
                { flag: "wx", mode: 0o600 },
            );
            lockHeld = true;
            startHeartbeat();
            return true;
        } catch (error) {
            if (errnoCode(error) !== "EEXIST") return false;
            if (await lockIsStale()) {
                await unlink(lockFilePath()).catch(() => {});
                continue;
            }
            if (Date.now() >= deadline) return false;
            await sleep(LOCK_SPIN_MS);
        }
    }
}

async function releaseLock(): Promise<void> {
    stopHeartbeat();
    if (!lockHeld) return;
    lockHeld = false;
    try {
        const raw = await readFile(lockFilePath(), "utf8");
        const parsed = JSON.parse(raw) as { pid?: number };
        // A stolen lock (stale unlink + recreate by another session) must
        // not be deleted by us.
        if (parsed?.pid !== process.pid) return;
    } catch {
        return;
    }
    await unlink(lockFilePath()).catch(() => {});
}

/**
 * Locked read-modify-write over the task file. The mutator receives a fresh
 * in-lock snapshot and mutates it in place; the result is always written
 * back. Read errors throw instead of writing a degraded snapshot, so a
 * corrupt or unreadable file is never overwritten with an empty list.
 * Returns false only when the lock could not be acquired within the budget.
 */
async function mutateTasks(
    mutator: (tasks: LoopTask[]) => Promise<void> | void,
): Promise<boolean> {
    return withFileMutationQueue(tasksFilePath(), async () => {
        if (!(await acquireLock())) return false;
        try {
            const tasks = await readTasks();
            await mutator(tasks);
            await writeTasks(tasks);
            return true;
        } finally {
            await releaseLock();
        }
    });
}

// ─── Run cap ──────────────────────────────────────────────────────

function sessionNameForAlias(alias: string): string {
    const uuid = createHash("sha256").update(alias, "utf8").digest("hex").slice(0, 16);
    return `background-task-${uuid}`;
}

async function countLiveRuns(): Promise<number> {
    let entries: string[];
    try {
        // Run dirs live under tasksDir/tasks/<alias> (background-task.ts layout).
        entries = await readdir(path.join(env!.tasksDir, "tasks"));
    } catch {
        return 0;
    }
    const aliases = entries.filter((name) => name.startsWith("loop-"));
    if (aliases.length === 0) return 0;
    const result = await api!.exec("tmux", [
        "-S",
        env!.socketPath,
        "list-sessions",
        "-F",
        "#{session_name}",
    ]);
    if (result.code !== 0) return 0;
    const live = new Set(
        result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
    );
    let count = 0;
    for (const alias of aliases) {
        if (live.has(sessionNameForAlias(alias))) count++;
    }
    return count;
}

// ─── Dispatch ─────────────────────────────────────────────────────

async function dispatchJob(
    task: LoopTask,
    ctx: ExtensionContext,
): Promise<DispatchOutcome> {
    const alias = `loop-${task.id}-${hhmmss()}`;
    const description = `loop ${task.cron}: ${previewText(task.prompt)}`;
    try {
        await dispatchBackgroundTask(api!, {
            alias,
            prompt: task.prompt,
            description,
            worktree: false,
            ctx,
        });
        return { ok: true, alias };
    } catch (error) {
        if (error instanceof TaskAliasConflictError) {
            const retryAlias = `${alias}-2`;
            try {
                await dispatchBackgroundTask(api!, {
                    alias: retryAlias,
                    prompt: task.prompt,
                    description,
                    worktree: false,
                    ctx,
                });
                return { ok: true, alias: retryAlias };
            } catch (retryError) {
                return { ok: false, error: messageOf(retryError) };
            }
        }
        return { ok: false, error: messageOf(error) };
    }
}

// ─── Scheduler ────────────────────────────────────────────────────

function scheduleTick(delayMs: number): void {
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = setTimeout(() => {
        void runTick();
    }, delayMs);
    tickTimer.unref();
}

/**
 * Top-rescheduling chain: the next tick is scheduled before the body runs,
 * so a throwing or hanging body only delays the chain, never kills it.
 * skip-if-running guards re-entrancy; the catch routes to console.error
 * because ctx.ui itself throws on a stale context.
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

async function tickBody(): Promise<void> {
    if (!env || shuttingDown) return;
    const now = Date.now();

    let due: LoopTask[];
    try {
        due = (await readTasks()).filter(
            (task) => isSchedulable(task) && task.lastFiredAt + task.intervalMs <= now,
        );
    } catch (error) {
        // The file broke after mount: keep the tick chain alive so a fixed
        // file resumes without /reload, but notify once per episode. The
        // error is rethrown from readTasks and never written back, so the
        // file survives.
        if (!readErrorNotified) {
            readErrorNotified = true;
            safeNotify(
                cachedCtx,
                `[loop] task file error: ${messageOf(error)} (retrying each tick)`,
                "error",
            );
        }
        console.error("[loop] task file read failed:", error);
        return;
    }
    readErrorNotified = false;
    if (due.length === 0) return;

    // Cap check outside the lock (counts run dirs with live tmux sessions).
    if ((await countLiveRuns()) >= MAX_RUNS) {
        if (!capBlocked) {
            capBlocked = true;
            safeNotify(
                cachedCtx,
                `[loop] run cap reached (${MAX_RUNS} live runs); waiting for runs to be Closed via /background-tasks.`,
                "warning",
            );
        }
        return;
    }
    capBlocked = false;

    // Claim: under the lock, re-read and mark due tasks (lastFiredAt = now).
    // The lock is released before any dispatch; a crash between claim and
    // finalize leaves lastFiredAt advanced (at-most-once; no re-fire).
    const claimed: LoopTask[] = [];
    const previousFired = new Map<string, number>();
    const acquired = await mutateTasks((tasks) => {
        for (const task of tasks) {
            if (!isSchedulable(task)) continue;
            if (task.lastFiredAt + task.intervalMs <= now) {
                previousFired.set(task.id, task.lastFiredAt);
                task.lastFiredAt = now;
                claimed.push({ ...task });
            }
        }
    });
    if (!acquired || claimed.length === 0) return;
    if (shuttingDown) return;

    // Dispatch outside the lock (7 pi.exec calls per dispatch).
    const failures = new Map<string, string>();
    const fired: string[] = [];
    for (const task of claimed) {
        const outcome = await dispatchJob(task, cachedCtx!);
        if (outcome.ok) {
            fired.push(`${previewText(task.prompt)} (${outcome.alias})`);
        } else {
            failures.set(task.id, outcome.error);
        }
    }

    // Finalize: under the lock, re-read and patch by id, touching ONLY this
    // tick's claimed tasks. Recurring successes reset failureCount and clear
    // lastError (nextFireAt is derived); one-shots are deleted; failed
    // dispatches bump failureCount, record lastError and restore lastFiredAt;
    // at MAX_FAILURES the job is left disabled so a deterministic failure
    // cannot leak a fresh run dir and tmux session every 30s until the cap
    // halts the scheduler.
    //
    // The lastFiredAt guards below are defensive, cross-session only: this
    // process never writes lastFiredAt between claim and finalize, but a
    // second session's tick can claim the same job again if its interval
    // elapsed while our dispatch was running. The success path keeps the
    // newer value; the failure path restores the pre-claim value only when
    // no newer claim superseded it. A false finalize return means the lock
    // budget expired and nothing was written back: on disk the job is
    // merely delayed one cycle, never double-triggered.
    await mutateTasks((tasks) => {
        for (const task of tasks) {
            if (!previousFired.has(task.id)) continue;
            const error = failures.get(task.id);
            if (error === undefined) {
                task.lastFiredAt = Math.max(task.lastFiredAt, now);
                delete task.lastError;
                if (task.failureCount) task.failureCount = 0;
                if (!task.recurring) {
                    const index = tasks.indexOf(task);
                    if (index >= 0) tasks.splice(index, 1);
                }
                continue;
            }
            task.lastError = error;
            const consecutive = (task.failureCount ?? 0) + 1;
            task.failureCount = consecutive;
            if (consecutive >= MAX_FAILURES) continue;
            const previous = previousFired.get(task.id);
            if (previous !== undefined && task.lastFiredAt === now) {
                task.lastFiredAt = previous;
            }
        }
    });

    for (const task of claimed) {
        const error = failures.get(task.id);
        if (error === undefined) continue;
        const consecutive = (task.failureCount ?? 0) + 1;
        if (consecutive >= MAX_FAILURES) {
            safeNotify(
                cachedCtx,
                `[loop] job ${task.id} disabled after ${MAX_FAILURES} failed dispatches ` +
                    `(last error: ${error}); delete with loop_delete or re-create once fixed`,
                "error",
            );
            continue;
        }
        // claimed snapshots predate finalize, so task.lastError is the
        // previously persisted error: notify only when the error changed.
        if (task.lastError !== error) {
            safeNotify(
                cachedCtx,
                `[loop] job ${task.id} dispatch failed (will retry next tick): ${error}`,
                "warning",
            );
        }
    }
    if (fired.length > 0) {
        safeNotify(cachedCtx, `[loop] fired: ${fired.join("; ")}`);
    }
}

/**
 * Mount-time sweep: one-shots with lastFiredAt > createdAt are crash
 * residues (claim landed, finalize never did). A never-fired one-shot has
 * lastFiredAt === createdAt and is kept; a restored failure also equals
 * createdAt and is correctly retried by the next tick. Disabled one-shots
 * are kept too: their advanced lastFiredAt is a disable marker, not a
 * crash residue, and they stay visible until cancelled.
 */
async function sweepZombieOneShots(): Promise<void> {
    await mutateTasks((tasks) => {
        for (let index = tasks.length - 1; index >= 0; index--) {
            const task = tasks[index];
            if (
                !task.recurring &&
                task.lastFiredAt > task.createdAt &&
                !isDisabled(task)
            ) {
                tasks.splice(index, 1);
            }
        }
    });
}

// ─── Confirmation message ─────────────────────────────────────────

/** Static pointers, shown after USAGE when /loop has no jobs to list. */
const EDUCATION =
    "Runs forever until cancelled.\n" +
    "Each run is a context-free child session (it sees only the prompt, not this conversation).\n" +
    "Runs stay in /background-tasks until you Close them.";

/**
 * One line: the schedule line (with the rounding note folded in when the
 * requested interval was not evenly expressible). Creation never dispatches
 * immediately; the first fire happens one interval after creation.
 */
function confirmationLine(task: LoopTask, roundedFrom?: string): string {
    const delay = formatDelay(task.intervalMs);
    let line =
        `[loop] scheduled ${task.id}: ${previewText(task.prompt)}` +
        ` · cron ${task.cron} · next fire in ${delay}`;
    if (roundedFrom) line += ` (${roundedFrom} → ${delay})`;
    return line;
}

// ─── /loop listing and per-job subcommands ────────────────────────

/** One line per job, plus an indented lastError line when present. */
function jobListLines(tasks: LoopTask[], now: number): string[] {
    return tasks.map((task) => {
        const state = isDisabled(task)
            ? `disabled (${MAX_FAILURES}+ failed dispatches)`
            : task.paused
              ? "paused"
              : `next fire in ${formatDelay(task.lastFiredAt + task.intervalMs - now)}`;
        const lastError = task.lastError
            ? `\n      last error: ${previewText(task.lastError)}`
            : "";
        return (
            `  ${task.id}  ${task.cron}  ${task.recurring ? "recurring" : "one-shot"}  ` +
            `${state}  ${previewText(task.prompt)}${lastError}`
        );
    });
}

/** "/loop" with no args: job listing, or USAGE + pointers when empty. */
async function listJobsNotify(ctx: ExtensionContext): Promise<void> {
    const tasks = await readTasksOrNotify(ctx);
    if (!tasks) return;
    if (tasks.length === 0) {
        safeNotify(ctx, `${USAGE}\n\n${EDUCATION}`, "info");
        return;
    }
    safeNotify(
        ctx,
        `[loop] ${tasks.length} job(s):\n${jobListLines(tasks, Date.now()).join("\n")}\n` +
            "Manage: /loop <id> delete|run|pause|resume",
        "info",
    );
}

/** Read the task file for a UI command; notify and return undefined on
 * failure (the command boundary is the right place to surface it). */
async function readTasksOrNotify(ctx: ExtensionContext): Promise<LoopTask[] | undefined> {
    try {
        return await readTasks();
    } catch (error) {
        safeNotify(ctx, `[loop] task file error: ${messageOf(error)}`, "error");
        return undefined;
    }
}

/** Exact-match miss: never prefix-guess; show the current ids instead.
 * Pass a snapshot when the caller has one (avoids a second read); undefined
 * makes the helper read the file itself. */
async function notifyUnknownJob(
    id: string,
    tasks: LoopTask[] | undefined,
    ctx: ExtensionContext,
): Promise<void> {
    tasks ??= await readTasksOrNotify(ctx);
    if (!tasks) return;
    if (tasks.length === 0) {
        safeNotify(ctx, `[loop] no job with id "${id}" (no jobs exist)`, "warning");
        return;
    }
    safeNotify(
        ctx,
        `[loop] no job with id "${id}". Current job ids:\n` +
            jobListLines(tasks, Date.now()).join("\n"),
        "warning",
    );
}

/** Shared skeleton for the delete/pause/resume verbs: exact-id mutation via
 * mutateTasks, with busy/missing reporting folded in. The mutator returns
 * the success message. */
async function mutateJob(
    id: string,
    ctx: ExtensionContext,
    mutator: (task: LoopTask, tasks: LoopTask[]) => string,
): Promise<void> {
    let found = false;
    let success = "";
    const written = await mutateTasks((tasks) => {
        const task = tasks.find((entry) => entry.id === id);
        if (!task) return;
        found = true;
        success = mutator(task, tasks);
    });
    if (!written) {
        safeNotify(ctx, "[loop] task file busy (lock timeout); retry", "warning");
        return;
    }
    if (!found) {
        await notifyUnknownJob(id, undefined, ctx);
        return;
    }
    safeNotify(ctx, success);
}

/** "/loop <id> delete|run|pause|resume": dispatch to the verb handlers. */
async function handleJobCommand(
    id: string,
    verb: ManageVerb,
    ctx: ExtensionContext,
): Promise<void> {
    if (verb === "delete") {
        await mutateJob(id, ctx, (task, tasks) => {
            tasks.splice(tasks.indexOf(task), 1);
            return `[loop] deleted job ${id}`;
        });
        return;
    }

    if (verb === "pause" || verb === "resume") {
        await mutateJob(id, ctx, (task) => {
            if (verb === "pause") {
                task.paused = true;
                return `[loop] job ${id} paused; resume with /loop ${id} resume`;
            }
            delete task.paused;
            // Resume is also the revival path for a disabled job.
            task.failureCount = 0;
            return `[loop] job ${id} resumed; if it is overdue it fires on the next tick`;
        });
        return;
    }

    // run: fire the prompt ONCE here in the current session via sendMessage
    // (triggerTurn). No scheduler involvement, no task-file mutation: no
    // backdating race and no zombie-sweep interaction.
    // Unlike scheduled runs (context-free child sessions), this injected run
    // carries the current conversation context, which is the point of a
    // manual test fire. Reviving a disabled job is resume's job (it clears
    // failureCount), not run's.
    if (!ctx.isIdle()) {
        safeNotify(
            ctx,
            "[loop] agent is busy; wait for the current run to finish, then retry",
            "warning",
        );
        return;
    }
    const tasks = await readTasksOrNotify(ctx);
    if (!tasks) return;
    const prompt = tasks.find((task) => task.id === id)?.prompt;
    if (prompt === undefined) {
        await notifyUnknownJob(id, tasks, ctx);
        return;
    }
    api!.sendMessage(
        {
            customType: "loop-run",
            content: `[loop] manual run of job ${id} — execute this prompt now:\n\n${prompt}`,
            display: true,
        },
        { triggerTurn: true },
    );
    safeNotify(ctx, `[loop] job ${id} fired in this session`);
}

// ─── Extension registration ───────────────────────────────────────

export default function (pi: ExtensionAPI) {
    // Background-task children auto-discover this extension too (~/.pi is a
    // symlink into this repo); the guard must run before any registration.
    if (process.env.PI_BACKGROUND_TASK_CHILD === "1") return;

    api = pi;

    pi.registerCommand("loop", {
        description:
            "Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo, defaults to 10m)",
        handler: async (args: string, ctx) => {
            if (!env) {
                ctx.ui.notify(
                    "[loop] disabled: not inside a git repo main worktree",
                    "warning",
                );
                return;
            }

            const raw = args.trim();
            if (!raw) {
                // No args: list jobs (USAGE + pointers when nothing is scheduled).
                await listJobsNotify(ctx);
                return;
            }

            // Interval syntax is checked before id interpretation: a leading
            // <N><unit> token is a creation form, never a job id.
            const tokens = raw.split(/\s+/);
            if (!INTERVAL_TOKEN.test(tokens[0])) {
                const first = tokens[0].toLowerCase();
                if (SUBCOMMAND_WORDS.has(first)) {
                    // Reserved verb with no id in front: unambiguous usage error.
                    if (first === "list") {
                        await listJobsNotify(ctx);
                        return;
                    }
                    ctx.ui.notify(
                        `[loop] usage: /loop <id> ${first} (ids: /loop or loop_list). ` +
                            `To schedule a prompt starting with "${first}", add an interval: /loop 10m ${first} ...`,
                        "warning",
                    );
                    return;
                }
                if (tokens.length === 2) {
                    // "<id> <verb>" with nothing after the verb: exact-id
                    // subcommand. Longer inputs stay prompt text.
                    const verb = tokens[1].toLowerCase();
                    if ((MANAGE_VERBS as readonly string[]).includes(verb)) {
                        await handleJobCommand(tokens[0], verb as ManageVerb, ctx);
                        return;
                    }
                    if (SUBCOMMAND_WORDS.has(verb)) {
                        // "<id> list" (or any reserved non-manage verb): an
                        // error beats silently creating a junk task.
                        ctx.ui.notify(
                            `[loop] usage: /loop <id> delete|run|pause|resume (ids: /loop or loop_list)`,
                            "warning",
                        );
                        return;
                    }
                }
            }

            const parsed = parseLoopArgs(args);
            if (parsed.error) {
                ctx.ui.notify(`[loop] ${parsed.error}`, "warning");
                return;
            }
            if (!parsed.prompt) {
                // Interval with no prompt (e.g. "/loop 5m").
                ctx.ui.notify(USAGE, "warning");
                return;
            }
            const interval =
                parsed.interval ??
                normalizeInterval(DEFAULT_INTERVAL.n, DEFAULT_INTERVAL.unit);

            const now = Date.now();
            const task: LoopTask = {
                id: randomId(),
                intervalMs: interval.intervalMs,
                cron: interval.cron,
                prompt: parsed.prompt,
                createdAt: now,
                lastFiredAt: now,
                recurring: true,
            };

            let overLimit = false;
            const written = await mutateTasks((tasks) => {
                if (tasks.length >= MAX_JOBS) {
                    overLimit = true;
                    return;
                }
                tasks.push(task);
            });
            if (!written) {
                ctx.ui.notify(
                    "[loop] task file busy (lock timeout); retry",
                    "warning",
                );
                return;
            }
            if (overLimit) {
                ctx.ui.notify(`[loop] max ${MAX_JOBS} jobs; delete one first`, "warning");
                return;
            }

            ctx.ui.notify(confirmationLine(task, interval.roundedFrom), "info");
        },
    });

    pi.registerTool({
        name: "loop_create",
        label: "Create Loop Job",
        description:
            "Schedule a prompt on a recurring interval (or one-shot). cron must be one of: " +
            "*/N * * * * (N divides 60, e.g. */5), 0 */H * * * (H divides 24), " +
            "0 0 */N * * (every N days). For other intervals use the /loop command " +
            "(e.g. /loop 7m <prompt>, which rounds to the nearest expressible interval). " +
            "Each run dispatches a fresh context-free child pi session that sees only the " +
            "prompt; results appear in /background-tasks until Closed. Jobs persist until " +
            "cancelled with loop_delete, or auto-disable after 3 consecutive dispatch failures " +
            "(visible via loop_list). The first run fires after one interval (not immediately).",
        parameters: Type.Object({
            cron: Type.String({
                description:
                    'Cron subset: "*/N * * * *" (N divides 60), "0 */H * * *" (H divides 24), or "0 0 */N * *" (every N days).',
            }),
            prompt: Type.String({
                description: "The prompt each run executes in its child session.",
            }),
            recurring: Type.Optional(
                Type.Boolean({
                    description:
                        "true (default) repeats every interval; false runs once then deletes the job.",
                }),
            ),
        }),
        annotations: { openWorldHint: true },
        async execute(_toolCallId, params) {
            if (!env) {
                throw new Error("[loop] disabled: not inside a git repo main worktree");
            }
            const cron = params.cron.trim();
            const intervalMs = cronToIntervalMs(cron);
            if (!intervalMs) throw new Error(CRON_HINT);
            const prompt = params.prompt.trim();
            if (!prompt) throw new Error("prompt must not be empty");

            const now = Date.now();
            const task: LoopTask = {
                id: randomId(),
                intervalMs,
                cron,
                prompt,
                createdAt: now,
                lastFiredAt: now,
                recurring: params.recurring ?? true,
            };

            let overLimit = false;
            const written = await mutateTasks((tasks) => {
                if (tasks.length >= MAX_JOBS) {
                    overLimit = true;
                    return;
                }
                tasks.push(task);
            });
            if (!written) throw new Error("loop task file busy (lock timeout); retry");
            if (overLimit) throw new Error(`max ${MAX_JOBS} jobs; delete one first`);

            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Created loop job ${task.id} (${task.cron}, ` +
                            `${task.recurring ? "recurring" : "one-shot"}). ` +
                            `First run at +${formatDelay(task.intervalMs)} (tick-driven). ` +
                            `Each run is a context-free child session; results via /background-tasks.`,
                    },
                ],
                details: undefined,
            };
        },
    });

    pi.registerTool({
        name: "loop_list",
        label: "List Loop Jobs",
        description:
            "List all scheduled loop jobs with cron, recurrence, time until the next fire, " +
            "disabled state, and last dispatch error. Read-only.",
        parameters: Type.Object({}),
        annotations: { readOnlyHint: true },
        async execute() {
            if (!env) {
                throw new Error("[loop] disabled: not inside a git repo main worktree");
            }
            const tasks = await readTasks();
            if (tasks.length === 0) {
                return {
                    content: [{ type: "text", text: "No loop jobs." }],
                    details: undefined,
                };
            }
            const lines = jobListLines(tasks, Date.now());
            return {
                content: [
                    { type: "text", text: `${tasks.length} loop job(s):\n${lines.join("\n")}` },
                ],
                details: undefined,
            };
        },
    });

    pi.registerTool({
        name: "loop_delete",
        label: "Delete Loop Job",
        description:
            "Cancel a scheduled loop job by id (from loop_list). Runs already dispatched keep " +
            "running until Closed via /background-tasks.",
        parameters: Type.Object({
            id: Type.String({
                description: "Job id from loop_list.",
            }),
        }),
        annotations: { destructiveHint: true },
        async execute(_toolCallId, params) {
            if (!env) {
                throw new Error("[loop] disabled: not inside a git repo main worktree");
            }
            const id = params.id.trim();
            let found = false;
            const written = await mutateTasks((tasks) => {
                const index = tasks.findIndex((task) => task.id === id);
                if (index < 0) return;
                found = true;
                tasks.splice(index, 1);
            });
            if (!written) throw new Error("loop task file busy (lock timeout); retry");
            if (!found) throw new Error(`Unknown loop job id "${id}".`);
            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Cancelled job ${id}. Runs already dispatched keep running ` +
                            `until Closed via /background-tasks.`,
                    },
                ],
                details: undefined,
            };
        },
    });

    pi.on("session_start", async (_event, ctx) => {
        cachedCtx = ctx;
        shuttingDown = false;
        if (!env) env = await probeEnv();
        if (!env) {
            safeNotify(
                ctx,
                "[loop] disabled: not inside a git repo main worktree",
                "warning",
            );
            return;
        }
        try {
            await sweepZombieOneShots();
        } catch (error) {
            // A broken task file pauses the scheduler instead of letting
            // the sweep's write-back overwrite it with an empty list.
            safeNotify(
                ctx,
                `[loop] task file error, scheduler paused: ${messageOf(error)}`,
                "error",
            );
            console.error("[loop] task file sweep failed:", error);
            return;
        }
        scheduleTick(TICK_MS);
    });

    // ctx is invalidated ONLY here: session_shutdown covers every replacement
    // path (switch/fork/new/reload all emit it, followed by session_start).
    // session_before_switch/_fork are cancellable and fire before teardown,
    // so clearing there could kill the scheduler with no follow-up start.
    pi.on("session_shutdown", () => {
        shuttingDown = true;
        if (tickTimer) {
            clearTimeout(tickTimer);
            tickTimer = undefined;
        }
        cachedCtx = undefined;
        if (lockHeld) void releaseLock();
    });
}
