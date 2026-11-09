#!/usr/bin/env node
/**
 * `schedule` — the management CLI for scheduled pi runs.
 *
 * Deliberately a plain executable on PATH (`~/.pi/agent/bin/schedule`, which pi
 * prepends to the bash tool's PATH) and not a pi flag and not a model tool:
 * every verb is one short-lived `node` process, so crontab, the agent's bash
 * tool and a human shell all drive the same state.
 *
 * pi-free on purpose (node built-ins + ./cron.ts ./slots.ts ./store.ts ./run.ts ./tick.ts).
 * The CLI must run under a bare `node`, which cannot resolve `@earendil-works/*`
 * (pi's loader resolves those against the pi install root).
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Kept ref'd on purpose: an unref'd timer lets node exit before a pending
// verb has finished writing (which silently swallowed `run`'s output).
import { setTimeout as delay } from "node:timers/promises";

import { CronParseError, cronToHuman, isValidCron, nextCron } from "./cron.ts";
import {
    activeRun,
    claimRun,
    effectiveState,
    executeRun,
    isActive,
    latestRun,
    listRuns,
    outputLogPath,
    readMetadata,
    readRunSummary,
} from "./run.ts";
import type { ActiveRun, EffectiveState, RunMetadata } from "./run.ts";
import { slotVerdict } from "./slots.ts";
import {
    KEEP_MS,
    addTask,
    errorMessage,
    getScheduleDir,
    listTasks,
    nextFireAnchor,
    readTask,
    readWatermark,
    removeTask,
    setTaskEnabled,
    setTaskPrompt,
    tasksDir,
    validateTaskId,
} from "./store.ts";
import type { Task } from "./store.ts";
import {
    formatTickResult,
    installCron,
    runTick,
    stampOf,
    uninstallCron,
} from "./tick.ts";
import { describeRoute, resolveSubagentRoute } from "./routing.ts";

const USAGE = `Usage:
  schedule list [--json]
  schedule add --name <name> --cron <expr> --cwd <abs-dir> (--prompt <text> | --prompt-file <path>) [--once]
  schedule remove <id>
  schedule set-prompt <id> (--prompt <text> | --prompt-file <path>)
  schedule enable <id>
  schedule disable <id>
  schedule run <id> [--fg]
  schedule logs <id> [--raw] [-f]
  schedule tick
  schedule install-cron
  schedule uninstall-cron

Options:
  --prompt <text>     inline prompt; use --prompt=<text> or --prompt-file for
                      text that starts with a dash
  --prompt-file <p>   read the prompt from a file now, at add/set-prompt time;
                      the task stores the text itself, never the path
  --once              fire only for the first scheduled slot, then stop
  --fg                run in the foreground (shares your terminal and process group)
  --raw               show the raw output.log instead of the run summary
  -f                  follow (with --raw)
  --json              machine-readable output (list)

Tasks live in ${getScheduleDir()}/tasks, runs in ${getScheduleDir()}/runs.
Every minute crontab runs \`schedule tick\`; install that with \`schedule install-cron\`,
remove it again with \`schedule uninstall-cron\` (tasks and run history are kept).
`;

function fail(message: string): never {
    process.stderr.write(`${message}\n`);
    process.exit(1);
}

const BOOLEAN_FLAGS = new Set([
    "--once",
    "--fg",
    "--raw",
    "--json",
    "--manual",
    "--help",
    "-h",
    "-f",
]);

interface ParsedArgs {
    positionals: string[];
    flags: Map<string, string | true>;
}

/**
 * Small hand-rolled parser. A string option takes the next token verbatim (so
 * `--prompt -5 minutes` works), unless that token is a known flag.
 */
function parseArgs(argv: string[]): ParsedArgs {
    const positionals: string[] = [];
    const flags = new Map<string, string | true>();
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--") break;
        if (arg.startsWith("--") && arg.includes("=")) {
            const at = arg.indexOf("=");
            flags.set(arg.slice(0, at), arg.slice(at + 1));
            continue;
        }
        if (arg.startsWith("-") && arg !== "-") {
            if (BOOLEAN_FLAGS.has(arg)) {
                flags.set(arg, true);
                continue;
            }
            const next = argv[i + 1];
            if (next !== undefined && !BOOLEAN_FLAGS.has(next)) {
                flags.set(arg, next);
                i += 1;
            } else {
                flags.set(arg, true);
            }
            continue;
        }
        positionals.push(arg);
    }
    return { positionals, flags };
}

