import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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
import { pickSession } from "./pick-session.ts";
import {
    previewSessionFile,
    sessionDisplayLabel,
} from "./lib/session-preview.ts";
import { Type } from "typebox";

// ─── Script Resolution ────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, "background-task");
const WORKTREE_SH = path.join(SCRIPTS_DIR, "worktree.sh");

/** `pi --attach-background-task <alias> [--task-root <repoRoot>]`: attach to a dispatched task's tmux session. */
const ATTACH_FLAG = "attach-background-task";
/** Repo root for the attach target; bypasses `git rev-parse` when supplied. */
const TASK_ROOT_FLAG = "task-root";
const TASKS_DIR_PARTS = [".pi", "background-tasks"] as const;

// ─── Background-task Child Mode ───────────────────────────────────

const TASK_CHILD_ENV = "PI_BACKGROUND_TASK_CHILD";
const TASK_RESULT_ENV = "PI_BACKGROUND_TASK_RESULT";
const TASK_ALIAS_ENV = "PI_BACKGROUND_TASK_ALIAS";
const EXTENSION_PATH = fileURLToPath(import.meta.url);

async function copyToClipboard(
    pi: ExtensionAPI,
    text: string,
): Promise<boolean> {
    for (const cmd of ["xclip -selection clipboard", "pbcopy"]) {
        const bin = cmd.split(" ")[0];
        const check = await pi.exec("which", [bin]);
        if (check.code !== 0) continue;
        const result = await pi.exec("bash", [
            "-c",
            `${cmd} <<< ${JSON.stringify(text)}`,
        ]);
        if (result.code === 0) return true;
    }
    return false;
}

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

