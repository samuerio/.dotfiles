/**
 * schedule run plumbing: run directories, the metadata state machine, the pi
 * launch line, timeout + signal escalation, effective-state derivation, and
 * session-JSONL result reading.
 *
 * pi-free on purpose (only node built-ins): the `schedule` CLI is executed by
 * plain `node`, which cannot resolve `@earendil-works/*`.
 *
 * One run = one directory `<agentDir>/schedule/runs/<taskId>/<ts>/` holding
 *
 *   prompt.md      snapshot of the prompt, also the `@file` input for pi
 *   session.jsonl  pre-created empty file, passed as `--session <path>`
 *   metadata.json  run metadata (state machine below)
 *   output.log     stdout+stderr, streamed through a raw fd
 *
 * Metadata state machine (see the plan's decision 15):
 *
 *   starting ──spawn ok──▶ running ──exit──▶ exited
 *      │                     │
 *      │                     └──timeout──▶ killed (terminal)
 *      └──spawn error──▶ error
 *
 * `state` on disk is a *claim*: occupancy is decided by `effectiveState()`,
 * which also catches a dead helper (`orphan`) and a stale `starting` record.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
    atomicWriteJson,
    ensureDir,
    errorMessage,
    listRunStamps,
    readJsonFile,
    runDir as runDirOf,
    taskRunsDir,
    validateRunStamp,
    validateTaskId,
} from "./store.ts";
import { routeFlags, type ModelRoute } from "./routing.ts";

/** Wall-clock ceiling for one run. Override with PI_SCHEDULE_TEST_TIMEOUT_MS. */
export const RUN_TIMEOUT_MS = 30 * 60 * 1000;
/** Grace between SIGTERM and SIGKILL. Override with PI_SCHEDULE_TEST_GRACE_MS. */
export const KILL_GRACE_MS = 10 * 1000;
/** A `starting` record older than this is stale. Override with PI_SCHEDULE_TEST_STALE_MS. */
export const STALE_START_MS = 60 * 1000;
/** Last-resort wait after SIGKILL; if the child still does not reap, give up. */
const POST_KILL_WAIT_MS = 5 * 1000;

/** pi is resolved from PATH; tests substitute a script through this env. */
const PI_BIN_ENV = "PI_SCHEDULE_PI_BIN";
/** Injected into the child so this extension can no-op in headless runs. */
const CHILD_GUARD_ENV = "PI_SCHEDULE_RUN_DIR";

export type RunState = "starting" | "running" | "exited" | "killed" | "error";

/**
 * Derived occupancy state. `starting`/`running`/`orphan` are active (they hold
 * the task); `stale` means the record claims to be alive but is not.
 */
export type EffectiveState =
    | "starting"
    | "running"
    | "orphan"
    | "stale"
    | "exited"
    | "killed"
    | "error";

export type RunTrigger = "scheduled" | "manual";

export interface RunMetadata {
    version: 1;
    taskId: string;
    trigger: RunTrigger;
    state: RunState;
    pid?: number;
    /** Process-group id; equals `pid` for detached runs, null when foreground. */
    pgid?: number | null;
    /** `/proc/<pid>/stat` field 22 — defeat pid reuse. */
    pidStartTime?: number;
    /** pid of the supervising helper; null when the caller supervises in-process. */
    helperPid?: number | null;
    startedAt: string;
    finishedAt?: string;
    killedAt?: string;
    exitCode?: number | null;
    signal?: string | null;
    sessionFile: string;
    cwd: string;
    launchArgs: string[];
    /** Resolved `roles.subagents` pin; absent when the run used pi's default. */
    modelRoute?: ModelRoute;
    error?: string;
}

export interface ExecuteRunOptions {
    taskId: string;
    stamp: string;
    trigger: RunTrigger;
    /** Foreground runs share the caller's process group and stdio. */
    foreground: boolean;
    cwd: string;
    promptText: string;
    /** Model pin resolved from modes.json; omitted → pi's configured default. */
    route?: ModelRoute;
    /** Extra environment for the child (merged over process.env). */
    env?: Record<string, string>;
}

export interface RunSummary {
    metadata: RunMetadata | undefined;
    effective: EffectiveState;
    lastAssistant: string | undefined;
}

export interface ActiveRun {
    dir: string;
    ts: string;
    metadata: RunMetadata;
    effective: EffectiveState;
}

// ---------------------------------------------------------------------------
// Tunables (env overrides keep the tests fast without touching the clock)
// ---------------------------------------------------------------------------

