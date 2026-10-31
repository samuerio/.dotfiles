import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
    DynamicBorder,
    SessionManager,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
    type SessionInfo,
    type Theme,
    type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
    Container,
    SelectList,
    Text,
    type SelectItem,
    type TUI,
} from "@earendil-works/pi-tui";
import { copyToClipboard } from "./lib/clipboard.ts";
import { pickSession } from "./lib/session-picker.ts";
import {
    previewSessionFile,
    sessionDisplayLabel,
} from "./lib/session-preview.ts";
import { Type } from "typebox";

// ─── Script Resolution ────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, "worktree-task");
const WORKTREE_SH = path.join(SCRIPTS_DIR, "worktree.sh");

/** `pi --attach-worktree-task <alias> [--task-root <repoRoot>]`: attach to a dispatched task's tmux session. */
const ATTACH_FLAG = "attach-worktree-task";
/** Repo root for the attach target; bypasses `git rev-parse` when supplied. */
const TASK_ROOT_FLAG = "task-root";
const TASKS_DIR_PARTS = [".pi", "worktree-tasks"] as const;

// ─── Worktree-task Child Mode ─────────────────────────────────────

const TASK_CHILD_ENV = "PI_WORKTREE_TASK_CHILD";
const TASK_RESULT_ENV = "PI_WORKTREE_TASK_RESULT";
const TASK_ALIAS_ENV = "PI_WORKTREE_TASK_ALIAS";
const EXTENSION_PATH = fileURLToPath(import.meta.url);

/**
 * Spacer for blank rows. pi-tui Text skips anything that is empty after trim()
 * (including "" and "\u00A0"), returning zero height. U+200B is not trimmed, so
 * Text still renders a full-width padded blank line.
 *
 * Do not pre-wrap lines here — Text already soft-wraps with padding-aware,
 * ANSI-aware width. A second wrapLine layer was off-by-padding and worse.
 */
const BLANK_ROW = "\u200B";

// ─── Widgets ──────────────────────────────────────────────────────

/** One colored/bold span inside a widget line. */
interface WidgetSegment {
    text: string;
    color?: ThemeColor;
    bold?: boolean;
}

/** A widget row: either a plain string (legacy) or a list of themed segments. */
type WidgetLine = string | WidgetSegment[];

function renderWidgetSegments(segments: WidgetSegment[], theme: Theme): string {
    return segments
        .map((segment) => {
            // Match subagent's wrapping order: fg("toolTitle", bold(session)).
            let text = segment.text;
            if (segment.bold) text = theme.bold(text);
            if (segment.color) text = theme.fg(segment.color, text);
            return text;
        })
        .join("");
}

/** Rows Text would collapse to zero height: empty, whitespace-only, or BLANK_ROW itself. */
function isBlankRow(line: string): boolean {
    return line === BLANK_ROW || /^\s*$/.test(line);
}

function buildWidget(lines: WidgetLine[], footer?: string) {
    return (_tui: TUI, theme: Theme) => {
        const container = new Container();
        for (const line of lines) {
            if (typeof line === "string") {
                // Map blank rows to BLANK_ROW so Text keeps height
                container.addChild(
                    new Text(isBlankRow(line) ? BLANK_ROW : line, 1, 0),
                );
                continue;
            }
            const rendered = renderWidgetSegments(line, theme);
            container.addChild(
                new Text(rendered.length > 0 ? rendered : BLANK_ROW, 1, 0),
            );
        }
        if (footer) {
            container.addChild(new Text(BLANK_ROW, 1, 0));
            container.addChild(new Text(theme.fg("muted", footer), 1, 0));
        }
        return container;
    };
}

// ─── Repo-local Tasks Environment & Keys ──────────────────────────

interface TasksEnv {
    repoRoot: string;
    tasksDir: string;
    socketPath: string;
}

function taskUuid(alias: string): string {
    return createHash("sha256")
        .update(alias, "utf8")
        .digest("hex")
        .slice(0, 16);
}

/**
 * Flat alias charset: no slashes (run dir = tasks/<alias>, so readdir finds one
 * entry per task), no leading "-" (the alias is spliced into the attach
 * command line), no path traversal ("." / ".." are rejected by the required
 * leading alphanumeric).
 */
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

async function validateAlias(pi: ExtensionAPI, alias: string): Promise<void> {
    if (!ALIAS_PATTERN.test(alias)) {
        throw new Error(
            `Invalid task alias "${alias}": 1-64 chars, must start with a letter or digit, may contain letters, digits, ".", "_" and "-" (slashes are not allowed).`,
        );
    }
    // The regex is wider than git's ref rules ("..", a trailing ".", and a
    // trailing ".lock" all pass it but are invalid branch names). git worktree
    // add would fail only after the run dir is claimed, so reject these here.
    const refCheck = await pi.exec("git", ["check-ref-format", "--branch", alias]);
    if (refCheck.code !== 0) {
        throw new Error(
            `Invalid task alias "${alias}": not usable as a git branch name. Choose a different alias.`,
        );
    }
}

function taskSessionName(uuid: string): string {
    return `worktree-task-${uuid}`;
}

function taskAttachCommand(alias: string, repoRoot?: string): string {
    const safe = /^[A-Za-z0-9._/-]+$/.test(alias);
    let cmd = `pi --${ATTACH_FLAG} ${safe ? alias : shellQuote(alias)}`;
    if (repoRoot) cmd += ` --${TASK_ROOT_FLAG} ${shellQuote(repoRoot)}`;
    return cmd;
}

async function getTasksEnv(pi: ExtensionAPI): Promise<TasksEnv | null> {
    const result = await pi.exec("bash", [WORKTREE_SH, "root-path"]);
    if (result.code !== 0) return null;
    const repoRoot = result.stdout.trim();
    if (!repoRoot) return null;
    const tasksDir = path.join(repoRoot, ...TASKS_DIR_PARTS);
    return { repoRoot, tasksDir, socketPath: path.join(tasksDir, "tmux.sock") };
}

/** Session names on our per-repo socket; [] when the server is down / socket missing. */
async function listSessionNames(
    pi: ExtensionAPI,
    socket: string,
): Promise<string[]> {
    const result = await pi.exec("tmux", [
        "-S",
        socket,
        "list-sessions",
        "-F",
        "#{session_name}",
    ]);
    if (result.code !== 0) return [];
    return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

// ─── Child Reporter (worktree task result.json) ───────────────────

interface WorktreeTaskResult {
    version: 1;
    /** Task alias / git branch, for uuid → alias reverse lookup. */
    branch?: string;
    status: "completed" | "failed";
    output: string;
    error?: string;
    stopReason?: string;
    sessionFile?: string;
    provider?: string;
    model?: string;
    thinking?: string;
    finishedAt: number;
}

function shellQuote(value: string): string {
    if (value.length === 0) return "''";
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getPiInvocationParts(): string[] {
    const currentScript = process.argv[1];
    if (currentScript && existsSync(currentScript)) {
        return [process.execPath, currentScript];
    }

    const execName = path.basename(process.execPath).toLowerCase();
    if (!/^(node|bun)(\.exe)?$/.test(execName)) {
        return [process.execPath];
    }

    return ["pi"];
}

function textFromAssistant(message: Record<string, unknown>): string {
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((part): part is { type: "text"; text: string } => {
            return Boolean(
                part &&
                typeof part === "object" &&
                part.type === "text" &&
                typeof part.text === "string",
            );
        })
        .map((part) => part.text)
        .join("\n");
}

function findLastAssistant(
    ctx: ExtensionContext,
): Record<string, unknown> | undefined {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index];
        if (entry.type !== "message") continue;
        const message = entry.message as unknown as Record<string, unknown>;
        if (message.role === "assistant") return message;
    }
    return undefined;
}