function flag(args: ParsedArgs, name: string): string | undefined {
    const value = args.flags.get(name);
    return typeof value === "string" ? value : undefined;
}

function has(args: ParsedArgs, name: string): boolean {
    return args.flags.get(name) === true;
}

function requireTask(id: string | undefined): Task {
    if (!id) fail("missing task id");
    if (!validateTaskId(id)) fail(`invalid task id: ${id}`);
    const task = readTask(id);
    if (!task) fail(`no such task (or unreadable): ${id}`);
    return task;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Rough display width: CJK and full-width forms take two cells. */
function displayWidth(text: string): number {
    let width = 0;
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        width +=
            (code >= 0x1100 && code <= 0x115f) ||
            (code >= 0x2e80 && code <= 0xa4cf) ||
            (code >= 0xac00 && code <= 0xd7a3) ||
            (code >= 0xf900 && code <= 0xfaff) ||
            (code >= 0xfe30 && code <= 0xfe6f) ||
            (code >= 0xff00 && code <= 0xff60) ||
            (code >= 0xffe0 && code <= 0xffe6)
                ? 2
                : 1;
    }
    return width;
}

function pad(text: string, width: number): string {
    const fill = width - displayWidth(text);
    return fill > 0 ? text + " ".repeat(fill) : text;
}

function shortId(id: string): string {
    return id.slice(0, 8);
}

function relativeTime(iso: string | undefined): string {
    if (!iso) return "—";
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return "—";
    const delta = Date.now() - at;
    const past = delta >= 0;
    const seconds = Math.abs(delta) / 1000;
    const unit =
        seconds < 60
            ? `${Math.round(seconds)}s`
            : seconds < 3600
              ? `${Math.round(seconds / 60)}m`
              : seconds < 86400
                ? `${Math.round(seconds / 3600)}h`
                : `${Math.round(seconds / 86400)}d`;
    return past ? `${unit} ago` : `in ${unit}`;
}

