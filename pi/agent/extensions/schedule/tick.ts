/**
 * schedule/tick.ts — the scheduler tick and crontab installation.
 *
 * `tick` is the only thing crontab runs (once a minute, TICK_SCHEDULE). It never
 * waits for a run: it decides what is due, claims the slot, and derives a
 * detached helper (`schedule __exec <id> <stamp>`) that owns the run's lifetime.
 *
 * Scheduling invariant (the bug this design exists to avoid): the anchor for
 * "when do I fire next" is the tick-owned watermark in
 * `runs/<id>/state.json`, never the run history. A missed slot advances the
 * watermark, so a machine that was off for four hours does not re-fire an
 * every-minute task forever, and GC pressure cannot shift the schedule.
 *
 * pi-free on purpose (node built-ins + ./cron.ts ./slots.ts ./store.ts
 * ./run.ts only).
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { activeRun, claimRun } from "./run.ts";
import { slotVerdict, type SlotVerdict } from "./slots.ts";
import {
    atomicWriteJson,
    ensureDir,
    errorMessage,
    gcRuns,
    getAgentDir,
    getScheduleDir,
    listTasks,
    readJsonFile,
    readWatermark,
    taskRunsDir,
    writeWatermark,
} from "./store.ts";
import type { Task } from "./store.ts";

/**
 * The crontab schedule for `tick`. Single source of truth: `installCron` renders
 * it and the tests assert against it.
 *
 * One minute is the resolution the scheduler can promise. A tick is a full
 * `node` start (~150ms wall, ~0.5% of a core while it runs), so a coarser
 * interval saves CPU — but any cron expression that resolves to slots closer
 * together than the tick interval is coalesced into one run per tick, which
 * silently turns `* * * * *` into "every N minutes". If you ever raise this,
 * treat the tick interval as the scheduler's minimum granularity.
 */
export const TICK_SCHEDULE = "* * * * *";

/** tick.log is rotated to tick.log.1 past this size. */
const TICK_LOG_MAX_BYTES = 1024 * 1024;

export const CRON_BLOCK_BEGIN = "# >>> pi-schedule >>>";
export const CRON_BLOCK_END = "# <<< pi-schedule <<<";

export interface TickResult {
    dispatched: string[];
    skipped: string[];
    missed: number;
}

export interface TickOptions {
    now?: Date;
    /**
     * Replacement for the detached helper spawn. Tests capture dispatches
     * instead of starting real `pi` processes.
     */
    dispatch?: (taskId: string, stamp: string) => void;
    /** Replacement for the append-only tick log. */
    log?: (line: string) => void;
}