async function writeJsonAtomic(
    filePath: string,
    value: unknown,
): Promise<void> {
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    await rename(temporaryPath, filePath);
}

function registerTaskChildReporter(pi: ExtensionAPI, resultPath: string): void {
    let reported = false;

    const report = async (
        ctx: ExtensionContext,
        fallbackError?: string,
    ): Promise<void> => {
        if (reported) return;
        reported = true;

        const assistant = findLastAssistant(ctx);
        const stopReason =
            typeof assistant?.stopReason === "string"
                ? assistant.stopReason
                : undefined;
        const assistantError =
            typeof assistant?.errorMessage === "string"
                ? assistant.errorMessage
                : undefined;
        const failed =
            !assistant ||
            stopReason === "error" ||
            stopReason === "aborted" ||
            Boolean(fallbackError);
        const output = assistant ? textFromAssistant(assistant) : "";
        const result: WorktreeTaskResult = {
            version: 1,
            branch: process.env[TASK_ALIAS_ENV] || undefined,
            status: failed ? "failed" : "completed",
            output,
            error:
                fallbackError ??
                assistantError ??
                (!assistant
                    ? "Worktree task exited without an assistant response."
                    : undefined),
            stopReason,
            sessionFile: ctx.sessionManager.getSessionFile(),
            provider:
                typeof assistant?.provider === "string"
                    ? assistant.provider
                    : ctx.model?.provider,
            model:
                typeof assistant?.model === "string"
                    ? assistant.model
                    : ctx.model?.id,
            thinking: pi.getThinkingLevel(),
            finishedAt: Date.now(),
        };

        try {
            await writeJsonAtomic(resultPath, result);
        } catch (error) {
            console.error(
                `[worktree-task] Failed to write result: ${errorMessage(error)}`,
            );
        }
    };

    // agent_settled was added after older peer type declarations but is present
    // in the Pi runtime this extension targets.
    (
        pi.on as unknown as (
            event: "agent_settled",
            handler: (
                event: unknown,
                ctx: ExtensionContext,
            ) => void | Promise<void>,
        ) => void
    )("agent_settled", async (_event, ctx) => {
        await report(ctx);
        // First settle reports the dispatched task's result; the child stays
        // alive at the interactive prompt so the user can attach and take over
        // the session. The `reported` flag keeps later settles from
        // overwriting result.json.
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        if (!reported)
            await report(
                ctx,
                "Worktree task session shut down before the task settled.",
            );
    });
}

// ─── Run Artifacts (task.md / result.json / sessions) ─────────────

/** Registry root: one subdirectory per task; the source of truth for task existence. */
function tasksRoot(tasksDir: string): string {
    return path.join(tasksDir, "tasks");
}

function taskRunDir(tasksDir: string, alias: string): string {
    return path.join(tasksRoot(tasksDir), alias);
}

function taskSessionsDir(tasksDir: string): string {
    return path.join(tasksDir, "sessions");
}

/** Latest run's result.json; null when missing, unreadable or not JSON. */
async function readTaskResult(
    tasksDir: string,
    alias: string,
): Promise<WorktreeTaskResult | null> {
    try {
        const raw = await readFile(
            path.join(taskRunDir(tasksDir, alias), "result.json"),
            "utf8",
        );
        return JSON.parse(raw) as WorktreeTaskResult;
    } catch {
        return null;
    }
}

/** Dispatch timestamp = task.md mtime (written right before the child starts). */
async function readTaskStartedAt(
    tasksDir: string,
    alias: string,
): Promise<number | undefined> {
    try {
        const info = await stat(
            path.join(taskRunDir(tasksDir, alias), "task.md"),
        );
        return info.mtimeMs;
    } catch {
        return undefined;
    }
}

// ─── Script Output Types ──────────────────────────────────────────

interface OpenOutput {
    branch: string;
    worktreePath: string;
    worktreeCreated: boolean;
}

interface CleanOutput {
    worktreePath: string;
    leftoverCount: number;
    leftovers: string[];
}

// ─── Script Output Parser ─────────────────────────────────────────

/** Parse a script's `--json` stdout; null when the output is not valid JSON. */
function parseScriptOutput<T>(stdout: string): T | null {
    try {
        return JSON.parse(stdout) as T;
    } catch {
        return null;
    }
}

// ─── Worktree task Facts ──────────────────────────────────────────

/** Task status transposed verbatim from result.json; undefined while running. */
type TaskStatus = "completed" | "failed";

/**
 * Independent facts about one worktree-task alias. The run dir
 * (tasks/<alias>) is the source of truth; the worktree is optional and
 * expressed by the optional worktree entity (existsSync reality).
 */
interface TaskFacts {
    name: string;
    worktree?: WorktreeRef;
    sessionExists: boolean;
    taskStatus?: TaskStatus;
    /** Latest run's child session file (result.json sessionFile); absent while running. */
    sessionFile?: string;
}

interface WorktreeRef {
    path: string;
}

/**
 * Worktree path is a pure function of the alias; presence is probed on
 * demand. Mirrors worktree.sh's `"$repo_main/.worktree/$(sha256[:16])"`
 * layout — keep the two in sync.
 */
function taskWorktreePath(repoRoot: string, alias: string): string {
    return path.join(repoRoot, ".worktree", taskUuid(alias));
}

/**
 * Per-name fact core shared by the task list and single-task resolution:
 * worktree reality (a missing worktree path, e.g. manually removed, reads
 * as already cleaned) joined with result.json status and tmux session
 * existence. The caller supplies
 * env and session names so listing resolves them once for all tasks.
 */
async function taskFactsFor(
    env: TasksEnv,
    sessions: string[],
    name: string,
): Promise<TaskFacts> {
    const worktreePath = taskWorktreePath(env.repoRoot, name);
    const worktree = existsSync(worktreePath)
        ? { path: worktreePath }
        : undefined;

    // Task status: verbatim result.json status; undefined while running.
    const childResult = await readTaskResult(env.tasksDir, name);

    return {
        name,
        worktree,
        sessionExists: sessions.includes(taskSessionName(taskUuid(name))),
        taskStatus: childResult?.status,
        sessionFile: childResult?.sessionFile,
    };
}

