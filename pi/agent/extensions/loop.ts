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
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
    mkdir,
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
    keyHint,
    type Theme,
    withFileMutationQueue,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    stripTerminalSequences,
    Text,
    truncateToWidth,
    visibleWidth,
    type Component,
} from "@earendil-works/pi-tui";

// ─── Constants ────────────────────────────────────────────────────

/** Scheduler tick (claude parity). Cron granularity is 1 minute. */
const TICK_MS = 1000;
/** How often a non-owner probes the owner lease. */
const LOCK_PROBE_MS = 5000;
/** Owner heartbeat on the lock file (corrupt-file liveness signal only). */
const HEARTBEAT_MS = 15_000;
/** Corrupt-lock mtime younger than this is treated as alive (no steal). */
const CORRUPT_LOCK_LIVE_MS = 60_000;
/** Stored-job cap (claude parity). */
const MAX_JOBS = 50;
/** Recurring tasks auto-expire after this age (fire one last time, then delete). */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** activeTaskIds TTL: last-resort clearing if no agent_settled ever arrives. */
const ACTIVE_TTL_MS = 60 * 60 * 1000;

/** Jitter knobs (claude DEFAULT_CRON_JITTER_CONFIG). */
const JITTER = {
    recurringFrac: 0.1,
    recurringCapMs: 15 * 60 * 1000,
    oneShotMaxMs: 90 * 1000,
    oneShotFloorMs: 0,
    oneShotMinuteMod: 30,
} as const;

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

// ─── Types ────────────────────────────────────────────────────────

interface StoredTask {
    /** 8-hex job id (first char a–f, never mistaken for an interval token). */
    id: string;
    /** 5-field cron string in local time — the scheduling truth. */
    cron: string;
    prompt: string;
    createdAt: number;
    /** Epoch ms of the most recent fire (recurring only). */
    lastFiredAt?: number;
    recurring?: boolean;
}

interface LoopFile {
    version: 2;
    tasks: unknown[];
}

interface OwnerLock {
    sessionId: string;
    pid: number;
    acquiredAt: number;
}

interface LoopEnv {
    repoRoot: string;
}

// ─── Module state (per module evaluation; /reload re-evaluates) ───

let api: ExtensionAPI | undefined;
let env: LoopEnv | undefined;
let cachedCtx: ExtensionContext | undefined;
let tickTimer: ReturnType<typeof setTimeout> | undefined;
let probeTimer: ReturnType<typeof setInterval> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
/** skip-if-running guard for the tick chain. */
let ticking = false;
let shuttingDown = false;
let isOwner = false;
let lockErrorNotified = false;
/** Durable tasks with an injected fire whose delete has not landed yet. */
const inFlight = new Set<string>();
/** Ids already surfaced as missed — prevents re-asking on every tick. */
const missedAsked = new Set<string>();
/** Ids with a live injected run (settle+idle clears; TTL is the backstop). */
const activeTaskIds = new Map<string, number>();
/** Session-only tasks (durable: false). Never touch the disk. */
const sessionTasks = new Map<string, StoredTask>();
/**
 * nextFireAt cache: id → { cron, anchor, next }. Recomputed when the cron
 * or the anchor (lastFiredAt ?? createdAt) changes; evicted when the id
 * disappears from a tick's seen set; cleared on owner takeover.
 */
const nextFireAt = new Map<string, { cron: string; anchor: number; next: number }>();
/** Notify a task-file read error once per broken-file episode. */
let readErrorNotified = false;

// ─── Small helpers ────────────────────────────────────────────────

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function errnoCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return errnoCode(error) === "EPERM";
    }
}