/** `YYYYMMDD-HHmmss`, local time — matches `claimRun`'s stamp pattern. */
export function stampOf(date: Date): string {
    const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
    return (
        `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    );
}

export function tickLogPath(): string {
    return join(getScheduleDir(), "tick.log");
}

function rotateTickLogIfNeeded(): void {
    const path = tickLogPath();
    try {
        if (statSync(path).size < TICK_LOG_MAX_BYTES) return;
        renameSync(path, `${path}.1`);
    } catch {
        // no log yet, or rename failed: not worth failing a tick over
    }
}

export function appendTickLog(line: string): void {
    rotateTickLogIfNeeded();
    ensureDir(getScheduleDir());
    appendFileSync(tickLogPath(), `${new Date().toISOString()} ${line}\n`, { encoding: "utf8" });
}

/**
 * Log a line only when `key` differs from the one logged last time.
 *
 * tick.log records *transitions*, not one line per task per minute. The key is
 * kept in `runs/<id>/notice.json` — a sibling of the watermark, so GC (which
 * only removes `<ts>` dirs) never touches it.
 */
function noticeOnce(taskId: string, key: string, line: string, log: (line: string) => void): void {
    const path = join(taskRunsDir(taskId), "notice.json");
    const parsed = readJsonFile(path);
    const previous = (parsed as { key?: unknown } | undefined)?.key;
    if (typeof previous === "string" && previous === key) return;
    atomicWriteJson(path, { key });
    log(line);
}

function defaultDispatch(taskId: string, stamp: string): void {
    const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const child = spawn(process.execPath, [cliPath, "__exec", taskId, stamp], {
        detached: true,
        stdio: "ignore",
    });
    child.on("error", (error: Error) => {
        appendTickLog(`[${taskId}] dispatch failed: ${error.message}`);
    });
    child.unref();
}

function taskTimestamp(task: Task): number {
    const createdAt = Date.parse(task.createdAt);
    return Number.isFinite(createdAt) ? createdAt : Date.now();
}

/**
 * One scheduler pass.
 *
 * For every enabled task:
 *   active run (any trigger)         → skipped (change-logged only, no watermark write)
 *   `once` with a watermark          → skipped (guard, before any verdict)
 *   no slot reached `now`            → pending, nothing written
 *   slots owed but all out of window → missed, watermark advanced to `now`
 *   at least one slot in the window  → watermark advanced to `now` → claim → dispatch
 *
 * The watermark is written *before* the claim so a crash after accounting can
 * lose a slot but never dispatch one twice (at-most-once).
 */
export function runTick(options: TickOptions = {}): TickResult {
    const now = options.now ?? new Date();
    const log = options.log ?? appendTickLog;
    const dispatch = options.dispatch ?? defaultDispatch;
    const result: TickResult = { dispatched: [], skipped: [], missed: 0 };

    gcRuns(now);

    for (const entry of listTasks()) {
        const { id } = entry;
        const task = entry.task;
        if (!task) {
            noticeOnce(id, `corrupt:${entry.error ?? "unknown"}`, `[${id}] corrupt task file: ${entry.error ?? "unknown"}`, log);
            continue;
        }
        if (!task.enabled) continue;

        const active = activeRun(id);
        if (active) {
            const key = `active:${active.ts}:${active.effective}`;
            const detail =
                active.effective === "orphan"
                    ? `orphan (pgid ${active.metadata.pgid ?? "?"})`
                    : active.effective;
            noticeOnce(id, key, `[${id}] ${detail} run ${active.ts}: scheduling skipped`, log);
            result.skipped.push(id);
            continue;
        }
        const watermark = readWatermark(id);

        // `once` is derived, not stored in the definition: it fires only while
        // the watermark is still empty. A slot that was accounted for as missed
        // also counts as consumed. This guard must stay *before* the verdict:
        // for a high-frequency cron the first slot after the anchor is still in
        // the past after consumption, so the watermark is the only stop.
        if (task.once && watermark.accountedThrough !== null) {
            noticeOnce(id, "once-consumed", `[${id}] once task already consumed; not firing again`, log);
            continue;
        }

        // The anchor is the highest instant already accounted for: the
        // watermark, or the creation time before the first accounting.
        const anchorMs = watermark.accountedThrough === null
            ? taskTimestamp(task)
            : Date.parse(watermark.accountedThrough);
        if (!Number.isFinite(anchorMs)) {
            noticeOnce(id, "bad-anchor", `[${id}] unusable scheduling anchor; skipping`, log);
            continue;
        }
        const anchor = new Date(anchorMs);

        let verdict: SlotVerdict;
        try {
            verdict = slotVerdict(task.cron, anchor, now);
        } catch (error) {
            const message = errorMessage(error);
            noticeOnce(id, `cron:${message}`, `[${id}] cron '${task.cron}' is not schedulable: ${message}`, log);
            continue;
        }

        if (verdict.kind === "pending") continue;

        // Account first, dispatch second: at-most-once, not at-least-once.
        writeWatermark(id, now.toISOString());

        if (verdict.kind === "missed") {
            if (task.once) {
                noticeOnce(id, "once-missed", `[${id}] once task consumed by a missed slot; not firing`, log);
            }
            log(`[${id}] behind since ${anchor.toISOString()} (cron '${task.cron}')`);
            result.missed += 1;
            continue;
        }

        const stamp = stampOf(now);
        try {
            claimRun(id, stamp, { cwd: task.cwd, startedAt: now });
        } catch (error) {
            // EEXIST is benign: another tick in the same second took the slot.
            // Anything else (the claim's metadata write) must not vanish: the
            // slot is already accounted for, so it will never be retried.
            if ((error as { code?: string }).code !== "EEXIST") {
                log(`[${id}] claim failed for run ${stamp}: ${errorMessage(error)}`);
            }
            continue;
        }
        try {
            dispatch(id, stamp);
            log(`[${id}] dispatched run ${stamp}`);
            result.dispatched.push(id);
        } catch (error) {
            log(`[${id}] dispatch failed for run ${stamp}: ${errorMessage(error)}`);
        }
    }

    return result;
}

export function formatTickResult(result: TickResult): string {
    return `dispatched ${result.dispatched.length} / skipped ${result.skipped.length} / missed ${result.missed}`;
}

// ---------------------------------------------------------------------------
// install-cron
// ---------------------------------------------------------------------------

export interface CommandResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

export type CommandRunner = (
    command: string,
    args: string[],
    options?: { input?: string },
) => CommandResult;

export function defaultRunner(
    command: string,
    args: string[],
    options?: { input?: string },
): CommandResult {
    const result = spawnSync(command, args, { input: options?.input, encoding: "utf8" });
    return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
}

/** Current crontab, or "" when there is none (crontab -l exits non-zero). */
function readCrontab(runner: CommandRunner): string {
    const listing = runner("crontab", ["-l"]);
    return listing.status === 0 ? listing.stdout : "";
}

/** Back up the old body, then write the new one (or throw). */
function commitCrontab(runner: CommandRunner, previous: string, next: string, label: string): void {
    if (previous.trim().length > 0) {
        ensureDir(getScheduleDir());
        writeFileSync(join(getScheduleDir(), "crontab.bak"), previous, {
            encoding: "utf8",
            mode: 0o600,
        });
    }
    const write = runner("crontab", ["-"], { input: next });
    if (write.status !== 0) {
        throw new Error(`${label}: crontab write failed: ${write.stderr.trim() || `exit ${write.status}`}`);
    }
}

export interface InstallCronOptions {
    runner?: CommandRunner;
    /** Defaults to `<agentDir>/bin/schedule`. */
    scheduleBin?: string;
    /** Defaults to `process.execPath`. */
    nodeBin?: string;
    logPath?: string;
    /** Defaults to a `which pi` probe. */
    piDir?: string;
}

export interface InstallCronResult {
    crontab: string;
    warnings: string[];
    smoke: { status: number | null; output: string };
    scheduleBin: string;
}

/** The managed block, markers included, or undefined when there is none. */
export function extractCronBlock(crontab: string): string | undefined {
    const lines = crontab.split("\n");
    const start = lines.findIndex((line) => line.trim() === CRON_BLOCK_BEGIN);
    if (start < 0) return undefined;
    const end = lines.findIndex(
        (line, index) => index > start && line.trim() === CRON_BLOCK_END,
    );
    // An unterminated block still belongs to us: stripCronBlock removes the
    // remainder too, so report the same span here.
    return (end < 0 ? lines.slice(start) : lines.slice(start, end + 1)).join("\n");
}

/** Strip our managed block (markers included) from a crontab body. */
export function stripCronBlock(crontab: string): string {
    const lines = crontab.split("\n");
    const kept: string[] = [];
    let inBlock = false;
    for (const line of lines) {
        if (line.trim() === CRON_BLOCK_BEGIN) {
            inBlock = true;
            continue;
        }
        if (line.trim() === CRON_BLOCK_END) {
            inBlock = false;
            continue;
        }
        if (inBlock) continue;
        kept.push(line);
    }
    while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
    return kept.join("\n");
}

export function renderCronBlock(options: {
    piDir: string;
    nodeBin: string;
    scheduleBin: string;
    logPath: string;
}): string {
    const path = `${options.piDir}:/usr/local/bin:/usr/bin:/bin`;
    return [
        CRON_BLOCK_BEGIN,
        `PATH=${path}`,
        `${TICK_SCHEDULE} ${options.nodeBin} ${options.scheduleBin} tick >> ${options.logPath} 2>&1`,
        CRON_BLOCK_END,
    ].join("\n");
}

function resolvePiDir(runner: CommandRunner, warnings: string[]): string {
    const which = runner("which", ["pi"]);
    const found = which.stdout.split("\n")[0]?.trim();
    if (which.status === 0 && found) return dirname(found);
    warnings.push("could not resolve `pi` on PATH; assuming ~/.npm-global/bin in the crontab PATH");
    return join(homedir(), ".npm-global", "bin");
}

function cronDaemonWarning(runner: CommandRunner, warnings: string[]): void {
    for (const name of ["cron", "crond"]) {
        const probe = runner("pgrep", ["-x", name]);
        if (probe.status === 0 && probe.stdout.trim().length > 0) return;
    }
    warnings.push(
        "no cron daemon running (pgrep -x cron / crond found nothing): ticks will never fire" +
            " — enable one first (Arch: `sudo systemctl enable --now cronie`," +
            " Debian/Ubuntu: `sudo systemctl enable --now cron`)",
    );
}

/**
 * Install (or refresh) the tick entry in the user's crontab.
 *
 * Idempotent and block-scoped: the user's own entries are preserved verbatim,
 * only the marked block is replaced. The previous crontab is backed up first.
 */
export function installCron(options: InstallCronOptions = {}): InstallCronResult {
    const runner = options.runner ?? defaultRunner;
    const warnings: string[] = [];
    const scheduleBin = options.scheduleBin ?? join(getAgentDir(), "bin", "schedule");
    const nodeBin = options.nodeBin ?? process.execPath;
    const logPath = options.logPath ?? tickLogPath();
    const piDir = options.piDir ?? resolvePiDir(runner, warnings);

    if (!existsSync(scheduleBin)) {
        warnings.push(`schedule entry point not found at ${scheduleBin} (is the bin symlink installed?)`);
    }
    cronDaemonWarning(runner, warnings);

    const previous = readCrontab(runner);
    const block = renderCronBlock({ piDir, nodeBin, scheduleBin, logPath });
    const kept = stripCronBlock(previous);
    const next = kept.length > 0 ? `${kept}\n${block}\n` : `${block}\n`;
    commitCrontab(runner, previous, next, "install-cron");

    // Smoke-test the crontab environment: a bare `env -i` has no HOME, no PATH
    // beyond what we hand it, and that is precisely what breaks cron jobs.
    const smoke = runner("env", [
        "-i",
        `PATH=${piDir}:/usr/local/bin:/usr/bin:/bin`,
        `HOME=${homedir()}`,
        nodeBin,
        scheduleBin,
        "list",
    ]);
    if (smoke.status !== 0) {
        warnings.push(`smoke test under cron-like env failed (exit ${smoke.status}): ${(smoke.stderr || smoke.stdout).trim().slice(0, 400)}`);
    }

    warnings.push("your shell needs ~/.pi/agent/bin on PATH to run `schedule` directly (pi's bash tool already has it)");

    return { crontab: next, warnings, smoke: { status: smoke.status, output: smoke.stdout.trim() }, scheduleBin };
}

export interface UninstallCronOptions {
    runner?: CommandRunner;
}

export interface UninstallCronResult {
    /** The crontab body that was written back. */
    crontab: string;
    /** False when there was no managed block to remove (idempotent no-op). */
    removed: boolean;
    /** The block that was removed, markers included, for the user to eyeball. */
    removedBlock: string;
}

/**
 * Remove the tick entry from the user's crontab.
 *
 * Idempotent and block-scoped, mirroring installCron: only the marked block is
 * removed, the user's own entries stay verbatim, and the previous crontab is
 * backed up first. Task definitions and run history are untouched — re-running
 * `schedule install-cron` restores the schedule, not the state.
 */
export function uninstallCron(options: UninstallCronOptions = {}): UninstallCronResult {
    const runner = options.runner ?? defaultRunner;
    const previous = readCrontab(runner);
    const removedBlock = extractCronBlock(previous);
    if (removedBlock === undefined) {
        return { crontab: previous, removed: false, removedBlock: "" };
    }

    const kept = stripCronBlock(previous);
    const next = kept.length > 0 ? `${kept}\n` : "";
    commitCrontab(runner, previous, next, "uninstall-cron");

    return { crontab: next, removed: true, removedBlock };
}