/** Shared wording for every path where worktree.sh cannot report a repo root. */
const NO_REPO_ROOT_MESSAGE =
    "Failed to resolve repo root for worktree-task artifacts.";

async function resolveTaskFacts(
    pi: ExtensionAPI,
    name: string,
): Promise<TaskFacts> {
    const env = await getTasksEnv(pi);
    if (!env) throw new Error(NO_REPO_ROOT_MESSAGE);
    // tmux session (per-repo socket, session named worktree-task-<uuid>)
    const sessions = await listSessionNames(pi, env.socketPath);
    return taskFactsFor(env, sessions, name);
}

// ─── UI Select Helpers ────────────────────────────────────────────

/**
 * Worktree task list: readdir of tasks/ (the source of truth — one
 * subdirectory per task) joined with existsSync worktree reality,
 * result.json task status, and tmux session existence.
 * Dirty state is not listed; it is computed at close time for the selected
 * task only.
 */
async function listTasks(pi: ExtensionAPI): Promise<TaskFacts[]> {
    const env = await getTasksEnv(pi);
    if (!env) return [];

    // An unreadable tasks/ means no tasks yet, not an error.
    const entries = await readdir(tasksRoot(env.tasksDir), {
        withFileTypes: true,
    }).catch(() => []);
    const sessions = await listSessionNames(pi, env.socketPath);

    // Per-entry reads are independent; resolve them in parallel.
    const names = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    const tasks = await Promise.all(
        names.map((name) => taskFactsFor(env, sessions, name)),
    );
    return tasks.sort((a, b) => a.name.localeCompare(b.name));
}

async function selectTask(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    title: string,
): Promise<TaskFacts | null> {
    const tasks = await listTasks(pi);
    if (tasks.length === 0) {
        ctx.ui.notify("No worktree tasks available.", "info");
        return null;
    }

    // Display row: "<alias> (<taskStatus>|running) (no session)"
    // — each mark omitted per facts; running = live session, no result yet.
    // Map display strings back to facts to avoid parsing.
    const displayToFacts = new Map<string, TaskFacts>();
    for (const task of tasks) {
        let state: TaskStatus | "running" | undefined = task.taskStatus;
        if (!state && task.sessionExists) state = "running";
        const mark = state ? ` (${state})` : "";
        const noSession = task.sessionExists ? "" : " (no session)";
        displayToFacts.set(`${task.name}${mark}${noSession}`, task);
    }

    const choice = await ctx.ui.select(
        title,
        Array.from(displayToFacts.keys()),
    );
    if (!choice) return null;
    return displayToFacts.get(choice)!;
}

type TaskAction =
    | "status"
    | "addToPrompt"
    | "result"
    | "preview"
    | "vscode"
    | "close";

// taskActionItems' menu invariants as types: the worktree-gated action (vscode)
// implies a worktree; session-gated actions (addToPrompt, preview) imply
// sessionFile. Facts come from the tasks dir, so both gated cases assert at
// the menu boundary (taskActionItems only offers them when the fact exists).
type WorktreeTaskFacts = TaskFacts & { worktree: WorktreeRef };
type SettledTaskFacts = TaskFacts & { sessionFile: string };

/** Action labels for the selector, filtered by facts (worktree → vscode; settled → result; session file → addToPrompt/preview; status/close always offered). */
function taskActionItems(facts: TaskFacts): SelectItem[] {
    const items: SelectItem[] = [];
    items.push({ value: "status", label: "Status (state / attach)" });
    if (facts.taskStatus) {
        items.push({ value: "result", label: "Add result to prompt" });
    }
    if (facts.sessionFile) {
        items.push({ value: "addToPrompt", label: "Add session to prompt" });
        items.push({ value: "preview", label: "Preview session" });
    }
    if (facts.worktree !== undefined) {
        items.push({ value: "vscode", label: "Open in VS Code" });
    }
    items.push({
        value: "close",
        label: "Close (remove worktree + kill session)",
    });
    return items;
}

/** files.ts-style action selector: bordered SelectList returning the chosen action. */
async function showActionMenu<T extends string>(
    ctx: ExtensionCommandContext,
    title: string,
    actions: SelectItem[],
): Promise<T | null> {
    return ctx.ui.custom<T | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
        container.addChild(new Text(theme.fg("accent", theme.bold(title))));

        const selectList = new SelectList(actions, actions.length, {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
        });
        selectList.onSelect = (item) => done(item.value as T);
        selectList.onCancel = () => done(null);

        container.addChild(selectList);
        container.addChild(
            new Text(
                theme.fg("dim", "Press enter to confirm or esc to cancel"),
            ),
        );
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

        return {
            render(width: number) {
                return container.render(width);
            },
            invalidate() {
                container.invalidate();
            },
            handleInput(data: string) {
                selectList.handleInput(data);
                tui.requestRender();
            },
        };
    });
}

async function selectTaskAction(
    ctx: ExtensionCommandContext,
    facts: TaskFacts,
): Promise<TaskAction | null> {
    return showActionMenu<TaskAction>(
        ctx,
        `Action for "${facts.name}"`,
        taskActionItems(facts),
    );
}

// ─── Action Runners (executed directly by the /worktree-tasks flow) ──────

/** Resolve the tasks env for a UI action; notifies and returns null when the repo root is unknown. */
async function requireTasksEnv(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
): Promise<TasksEnv | null> {
    const env = await getTasksEnv(pi);
    if (!env) ctx.ui.notify(NO_REPO_ROOT_MESSAGE, "error");
    return env;
}

/**
 * Confirm with the user, then retry the close with `force`. Returns the new
 * outcome, or null when the user cancelled or the retry threw (already
 * notified).
 */
async function confirmAndForceClose(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    name: string,
    prompt: { title: string; message: string },
): Promise<CloseOutcome | null> {
    const proceed = await ctx.ui.confirm(prompt.title, prompt.message);
    if (!proceed) {
        ctx.ui.notify("Cancelled.", "info");
        return null;
    }
    try {
        return await closeTask(pi, { name, force: true });
    } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
        return null;
    }
}

async function runCloseAction(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    facts: TaskFacts,
): Promise<void> {
    let outcome: CloseOutcome;
    try {
        outcome = await closeTask(pi, { name: facts.name });
    } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
        return;
    }

    // Dirty worktree: interactive confirm maps to a forced retry; never
    // close one without it (dirty is computed inside closeTask, once per
    // attempt — the task list does not track it anymore).
    if (outcome.status === "dirty") {
        const retried = await confirmAndForceClose(pi, ctx, facts.name, {
            title: "Dirty Worktree",
            message: `Worktree task "${facts.name}" has uncommitted changes. Close anyway?`,
        });
        if (!retried) return;
        outcome = retried;
    }

    // Leftover directory (exists but no registered worktree): confirm
    // before the forced removal, with its own truthful title — its contents
    // are not covered by the dirty-worktree probe.
    if (outcome.status === "leftover") {
        const retried = await confirmAndForceClose(pi, ctx, facts.name, {
            title: "Task Directory Not a Worktree",
            message: `The directory for task "${facts.name}" exists but is not a registered git worktree. Remove it and close anyway?`,
        });
        if (!retried) return;
        outcome = retried;
    }

    if (outcome.status !== "closed") return;
    const result = outcome.result;
    if (result.warning) {
        ctx.ui.notify(result.warning, "warning");
    }
    ctx.ui.notify(formatCloseText(result), "info");
}