function randomId(): string {
    const id = randomBytes(4).toString("hex");
    // First char forced to a hex letter so an id can never look like a
    // leading interval token (\d+[smhd]) in a /loop invocation.
    return "abcdef"[randomBytes(1)[0] % 6] + id.slice(1);
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

function tasksFilePath(): string {
    return path.join(env!.repoRoot, ".pi", "loop-tasks.json");
}

function lockFilePath(): string {
    return path.join(env!.repoRoot, ".pi", "loop-tasks.lock");
}

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

// ─── Cron core (ported from claude src/utils/cron.ts) ─────────────

type CronFields = {
    minute: number[];
    hour: number[];
    dayOfMonth: number[];
    month: number[];
    dayOfWeek: number[];
};

const FIELD_RANGES = [
    { min: 0, max: 59 }, // minute
    { min: 0, max: 23 }, // hour
    { min: 1, max: 31 }, // dayOfMonth
    { min: 1, max: 12 }, // month
    { min: 0, max: 6 }, // dayOfWeek (0=Sunday; 7 accepted as Sunday alias)
] as const;

type ExpandResult = { values: number[] } | { error: string };

/**
 * Parse a single cron field. Supports wildcard, N, star-slash-N, N-M,
 * N-M/S and comma-lists. [v5] A step larger than the field span is
 * rejected (instead of silently collapsing to the field minimum): cron
 * would collapse a star-step of 40 over the day-of-month field to a
 * monthly schedule, and a star-step of 90 over minutes to hourly.
 */
function expandField(field: string, index: number): ExpandResult {
    const { min, max } = FIELD_RANGES[index];
    const out = new Set<number>();

    for (const part of field.split(",")) {
        const stepMatch = /^\*(?:\/(\d+))?$/.exec(part);
        if (stepMatch) {
            const step = stepMatch[1] ? Number.parseInt(stepMatch[1], 10) : 1;
            if (!(step >= 1)) return { error: "step must be >= 1" };
            if (step > max - min + 1) {
                return {
                    error: `step ${step} exceeds the field span (${min}-${max}); smallest usable value is ${min}`,
                };
            }
            for (let i = min; i <= max; i += step) out.add(i);
            continue;
        }

        const rangeMatch = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part);
        if (rangeMatch) {
            const lo = Number.parseInt(rangeMatch[1], 10);
            const hi = Number.parseInt(rangeMatch[2], 10);
            const step = rangeMatch[3] ? Number.parseInt(rangeMatch[3], 10) : 1;
            // dayOfWeek: accept 7 as Sunday alias in ranges (5-7 → [5,6,0]).
            const isDow = min === 0 && max === 6;
            const effMax = isDow ? 7 : max;
            if (lo > hi || step < 1 || lo < min || hi > effMax) {
                return { error: `value out of range (${min}-${max})` };
            }
            if (step > hi - lo + 1) {
                return {
                    error: `step ${step} exceeds the range span (${lo}-${hi})`,
                };
            }
            for (let i = lo; i <= hi; i += step) {
                out.add(isDow && i === 7 ? 0 : i);
            }
            continue;
        }

        if (/^\d+$/.test(part)) {
            let n = Number.parseInt(part, 10);
            if (min === 0 && max === 6 && n === 7) n = 0;
            if (n < min || n > max) {
                return { error: `value out of range (${min}-${max})` };
            }
            out.add(n);
            continue;
        }

        return { error: `unsupported syntax (no L/W/?/names)` };
    }

    if (out.size === 0) return { error: "field matches no values" };
    return { values: Array.from(out).sort((a, b) => a - b) };
}

/**
 * Parse a 5-field cron expression. Returns an error message on invalid or
 * unsupported syntax (including [v5] out-of-span steps), otherwise the
 * expanded fields.
 */
export function parseCronDetailed(
    expr: string,
): { fields: CronFields } | { error: string } {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) {
        return { error: "expected 5 fields: M H DoM Mon DoW" };
    }
    const expanded: number[][] = [];
    for (let i = 0; i < 5; i++) {
        const result = expandField(parts[i], i);
        if ("error" in result) {
            return { error: `field ${i + 1} '${parts[i]}': ${result.error}` };
        }
        expanded.push(result.values);
    }
    return {
        fields: {
            minute: expanded[0],
            hour: expanded[1],
            dayOfMonth: expanded[2],
            month: expanded[3],
            dayOfWeek: expanded[4],
        },
    };
}

function parseCronExpression(expr: string): CronFields | null {
    const parsed = parseCronDetailed(expr);
    return "fields" in parsed ? parsed.fields : null;
}

/**
 * Next local-time match strictly after `from`, minute-by-minute, bounded
 * at 366 days. DoM/DoW constrained simultaneously → OR semantics.
 *
 * DST: fixed-hour crons targeting a spring-forward gap skip the transition
 * day; wildcard-hour crons fire at the first valid minute after the gap;
 * fall-back repeats fire once. Matches vixie-cron / claude behavior.
 */
export function computeNextCronRun(fields: CronFields, from: Date): Date | null {
    const minuteSet = new Set(fields.minute);
    const hourSet = new Set(fields.hour);
    const domSet = new Set(fields.dayOfMonth);
    const monthSet = new Set(fields.month);
    const dowSet = new Set(fields.dayOfWeek);

    const domWild = fields.dayOfMonth.length === 31;
    const dowWild = fields.dayOfWeek.length === 7;

    const t = new Date(from.getTime());
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() + 1);

    // Hard wall-clock cap: month/day skips consume few iterations, so a
    // sparse DoM/DoW (leap-day) cron must be bounded by TIME, not by loop
    // count. Matches claude's "no match within a year" semantics.
    const deadline = from.getTime() + 366 * 24 * 60 * 60 * 1000;
    const maxIter = 366 * 24 * 60;
    for (let i = 0; i < maxIter; i++) {
        if (t.getTime() > deadline) return null;
        const month = t.getMonth() + 1;
        if (!monthSet.has(month)) {
            t.setMonth(t.getMonth() + 1, 1);
            t.setHours(0, 0, 0, 0);
            continue;
        }

        const dom = t.getDate();
        const dow = t.getDay();
        const dayMatches =
            domWild && dowWild
                ? true
                : domWild
                  ? dowSet.has(dow)
                  : dowWild
                    ? domSet.has(dom)
                    : domSet.has(dom) || dowSet.has(dow);
        if (!dayMatches) {
            t.setDate(t.getDate() + 1);
            t.setHours(0, 0, 0, 0);
            continue;
        }

        if (!hourSet.has(t.getHours())) {
            t.setHours(t.getHours() + 1, 0, 0, 0);
            continue;
        }
        if (!minuteSet.has(t.getMinutes())) {
            t.setMinutes(t.getMinutes() + 1);
            continue;
        }
        return t;
    }
    return null;
}

/** Next fire in epoch ms strictly after fromMs, or null. */
export function nextCronRunMs(cron: string, fromMs: number): number | null {
    const fields = parseCronExpression(cron);
    if (!fields) return null;
    const next = computeNextCronRun(fields, new Date(fromMs));
    return next ? next.getTime() : null;
}