function buildWidget(lines: WidgetLine[], footer?: string) {
    return (_tui: TUI, theme: Theme) => {
        const container = new Container();
        for (const line of lines) {
            if (typeof line === "string") {
                // Map empty / unicode-whitespace-only rows to BLANK_ROW so Text keeps height
                if (
                    line.length === 0 ||
                    line === BLANK_ROW ||
                    /^[\s\u00A0]*$/.test(line)
                ) {
                    container.addChild(new Text(BLANK_ROW, 1, 0));
                    continue;
                }
                container.addChild(new Text(line, 1, 0));
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

function validateAlias(alias: string): void {
    if (!ALIAS_PATTERN.test(alias)) {
        throw new Error(
            `Invalid task alias "${alias}": 1-64 chars, must start with a letter or digit, may contain letters, digits, ".", "_" and "-" (slashes are not allowed).`,
        );
    }
}

function taskSessionName(uuid: string): string {
    return `background-task-${uuid}`;
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

// ─── Child Reporter (background task result.json) ─────────────────

interface BackgroundTaskResult {
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
        const branch = process.env[TASK_ALIAS_ENV];
        const result: BackgroundTaskResult = {
            version: 1,
            branch: branch && branch.length > 0 ? branch : undefined,
            status: failed ? "failed" : "completed",
            output,
            error:
                fallbackError ??
                assistantError ??
                (!assistant
                    ? "Background task exited without an assistant response."
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
                `[background-task] Failed to write result: ${error instanceof Error ? error.message : String(error)}`,
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
                "Background task session shut down before the task settled.",
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

/** Parse one JSON file from a run dir; null when missing or unreadable. */
async function readRunJson(
    tasksDir: string,
    alias: string,
    file: string,
): Promise<unknown> {
    try {
        return JSON.parse(
            await readFile(path.join(taskRunDir(tasksDir, alias), file), "utf8"),
        );
    } catch {
        return null;
    }
}

async function readTaskResult(
    tasksDir: string,
    alias: string,
): Promise<BackgroundTaskResult | null> {
    return (await readRunJson(
        tasksDir,
        alias,
        "result.json",
    )) as BackgroundTaskResult | null;
}

/** Dispatch-time registry record; worktree is intent, reality is probed via existsSync. */
interface TaskMeta {
    version: 1;
    worktree: boolean;
}

async function readTaskMeta(
    tasksDir: string,
    alias: string,
): Promise<TaskMeta | null> {
    const value = await readRunJson(tasksDir, alias, "meta.json");
    if (
        value &&
        typeof value === "object" &&
        (value as TaskMeta).version === 1 &&
        typeof (value as TaskMeta).worktree === "boolean"
    ) {
        return value as TaskMeta;
    }
    return null;
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
    success: boolean;
    worktreePath: string;
    leftoverCount: number;
    leftovers: string[];
}

// ─── Script Output Parsers ────────────────────────────────────────

function parseOpenOutput(stdout: string): OpenOutput | null {
    try {
        return JSON.parse(stdout);
    } catch {
        return null;
    }
}

function parseCleanOutput(stdout: string): CleanOutput | null {
    try {
        return JSON.parse(stdout);
    } catch {
        return null;
    }
}

// ─── Background task Facts ───────────────────────────────────────

/** Task status transposed verbatim from result.json; undefined while running. */
type TaskStatus = "completed" | "failed";

/**
 * Independent facts about one background-task alias. The run dir
 * (tasks/<alias>) is the source of truth; the worktree is optional and
 * expressed by the optional worktree entity (meta.json intent × existsSync
 * reality).
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
 * meta.json worktree intent × existsSync worktree reality (a missing
 * worktree path, e.g. manually removed, reads as already cleaned) joined
 * with result.json status and tmux session existence. The caller supplies
 * env and session names so listing resolves them once for all tasks.
 */
async function taskFactsFor(
    env: TasksEnv,
    sessions: string[],
    name: string,
): Promise<TaskFacts> {
    // Worktree: meta.json intent, written at the atomic claim before any
    // worktree side effect, so a missing meta only means a broken run dir.
    const meta = await readTaskMeta(env.tasksDir, name);
    const worktreePath = taskWorktreePath(env.repoRoot, name);
    const worktree =
        meta?.worktree && existsSync(worktreePath)
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

async function resolveTaskFacts(
    pi: ExtensionAPI,
    name: string,
): Promise<TaskFacts> {
    const env = await getTasksEnv(pi);
    if (!env) {
        throw new Error(
            "Failed to resolve repo root for background-task artifacts.",
        );
    }
    // tmux session (per-repo socket, session named background-task-<uuid>)
    const sessions = await listSessionNames(pi, env.socketPath);
    return taskFactsFor(env, sessions, name);
}

// ─── UI Select Helpers ────────────────────────────────────────────

/**
 * Background task list: readdir of tasks/ (the source of truth — one
 * subdirectory per task) joined with meta.json worktree intent, existsSync
 * worktree reality, result.json task status, and tmux session existence.
 * Dirty state is not listed; it is computed at close time for the selected
 * task only.
 */
async function listTasks(pi: ExtensionAPI): Promise<TaskFacts[]> {
    const env = await getTasksEnv(pi);
    if (!env) return [];

    let entries;
    try {
        entries = await readdir(tasksRoot(env.tasksDir), {
            withFileTypes: true,
        });
    } catch {
        return [];
    }
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
        ctx.ui.notify("No background tasks available.", "info");
        return null;
    }

    // Display row: "<alias> (<taskStatus>|running) (no worktree) (no session)"
    // — each mark omitted per facts; running = live session, no result yet.
    // Map display strings back to facts to avoid parsing.
    const displayToFacts = new Map<string, TaskFacts>();
    for (const task of tasks) {
        const marks: string[] = [];
        if (task.taskStatus) marks.push(task.taskStatus);
        else if (task.sessionExists) marks.push("running");
        const mark = marks.length > 0 ? ` (${marks.join(", ")})` : "";
        const noWorktree = task.worktree ? "" : " (no worktree)";
        const noSession = task.sessionExists ? "" : " (no session)";
        displayToFacts.set(
            `${task.name}${mark}${noWorktree}${noSession}`,
            task,
        );
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
        label: facts.worktree
            ? "Close (remove worktree + kill session)"
            : "Close (kill session + remove artifacts)",
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

// ─── Action Runners (executed directly by the /background-tasks flow) ──────

async function runCloseAction(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    facts: TaskFacts,
): Promise<void> {
    let outcome: CloseOutcome;
    try {
        outcome = await closeTask(pi, { name: facts.name });
    } catch (error) {
        ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
        );
        return;
    }

    // Dirty worktree: interactive confirm maps to a forced retry; never
    // close one without it (dirty is computed inside closeTask, once per
    // attempt — the task list does not track it anymore).
    if (outcome.status === "dirty") {
        const proceed = await ctx.ui.confirm(
            "Dirty Worktree",
            `Background task "${facts.name}" has uncommitted changes. Close anyway?`,
        );
        if (!proceed) {
            ctx.ui.notify("Cancelled.", "info");
            return;
        }
        try {
            outcome = await closeTask(pi, { name: facts.name, force: true });
        } catch (error) {
            ctx.ui.notify(
                error instanceof Error ? error.message : String(error),
                "error",
            );
            return;
        }
    }

    // Unreachable in practice: force closes a dirty worktree unconditionally.
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

    const env = await getTasksEnv(pi);
    if (!env) {
        ctx.ui.notify(
            "Failed to resolve repo root for background-task artifacts.",
            "error",
        );
        return;
    }

    const result = await readTaskResult(env.tasksDir, taskName);
    const startedAt = await readTaskStartedAt(env.tasksDir, taskName);
    const duration = formatDuration(startedAt, result?.finishedAt);

    // Attach line renders only while the tmux session still exists.
    // Include --task-root so the copied command works from any directory.
    const attachCommand = facts.sessionExists
        ? taskAttachCommand(taskName, env.repoRoot)
        : undefined;

    let attachCopied = false;
    if (attachCommand) {
        attachCopied = await copyToClipboard(pi, attachCommand);
    }

    const lines = formatLogWidgetLines(
        taskName,
        facts.worktree?.path,
        attachCommand,
        attachCopied,
        result,
        duration,
    );
    ctx.ui.setWidget("background-task-status", buildWidget(lines), {
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

// ─── Child Session History (/background-tasks sessions) ──────────

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
    const env = await getTasksEnv(pi);
    if (!env) {
        ctx.ui.notify(
            "Failed to resolve repo root for background-task artifacts.",
            "error",
        );
        return;
    }
    const result = await readTaskResult(env.tasksDir, facts.name);
    if (!result) {
        ctx.ui.notify(
            `Background task "${facts.name}" has no settled result.`,
            "error",
        );
        return;
    }
    let output = result.output.trim();
    if (result.status === "failed" && result.error?.trim()) {
        output += `${output ? "\n\n" : ""}Error: ${result.error.trim()}`;
    }
    const text = `background task ${facts.name} result:\n\n${output || "(no text output)"}`;
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
 * `/background-tasks sessions`: child-session history picker over the shared
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
            "background-tasks sessions requires interactive mode",
            "error",
        );
        return;
    }

    const env = await getTasksEnv(pi);
    if (!env) {
        ctx.ui.notify(
            "Failed to resolve repo root for background-task artifacts.",
            "error",
        );
        return;
    }
    const sessionsDir = taskSessionsDir(env.tasksDir);
    if (!existsSync(sessionsDir)) {
        ctx.ui.notify("No background-task sessions yet.", "info");
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
                `Failed to resume session: ${error instanceof Error ? error.message : String(error)}`,
                "error",
            );
        }
        // Session replaced (or resume failed terminally): stop using this ctx.
        return;
    }

    addSessionToPrompt(ctx, selected.path);
}
// ─── Formatting Helpers ───────────────────────────────────────────

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

/**
 * Status action widget: state-only card, no output text.
 * Status line (✓/✗/● + alias + status · duration); a truncated Error line
 * under the status line on failed; attach line only while the tmux session
 * still exists (attachCommand undefined otherwise), with " (copied)" appended
 * when the command was copied to the clipboard; provider/model line once
 * settled; worktree line only in worktree mode (no line at all when the
 * child runs in the main repo).
 */
function formatLogWidgetLines(
    alias: string,
    worktreePath: string | undefined,
    attachCommand: string | undefined,
    attachCopied: boolean,
    result: BackgroundTaskResult | null,
    duration?: string,
): WidgetLine[] {
    const status = result ? result.status : "running";
    const icon: WidgetSegment =
        status === "completed"
            ? { text: "✓", color: "success" }
            : status === "failed"
              ? { text: "✗", color: "error" }
              : { text: "●", color: "warning" };

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

/** closeTask outcome: "dirty" asks the caller to confirm a forced retry; "closed" finished the cleanup. */
type CloseOutcome =
    | { status: "dirty" }
    | { status: "closed"; result: CloseResult };

/**
 * Close a background task. Worktree mode: removes the worktree (a dirty
 * one returns the "dirty" outcome unless force; a missing worktree path
 * counts as already cleaned, so close stays idempotent). No-worktree mode
 * skips worktree cleanup entirely. Both modes kill the tmux session when
 * present and delete the run dir (task.md / result.json / meta.json) — the
 * task list is sourced from tasks/, so leftover artifacts would be
 * orphaned. The sessions dir (child session history) is append-only and
 * never touched here.
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
        const dirty = await isWorktreeDirty(pi, facts.worktree.path);
        if (dirty && !force) {
            return { status: "dirty" };
        }

        const cleanArgs = [WORKTREE_SH, "clean", name];
        if (dirty) cleanArgs.push("--force");
        cleanArgs.push("--json");
        const cleanResult = await pi.exec("bash", cleanArgs);
        if (cleanResult.code !== 0) {
            throw new Error(
                cleanResult.stderr.trim() || "Failed to remove worktree.",
            );
        }
        cleanOutput = parseCleanOutput(cleanResult.stdout);
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
            runDirWarn = `Failed to remove run artifacts: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    return {
        status: "closed",
        result: {
            name,
            leftoverCount: cleanOutput?.leftoverCount ?? 0,
            warning: sessionWarn ?? runDirWarn,
        },
    };
}

function formatCloseText(result: CloseResult): string {
    let msg = `Background task "${result.name}" closed.`;
    if (result.leftoverCount > 0) {
        msg += ` Warning: ${result.leftoverCount} leftover file(s).`;
    }
    return msg;
}

// ─── Background Task Dispatch ─────────────────────────────────────

interface DispatchResult {
    alias: string;
    /** sha256(alias) truncated to 16 hex chars — worktree/run/session key. */
    uuid: string;
    /** Worktree path in worktree mode; undefined when the child runs in the main repo. */
    worktreePath?: string;
    tmuxSession: string;
    attachCommand: string;
    provider: string;
    model: string;
    thinking: string;
    prompt: string;
}

async function dispatchBackgroundTask(
    pi: ExtensionAPI,
    opts: {
        alias: string;
        prompt: string;
        description: string;
        worktree: boolean;
        ctx: ExtensionContext;
    },
): Promise<DispatchResult> {
    const { alias, prompt, description, worktree, ctx } = opts;
    validateAlias(alias);

    // Model check first: no filesystem side effects before it can pass.
    const provider = ctx.model?.provider;
    const model = ctx.model?.id;
    const thinking = pi.getThinkingLevel();
    if (!provider || !model) {
        throw new Error("No model is active. Cannot dispatch background task.");
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
        throw new Error(
            `Background task "${alias}" already exists (tmux session). Choose a different alias.`,
        );
    }

    // Atomic claim: non-recursive mkdir — EEXIST is the conflict, no
    // check-then-create race. Every failure after this point leaves a task
    // that is listed and closable via /background-tasks.
    const runDir = taskRunDir(env.tasksDir, alias);
    try {
        await mkdir(path.dirname(runDir), { recursive: true, mode: 0o700 });
        await mkdir(runDir, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
            throw new Error(
                `Background task "${alias}" already exists (run dir). Choose a different alias.`,
            );
        }
        throw new Error(
            `Failed to prepare run directory: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    let resultPath: string;
    // meta.json records the worktree intent right after the atomic claim,
    // before any worktree/session side effect, so "run dir exists ⇒ meta
    // exists" holds and readers need no missing-meta fallback. Atomic write,
    // so a crash cannot leave a half-written record.
    try {
        await writeJsonAtomic(path.join(runDir, "meta.json"), {
            version: 1,
            worktree,
        });
    } catch (error) {
        throw new Error(
            `Failed to write task meta: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    let promptPath: string;
    let sessionDir: string;
    try {
        sessionDir = taskSessionsDir(env.tasksDir);
        await mkdir(sessionDir, { recursive: true, mode: 0o700 });
        promptPath = path.join(runDir, "task.md");
        resultPath = path.join(runDir, "result.json");
        await writeFile(promptPath, `${prompt}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
    } catch (error) {
        throw new Error(
            `Failed to prepare run directory: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    // Optional worktree; no-worktree mode runs the child in the main repo.
    let worktreePath: string | undefined;
    if (worktree) {
        const wtResult = await pi.exec("bash", [
            WORKTREE_SH,
            "open",
            alias,
            "--json",
        ]);
        if (wtResult.code !== 0) {
            throw new Error(wtResult.stderr.trim() || "worktree.sh open failed");
        }
        const output = parseOpenOutput(wtResult.stdout);
        if (!output) {
            throw new Error("Failed to parse worktree output");
        }
        worktreePath = output.worktreePath;
    }
    const sessionOk = await ensureSession(
        pi,
        env.socketPath,
        session,
        worktreePath ?? env.repoRoot,
    );
    if (!sessionOk) {
        throw new Error(`Failed to start tmux session "${session}".`);
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
            remain.stderr.trim() || "Failed to set remain-on-exit.",
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

    const cleanupHint = `run dir/session already created (clean up: user runs /background-tasks, select "${alias}", then Close)`;
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
    const lines = [`Dispatched background task "${result.alias}".`];
    if (result.worktreePath) {
        lines.push(`Worktree: ${result.worktreePath}`);
    }
    lines.push(
        `Observe progress or clean up via /background-tasks (select "${result.alias}").`,
    );
    return lines.join("\n");
}

// ─── Attach Flag (pi --attach-background-task <alias>) ─────────────────────────

function currentTmuxSocket(): string | undefined {
    const socket = process.env.TMUX?.split(",", 1)[0]?.trim();
    return socket || undefined;
}

function attachFlagValue(argv: string[]): string | undefined {
    const flag = `--${ATTACH_FLAG}`;
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

function taskRootFlagValue(argv: string[]): string | undefined {
    const flag = `--${TASK_ROOT_FLAG}`;
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

function attachToBackgroundTaskAndExit(
    rawAlias: string,
    rawRoot?: string,
): never {
    const alias = rawAlias.trim();
    if (!alias) {
        console.error(
            `Error: --${ATTACH_FLAG} requires a background-task alias.`,
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
        const expanded = trimmed.startsWith("~/")
            ? path.join(process.env.HOME ?? os.homedir(), trimmed.slice(2))
            : trimmed.startsWith("~") && trimmed.length === 1
              ? (process.env.HOME ?? os.homedir())
              : trimmed;
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
            `Error: no background-task tmux socket at ${socketPath}. Dispatched a task from this repo?`,
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
            `Error: no live tmux session for background task "${alias}" (settled or closed).`,
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
    // `pi --attach-background-task <alias> [--task-root <repoRoot>]`: attach to a
    // dispatched task's tmux session and exit (never starts the normal TUI).
    // Registered before child mode so the flags work in every invocation context.
    pi.registerFlag(ATTACH_FLAG, {
        description: "Attach to a background-task tmux session by task alias",
        type: "string",
    });
    pi.registerFlag(TASK_ROOT_FLAG, {
        description: "Repo root for --attach-background-task",
        type: "string",
    });
    const attachTarget = attachFlagValue(process.argv);
    if (attachTarget !== undefined) {
        const taskRoot = taskRootFlagValue(process.argv);
        attachToBackgroundTaskAndExit(attachTarget, taskRoot);
    }

    // Child mode (dispatched background task): register only the result
    // reporter — no slash commands, no agent tools.
    if (process.env[TASK_CHILD_ENV] === "1") {
        const resultPath = process.env[TASK_RESULT_ENV];
        if (!resultPath) {
            console.error(
                `[background-task] ${TASK_RESULT_ENV} is required in child mode.`,
            );
            return;
        }
        registerTaskChildReporter(pi, resultPath);
        return;
    }

    // Clear background-task widgets when a new turn starts so they don't block conversation output.
    pi.on("turn_start", async (_event, ctx) => {
        ctx.ui.setWidget("background-task-status", undefined);
    });

    // ── /background-tasks ──  (single entry point: task list → action → execute, loop)
    pi.registerCommand("background-tasks", {
        description:
            "List background tasks and run an action (status / add to prompt / add result / preview / vscode / close); 'sessions' picks a child session (resume / add to prompt)",
        handler: async (args, ctx) => {
            // `/background-tasks sessions`: child-session history picker.
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
                    "Select background task",
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
                            `read background task ${selected.name} session @${sessionFile}`,
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

    // ── Tool: background_task ──
    // One-shot background task: optional fresh worktree + interactive child
    // Pi, dispatched and returned immediately (no waiting / polling).

    pi.registerTool({
        name: "background_task",
        label: "Background task",
        description:
            "Dispatch a one-shot background task: create a tmux session keyed by the task alias (the child runs in a fresh git worktree by default, or directly in the main repo when worktree is false), then start an interactive Pi process with the given prompt. Returns immediately without waiting for the task. Progress and completion are observed by the user via /background-tasks. Fails fast if the alias already exists.",
        promptSnippet:
            "Dispatch a one-shot background task (isolated worktree by default); returns immediately.",
        promptGuidelines: [
            "background_task is fire-and-forget — returns immediately, the user observes via /background-tasks.",
            "Keep background_task's prompt free of commit instructions; leave the work uncommitted so the user can review before anything lands. In no-worktree mode this matters more: a child commit would land on the user's live checked-out branch.",
            "Worktree mode (default): write file paths in the prompt relative to the worktree root (the child Pi's cwd is the fresh worktree, which contains all committed repo files, so relative paths also work for read-only references). Never put an absolute main-repo path in the prompt: the child follows literal paths and would edit the main repo, bypassing worktree isolation. No-worktree mode: the child runs directly in the main repo, so main-repo paths are correct and its edits are immediately live. In both modes, if the child needs uncommitted main-repo content as context, paste the relevant snippet into the prompt instead of a path.",
            "Never clean up a background task yourself (worktree removal, session kill, run dir deletion); the user closes it via /background-tasks after reviewing.",
        ],
        parameters: Type.Object({
            alias: Type.String({
                description:
                    "Task alias: 1-64 chars, must start with a letter or digit, then letters/digits/./_/- (flat names, no slashes; e.g. fix-socket-hang). Also used as the branch name in worktree mode. Must not already exist.",
            }),
            worktree: Type.Optional(
                Type.Boolean({
                    description:
                        "Create a fresh git worktree for the task (default true). When false, the child runs directly in the main repo: edits are immediately live and commits land on the user's checked-out branch.",
                }),
            ),
            prompt: Type.String({
                description:
                    "The task for the agent to perform. Be specific about what needs to be done and include any relevant context. In worktree mode (default) reference files by paths relative to the worktree root; never absolute paths into the main repo.",
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
                throw new Error("background_task requires a non-empty alias.");
            }
            if (!prompt) {
                throw new Error("background_task requires a non-empty prompt.");
            }
            if (!description) {
                throw new Error(
                    "background_task requires a non-empty description.",
                );
            }
            const worktree =
                typeof params.worktree === "boolean" ? params.worktree : true;
            const result = await dispatchBackgroundTask(pi, {
                alias,
                prompt,
                description,
                worktree,
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
                theme.fg("toolTitle", theme.bold("background_task ")) +
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
                // Only mark the deviation from the default: no worktree
                // means the child edits the main repo directly (live).
                const modeMark = details.worktreePath
                    ? ""
                    : theme.fg("muted", " · no worktree");
                container.addChild(
                    new Text(
                        `${theme.fg("warning", "●")} ${theme.fg("toolTitle", theme.bold(details.alias))}${theme.fg("muted", " · dispatched")}${modeMark}`,
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
            // Compact view: same single-line mode mark as the expanded view.
            const modeMark = details.worktreePath
                ? ""
                : theme.fg("muted", " · no worktree");
            let text = `${theme.fg("warning", "●")} ${theme.fg("toolTitle", theme.bold(details.alias))}`;
            text += theme.fg("muted", " · dispatched");
            text += modeMark;
            text += `\n  ${theme.fg("accent", details.attachCommand)}`;
            text += `\n  ${theme.fg("dim", `${details.provider}/${details.model} (${details.thinking})`)}`;
            return new Text(text, 0, 0);
        },
    });
}