async function runStatusAction(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    facts: TaskFacts,
): Promise<void> {
    const { name: taskName } = facts;

    const env = await requireTasksEnv(pi, ctx);
    if (!env) return;

    const result = await readTaskResult(env.tasksDir, taskName);
    const startedAt = await readTaskStartedAt(env.tasksDir, taskName);
    const duration = formatDuration(startedAt, result?.finishedAt);

    // Attach line renders only while the tmux session still exists.
    // Include --task-root so the copied command works from any directory.
    const attachCommand = facts.sessionExists
        ? taskAttachCommand(taskName, env.repoRoot)
        : undefined;
    const attachCopied = attachCommand
        ? await copyToClipboard(pi, attachCommand)
        : false;

    const lines = formatLogWidgetLines(
        taskName,
        facts.worktree?.path,
        attachCommand,
        attachCopied,
        result,
        duration,
    );
    ctx.ui.setWidget("worktree-task-status", buildWidget(lines), {
        placement: "aboveEditor",
    });
}

async function runVscodeAction(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    facts: WorktreeTaskFacts,
): Promise<void> {
    await pi.exec("code", [facts.worktree.path]);
    ctx.ui.notify(
        `Opened VS Code for "${facts.name}" at ${facts.worktree.path}`,
        "info",
    );
}

// ─── Child Session History (/worktree-tasks sessions) ─────────────

type SessionAction = "preview" | "resume" | "addToPrompt";

/** Append "read session @<path>" to the editor (files.ts addFileToPrompt variant). */
function addSessionToPrompt(
    ctx: ExtensionCommandContext,
    sessionFile: string,
    mention = `read session @${sessionFile}`,
): void {
    const current = ctx.ui.getEditorText();
    const separator = current && !current.endsWith(" ") ? " " : "";
    ctx.ui.setEditorText(`${current}${separator}${mention}`);
    ctx.ui.notify(`Added ${mention} to prompt`, "info");
}

/**
 * Add the settled task's result output to the editor: the shortest path to
 * "continue from the task result" without loading the whole child session.
 * Failed tasks get the error appended (the status widget shows the same line).
 */
async function runAddResultAction(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    facts: TaskFacts,
): Promise<void> {
    const env = await requireTasksEnv(pi, ctx);
    if (!env) return;
    const result = await readTaskResult(env.tasksDir, facts.name);
    if (!result) {
        ctx.ui.notify(
            `Worktree task "${facts.name}" has no settled result.`,
            "error",
        );
        return;
    }
    let output = result.output.trim();
    if (result.status === "failed" && result.error?.trim()) {
        output += `${output ? "\n\n" : ""}Error: ${result.error.trim()}`;
    }
    const text = `worktree task ${facts.name} result:\n\n${output || "(no text output)"}`;
    const current = ctx.ui.getEditorText();
    const separator = current && !current.endsWith("\n") ? "\n" : "";
    ctx.ui.setEditorText(`${current}${separator}${text}`);
    ctx.ui.notify(`Added result for "${facts.name}" to prompt`, "info");
}

async function selectSessionAction(
    ctx: ExtensionCommandContext,
    info: SessionInfo,
): Promise<SessionAction | null> {
    const label = sessionDisplayLabel(info);
    const title = `Action for "${label.length > 40 ? `${label.slice(0, 39)}…` : label}"`;
    return showActionMenu<SessionAction>(ctx, title, [
        { value: "preview", label: "Preview" },
        { value: "addToPrompt", label: "Add to prompt" },
        { value: "resume", label: "Resume" },
    ]);
}

/**
 * `/worktree-tasks sessions`: child-session history picker over the shared
 * built-in /resume selector (Current Folder / All both read the same flat
 * dir). Selection opens the action menu; the flow ends after one action.
 * Resume replaces the current session; the handler returns immediately
 * afterwards because this ctx is stale.
 */
async function runSessionsFlow(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
): Promise<void> {
    if (!ctx.hasUI) {
        ctx.ui.notify(
            "/worktree-tasks sessions requires interactive mode",
            "error",
        );
        return;
    }

    const env = await requireTasksEnv(pi, ctx);
    if (!env) return;
    const sessionsDir = taskSessionsDir(env.tasksDir);
    if (!existsSync(sessionsDir)) {
        ctx.ui.notify("No worktree-task sessions yet.", "info");
        return;
    }

    const selected = await pickSession(ctx, {
        // One flat dir: both scopes read it (Tab has no distinct meaning here).
        current: (onProgress) =>
            SessionManager.listAll(sessionsDir, onProgress),
        all: (onProgress) => SessionManager.listAll(sessionsDir, onProgress),
        // ctrl+o previews the highlighted session in an overlay while the
        // picker stays open (same preview as the action menu below).
        onPreview: (sessionFile, label) =>
            previewSessionFile(ctx, label, sessionFile),
    });
    if (!selected) return;

    const action = await selectSessionAction(ctx, selected);
    if (!action) return;

    if (action === "preview") {
        await previewSessionFile(
            ctx,
            sessionDisplayLabel(selected),
            selected.path,
        );
        return;
    }

    if (action === "resume") {
        try {
            const result = await ctx.switchSession(selected.path);
            if (result.cancelled) {
                ctx.ui.notify("Resume cancelled.", "info");
                return;
            }
        } catch (error) {
            ctx.ui.notify(
                `Failed to resume session: ${errorMessage(error)}`,
                "error",
            );
        }
        // Session replaced (or resume failed terminally): stop using this ctx.
        return;
    }

    addSessionToPrompt(ctx, selected.path);
}
// ─── Formatting Helpers ───────────────────────────────────────────

/** Message of a caught value, whether or not it is an `Error`. */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function formatDuration(
    startedAt: number | undefined,
    finishedAt = Date.now(),
): string | undefined {
    if (startedAt === undefined) return undefined;
    const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
}

// ─── Status Widgets ───────────────────────────────────────────────

/** Run state shown in the status line: the settled status, or "running" while result.json is absent. */
type RunState = TaskStatus | "running";

const RUN_STATE_ICONS: Record<RunState, WidgetSegment> = {
    completed: { text: "✓", color: "success" },
    failed: { text: "✗", color: "error" },
    running: { text: "●", color: "warning" },
};

/**
 * Status action widget: state-only card, no output text.
 * Status line (✓/✗/● + alias + status · duration); a truncated Error line
 * under the status line on failed; attach line only while the tmux session
 * still exists (attachCommand undefined otherwise), with " (copied)" appended
 * when the command was copied to the clipboard; provider/model line once
 * settled; worktree line while the worktree dir still exists.
 */