// ─── cronToHuman (claude parity, local time) ──────────────────────

const DAY_NAMES = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

function formatLocalTime(minute: number, hour: number): string {
    // January 1 — no DST gap anywhere; new Date() (today) would roll
    // 2am→3am on the one spring-forward day per year.
    const d = new Date(2000, 0, 1, hour, minute);
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * Human-readable schedule for common shapes; anything else falls back to
 * the raw cron string (loop_list output depends on this fallback).
 */
export function cronToHuman(cron: string): string {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return cron;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
        string,
        string,
        string,
        string,
        string,
    ];

    const everyMinMatch = /^\*\/(\d+)$/.exec(minute);
    if (
        everyMinMatch &&
        hour === "*" &&
        dayOfMonth === "*" &&
        month === "*" &&
        dayOfWeek === "*"
    ) {
        const n = Number.parseInt(everyMinMatch[1], 10);
        return n === 1 ? "Every minute" : `Every ${n} minutes`;
    }

    if (
        /^\d+$/.test(minute) &&
        hour === "*" &&
        dayOfMonth === "*" &&
        month === "*" &&
        dayOfWeek === "*"
    ) {
        const m = Number.parseInt(minute, 10);
        return m === 0 ? "Every hour" : `Every hour at :${m.toString().padStart(2, "0")}`;
    }

    const everyHourMatch = /^\*\/(\d+)$/.exec(hour);
    if (
        /^\d+$/.test(minute) &&
        everyHourMatch &&
        dayOfMonth === "*" &&
        month === "*" &&
        dayOfWeek === "*"
    ) {
        const n = Number.parseInt(everyHourMatch[1], 10);
        const m = Number.parseInt(minute, 10);
        const suffix = m === 0 ? "" : ` at :${m.toString().padStart(2, "0")}`;
        return n === 1 ? `Every hour${suffix}` : `Every ${n} hours${suffix}`;
    }

    if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return cron;
    const m = Number.parseInt(minute, 10);
    const h = Number.parseInt(hour, 10);

    if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
        return `Every day at ${formatLocalTime(m, h)}`;
    }
    if (dayOfMonth === "*" && month === "*" && /^\d$/.test(dayOfWeek)) {
        const dayIndex = Number.parseInt(dayOfWeek, 10) % 7;
        const dayName = DAY_NAMES[dayIndex];
        if (dayName) return `Every ${dayName} at ${formatLocalTime(m, h)}`;
    }
    if (dayOfMonth === "*" && month === "*" && dayOfWeek === "1-5") {
        return `Weekdays at ${formatLocalTime(m, h)}`;
    }
    return cron;
}

// ─── Jitter (ported from claude src/utils/cronTasks.ts) ───────────

/** id is 8-hex (first char a–f); non-hex ids (hand-edited files) → 0. */
function jitterFrac(taskId: string): number {
    const frac = Number.parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000;
    return Number.isFinite(frac) ? frac : 0;
}

/**
 * Recurring: fire at t1 plus a deterministic per-task delay proportional
 * to the gap between fires (10%, cap 15m) — spreads the herd off :00.
 */
export function jitteredNextCronRunMs(
    cron: string,
    fromMs: number,
    taskId: string,
): number | null {
    const t1 = nextCronRunMs(cron, fromMs);
    if (t1 === null) return null;
    const t2 = nextCronRunMs(cron, t1);
    if (t2 === null) return t1;
    const jitter = Math.min(
        jitterFrac(taskId) * JITTER.recurringFrac * (t2 - t1),
        JITTER.recurringCapMs,
    );
    return t1 + jitter;
}

/**
 * One-shot: fire UP TO 90s EARLY when the computed time lands on a
 * :00/:30 local minute (humans round to the half-hour). Anchor is
 * createdAt, and the result is clamped to fromMs so a task created inside
 * its own lead window never fires before it existed.
 */
export function oneShotJitteredNextCronRunMs(
    cron: string,
    fromMs: number,
    taskId: string,
): number | null {
    const t1 = nextCronRunMs(cron, fromMs);
    if (t1 === null) return null;
    if (new Date(t1).getMinutes() % JITTER.oneShotMinuteMod !== 0) return t1;
    const lead =
        JITTER.oneShotFloorMs +
        jitterFrac(taskId) * (JITTER.oneShotMaxMs - JITTER.oneShotFloorMs);
    return Math.max(t1 - lead, fromMs);
}

/** A task is "missed" when its first scheduled run (from createdAt) is past. */
export function findMissedTasks(tasks: StoredTask[], nowMs: number): StoredTask[] {
    return tasks.filter((t) => {
        if (t.recurring) return false;
        const next = nextCronRunMs(t.cron, t.createdAt);
        return next !== null && next < nowMs;
    });
}

// ─── Task file IO (tolerant read, verified atomic write) ──────────