function formatLocal(date: Date): string {
    const pad2 = (value: number): string => String(value).padStart(2, "0");
    return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function describeState(effective: EffectiveState, metadata: RunMetadata | undefined): string {
    if (!metadata) return effective;
    if (effective === "orphan") return `orphan (pgid ${metadata.pgid ?? "?"})`;
    if (effective === "exited") {
        if (metadata.signal) return `exited (${metadata.signal})`;
        if (typeof metadata.exitCode === "number") return `exited (code ${metadata.exitCode})`;
    }
    return effective;
}

type NextFire =
    | { kind: "at"; date: Date }
    | { kind: "consumed" }
    | { kind: "unschedulable" };

function nextFireOf(task: Task): NextFire {
    try {
        const watermark = readWatermark(task.id);
        if (task.once && watermark.accountedThrough !== null) return { kind: "consumed" };
        const anchor = nextFireAnchor(watermark.accountedThrough);
        if (!anchor) return { kind: "unschedulable" };
        return { kind: "at", date: nextCron(task.cron, anchor) };
    } catch {
        return { kind: "unschedulable" };
    }
}

/** `NEXT` column: `—` means only one thing — a consumed one-shot task. */
function nextText(next: NextFire): string {
    switch (next.kind) {
        case "at":
            return formatLocal(next.date);
        case "consumed":
            return "—";
        case "unschedulable":
            return "invalid";
    }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

interface ListRow {
    id: string;
    name: string;
    cron: string;
    schedule: string;
    enabled: boolean;
    once: boolean;
    next: string;
    last: string;
    state: string;
    missed: boolean;
}

/**
 * First slot the task owed but never ran, or undefined when it is up to date
 * (or currently busy).
 *
 * The read side deliberately does not look at the watermark: a missed tick
 * pushes the watermark to `now`, destroying the evidence within one cycle. The
 * newest run's `startedAt` — and `createdAt` before the first run — is the
 * stable proof of what actually happened.
 */
export function missedSince(
    task: Task,
    newest: ActiveRun | undefined,
    now = new Date(),
): Date | undefined {
    if (!task.enabled) return undefined;
    // A run in flight is not a missed slot, even after the 10-minute catch-up
    // window: `first` drops out of the window while the task is still working.
    // A `stale` claim is a dispatch that was accounted for but never picked up;
    // reporting it as `missed` would hide the real fault behind the schedule.
    if (newest && (isActive(newest.effective) || newest.effective === "stale")) return undefined;
    const base = newest ? Date.parse(newest.metadata.startedAt) : Date.parse(task.createdAt);
    if (!Number.isFinite(base)) return undefined;
    try {
        const verdict = slotVerdict(task.cron, new Date(base), now);
        return verdict.kind === "missed" ? verdict.first : undefined;
    } catch {
        return undefined;
    }
}

/** `LAST` column: a missed slot overrides the newest run, and `—` means none. */
function lastText(missed: Date | undefined, newest: ActiveRun | undefined): string {
    if (missed) return `missed · ${relativeTime(missed.toISOString())}`;
    if (!newest) return "—";
    return `${describeState(newest.effective, newest.metadata)} · ${relativeTime(newest.metadata.startedAt)}`;
}

export function buildRows(now = new Date()): ListRow[] {
    const rows: ListRow[] = [];
    for (const entry of listTasks()) {
        const { task, id } = entry;
        if (!task) {
            rows.push({
                id: shortId(id),
                name: "(unreadable)",
                cron: "—",
                schedule: "—",
                enabled: false,
                once: false,
                next: "—",
                last: "—",
                state: "corrupt",
                missed: false,
            });
            continue;
        }
        const runs = listRuns(id);
        const newest = runs[0];
        const missed = missedSince(task, newest, now);
        const next = nextFireOf(task);
        rows.push({
            id: shortId(id),
            name: task.name,
            cron: task.cron,
            schedule: cronToHuman(task.cron),
            enabled: task.enabled,
            once: Boolean(task.once),
            next: nextText(next),
            last: lastText(missed, newest),
            state: newest ? describeState(newest.effective, newest.metadata) : "idle",
            missed: missed !== undefined,
        });
    }
    return rows;
}

function printList(rows: ListRow[]): void {
    if (rows.length === 0) {
        process.stdout.write(`No scheduled tasks. Create one with \`schedule add ...\`.\n`);
        return;
    }
    const header = ["ID", "NAME", "ENABLED", "NEXT", "LAST", "SCHEDULE"];
    const body = rows.map((row) => [
        row.id,
        row.name,
        row.enabled ? "yes" : "no",
        row.next,
        row.last,
        row.once ? `${row.schedule} · once` : row.schedule,
    ]);
    const widths = header.map((cell, column) =>
        Math.max(displayWidth(cell), ...body.map((line) => displayWidth(line[column]))),
    );
    const render = (line: string[]): string =>
        line.map((cell, column) => pad(cell, widths[column])).join("  ").trimEnd();
    process.stdout.write(`${render(header)}\n`);
    for (const line of body) {
        process.stdout.write(`${render(line)}\n`);
    }
    // A corrupt file is otherwise invisible: it renders as "(unreadable)" and
    // the fix (re-add or delete it) is not something the table can express.
    const corrupt = rows.filter((row) => row.state === "corrupt").length;
    if (corrupt > 0) {
        process.stdout.write(
            `\n${corrupt} corrupt task definition(s): re-add with \`schedule add\`, or delete the bad file under ${tasksDir()}\n`,
        );
    }
}

function cmdList(args: ParsedArgs): number {
    const rows = buildRows();
    if (has(args, "--json")) {
        process.stdout.write(`${JSON.stringify({ tasks: rows }, null, 2)}\n`);
        return 0;
    }
    printList(rows);
    return 0;
}

// ---------------------------------------------------------------------------
// add / remove / set-prompt / enable / disable
// ---------------------------------------------------------------------------

function cmdAdd(args: ParsedArgs): number {
    // addTask owns the required-field checks; the catch below surfaces its
    // messages, so they must not be duplicated here.
    const name = flag(args, "--name") ?? "";
    const cron = flag(args, "--cron") ?? "";
    const cwd = flag(args, "--cwd") ?? "";
    const prompt = flag(args, "--prompt");
    const promptFile = flag(args, "--prompt-file");

    if (cron && !isValidCron(cron)) {
        let detail = "invalid expression";
        try {
            nextCron(cron, new Date());
        } catch (error) {
            if (error instanceof CronParseError) detail = error.message;
        }
        fail(`add: invalid --cron '${cron}': ${detail}`);
    }

    let task: Task;
    try {
        task = addTask({
            name,
            cron,
            cwd,
            prompt,
            promptFile,
            once: has(args, "--once"),
        });
    } catch (error) {
        fail(errorMessage(error));
    }

    const next = nextFireOf(task);
    process.stdout.write(
        `added ${task.id}  ${task.name}  (${cronToHuman(task.cron)})\n` +
            `next: ${nextText(next)}\n` +
            `model: ${describeRoute(resolveSubagentRoute(task.cwd))}\n`,
    );
    return 0;
}

function cmdRemove(args: ParsedArgs): number {
    const id = args.positionals[0];
    if (!id || !validateTaskId(id)) fail(`invalid task id: ${id ?? "(missing)"}`);
    if (!removeTask(id)) fail(`no such task: ${id}`);
    const days = Math.round(KEEP_MS / (24 * 60 * 60 * 1000));
    process.stdout.write(`removed ${id} (run history is collected by GC after ${days} days)\n`);
    return 0;
}

function cmdSetPrompt(args: ParsedArgs): number {
    const task = requireTask(args.positionals[0]);
    let next: Task | undefined;
    try {
        next = setTaskPrompt(task.id, {
            prompt: flag(args, "--prompt"),
            promptFile: flag(args, "--prompt-file"),
        });
    } catch (error) {
        fail(errorMessage(error));
    }
    if (!next) fail(`could not update task: ${task.id}`);
    // No NEXT line: only the prompt body changed, the schedule is untouched.
    process.stdout.write(`set prompt for ${next.id}  ${next.name} (${next.prompt.length} chars)\n`);
    return 0;
}

function cmdToggle(args: ParsedArgs, enabled: boolean): number {
    const task = requireTask(args.positionals[0]);
    const next = setTaskEnabled(task.id, enabled);
    if (!next) fail(`could not update task: ${task.id}`);
    process.stdout.write(
        `${enabled ? "enabled" : "disabled"} ${next.id}  ${next.name}\n` +
            (enabled ? `next: ${nextText(nextFireOf(next))}\n` : ""),
    );
    return 0;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

function cliPath(): string {
    return fileURLToPath(import.meta.url);
}

/**
 * Poll until `ready` accepts the run's metadata, or the timeout expires.
 *
 * The claim itself writes a `starting` record with `pid: null`, so callers that
 * report the pid must keep waiting until the helper has recorded one (or the
 * run already reached a terminal state).
 */
async function waitForMetadata(
    dir: string,
    ready: (metadata: RunMetadata) => boolean = () => true,
    timeoutMs = 1000,
): Promise<RunMetadata | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const metadata = readMetadata(dir);
        if (metadata && ready(metadata)) return metadata;
        if (Date.now() > deadline) return metadata;
        await delay(25);
    }
}

/** Inputs every real run needs; both `run` and `__exec` go through here. */
function runInputs(task: Task): {
    promptText: string;
    route: ReturnType<typeof resolveSubagentRoute>;
} {
    // Runs are one-shot worker calls: follow the active mode's
    // roles.subagents pin instead of whichever provider pi falls back to.
    return { promptText: task.prompt, route: resolveSubagentRoute(task.cwd) };
}

async function cmdRun(args: ParsedArgs): Promise<number> {
    const task = requireTask(args.positionals[0]);
    const foreground = has(args, "--fg");

    const conflict = activeRun(task.id);
    if (conflict) {
        fail(
            `run ${task.id}: already running (${describeState(conflict.effective, conflict.metadata)}, ` +
                `run ${conflict.ts}, ${conflict.metadata.trigger})`,
        );
    }

    const { promptText, route } = runInputs(task);
    const now = new Date();
    const stamp = stampOf(now);
    let dir: string;
    try {
        dir = claimRun(task.id, stamp, { trigger: "manual", cwd: task.cwd, startedAt: now });
    } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") {
            fail(`run ${task.id}: cannot claim slot ${stamp}: ${errorMessage(error)}`);
        }
        fail(`run ${task.id}: slot ${stamp} was claimed by another process, retry`);
    }

    if (foreground) {
        const code = await executeRun({
            taskId: task.id,
            stamp,
            trigger: "manual",
            foreground: true,
            cwd: task.cwd,
            promptText,
            route,
        });
        const summary = readRunSummary(dir);
        process.stdout.write(
            `\n--- ${task.id} run ${stamp} · ${describeState(summary.effective, summary.metadata)} ---\n`,
        );
        if (summary.lastAssistant) process.stdout.write(`${summary.lastAssistant}\n`);
        return code;
    }

    const child = spawn(process.execPath, [cliPath(), "__exec", task.id, stamp, "--manual"], {
        detached: true,
        stdio: "ignore",
    });
    child.unref();

    const metadata = await waitForMetadata(
        dir,
        (candidate) => typeof candidate.pid === "number" || !isActive(effectiveState(candidate)),
    );
    process.stdout.write(
        `started ${task.id} run ${stamp}` +
            (metadata?.pid ? ` (pid ${metadata.pid})` : "") +
            `\nlogs: schedule logs ${task.id}\n`,
    );
    return 0;
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