function formatLogWidgetLines(
    alias: string,
    worktreePath: string | undefined,
    attachCommand: string | undefined,
    attachCopied: boolean,
    result: WorktreeTaskResult | null,
    duration?: string,
): WidgetLine[] {
    const status: RunState = result?.status ?? "running";
    const icon = RUN_STATE_ICONS[status];

    const lines: WidgetLine[] = [];
    lines.push([
        icon,
        { text: " " },
        { text: alias, color: "toolTitle", bold: true },
        {
            text: ` · ${status}${duration ? ` · ${duration}` : ""}`,
            color: "muted",
        },
    ]);
    if (status === "failed" && result?.error?.trim()) {
        // One truncated line; the full error lives in result.json / the child session.
        const errorFirstLine = result.error.trim().split("\n")[0] ?? "";
        const errorLine =
            errorFirstLine.length > 160
                ? `${errorFirstLine.slice(0, 159)}…`
                : errorFirstLine;
        lines.push([{ text: `  Error: ${errorLine}`, color: "error" }]);
    }
    if (attachCommand) {
        lines.push([
            {
                text: `  ${attachCommand}${attachCopied ? " (copied)" : ""}`,
                color: "accent",
            },
        ]);
    }
    if (result) {
        lines.push([
            {
                text: `  ${result.provider ?? ""}/${result.model ?? ""} (${result.thinking ?? ""})`,
                color: "dim",
            },
        ]);
    }
    if (worktreePath !== undefined) {
        lines.push([{ text: `  worktree: ${worktreePath}`, color: "dim" }]);
    }
    lines.push("");
    return lines;
}

// ─── Session Management ───────────────────────────────────────────

async function ensureSession(
    pi: ExtensionAPI,
    socket: string,
    session: string,
    cwd: string,
): Promise<boolean> {
    const hasSession = await pi.exec("tmux", [
        "-S",
        socket,
        "has-session",
        "-t",
        session,
    ]);
    if (hasSession.code === 0) return true;

    await mkdir(path.dirname(socket), { recursive: true });
    const create = () =>
        pi.exec("tmux", [
            "-S",
            socket,
            "new-session",
            "-d",
            "-s",
            session,
            "-c",
            cwd,
        ]);
    let result = await create();
    if (result.code !== 0 && existsSync(socket)) {
        // Stale socket file (server died, file left behind) blocks new-session:
        // confirm no server listens, then remove the file and retry once.
        const probe = await pi.exec("tmux", ["-S", socket, "list-sessions"]);
        if (probe.code !== 0) {
            await rm(socket, { force: true });
            result = await create();
        }
    }
    return result.code === 0;
}

// ─── Task Close (worktree + session) ──────────────────────────────

interface CloseResult {
    name: string;
    leftoverCount: number;
    /** First leftover paths (truncated like the shell's own output). */
    leftovers?: string[];
    /** One of at most one: session kill or run-dir removal partially failed. */
    warning?: string;
}

/** One git status per close: dirty is not tracked in the task list anymore. */
async function isWorktreeDirty(
    pi: ExtensionAPI,
    worktreePath: string,
): Promise<boolean> {
    const result = await pi.exec("git", [
        "-C",
        worktreePath,
        "status",
        "--porcelain",
    ]);
    return result.code === 0 && result.stdout.trim().length > 0;
}

/** closeTask outcome: "dirty" / "leftover" ask the caller to confirm a forced retry; "closed" finished the cleanup. */
type CloseOutcome =
    | { status: "dirty" }
    | { status: "leftover" }
    | { status: "closed"; result: CloseResult };

/**
 * Close a worktree task. Removes the worktree if one is registered at
 * the derived path (a dirty one returns the "dirty" outcome unless force;
 * a missing path counts as already cleaned, so close stays idempotent).
 * If the path exists but git is not a worktree there, the "leftover"
 * outcome asks for confirmation first — its contents may be the child's
 * uncommitted work. Also kills the
 * tmux session when present and deletes the run dir (task.md /
 * result.json) — the task list is sourced from tasks/, so leftover
 * artifacts would be orphaned. The sessions dir (child session history)
 * is append-only and never touched here.
 *
 * Failures throw a user-facing Error; a successful close returns "closed".
 */
async function closeTask(
    pi: ExtensionAPI,
    opts: { name: string; force?: boolean },
): Promise<CloseOutcome> {
    const { name, force = false } = opts;
    const facts = await resolveTaskFacts(pi, name);

    let cleanOutput: CleanOutput | null = null;
    if (facts.worktree !== undefined) {
        // A real git worktree, or just a leftover directory at the derived
        // path? Ask git: a leftover resolves --show-toplevel to the main
        // repo (or fails), so the dirty probe below would report the main
        // repo's entries instead of this directory's contents.
        const probe = await pi.exec("git", [
            "-C",
            facts.worktree.path,
            "rev-parse",
            "--show-toplevel",
        ]);
        // .git must be a file: a registered worktree's .git links back to
        // the main repo, while a leftover directory that is itself a repo
        // root has a .git directory (so rev-parse would answer from it and
        // trick the probe into "registered" — then clean always fails
        // without --force and Close dead-ends).
        let registered = false;
        try {
            registered =
                probe.code === 0 &&
                probe.stdout.trim() === facts.worktree.path &&
                statSync(path.join(facts.worktree.path, ".git")).isFile();
        } catch {
            registered = false;
        }
        if (!registered && !force) {
            return { status: "leftover" };
        }
        let dirty = false;
        if (registered) {
            dirty = await isWorktreeDirty(pi, facts.worktree.path);
            if (dirty && !force) {
                return { status: "dirty" };
            }
        }

        // Leftover removal always goes through --force; worktree.sh only
        // deletes a plain (unregistered) directory under that flag.
        const cleanArgs = [WORKTREE_SH, "clean", name];
        // Include force: the leftover retry re-enters closeTask with
        // force=true after the user confirmed; without it the identical
        // command runs again and the retry is a silent no-op.
        if (dirty || !registered || force) cleanArgs.push("--force");
        cleanArgs.push("--json");
        const cleanResult = await pi.exec("bash", cleanArgs);
        if (cleanResult.code !== 0) {
            // The shell re-decides registration at clean time; exit 3 is
            // its dedicated "unregistered directory, no --force" refusal
            // (any other non-zero is a real git failure). Fall back to the
            // leftover confirmation instead of dead-ending Close.
            if (cleanResult.code === 3) {
                return { status: "leftover" };
            }
            throw new Error(
                cleanResult.stderr.trim() || "Failed to remove worktree.",
            );
        }
        cleanOutput = parseScriptOutput<CleanOutput>(cleanResult.stdout);
    }

    // Kill the session when present; failure is only a warning.
    const env = await getTasksEnv(pi);
    let sessionWarn: string | undefined;
    if (facts.sessionExists) {
        if (env) {
            const killResult = await pi.exec("tmux", [
                "-S",
                env.socketPath,
                "kill-session",
                "-t",
                taskSessionName(taskUuid(name)),
            ]);
            if (killResult.code !== 0) {
                sessionWarn = `Cleanup partially failed: tmux session "${name}" could not be killed.`;
            }
        }
    }

    // Remove the run dir (task.md + result.json) after successful cleanup:
    // best-effort, skipped when the session kill failed (the child may still
    // be writing result.json there). Failure to delete is only a warning.
    let runDirWarn: string | undefined;
    if (env && !sessionWarn) {
        try {
            await rm(taskRunDir(env.tasksDir, name), {
                recursive: true,
                force: true,
            });
        } catch (error) {
            runDirWarn = `Failed to remove run artifacts: ${errorMessage(error)}`;
        }
    }

    // Worktree gone; branch (usually) kept.
    return {
        status: "closed",
        result: {
            name,
            leftoverCount: cleanOutput?.leftoverCount ?? 0,
            leftovers: cleanOutput?.leftovers,
            warning: sessionWarn ?? runDirWarn,
        },
    };
}