function isStoredTask(value: unknown): value is StoredTask {
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

type ReadResult = {
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
export async function readTaskFile(): Promise<ReadResult> {
    let raw: string;
    try {
        raw = await readFile(tasksFilePath(), "utf8");
    } catch (error) {
        if (errnoCode(error) === "ENOENT") return { valid: [], rest: [] };
        throw new Error(`cannot read ${tasksFilePath()}: ${messageOf(error)}`, {
            cause: error,
        });
    }
    let parsed: { version?: unknown; tasks?: unknown };
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`${tasksFilePath()} is corrupt JSON: ${messageOf(error)}`, {
            cause: error,
        });
    }
    if (!parsed || !Array.isArray(parsed.tasks)) {
        throw new Error(`${tasksFilePath()} is malformed: 'tasks' is not an array`);
    }
    const valid: StoredTask[] = [];
    const rest: unknown[] = [];
    for (const entry of parsed.tasks) {
        if (isStoredTask(entry)) {
            valid.push(entry);
            continue;
        }
        const converted = legacyToStored(entry as Record<string, unknown>);
        if (converted) valid.push(converted);
        else rest.push(entry);
    }
    return { valid, rest };
}

/** Atomic write: unique temp name (pid + random — two processes sharing a
 * fixed .tmp would rename onto each other's half-written file), then rename. */