function printRaw(path: string): number {
    try {
        process.stdout.write(readFileSync(path, "utf8"));
        return 0;
    } catch {
        fail(`no output.log at ${path}`);
    }
}

async function followRaw(path: string, done: () => boolean): Promise<number> {
    let offset = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
        let size: number;
        try {
            size = statSync(path).size;
        } catch {
            fail(`no output.log at ${path}`);
        }
        if (size > offset) {
            const fd = openSync(path, "r");
            try {
                let position = offset;
                for (;;) {
                    const read = readSync(fd, buffer, 0, buffer.length, position);
                    if (read <= 0) break;
                    process.stdout.write(buffer.subarray(0, read));
                    position += read;
                }
            } finally {
                closeSync(fd);
            }
            offset = size;
            continue;
        }
        if (done()) return 0;
        await delay(250);
    }
}

async function cmdLogs(args: ParsedArgs): Promise<number> {
    const task = requireTask(args.positionals[0]);
    const latest = latestRun(task.id);
    if (!latest) fail(`no runs recorded for ${task.id}`);

    if (has(args, "--raw")) {
        const path = outputLogPath(latest.dir);
        if (!existsSync(path)) {
            process.stdout.write(
                latest.metadata.trigger === "manual"
                    ? `run ${latest.ts} was manual: its output went to the terminal, not output.log\n`
                    : `no output.log for run ${latest.ts}\n`,
            );
            return 0;
        }
        if (!has(args, "-f")) return printRaw(path);
        return followRaw(path, () => {
            const current = readMetadata(latest.dir);
            if (!current) return true;
            return !isActive(effectiveState(current));
        });
    }

    const summary = readRunSummary(latest.dir);
    const metadata = summary.metadata;
    const lines: string[] = [];
    lines.push(`${task.id}  ${task.name}  run ${latest.ts}  (${metadata?.trigger ?? "?"})`);
    lines.push(`state: ${describeState(summary.effective, metadata)}`);
    lines.push(`model: ${describeRoute(metadata?.modelRoute)}`);
    if (metadata) {
        const started = metadata.startedAt;
        const finished = metadata.finishedAt;
        const durationMs = finished ? Date.parse(finished) - Date.parse(started) : undefined;
        lines.push(
            `started: ${started}${finished ? `  finished: ${finished}` : ""}` +
                (durationMs !== undefined && Number.isFinite(durationMs)
                    ? `  (${Math.round(durationMs / 1000)}s)`
                    : ""),
        );
        if (metadata.killedAt) lines.push(`killed at: ${metadata.killedAt}`);
        if (metadata.error) lines.push(`error: ${metadata.error}`);
        lines.push(`session: ${metadata.sessionFile}`);
        lines.push(`output: ${outputLogPath(latest.dir)}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    process.stdout.write(`\n--- last assistant ---\n${summary.lastAssistant ?? "(none yet)"}\n`);
    return 0;
}

// ---------------------------------------------------------------------------
// tick / install-cron / __exec
// ---------------------------------------------------------------------------

function cmdTick(): number {
    const result = runTick();
    process.stdout.write(`${formatTickResult(result)}\n`);
    return 0;
}

function cmdInstallCron(): number {
    const result = installCron();
    process.stdout.write(`${result.crontab}`);
    for (const warning of result.warnings) process.stdout.write(`⚠ ${warning}\n`);
    return 0;
}

function cmdUninstallCron(): number {
    const result = uninstallCron();
    if (!result.removed) {
        process.stdout.write("no pi-schedule block found in crontab\n");
        return 0;
    }
    process.stdout.write("removed crontab block:\n");
    process.stdout.write(`${result.removedBlock}\n`);
    process.stdout.write("tasks and run history are untouched\n");
    return 0;
}

async function cmdExec(args: ParsedArgs): Promise<number> {
    const id = args.positionals[0];
    const stamp = args.positionals[1];
    if (!id || !stamp) fail("__exec: usage: schedule __exec <id> <stamp> [--fg] [--manual]");
    const task = readTask(id);
    if (!task) fail(`__exec: no such task: ${id}`);
    const { promptText, route } = runInputs(task);
    return executeRun({
        taskId: task.id,
        stamp,
        trigger: has(args, "--manual") ? "manual" : "scheduled",
        foreground: has(args, "--fg"),
        cwd: task.cwd,
        promptText,
        route,
    });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
    if (process.platform === "win32") {
        fail("schedule: POSIX only (process-group kill is required to contain runs)");
    }
    const argv = process.argv.slice(2);
    const [command, ...rest] = argv;
    if (!command || command === "--help" || command === "-h" || command === "help") {
        process.stdout.write(USAGE);
        return command ? 0 : 1;
    }
    const args = parseArgs(rest);
    switch (command) {
        case "list":
            return cmdList(args);
        case "add":
            return cmdAdd(args);
        case "remove":
        case "rm":
            return cmdRemove(args);
        case "set-prompt":
            return cmdSetPrompt(args);
        case "enable":
            return cmdToggle(args, true);
        case "disable":
            return cmdToggle(args, false);
        case "run":
            return cmdRun(args);
        case "logs":
            return cmdLogs(args);
        case "tick":
            return cmdTick();
        case "install-cron":
            return cmdInstallCron();
        case "uninstall-cron":
            return cmdUninstallCron();
        case "__exec":
            return cmdExec(args);
        default:
            process.stderr.write(`schedule: unknown command '${command}'\n\n`);
            process.stdout.write(USAGE);
            return 1;
    }
}

// `schedule list | head` closes stdout mid-write; an EPIPE is the caller saying
// "enough", not a crash worth a stack trace.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
});

/**
 * True when this module is the process entry point (directly, or through the
 * `~/.pi/agent/bin/schedule` symlink). Tests import `buildRows`/`missedSince`
 * from here, so importing must not run the CLI.
 */
function isEntryPoint(): boolean {
    const entry = process.argv[1];
    if (!entry) return false;
    try {
        return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isEntryPoint()) {
    main()
        .then((code) => {
            process.exitCode = code;
        })
        .catch((error: unknown) => {
            process.stderr.write(`${errorMessage(error)}\n`);
            process.exitCode = 1;
        });
}