function formatCloseText(result: CloseResult): string {
    let msg = `Worktree task "${result.name}" closed.`;
    if (result.leftoverCount > 0) {
        msg += ` Warning: ${result.leftoverCount} leftover file(s):`;
        const shown = result.leftovers?.slice(0, 3) ?? [];
        for (const item of shown) {
            msg += `
  ${item}`;
        }
        const hidden = result.leftoverCount - shown.length;
        if (hidden > 0) msg += `
  ...and ${hidden} more`;
    }
    // Without this line the next dispatch of a reused alias fails with an
    // alias-branch conflict that reads like an unrelated git problem.
    // Hedged: a leftover-dir close means the branch may not exist.
    msg += `
Branch "${result.name}" may remain — delete it when done (git branch -D ${result.name}).`;
    return msg;
}

// ─── Worktree Task Dispatch ───────────────────────────────────────

/** Thrown by dispatchWorktreeTask when the alias is already taken (live tmux session or existing run dir). */
export class TaskAliasConflictError extends Error {}

export interface DispatchResult {
    alias: string;
    /** sha256(alias) truncated to 16 hex chars — worktree/run/session key. */
    uuid: string;
    /** Fresh git worktree the child runs in. */
    worktreePath?: string;
    tmuxSession: string;
    attachCommand: string;
    provider: string;
    model: string;
    thinking: string;
    prompt: string;
}