function numberFromEnv(name: string): number | undefined {
    const raw = process.env[name];
    if (raw === undefined || raw.length === 0) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function runTimeoutMs(): number {
    return numberFromEnv("PI_SCHEDULE_TEST_TIMEOUT_MS") ?? RUN_TIMEOUT_MS;
}

export function killGraceMs(): number {
    return numberFromEnv("PI_SCHEDULE_TEST_GRACE_MS") ?? KILL_GRACE_MS;
}

export function staleStartMs(): number {
    return numberFromEnv("PI_SCHEDULE_TEST_STALE_MS") ?? STALE_START_MS;
}

export function piBinary(): string {
    const fromEnv = process.env[PI_BIN_ENV];
    return fromEnv && fromEnv.length > 0 ? fromEnv : "pi";
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function metadataPath(dir: string): string {
    return join(dir, "metadata.json");
}

export function promptPath(dir: string): string {
    return join(dir, "prompt.md");
}

export function sessionPath(dir: string): string {
    return join(dir, "session.jsonl");
}

export function outputLogPath(dir: string): string {
    return join(dir, "output.log");
}

/**
 * Claim a run slot. The non-recursive `mkdir` is the atomic claim: two ticks in
 * the same second cannot both win (`EEXIST` for the loser).
 */
export function claimRun(taskId: string, stamp: string): string {
    if (!validateTaskId(taskId)) throw new Error(`invalid task id: ${taskId}`);
    if (!validateRunStamp(stamp)) throw new Error(`invalid run stamp: ${stamp}`);
    ensureDir(taskRunsDir(taskId));
    const dir = runDirOf(taskId, stamp);
    mkdirSync(dir, { mode: 0o700 });
    return dir;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

const RUN_STATES: readonly string[] = ["starting", "running", "exited", "killed", "error"];

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function parseMetadata(value: unknown): RunMetadata | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const metadata = value as Partial<RunMetadata>;
    if (metadata.version !== 1) return undefined;
    if (!isString(metadata.taskId) || !validateTaskId(metadata.taskId)) return undefined;
    if (metadata.trigger !== "scheduled" && metadata.trigger !== "manual") return undefined;
    if (!isString(metadata.state) || !RUN_STATES.includes(metadata.state)) return undefined;
    if (!isString(metadata.startedAt)) return undefined;
    if (!isString(metadata.sessionFile)) return undefined;
    if (!isString(metadata.cwd)) return undefined;
    if (!Array.isArray(metadata.launchArgs)) return undefined;
    return metadata as RunMetadata;
}

export function readMetadata(dir: string): RunMetadata | undefined {
    return parseMetadata(readJsonFile(metadataPath(dir)));
}

export function writeMetadata(dir: string, metadata: RunMetadata): void {
    atomicWriteJson(metadataPath(dir), metadata);
}

/**
 * Read-modify-write one metadata document. Whole-document writes with a rename
 * mean the worst case is a lost update, never a torn file.
 */
export function patchMetadata(dir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
    const current = readMetadata(dir);
    if (!current) return undefined;
    const next: RunMetadata = {
        ...current,
        ...patch,
        version: 1,
        taskId: current.taskId,
    };
    writeMetadata(dir, next);
    return next;
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

const HAS_PROC = existsSync("/proc/self/stat");

/**
 * Parse `/proc/<pid>/stat`. Field 3 is `comm` and may contain spaces and
 * parentheses, so split on the *last* `)`; field 22 (starttime) then lives at
 * index 19 of the remainder.
 */
export function parseProcStatStartTime(raw: string): number | undefined {
    const close = raw.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    const starttime = Number(fields[19]);
    return Number.isFinite(starttime) && fields[19] !== undefined ? starttime : undefined;
}

export function readPidStartTime(pid: number): number | undefined {
    if (!HAS_PROC) return undefined;
    let raw: string;
    try {
        raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
        return undefined;
    }
    return parseProcStatStartTime(raw);
}

export function processAlive(pid: number | undefined | null, expectedStartTime?: number): boolean {
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
    if (HAS_PROC) {
        const actual = readPidStartTime(pid);
        if (actual === undefined) return false;
        if (expectedStartTime !== undefined && actual !== expectedStartTime) return false;
        return true;
    }
    // Non-Linux POSIX: no starttime available, signal 0 is the best we can do.
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Occupancy verdict for one metadata document. Everything that decides "is this
 * task busy" must go through here, not through the raw `state` field.
 */
export function effectiveState(metadata: RunMetadata, now: Date = new Date()): EffectiveState {
    if (metadata.state === "starting") {
        const started = Date.parse(metadata.startedAt);
        if (!Number.isFinite(started)) return "stale";
        return now.getTime() - started < staleStartMs() ? "starting" : "stale";
    }
    if (metadata.state === "running") {
        if (!processAlive(metadata.pid, metadata.pidStartTime)) return "stale";
        // `helperPid` is present for detached *and* foreground runs; null only
        // for records written before this field existed.
        if (metadata.helperPid === null || metadata.helperPid === undefined) return "running";
        return processAlive(metadata.helperPid) ? "running" : "orphan";
    }
    return metadata.state;
}

export function isActive(state: EffectiveState): boolean {
    return state === "starting" || state === "running" || state === "orphan";
}

function readRun(taskId: string, ts: string): ActiveRun | undefined {
    const dir = runDirOf(taskId, ts);
    const metadata = readMetadata(dir);
    if (!metadata) return undefined;
    return { dir, ts, metadata, effective: effectiveState(metadata) };
}

/** All runs of a task, newest first. */
export function listRuns(taskId: string): ActiveRun[] {
    const runs: ActiveRun[] = [];
    for (const ts of listRunStamps(taskId)) {
        const run = readRun(taskId, ts);
        if (run) runs.push(run);
    }
    return runs;
}

/** Newest run of a task, active or not; stops at the first readable record. */
export function latestRun(taskId: string): ActiveRun | undefined {
    for (const ts of listRunStamps(taskId)) {
        const run = readRun(taskId, ts);
        if (run) return run;
    }
    return undefined;
}

/**
 * The newest run that still holds the task. Concurrency is `skip`, and the
 * check covers *every* trigger, so a manual run blocks the scheduler and vice
 * versa.
 */
export function activeRun(taskId: string): ActiveRun | undefined {
    return listRuns(taskId).find((run) => isActive(run.effective));
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/**
 * The one launch line. Foreground and detached runs share it; only the spawn
 * options differ.
 *
 *   pi -p --approve --name schedule:<id> --session <dir>/session.jsonl \
 *      -- @<dir>/prompt.md
 *
 * `@` makes pi read the file (dist/cli/args.js: after `--`, `@`-prefixed
 * positionals become fileArgs), which sidesteps MAX_ARG_STRLEN on long prompts.
 */
export function buildLaunchArgs(options: {
    taskId: string;
    runDir: string;
    /** Resolved `roles.subagents` pin; omitted → pi's configured default. */
    route?: ModelRoute;
}): string[] {
    return [
        "-p",
        "--approve",
        ...routeFlags(options.route),
        "--name",
        `schedule:${options.taskId}`,
        "--session",
        sessionPath(options.runDir),
        "--",
        `@${promptPath(options.runDir)}`,
    ];
}

// ---------------------------------------------------------------------------
// Execute one run
// ---------------------------------------------------------------------------

interface ExitInfo {
    code: number | null;
    signal: string | null;
}

function waitForExit(child: ChildProcess): Promise<ExitInfo> {
    return new Promise<ExitInfo>((resolve) => {
        let settled = false;
        const finish = (info: ExitInfo): void => {
            if (settled) return;
            settled = true;
            resolve(info);
        };
        child.once("exit", (code, signal) => finish({ code, signal }));
        child.once("error", () => finish({ code: null, signal: null }));
    });
}

function withDeadline(promise: Promise<unknown>, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        timer.unref?.();
        void promise.then(() => {
            clearTimeout(timer);
            resolve(true);
        });
    });
}

/**
 * Signal the child. Detached runs get the whole process group (`-pid`) so pi's
 * sub-shell cannot survive; foreground runs must stay pid-only, because they
 * share the caller's group (killing it would take down the user's shell).
 */
function signalChild(child: ChildProcess, signal: NodeJS.Signals, useGroup: boolean): void {
    const pid = child.pid;
    if (useGroup && typeof pid === "number" && pid > 0) {
        try {
            process.kill(-pid, signal);
            return;
        } catch {
            // fall through to the pid-only path
        }
    }
    try {
        child.kill(signal);
    } catch {
        // already gone
    }
}

function exitCodeOf(info: ExitInfo | undefined): number {
    if (!info) return 1;
    if (typeof info.code === "number") return info.code;
    if (info.signal === "SIGTERM" || info.signal === "SIGKILL") return 124;
    return 1;
}

/**
 * Run one claimed slot to completion.
 *
 * Returns the child's exit code (124 when it had to be killed). Never throws for
 * child failures; the failure is recorded in metadata instead.
 */
export async function executeRun(options: ExecuteRunOptions): Promise<number> {
    if (process.platform === "win32") {
        throw new Error("schedule: POSIX only (process-group kill is not available)");
    }
    const dir = runDirOf(options.taskId, options.stamp);

    // 1. Prompt snapshot + pre-created session file: both paths must exist and
    //    be final before the metadata first write, so `logs` never waits.
    writeFileSync(promptPath(dir), options.promptText, { encoding: "utf8", mode: 0o600 });
    if (!existsSync(sessionPath(dir))) {
        writeFileSync(sessionPath(dir), "", { encoding: "utf8", mode: 0o600 });
    }

    const launchArgs = buildLaunchArgs({
        taskId: options.taskId,
        runDir: dir,
        route: options.route,
    });
    const startedAt = new Date().toISOString();

    // 2. Declare occupancy *before* spawning (decision 15): the window between
    //    claim and first metadata write must not look idle to another tick.
    const starting: RunMetadata = {
        version: 1,
        taskId: options.taskId,
        trigger: options.trigger,
        state: "starting",
        startedAt,
        sessionFile: sessionPath(dir),
        cwd: options.cwd,
        launchArgs,
        ...(options.route ? { modelRoute: options.route } : {}),
    };
    writeMetadata(dir, starting);

    // 3. Spawn.
    const useGroup = !options.foreground;
    let child: ChildProcess;
    let logFd: number | undefined;
    try {
        let stdio: "inherit" | Array<number | "ignore">;
        if (options.foreground) {
            stdio = "inherit";
        } else {
            logFd = openSync(outputLogPath(dir), "a");
            stdio = ["ignore", logFd, logFd];
        }
        child = spawn(piBinary(), launchArgs, {
            cwd: options.cwd,
            detached: useGroup,
            stdio,
            env: {
                ...process.env,
                ...(options.env ?? {}),
                [CHILD_GUARD_ENV]: dir,
            },
        });
    } catch (error) {
        if (logFd !== undefined) closeSync(logFd);
        patchMetadata(dir, {
            state: "error",
            error: errorMessage(error),
            finishedAt: new Date().toISOString(),
        });
        return 1;
    }

    const pid = child.pid;
    if (typeof pid !== "number" || pid <= 0) {
        // Swallow the async `error` event (ENOENT &c.); otherwise it surfaces as
        // an uncaught exception in the CLI process.
        child.on("error", () => undefined);
        if (logFd !== undefined) closeSync(logFd);
        patchMetadata(dir, {
            state: "error",
            error: `spawn did not yield a pid (${piBinary()})`,
            finishedAt: new Date().toISOString(),
        });
        return 1;
    }

    // 4. Promote to `running`.
    //    `helperPid` is set for foreground runs too: if this process dies
    //    (Ctrl-C, OOM) while pi keeps running, `effectiveState` must report
    //    `orphan` instead of a forever-`running` ghost.
    patchMetadata(dir, {
        state: "running",
        pid,
        pgid: useGroup ? pid : null,
        pidStartTime: readPidStartTime(pid),
        helperPid: process.pid,
    });

    const exitPromise = waitForExit(child);
    let exitInfo: ExitInfo | undefined;
    void exitPromise.then((info) => {
        exitInfo = info;
    });

    // 5. Timeout. `withDeadline` is the single source of truth; a second timer
    //    of the same length would only race it.
    const timedOut = !await withDeadline(exitPromise, runTimeoutMs());

    if (timedOut) {
        // 6. Declare `killed` first: the scheduler must be free even if the
        //    process is stuck in uninterruptible sleep and ignores SIGKILL.
        patchMetadata(dir, { state: "killed" });
        signalChild(child, "SIGTERM", useGroup);
        const diedQuietly = await withDeadline(exitPromise, killGraceMs());
        if (!diedQuietly) {
            signalChild(child, "SIGKILL", useGroup);
            await withDeadline(exitPromise, POST_KILL_WAIT_MS);
        }
        patchMetadata(dir, { killedAt: new Date().toISOString() });
    }

    if (logFd !== undefined) {
        try {
            closeSync(logFd);
        } catch {
            // best effort
        }
    }

    // 7. Record the outcome. `killed` is terminal: never downgrade it to exited.
    const outcome: Partial<RunMetadata> = {
        finishedAt: new Date().toISOString(),
        exitCode: exitInfo ? exitInfo.code : null,
        signal: exitInfo ? exitInfo.signal : null,
        ...(timedOut ? {} : { state: "exited" as const }),
    };
    patchMetadata(dir, outcome);

    return timedOut ? 124 : exitCodeOf(exitInfo);
}

// Log the SIGTERM-handler contract for future readers: pi's print mode installs
// a SIGTERM handler that kills its tracked detached tool children, which is why
// SIGTERM comes first. Tool grandchildren are NOT in pi's process group
// (dist/core/tools/bash.js spawns every command with `detached: true`), so the
// group kill only reaches pi and its immediate sub-shells.
// ---------------------------------------------------------------------------
// Session JSONL reading
// ---------------------------------------------------------------------------

interface SessionEntry {
    id?: string;
    parentId?: string | null;
    type?: string;
    message?: unknown;
    role?: unknown;
    content?: unknown;
}

function parseLine(line: string): SessionEntry | undefined {
    const trimmed = line.trim();
    if (trimmed.length === 0) return undefined;
    try {
        const value: unknown = JSON.parse(trimmed);
        if (typeof value !== "object" || value === null) return undefined;
        return value as SessionEntry;
    } catch {
        // Torn tail while pi is still appending.
        return undefined;
    }
}

function messageRole(entry: SessionEntry): string | undefined {
    const message = entry.message;
    if (typeof message === "object" && message !== null) {
        const role = (message as { role?: unknown }).role;
        if (typeof role === "string") return role;
    }
    if (typeof entry.role === "string") return entry.role;
    if (entry.type === "user" || entry.type === "assistant") return entry.type;
    return undefined;
}

function messageContent(entry: SessionEntry): unknown {
    const message = entry.message;
    if (typeof message === "object" && message !== null) {
        return (message as { content?: unknown }).content;
    }
    return entry.content;
}

function textOfContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const part of content) {
        if (typeof part === "string") {
            parts.push(part);
            continue;
        }
        if (typeof part !== "object" || part === null) continue;
        const candidate = part as { type?: unknown; text?: unknown };
        if (candidate.type === "text" && typeof candidate.text === "string") {
            parts.push(candidate.text);
        }
    }
    return parts.join("");
}

/**
 * Text of the last assistant message on the active branch.
 *
 * The active branch is the parent chain of the last id-bearing entry — the same
 * "follow parentId" rule pi's own session rendering uses, so abandoned branches
 * never leak into a run summary.
 */
export function readLatestAssistant(sessionFile: string): string | undefined {
    let raw: string;
    try {
        raw = readFileSync(sessionFile, "utf8");
    } catch {
        return undefined;
    }
    const entries: SessionEntry[] = [];
    for (const line of raw.split("\n")) {
        const entry = parseLine(line);
        if (entry) entries.push(entry);
    }
    if (entries.length === 0) return undefined;

    const byId = new Map<string, SessionEntry>();
    for (const entry of entries) {
        if (typeof entry.id === "string") byId.set(entry.id, entry);
    }
    const onActiveBranch = new Set<string>();
    let cursor: SessionEntry | undefined = [...entries].reverse().find((entry) => typeof entry.id === "string");
    while (cursor && typeof cursor.id === "string" && !onActiveBranch.has(cursor.id)) {
        onActiveBranch.add(cursor.id);
        const parentId = cursor.parentId;
        cursor = typeof parentId === "string" ? byId.get(parentId) : undefined;
    }

    let latest = lastAssistantText(entries, onActiveBranch);
    if (latest === undefined) {
        // Fallback: an abandoned branch may hold the only assistant text (a
        // forked/re-run session). Better to show a stale-but-real answer than
        // an empty summary.
        latest = lastAssistantText(entries, undefined);
    }
    return latest;
}

function lastAssistantText(entries: SessionEntry[], branch: Set<string> | undefined): string | undefined {
    let latest: string | undefined;
    for (const entry of entries) {
        if (messageRole(entry) !== "assistant") continue;
        if (branch && branch.size > 0 && typeof entry.id === "string" && !branch.has(entry.id)) continue;
        const text = textOfContent(messageContent(entry)).trim();
        if (text.length > 0) latest = text;
    }
    return latest;
}

export function readRunSummary(dir: string): RunSummary {
    const metadata = readMetadata(dir);
    if (!metadata) return { metadata: undefined, effective: "stale", lastAssistant: undefined };
    return {
        metadata,
        effective: effectiveState(metadata),
        lastAssistant: readLatestAssistant(metadata.sessionFile),
    };
}