async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
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
    mutator: (tasks: StoredTask[], rest: unknown[]) => void,
): Promise<boolean> {
    return withFileMutationQueue(tasksFilePath(), async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
            const { valid, rest } = await readTaskFile();
            mutator(valid, rest);
            const payload: LoopFile = { version: 2, tasks: [...valid, ...rest] };
            const contents = `${JSON.stringify(payload, null, 2)}\n`;
            await atomicWriteFile(tasksFilePath(), contents);
            try {
                if ((await readFile(tasksFilePath(), "utf8")) === contents) return true;
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

// ─── Owner lease (identity lock; PID liveness decides) ────────────

async function readOwnerLock(): Promise<OwnerLock | undefined> {
    try {
        const raw = await readFile(lockFilePath(), "utf8");
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
 * Acquire or confirm the scheduler owner lease.
 *   ① lock already ours (same sessionId — the /reload path, where the file
 *     still names this process's pid under the previous module evaluation)
 *     → true, rewriting the pid if the module restarted under a new one;
 *   ② another LIVE pid → false (probe again in 5s);
 *   ③ dead pid → unlink and re-create;
 *   ④ corrupt file → mtime-guarded unlink and re-create (the heartbeat
 *     keeps a live owner's mtime fresh, so a live owner is never stolen;
 *     mtime is ONLY consulted here, never on a parseable lock).
 */
/**
 * Acquire or confirm the scheduler owner lease.
 *   ① lock already ours (same sessionId after /reload, or the file names
 *     THIS process's pid after a same-process session replacement) → true,
 *     rewriting the payload to the current sessionId + live pid;
 *   ② another LIVE pid → false (probe again in 5s);
 *   ③ dead pid → unlink and re-create;
 *   ④ corrupt file → mtime-guarded unlink and re-create (the heartbeat
 *     keeps a live owner's mtime fresh, so a live owner is never stolen;
 *     mtime is ONLY consulted here, never on a parseable lock).
 */
/** Exported for lease tests: same-process re-acquire / foreign-pid guard. */
export async function tryAcquireOwnerLock(): Promise<boolean> {
    const sessionId = currentSessionId();
    const writeExclusive = async (): Promise<boolean> => {
        try {
            await mkdir(path.dirname(lockFilePath()), { recursive: true });
            await writeFile(
                lockFilePath(),
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

    const adopt = (): true => {
        isOwner = true;
        lockErrorNotified = false;
        startHeartbeat();
        return true;
    };

    try {
        if (await writeExclusive()) return adopt();
    } catch (error) {
        reportLockError(error);
        return false;
    }

    const existing = await readOwnerLock();
    if (existing && (existing.sessionId === sessionId || existing.pid === process.pid)) {
        // Idempotent re-acquire. Covers both: /reload (same session id,
        // possibly a new pid after module re-evaluation) AND same-process
        // session replacement (/new, /fork, switch — the shutdown release
        // may have failed, leaving the file naming OUR live pid under the
        // previous session id). Rewrite the payload so other sessions see
        // the current session id plus a live pid and don't steal it.
        await atomicWriteFile(
            lockFilePath(),
            `${JSON.stringify({ sessionId, pid: process.pid, acquiredAt: existing.acquiredAt })}\n`,
        ).catch(() => {});
        return adopt();
    }

    if (existing && processAlive(existing.pid)) return false;

    if (!existing) {
        // Corrupt/missing since the wx failure: steal only if the mtime is
        // stale (a live owner's heartbeat refreshes it every 15s).
        try {
            const info = await stat(lockFilePath());
            if (Date.now() - info.mtimeMs < CORRUPT_LOCK_LIVE_MS) return false;
        } catch {
            return false; // vanished between wx and stat: retry next probe
        }
    }

    await unlink(lockFilePath()).catch(() => {});
    try {
        if (await writeExclusive()) return adopt();
    } catch (error) {
        reportLockError(error);
    }
    return false; // another session won the recovery race
}
function releaseOwnerLock(): void {
    stopHeartbeat();
    // Snapshot synchronously: session_shutdown clears cachedCtx around this
    // call, and currentSessionId() degrades to the pid string once it has.
    const sessionId = currentSessionId();
    void (async () => {
        try {
            const existing = await readOwnerLock();
            // A stolen lock must not be deleted by us.
            if (
                !existing ||
                (existing.sessionId !== sessionId && existing.pid !== process.pid)
            ) {
                return;
            }
            await unlink(lockFilePath());
        } catch {
            // already gone
        }
    })();
}

/** Surface lock-write failures once per process (the probe re-runs every
 * 5s); a read-only repo or full disk must not masquerade as "held". */
function reportLockError(error: unknown): void {
    console.error("[loop] owner lock write failed:", error);
    if (lockErrorNotified) return;
    lockErrorNotified = true;
    safeNotify(
        cachedCtx,
        `[loop] cannot write owner lock (${messageOf(error)}); durable scheduling paused`,
        "error",
    );
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
    const removed = await mutateTaskFile((tasks) => {
        for (let i = tasks.length - 1; i >= 0; i--) {
            if (missed.some((m) => m.id === tasks[i].id)) tasks.splice(i, 1);
        }
    }).catch((error) => {
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

function computeEntry(task: StoredTask): {
    cron: string;
    anchor: number;
    next: number;
} {
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
            // Recurring fire whose injection failed: the reschedule stands
            // (retrying each tick would hot-loop); the task fires again at
            // its next cron match.
        } else if (isSession) {
            // One-shot (or aged) session task: synchronous memory removal.
            if (fired) {
                sessionTasks.delete(task.id);
                nextFireAt.delete(task.id);
            }
            // Injection failed: keep it due so the next tick retries.
        } else if (fired) {
            // One-shot (or aged) durable task: inject FIRST, then delete.
            // If the delete fails the task survives on disk for the next
            // tick (inFlight holds until the write settles); a crash
            // between inject and delete can re-run it once — accepted
            // (claude parity).
            inFlight.add(task.id);
            nextFireAt.delete(task.id);
            void mutateTaskFile((tasks) => {
                const index = tasks.findIndex((t) => t.id === task.id);
                if (index >= 0) tasks.splice(index, 1);
            })
                .catch((error) => {
                    console.error(
                        `[loop] failed to remove fired task ${task.id}: ${messageOf(error)}`,
                    );
                })
                .finally(() => inFlight.delete(task.id));
        } else {
            // Durable one-shot whose injection failed: the task stays on
            // disk and the next tick retries the injection (v5 ordering
            // rationale: never delete what was never delivered).
        }
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

    if (seen.size === 0) {
        nextFireAt.clear();
        return;
    }
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

// ─── v1 → v2 migration ────────────────────────────────────────────

/**
 * session_start: if the task file is not version 2, rewrite it as v2
 * (cron was already the display truth for the three legacy templates;
 * recurring lastFiredAt stamps to now to avoid a migrated-fire stampede).
 * Correctness comes from version checking + content idempotence, not from
 * a cross-process queue: two windows may each migrate once and the last
 * write wins — the result is still a valid v2 file with the same tasks.
 */
export async function migrateTaskFile(): Promise<void> {
    let raw: string;
    try {
        raw = await readFile(tasksFilePath(), "utf8");
    } catch (error) {
        if (errnoCode(error) === "ENOENT") return;
        throw error;
    }
    let parsed: { version?: unknown; tasks?: unknown };
    try {
        parsed = JSON.parse(raw);
    } catch {
        return; // corrupt: leave it; readTaskFile/mutate will fail loudly
    }
    if (parsed?.version === 2) return;
    const { valid, rest } = await readTaskFile();
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
    await atomicWriteFile(tasksFilePath(), `${JSON.stringify(payload, null, 2)}\n`);
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

// ─── Renderer formatters (pure, testable) ─────────────────────────
//
// How the three tools draw in the interactive transcript (and HTML
// exports). Same shape as the built-in tools: format* returns a
// styled string, thin render* closures reuse the last component.
//
// Rules (mirroring read/bash renderers):
// - never throw: a renderer exception is silently swallowed by the
//   TUI and falls back to the raw JSON args line;
// - no fs, no module state, no relative times ("in 3m"): rows are
//   snapshots re-rendered on every repaint, session reloads, and
//   HTML exports (which also render at fixed width 100);
// - read everything from the tool call's args (typed, may be partial
//   while streaming) and the structured `details` set by execute() —
//   details ride along with the result through session storage but
//   are never sent to the model.

export interface LoopCreateDetails {
    id: string;
    cron: string;
    recurring: boolean;
    durable: boolean;
    /** Jittered first fire (epoch ms); null when the cron matches nothing. */
    nextFireAt: number | null;
}

interface LoopListJob {
    id: string;
    cron: string;
    recurring: boolean;
    durable: boolean;
    prompt: string;
    createdAt: number;
}

export interface LoopListDetails {
    jobs: LoopListJob[];
}

interface LoopDeleteDetails {
    id: string;
    scope: "session" | "durable";
}

type RenderArgs = {
    cron?: unknown;
    prompt?: unknown;
    recurring?: unknown;
    durable?: unknown;
    id?: unknown;
};

type RenderContent = { type?: unknown; text?: unknown };

interface RenderResult {
    content: RenderContent[];
    details?: unknown;
}

interface RenderChecks {
    args?: RenderArgs;
    argsComplete: boolean;
    isError: boolean;
    lastComponent?: Component;
}

/** Neutralize a model-controlled string (cron, id) for row output: any
 *  terminal-control sequences the model emits must not reach the UI. */
function cleanToken(text: unknown): string {
    return typeof text === "string" ? stripTerminalSequences(text) : "";
}

function asArgs(args: RenderArgs | undefined | null): RenderArgs {
    return typeof args === "object" && args !== null ? args : {};
}

function resultTextOf(result: RenderResult): string {
    return Array.isArray(result?.content)
        ? result.content
              .filter((block) => block.type === "text" && typeof block.text === "string")
              .map((block) => block.text as string)
              .join("\n")
        : "";
}

/** Reuse the previously returned component (built-in renderer pattern). */
function reuseText(last: Component | undefined): Text {
    return last instanceof Text ? last : new Text("", 0, 0);
}

/** One safe display line: sequences stripped, whitespace folded, width-capped. */
function oneLine(text: string, maxWidth: number): string {
    const clean = stripTerminalSequences(typeof text === "string" ? text : "").replace(/\s+/g, " ").trim();
    return truncateToWidth(clean, Math.max(1, maxWidth), "…");
}

/** Truncate to width then pad to width (counting display cells, CJK-safe). */
function padTo(text: string, width: number): string {
    const capped = truncateToWidth(text, width);
    return capped + " ".repeat(Math.max(0, width - visibleWidth(capped)));
}

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Absolute wall-clock label for an epoch stamp, never a relative
 * "in 3m" (which would be wrong the next time the row repaints).
 */
function formatFireTime(ms: number, nowMs: number): string {
    const at = new Date(ms);
    const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    if (at.toDateString() === new Date(nowMs).toDateString()) return `~${time}`;
    if (nowMs - ms < 6 * 86_400_000) {
        return `~${WEEKDAYS_SHORT[at.getDay()] ?? "?"} ${time}`;
    }
    const pad = (n: number) => String(n).padStart(2, "0");
    return `~${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

function formatCreatedStamp(ms: number): string {
    return new Date(ms).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

/**
 * Human schedule at render time: cronToHuman falls back to the raw
 * expression when it cannot make it friendly — don't echo it twice.
 */
function scheduleLabel(cron: string): string {
    const trimmed = cron.trim();
    const human = cronToHuman(trimmed);
    return human === trimmed ? trimmed : human;
}

/**
 * Error rows: one truncated line collapsed, the full message expanded.
 * No glyph: a rendered result row only ever exists when something
 * failed, and the toolErrorBg/toolError colors already carry that.
 */
function errorBody(text: string, expanded: boolean, theme: Theme): string {
    const clean = stripTerminalSequences(text ?? "").trim() || "failed";
    return theme.fg("error", expanded ? clean : oneLine(clean, 96));
}

/**
 * Rows without usable details (results recorded before this change,
 * aborted calls, anything hook-rewritten): show the content text as-is.
 */
function legacyBody(text: string, expanded: boolean, theme: Theme): string {
    const clean = stripTerminalSequences(text ?? "").trim();
    if (!clean) return theme.fg("dim", "(no output)");
    if (!expanded) return theme.fg("dim", oneLine(clean.split("\n")[0] ?? clean, 96));
    return theme.fg("toolOutput", stripTerminalSequences(clean));
}

function keyRow(label: string, value: string, theme: Theme): string {
    return theme.fg("dim", `   ${label.padEnd(9)}`) + theme.fg("toolOutput", value);
}

function promptLines(prompt: unknown): string[] {
    if (typeof prompt !== "string") return ["(unknown)"];
    const clean = stripTerminalSequences(prompt).trim();
    return clean ? clean.split(/\r?\n/) : ["(empty)"];
}

export function formatCreateCall(
    args: RenderArgs,
    theme: Theme,
    argsComplete: boolean,
): string {
    const safe = asArgs(args);
    const cron = cleanToken(safe.cron).trim();
    const prompt = typeof safe.prompt === "string" ? oneLine(safe.prompt, 44) : "";
    let text = theme.fg("toolTitle", theme.bold("loop_create "));
    if (argsComplete && cron) {
        // Only humanize complete, parseable args; a half-streamed or
        // invalid cron stays raw.
        text += parseCronExpression(cron)
            ? theme.fg("accent", scheduleLabel(cron))
            : theme.fg("dim", cron);
    } else if (cron) {
        text += theme.fg("dim", cron);
    } else {
        text += theme.fg("dim", "…");
    }
    if (prompt) {
        text += " " + theme.fg(argsComplete ? "muted" : "dim", `"${prompt}"`);
    }
    return text;
}

function asCreateDetails(value: unknown): LoopCreateDetails | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const v = value as Record<string, unknown>;
    if (typeof v.id !== "string" || !v.id || typeof v.cron !== "string" || !v.cron) {
        return undefined;
    }
    return {
        id: v.id,
        cron: v.cron,
        recurring: v.recurring !== false,
        durable: v.durable === true,
        nextFireAt: typeof v.nextFireAt === "number" ? v.nextFireAt : null,
    };
}

export function formatCreateResult(
    args: RenderArgs,
    details: LoopCreateDetails | undefined,
    result: RenderResult,
    options: { expanded: boolean },
    theme: Theme,
    isError: boolean,
): string {
    if (isError) return errorBody(resultTextOf(result), options.expanded, theme);
    if (!details) return legacyBody(resultTextOf(result), options.expanded, theme);

    let head =
        theme.fg("toolOutput", details.id) +
        theme.fg(
            "muted",
            ` · ${details.recurring ? "recurring" : "one-shot"} · ${details.durable ? "durable" : "session"}`,
        );
    if (details.nextFireAt !== null && Number.isFinite(details.nextFireAt)) {
        head += theme.fg("muted", ` · first fire ${formatFireTime(details.nextFireAt, Date.now())}`);
    }
    const lines = [head];
    if (options.expanded) {
        lines.push(keyRow("cron", cleanToken(details.cron), theme));
        lines.push(
            keyRow(
                "storage",
                details.durable
                    ? "durable — persisted to .pi/loop-tasks.json"
                    : "session — in memory, dies when this session exits",
                theme,
            ),
        );
        lines.push(
            keyRow(
                "expiry",
                details.recurring ? "auto-expires after 7 days" : "fires once, then auto-deletes",
                theme,
            ),
        );
        promptLines(asArgs(args).prompt).forEach((line, index) => {
            lines.push(index === 0 ? keyRow("prompt", line, theme) : `            ${line}`);
        });
    }
    return lines.join("\n");
}

export function formatDeleteCall(
    args: RenderArgs,
    theme: Theme,
    argsComplete: boolean,
): string {
    const id = cleanToken(asArgs(args).id).trim();
    let text = theme.fg("toolTitle", theme.bold("loop_delete "));
    text += id
        ? theme.fg(argsComplete ? "toolOutput" : "dim", id)
        : theme.fg("dim", "…");
    return text;
}

function asDeleteDetails(value: unknown): LoopDeleteDetails | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const v = value as Record<string, unknown>;
    if (typeof v.id !== "string" || !v.id) return undefined;
    return { id: v.id, scope: v.scope === "durable" ? "durable" : "session" };
}

export function formatDeleteResult(
    details: LoopDeleteDetails | undefined,
    result: RenderResult,
    options: { expanded: boolean },
    theme: Theme,
    isError: boolean,
): string {
    if (isError) return errorBody(resultTextOf(result), options.expanded, theme);
    if (!details) return legacyBody(resultTextOf(result), options.expanded, theme);
    // Success: the call row already says everything (`loop_delete <id>`)
    // and "Cancelled job <id>." adds nothing — hide the result entirely,
    // collapsed and expanded alike (like the write tool).
    return "";
}

/** List schedule text: mirror loop_list's model-facing "invalid cron" wording. */
function listScheduleOf(cron: string): string {
    return parseCronExpression(cron) ? cronToHuman(cron.trim()) : "invalid cron";
}

const LIST_COLUMN = { id: 10, schedule: 21, recurrence: 11, scope: 9 };

function formatListRow(job: LoopListJob, theme: Theme, promptWidth: number): string {
    return (
        theme.fg("toolOutput", padTo(cleanToken(job.id), LIST_COLUMN.id)) +
        theme.fg("accent", padTo(listScheduleOf(cleanToken(job.cron)), LIST_COLUMN.schedule)) +
        theme.fg(
            "muted",
            padTo(job.recurring ? "recurring" : "one-shot", LIST_COLUMN.recurrence) +
                padTo(job.durable ? "durable" : "session", LIST_COLUMN.scope),
        ) +
        theme.fg("dim", `"${oneLine(job.prompt, promptWidth)}"`)
    );
}

function formatListDetailLine(job: LoopListJob, theme: Theme): string {
    const created = Number.isFinite(job.createdAt)
        ? ` · created ${formatCreatedStamp(job.createdAt)}`
        : "";
    const detail = `cron ${cleanToken(job.cron)}${created} · fires while session idle`;
    return theme.fg("dim", "          " + truncateToWidth(detail, 86, "…"));
}

function asListDetails(value: unknown): LoopListDetails | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const v = value as Record<string, unknown>;
    if (!Array.isArray(v.jobs)) return undefined;
    return {
        jobs: v.jobs.flatMap((raw) => {
            // Renderer inputs must be fully shaped: pi re-feeds persisted
            // details from unvalidated session files (HTML export included),
            // so every field the row reads is coerced here.
            if (typeof raw !== "object" || raw === null) return [];
            const job = raw as Record<string, unknown>;
            if (typeof job.id !== "string" || !job.id) return [];
            if (typeof job.cron !== "string" || !job.cron) return [];
            return [
                {
                    id: job.id,
                    cron: job.cron,
                    recurring: job.recurring !== false,
                    durable: job.durable === true,
                    prompt: typeof job.prompt === "string" ? job.prompt : "",
                    createdAt: typeof job.createdAt === "number" ? job.createdAt : NaN,
                } satisfies LoopListJob,
            ];
        }),
    };
}

/** Expansion hint respects user keybindings; falls back if the theme
 *  subsystem is not initialized (renderer must never throw). */
function expandHint(): string {
    try {
        return keyHint("app.tools.expand", "to expand");
    } catch {
        return "ctrl+e to expand";
    }
}

export function formatListResult(
    details: LoopListDetails | undefined,
    result: RenderResult,
    options: { expanded: boolean },
    theme: Theme,
    isError: boolean,
): string {
    if (isError) return errorBody(resultTextOf(result), options.expanded, theme);
    if (!details) return legacyBody(resultTextOf(result), options.expanded, theme);
    const jobs = details.jobs.filter(
        (job) => typeof job.id === "string" && typeof job.cron === "string",
    );
    if (jobs.length === 0) return theme.fg("dim", "no scheduled jobs");

    const durableCount = jobs.filter((job) => job.durable === true).length;
    const lines = [
        theme.fg("toolOutput", `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}`) +
            theme.fg(
                "muted",
                ` · ${durableCount} durable · ${jobs.length - durableCount} session`,
            ),
    ];
    // Fixed columns total 51 cells; quotes add 2. Keep the whole row within
    // the HTML export's fixed 100-column budget in either mode.
    const promptWidth = options.expanded ? 46 : 43;
    if (options.expanded) {
        for (const job of jobs) {
            lines.push(formatListRow(job, theme, promptWidth));
            lines.push(formatListDetailLine(job, theme));
        }
    } else {
        const shown = jobs.slice(0, 5);
        for (const job of shown) lines.push(formatListRow(job, theme, promptWidth));
        if (jobs.length > shown.length) {
            lines.push(
                theme.fg("muted", `… ${jobs.length - shown.length} more jobs · `) +
                    expandHint(),
            );
        }
    }
    return lines.join("\n");
}

const loopCreateRenderers = {
    renderCall(args: RenderArgs, theme: Theme, context: RenderChecks) {
        const component = reuseText(context.lastComponent);
        component.setText(formatCreateCall(asArgs(args), theme, context.argsComplete));
        return component;
    },
    renderResult(
        result: RenderResult,
        options: { expanded: boolean; isPartial: boolean },
        theme: Theme,
        context: RenderChecks,
    ) {
        const component = reuseText(context.lastComponent);
        component.setText(
            formatCreateResult(
                context.args ?? {},
                asCreateDetails(result.details),
                result,
                options,
                theme,
                context.isError,
            ),
        );
        return component;
    },
};

const loopDeleteRenderers = {
    renderCall(args: RenderArgs, theme: Theme, context: RenderChecks) {
        const component = reuseText(context.lastComponent);
        component.setText(formatDeleteCall(asArgs(args), theme, context.argsComplete));
        return component;
    },
    renderResult(
        result: RenderResult,
        options: { expanded: boolean; isPartial: boolean },
        theme: Theme,
        context: RenderChecks,
    ) {
        const component = reuseText(context.lastComponent);
        component.setText(
            formatDeleteResult(asDeleteDetails(result.details), result, options, theme, context.isError),
        );
        return component;
    },
};

const loopListRenderers = {
    renderCall(_args: RenderArgs, theme: Theme, context: RenderChecks) {
        const component = reuseText(context.lastComponent);
        const title = theme.fg("toolTitle", theme.bold("loop_list "));
        component.setText(context.argsComplete ? title : title + theme.fg("dim", "…"));
        return component;
    },
    renderResult(
        result: RenderResult,
        options: { expanded: boolean; isPartial: boolean },
        theme: Theme,
        context: RenderChecks,
    ) {
        const component = reuseText(context.lastComponent);
        component.setText(
            formatListResult(asListDetails(result.details), result, options, theme, context.isError),
        );
        return component;
    },
};

// ─── Extension registration ───────────────────────────────────────

export default function (pi: ExtensionAPI) {
    // Background-task children auto-discover this extension too (~/.pi is a
    // symlink into this repo); a task runner session must not drive the
    // scheduler or inject prompts into its own throwaway session.
    if (process.env.PI_BACKGROUND_TASK_CHILD === "1") return;

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

            const nextFireAt =
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
                    nextFireAt,
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
            const jobs: LoopListJob[] = [];
            let fileTasks: StoredTask[];
            try {
                fileTasks = (await readTaskFile()).valid;
            } catch (error) {
                throw new Error(`loop task file error: ${messageOf(error)}`);
            }
            for (const task of fileTasks) {
                jobs.push({
                    id: task.id,
                    cron: task.cron,
                    recurring: task.recurring ?? false,
                    durable: true,
                    // Details ride in the session/HTML export forever; cap
                    // at the same preview the model-facing line uses.
                    prompt: truncate80(task.prompt),
                    createdAt: task.createdAt,
                });
            }
            for (const task of sessionTasks.values()) {
                jobs.push({
                    id: task.id,
                    cron: task.cron,
                    recurring: task.recurring ?? false,
                    durable: false,
                    prompt: truncate80(task.prompt),
                    createdAt: task.createdAt,
                });
            }
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
            // touch the disk (claude validateInput parity).
            // Snapshot where the job lived before any removal, so the
            // renderer can show "cancelled · session|durable".
            let scope: LoopDeleteDetails["scope"] = sessionTasks.has(id)
                ? "session"
                : "durable";
            let exists = sessionTasks.has(id);
            if (!exists) {
                try {
                    exists = (await readTaskFile()).valid.some((t) => t.id === id);
                } catch (error) {
                    throw new Error(`loop task file error: ${messageOf(error)}`);
                }
            }
            if (!exists) throw new Error(`No scheduled job with id '${id}'.`);

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
                const removed = await mutateTaskFile((tasks) => {
                    const index = tasks.findIndex((task) => task.id === id);
                    if (index >= 0) tasks.splice(index, 1);
                }).catch((error) => {
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

/** Point the module at a scratch repo root and clear scheduler state. */
export function __testAddSessionTask(task: StoredTask): void {
    sessionTasks.set(task.id, { ...task });
}

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