export async function dispatchWorktreeTask(
    pi: ExtensionAPI,
    opts: {
        alias: string;
        prompt: string;
        description: string;
        ctx: ExtensionContext;
    },
): Promise<DispatchResult> {
    const { alias, prompt, description, ctx } = opts;
    await validateAlias(pi, alias);

    // Model check first: no filesystem side effects before it can pass.
    const provider = ctx.model?.provider;
    const model = ctx.model?.id;
    const thinking = pi.getThinkingLevel();
    if (!provider || !model) {
        throw new Error("No model is active. Cannot dispatch worktree task.");
    }

    const env = await getTasksEnv(pi);
    if (!env) {
        throw new Error("Failed to resolve repo root (worktree.sh root-path)");
    }
    const uuid = taskUuid(alias);
    const session = taskSessionName(uuid);

    // Conflict detection: a live tmux session means the alias is taken. The
    // run-dir mkdir below is the atomic claim (EEXIST), so a concurrent
    // duplicate dispatch cannot slip through.
    const sessions = await listSessionNames(pi, env.socketPath);
    if (sessions.includes(session)) {
        throw new TaskAliasConflictError(
            `Worktree task "${alias}" already exists (tmux session). Choose a different alias.`,
        );
    }

    // Atomic claim: non-recursive mkdir — EEXIST is the conflict, no
    // check-then-create race. Every failure after this point leaves a task
    // that is listed and closable via /worktree-tasks.
    const runDir = taskRunDir(env.tasksDir, alias);
    try {
        await mkdir(path.dirname(runDir), { recursive: true, mode: 0o700 });
        await mkdir(runDir, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
            throw new TaskAliasConflictError(
                `Worktree task "${alias}" already exists (run dir). Choose a different alias.`,
            );
        }
        throw new Error(
            `Failed to prepare run directory: ${errorMessage(error)}`,
        );
    }

    const sessionDir = taskSessionsDir(env.tasksDir);
    const promptPath = path.join(runDir, "task.md");
    const resultPath = path.join(runDir, "result.json");
    try {
        await mkdir(sessionDir, { recursive: true, mode: 0o700 });
        await writeFile(promptPath, `${prompt}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
    } catch (error) {
        throw new Error(
            `Failed to prepare run directory: ${errorMessage(error)}`,
        );
    }

    // Fresh git worktree for the child (branch = alias). Every failure below
    // happens before any session or worktree exists, so rolling back the
    // run-dir claim keeps the alias immediately retryable and stops a phantom
    // task from masking the real failure reason.
    const rollbackRunDir = () =>
        rm(runDir, { recursive: true, force: true }).catch(() => {});

    const wtResult = await pi.exec("bash", [
        WORKTREE_SH,
        "open",
        alias,
        "--json",
    ]);
    if (wtResult.code !== 0) {
        await rollbackRunDir();
        throw new Error(wtResult.stderr.trim() || "worktree.sh open failed");
    }
    const opened = parseScriptOutput<OpenOutput>(wtResult.stdout);
    if (!opened) {
        await rollbackRunDir();
        throw new Error("Failed to parse worktree output");
    }
    // Second line of defence: worktree.sh reports success only for a
    // directory that exists; a missing one would make tmux silently
    // start the child in $HOME instead.
    if (!existsSync(opened.worktreePath)) {
        await rollbackRunDir();
        throw new Error(
            `worktree.sh open reported ${opened.worktreePath} but the directory does not exist.`,
        );
    }
    const worktreePath = opened.worktreePath;
    const cleanupHint = `run dir/worktree already created (clean up: user runs /worktree-tasks, select "${alias}", then Close)`;
    const sessionOk = await ensureSession(
        pi,
        env.socketPath,
        session,
        worktreePath,
    );
    if (!sessionOk) {
        throw new Error(
            `Failed to start tmux session "${session}". (${cleanupHint})`,
        );
    }

    const remain = await pi.exec("tmux", [
        "-S",
        env.socketPath,
        "set-window-option",
        "-t",
        `${session}:0`,
        "remain-on-exit",
        "on",
    ]);
    if (remain.code !== 0) {
        throw new Error(
            `${remain.stderr.trim() || "Failed to set remain-on-exit."} (${cleanupHint})`,
        );
    }

    const tmuxTarget = `${session}:0.0`;
    const attachCommand = taskAttachCommand(alias, env.repoRoot);
    const piArgs = [
        ...getPiInvocationParts(),
        "--provider",
        provider,
        "--model",
        model,
        "--thinking",
        thinking,
        "--session-dir",
        sessionDir,
        "--session-id",
        `${uuid}-${randomUUID().slice(0, 6)}`,
        "--name",
        description,
        "--approve",
        "--extension",
        EXTENSION_PATH,
        `@${promptPath}`,
    ];
    const childCommand = [
        "exec env",
        `${TASK_CHILD_ENV}=1`,
        `${TASK_RESULT_ENV}=${shellQuote(resultPath)}`,
        `${TASK_ALIAS_ENV}=${shellQuote(alias)}`,
        piArgs.map(shellQuote).join(" "),
    ].join(" ");

    const sent = await pi.exec("tmux", [
        "-S",
        env.socketPath,
        "send-keys",
        "-t",
        tmuxTarget,
        "-l",
        "--",
        childCommand,
    ]);
    if (sent.code !== 0) {
        throw new Error(
            `${sent.stderr.trim() || "Failed to start child Pi."} (${cleanupHint})`,
        );
    }
    const entered = await pi.exec("tmux", [
        "-S",
        env.socketPath,
        "send-keys",
        "-t",
        tmuxTarget,
        "Enter",
    ]);
    if (entered.code !== 0) {
        throw new Error(
            `${entered.stderr.trim() || "Failed to submit child command."} (${cleanupHint})`,
        );
    }

    return {
        alias,
        uuid,
        worktreePath,
        tmuxSession: session,
        attachCommand,
        provider,
        model,
        thinking,
        prompt,
    };
}

function formatDispatchText(result: DispatchResult): string {
    const lines = [`Dispatched worktree task "${result.alias}".`];
    if (result.worktreePath) {
        lines.push(`Worktree: ${result.worktreePath}`);
    }
    lines.push(
        `Observe progress or clean up via /worktree-tasks (select "${result.alias}").`,
    );
    return lines.join("\n");
}

// ─── Attach Flag (pi --attach-worktree-task <alias>) ─────────────────────────

function currentTmuxSocket(): string | undefined {
    const socket = process.env.TMUX?.split(",", 1)[0]?.trim();
    return socket || undefined;
}

/**
 * Value of `--<name> <value>` / `--<name>=<value>` in argv, scanning from the
 * first user argument. Empty string when the flag is present without a value;
 * undefined when absent.
 */
function flagValue(argv: string[], name: string): string | undefined {
    const flag = `--${name}`;
    for (let index = 2; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === "--") break;
        if (argument === flag) {
            const value = argv[index + 1];
            return !value || value.startsWith("--") ? "" : value;
        }
        if (argument.startsWith(`${flag}=`))
            return argument.slice(flag.length + 1);
    }
    return undefined;
}

function attachToWorktreeTaskAndExit(
    rawAlias: string,
    rawRoot?: string,
): never {
    const alias = rawAlias.trim();
    if (!alias) {
        console.error(
            `Error: --${ATTACH_FLAG} requires a worktree-task alias.`,
        );
        process.exit(2);
    }
    let repoRoot: string;
    if (rawRoot !== undefined) {
        const trimmed = rawRoot.trim();
        if (!trimmed) {
            console.error(
                `Error: --${TASK_ROOT_FLAG} requires a repo root path.`,
            );
            process.exit(2);
        }
        // Tilde expansion for convenience; the rest is path.resolve (handles relative).
        const home = process.env.HOME ?? os.homedir();
        let expanded = trimmed;
        if (trimmed === "~") expanded = home;
        else if (trimmed.startsWith("~/"))
            expanded = path.join(home, trimmed.slice(2));
        repoRoot = path.resolve(expanded);
        if (!existsSync(repoRoot)) {
            console.error(
                `Error: --${TASK_ROOT_FLAG} "${rawRoot}" does not exist.`,
            );
            process.exit(2);
        }
    } else {
        const root = spawnSync("git", ["rev-parse", "--show-toplevel"], {
            encoding: "utf8",
        });
        if (root.status !== 0 || !root.stdout.trim()) {
            console.error(
                `Error: --${ATTACH_FLAG} must be run from inside the repository that dispatched the task (or pass --${TASK_ROOT_FLAG} <repoRoot>).`,
            );
            process.exit(2);
        }
        repoRoot = root.stdout.trim();
    }
    const socketPath = path.join(repoRoot, ...TASKS_DIR_PARTS, "tmux.sock");
    if (!existsSync(socketPath)) {
        console.error(
            `Error: no worktree-task tmux socket at ${socketPath}. Dispatched a task from this repo?`,
        );
        process.exit(2);
    }

    const session = taskSessionName(taskUuid(alias));
    const probe = spawnSync(
        "tmux",
        ["-S", socketPath, "has-session", "-t", session],
        { encoding: "utf8" },
    );
    if (probe.status !== 0) {
        console.error(
            `Error: no live tmux session for worktree task "${alias}" (settled or closed).`,
        );
        process.exit(2);
    }

    const sameServer = currentTmuxSocket() === socketPath;
    const args = [
        "-S",
        socketPath,
        sameServer ? "switch-client" : "attach-session",
        "-t",
        session,
    ];
    const env = { ...process.env };
    if (!sameServer) {
        delete env.TMUX;
        delete env.TMUX_PANE;
    }
    const result = spawnSync("tmux", args, { stdio: "inherit", env });
    if (result.error)
        console.error(`Failed to run tmux: ${result.error.message}`);
    process.exit(result.status ?? 1);
}

// ─── Commands & Tools ─────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
    // `pi --attach-worktree-task <alias> [--task-root <repoRoot>]`: attach to a
    // dispatched task's tmux session and exit (never starts the normal TUI).
    // Registered before child mode so the flags work in every invocation context.
    pi.registerFlag(ATTACH_FLAG, {
        description: "Attach to a worktree-task tmux session by task alias",
        type: "string",
    });
    pi.registerFlag(TASK_ROOT_FLAG, {
        description: "Repo root for --attach-worktree-task",
        type: "string",
    });
    const attachTarget = flagValue(process.argv, ATTACH_FLAG);
    if (attachTarget !== undefined) {
        const taskRoot = flagValue(process.argv, TASK_ROOT_FLAG);
        attachToWorktreeTaskAndExit(attachTarget, taskRoot);
    }

    // Child mode (dispatched worktree task): register only the result
    // reporter — no slash commands, no agent tools.
    if (process.env[TASK_CHILD_ENV] === "1") {
        const resultPath = process.env[TASK_RESULT_ENV];
        if (!resultPath) {
            console.error(
                `[worktree-task] ${TASK_RESULT_ENV} is required in child mode.`,
            );
            return;
        }
        registerTaskChildReporter(pi, resultPath);
        return;
    }

    // Clear worktree-task widgets when a new turn starts so they don't block conversation output.
    pi.on("turn_start", async (_event, ctx) => {
        ctx.ui.setWidget("worktree-task-status", undefined);
    });

    // ── /worktree-tasks ──  (single entry point: task list → action → execute, loop)
    pi.registerCommand("worktree-tasks", {
        description:
            "List worktree tasks and run an action (status / add to prompt / add result / preview / vscode / close); 'sessions' picks a child session (resume / add to prompt)",
        handler: async (args, ctx) => {
            // `/worktree-tasks sessions`: child-session history picker.
            if (args.trim() === "sessions") {
                await runSessionsFlow(pi, ctx);
                return;
            }

            // files.ts pattern: esc at the action selector returns to the task
            // list; esc at the task list exits. Actions run directly (no command
            // pasting), so several tasks can be observed in one invocation.
            while (true) {
                const selected = await selectTask(
                    pi,
                    ctx,
                    "Select worktree task",
                );
                if (!selected) return;

                const action = await selectTaskAction(ctx, selected);
                if (!action) continue;

                switch (action) {
                    case "status":
                        await runStatusAction(pi, ctx, selected);
                        break;
                    case "addToPrompt": {
                        const { sessionFile } = selected as SettledTaskFacts;
                        // Alias (= branch) names the task up front: the session
                        // file name only carries a uuid.
                        addSessionToPrompt(
                            ctx,
                            sessionFile,
                            `read worktree task ${selected.name} session @${sessionFile}`,
                        );
                        // Session added to the editor: the task's purpose is served;
                        // returning to the list has no next step. Exit the flow.
                        return;
                    }
                    case "result":
                        await runAddResultAction(pi, ctx, selected);
                        // Result added to the editor: same as addToPrompt,
                        // no next step in the list. Exit the flow.
                        return;
                    case "preview": {
                        const { name, sessionFile } =
                            selected as SettledTaskFacts;
                        await previewSessionFile(ctx, name, sessionFile);
                        break;
                    }
                    case "vscode":
                        // Menu boundary assertion: taskActionItems only
                        // offers vscode when a worktree exists.
                        await runVscodeAction(
                            pi,
                            ctx,
                            selected as WorktreeTaskFacts,
                        );
                        // Attention moved to the external editor; no reason to loop
                        // back into the list. Exit the flow.
                        return;
                    case "close":
                        await runCloseAction(pi, ctx, selected);
                        break;
                }
            }
        },
    });

    // ── Tool: worktree_task ──
    // One-shot worktree task: fresh git worktree + interactive child Pi,
    // dispatched and returned immediately (no waiting / polling).

    pi.registerTool({
        name: "worktree_task",
        label: "Worktree task",
        description:
            "Dispatch a one-shot worktree task: create a tmux session keyed by the task alias (the child runs in a fresh git worktree, branch = alias), then start an interactive Pi process with the given prompt. Returns immediately without waiting for the task. Progress and completion are observed by the user via /worktree-tasks. Fails fast if the alias already exists.",
        promptSnippet:
            "Dispatch a one-shot worktree task (isolated fresh git worktree); returns immediately.",
        promptGuidelines: [
            "worktree_task is fire-and-forget — returns immediately, the user observes via /worktree-tasks.",
            "Keep worktree_task's prompt free of commit instructions; leave the work uncommitted so the user can review before anything lands.",
            "Write file paths in the prompt relative to the worktree root (the child Pi's cwd is the fresh worktree, which contains all committed repo files, so relative paths also work for read-only references). Never put an absolute main-repo path in the prompt: the child follows literal paths and would edit the main repo, bypassing worktree isolation. If the child needs uncommitted main-repo content as context, paste the relevant snippet into the prompt instead of a path.",
            "Never clean up a worktree task yourself (worktree removal, session kill, run dir deletion); the user closes it via /worktree-tasks after reviewing.",
        ],
        parameters: Type.Object({
            alias: Type.String({
                description:
                    "Task alias: 1-64 chars, must start with a letter or digit, then letters/digits/./_/- (flat names, no slashes; e.g. fix-socket-hang). Also used as the branch name. Must not already exist.",
            }),
            prompt: Type.String({
                description:
                    "The task for the agent to perform. Be specific about what needs to be done and include any relevant context. Reference files by paths relative to the worktree root; never absolute paths into the main repo.",
            }),
            description: Type.String({
                description:
                    "A very short description of the task that can be displayed to the user.",
            }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const alias =
                typeof params.alias === "string" ? params.alias.trim() : "";
            const prompt =
                typeof params.prompt === "string" ? params.prompt.trim() : "";
            const description =
                typeof params.description === "string"
                    ? params.description.trim()
                    : "";
            if (!alias) {
                throw new Error("worktree_task requires a non-empty alias.");
            }
            if (!prompt) {
                throw new Error("worktree_task requires a non-empty prompt.");
            }
            if (!description) {
                throw new Error(
                    "worktree_task requires a non-empty description.",
                );
            }
            const result = await dispatchWorktreeTask(pi, {
                alias,
                prompt,
                description,
                ctx,
            });
            return {
                content: [
                    { type: "text" as const, text: formatDispatchText(result) },
                ],
                details: result,
            };
        },
        renderCall(args, theme) {
            const description =
                typeof args.description === "string" && args.description.trim()
                    ? args.description.trim()
                    : "...";
            const text =
                theme.fg("toolTitle", theme.bold("worktree_task ")) +
                theme.fg("dim", description);
            return new Text(text, 0, 0);
        },
        renderResult(result, { expanded }, theme, context) {
            const details = result.details as DispatchResult;
            if (context.isError) {
                const content = result.content.find(
                    (part) => part.type === "text",
                );
                return new Text(
                    content?.type === "text" ? content.text : "(no output)",
                    0,
                    0,
                );
            }
            if (expanded) {
                const container = new Container();
                container.addChild(
                    new Text(
                        `${theme.fg("warning", "●")} ${theme.fg("toolTitle", theme.bold(details.alias))}${theme.fg("muted", " · dispatched")}`,
                        0,
                        0,
                    ),
                );
                container.addChild(
                    new Text(theme.fg("accent", details.attachCommand), 0, 0),
                );
                container.addChild(
                    new Text(
                        theme.fg(
                            "dim",
                            `${details.provider}/${details.model} (${details.thinking})`,
                        ),
                        0,
                        0,
                    ),
                );
                container.addChild(new Text(BLANK_ROW, 1, 0));
                container.addChild(
                    new Text(theme.fg("muted", "─── Prompt ───"), 0, 0),
                );
                container.addChild(
                    new Text(theme.fg("dim", details.prompt), 0, 0),
                );
                return container;
            }
            // Compact view.
            let text = `${theme.fg("warning", "●")} ${theme.fg("toolTitle", theme.bold(details.alias))}`;
            text += theme.fg("muted", " · dispatched");
            text += `\n  ${theme.fg("accent", details.attachCommand)}`;
            text += `\n  ${theme.fg("dim", `${details.provider}/${details.model} (${details.thinking})`)}`;
            return new Text(text, 0, 0);
        },
    });
}
