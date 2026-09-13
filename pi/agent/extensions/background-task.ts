import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
	DynamicBorder,
	SessionManager,
	buildSessionContext,
	getMarkdownTheme,
	migrateSessionEntries,
	parseSessionEntries,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type KeybindingsManager,
	type SessionEntry,
	type SessionInfo,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	Markdown,
	SelectList,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type SelectItem,
	type TUI,
} from "@earendil-works/pi-tui";
import { pickSession } from "./pick-session.ts";
import { Type } from "typebox";

// ─── Script Resolution ────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, "background-task");
const WORKTREE_SH = path.join(SCRIPTS_DIR, "worktree.sh");

/** `pi --attach-background-task <alias> [--task-root <repoRoot>]`: attach to a dispatched task's tmux session. */
const ATTACH_FLAG = "attach-background-task";
/** Repo root for the attach target; bypasses `git rev-parse` when supplied. */
const TASK_ROOT_FLAG = "task-root";
/** Repo-local tasks dir (relative to repo root): `.pi/background-tasks/`. */
const TASKS_DIR_PARTS = [".pi", "background-tasks"] as const;

// ─── Background-task Child Mode ───────────────────────────────────

/** Set on the dispatched child Pi: register only the result reporter. */
const TASK_CHILD_ENV = "PI_BACKGROUND_TASK_CHILD";
/** Result file path handed to the child Pi via env. */
const TASK_RESULT_ENV = "PI_BACKGROUND_TASK_RESULT";
/** Task alias handed to the child Pi via env (reporter writes result.json branch). */
const TASK_ALIAS_ENV = "PI_BACKGROUND_TASK_ALIAS";
const EXTENSION_PATH = fileURLToPath(import.meta.url);

async function copyToClipboard(pi: ExtensionAPI, text: string): Promise<boolean> {
	for (const cmd of ["xclip -selection clipboard", "pbcopy"]) {
		const bin = cmd.split(" ")[0];
		const check = await pi.exec("which", [bin]);
		if (check.code !== 0) continue;
		const result = await pi.exec("bash", ["-c", `${cmd} <<< ${JSON.stringify(text)}`]);
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
				if (line.length === 0 || line === BLANK_ROW || /^[\s\u00A0]*$/.test(line)) {
					container.addChild(new Text(BLANK_ROW, 1, 0));
					continue;
				}
				container.addChild(new Text(line, 1, 0));
				continue;
			}
			const rendered = renderWidgetSegments(line, theme);
			container.addChild(new Text(rendered.length > 0 ? rendered : BLANK_ROW, 1, 0));
		}
		if (footer) {
			container.addChild(new Text(BLANK_ROW, 1, 0));
			container.addChild(new Text(theme.fg("muted", footer), 1, 0));
		}
		return container;
	};
}

// ─── Repo-local Tasks Environment & Keys ──────────────────────────

/** Repo-root-local background-task environment (artifacts + tmux socket). */
interface TasksEnv {
	/** Main worktree root (absolute), from `worktree.sh root-path`. */
	repoRoot: string;
	/** `<repoRoot>/.pi/background-tasks`. */
	tasksDir: string;
	/** Per-repo tmux socket inside tasksDir. */
	socketPath: string;
}

/** uuid = sha256(alias) truncated to 16 hex chars; unique per repo (branch names are unique). */
function taskUuid(alias: string): string {
	return createHash("sha256").update(alias, "utf8").digest("hex").slice(0, 16);
}

/** tmux session / window naming: `background-task-<uuid>` (window name is fixed "pi"). */
function taskSessionName(uuid: string): string {
	return `background-task-${uuid}`;
}

/** Attach command: `pi --attach-background-task <alias> [--task-root <repoRoot>]` — quote only when needed. */
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
async function listSessionNames(pi: ExtensionAPI, socket: string): Promise<string[]> {
	const result = await pi.exec("tmux", ["-S", socket, "list-sessions", "-F", "#{session_name}"]);
	if (result.code !== 0) return [];
	return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
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
			return Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string");
		})
		.map((part) => part.text)
		.join("\n");
}

function findLastAssistant(ctx: ExtensionContext): Record<string, unknown> | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as Record<string, unknown>;
		if (message.role === "assistant") return message;
	}
	return undefined;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporaryPath, filePath);
}

function registerTaskChildReporter(pi: ExtensionAPI, resultPath: string): void {
	let reported = false;

	const report = async (ctx: ExtensionContext, fallbackError?: string): Promise<void> => {
		if (reported) return;
		reported = true;

		const assistant = findLastAssistant(ctx);
		const stopReason = typeof assistant?.stopReason === "string" ? assistant.stopReason : undefined;
		const assistantError = typeof assistant?.errorMessage === "string" ? assistant.errorMessage : undefined;
		const failed = !assistant || stopReason === "error" || stopReason === "aborted" || Boolean(fallbackError);
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
				(!assistant ? "Background task exited without an assistant response." : undefined),
			stopReason,
			sessionFile: ctx.sessionManager.getSessionFile(),
			provider: typeof assistant?.provider === "string" ? assistant.provider : ctx.model?.provider,
			model: typeof assistant?.model === "string" ? assistant.model : ctx.model?.id,
			thinking: pi.getThinkingLevel(),
			finishedAt: Date.now(),
		};

		try {
			await writeJsonAtomic(resultPath, result);
		} catch (error) {
			console.error(`[background-task] Failed to write result: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	// agent_settled was added after older peer type declarations but is present
	// in the Pi runtime this extension targets.
	(
		pi.on as unknown as (
			event: "agent_settled",
			handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
		) => void
	)("agent_settled", async (_event, ctx) => {
		await report(ctx);
		ctx.shutdown();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!reported) await report(ctx, "Background task session shut down before the task settled.");
	});
}

// ─── Run Artifacts (task.md / result.json / sessions) ─────────────

/** Per-task run dir: `<tasksDir>/<uuid>/` (task.md + result.json, latest-wins). */
function taskRunDir(tasksDir: string, alias: string): string {
	return path.join(tasksDir, taskUuid(alias));
}

/**
 * Flat session dir: `<tasksDir>/sessions/` (child --session-dir). Session
 * files are named `<timestamp>_<uuid>.jsonl` by pi, so no per-task subdir is
 * needed; the dir is append-only history (never wiped on re-dispatch).
 */
function taskSessionsDir(tasksDir: string): string {
	return path.join(tasksDir, "sessions");
}

async function readTaskResult(tasksDir: string, alias: string): Promise<BackgroundTaskResult | null> {
	try {
		return JSON.parse(await readFile(path.join(taskRunDir(tasksDir, alias), "result.json"), "utf8")) as BackgroundTaskResult;
	} catch {
		return null;
	}
}

/** Dispatch timestamp = task.md mtime (written right before the child starts). */
async function readTaskStartedAt(tasksDir: string, alias: string): Promise<number | undefined> {
	try {
		const info = await stat(path.join(taskRunDir(tasksDir, alias), "task.md"));
		return info.mtimeMs;
	} catch {
		return undefined;
	}
}

// ─── Script Output Types ──────────────────────────────────────────

interface WorktreeEntry {
	branch: string;
	path: string;
	dirty: boolean;
}

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

function parseWorktreeOutput(stdout: string): WorktreeEntry[] {
	try {
		return JSON.parse(stdout);
	} catch {
		return [];
	}
}

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
 * Independent facts about one background-task alias. Worktree existence is
 * expressed by worktreePath being defined (no separate boolean).
 */
interface TaskFacts {
	name: string;
	worktreePath?: string;
	dirty?: boolean;
	sessionExists: boolean;
	taskStatus?: TaskStatus;
	/** Latest run's child session file (result.json sessionFile); absent while running. */
	sessionFile?: string;
}

async function resolveTaskFacts(
	pi: ExtensionAPI,
	name: string,
): Promise<TaskFacts> {
	const env = await getTasksEnv(pi);

	// Worktree
	const wtResult = await pi.exec("bash", [WORKTREE_SH, "list", "--json", "-q", name]);
	const worktrees = wtResult.code === 0 ? parseWorktreeOutput(wtResult.stdout) : [];
	const worktree = worktrees.find((w) => w.branch === name);

	// tmux session (per-repo socket, session named background-task-<uuid>)
	let sessionExists = false;
	if (env) {
		const sessions = await listSessionNames(pi, env.socketPath);
		sessionExists = sessions.includes(taskSessionName(taskUuid(name)));
	}

	// Task status from run artifacts
	const childResult = env ? await readTaskResult(env.tasksDir, name) : null;

	return {
		name,
		worktreePath: worktree?.path,
		dirty: worktree?.dirty,
		sessionExists,
		taskStatus: childResult?.status,
		sessionFile: childResult?.sessionFile,
	};
}

// ─── UI Select Helpers ────────────────────────────────────────────

/**
 * Task worktree list: worktree.sh output joined with result.json task status
 * and session existence. Source is the worktree list only — session-only
 * leftovers are not listed.
 */
async function listTaskWorktrees(pi: ExtensionAPI): Promise<TaskFacts[]> {
	const wtResult = await pi.exec("bash", [WORKTREE_SH, "list", "--json"]);
	const worktrees = wtResult.code === 0 ? parseWorktreeOutput(wtResult.stdout) : [];
	if (worktrees.length === 0) return [];

	const env = await getTasksEnv(pi);
	const sessions = env ? await listSessionNames(pi, env.socketPath) : [];
	const result: TaskFacts[] = [];
	for (const wt of [...worktrees].sort((a, b) => a.branch.localeCompare(b.branch))) {
		// Task status: verbatim result.json status; undefined while running or
		// when the worktree was not created by background_task.
		const childResult = env ? await readTaskResult(env.tasksDir, wt.branch) : null;
		result.push({
			name: wt.branch,
			worktreePath: wt.path,
			dirty: wt.dirty,
			sessionExists: sessions.includes(taskSessionName(taskUuid(wt.branch))),
			taskStatus: childResult?.status,
			sessionFile: childResult?.sessionFile,
		});
	}
	return result;
}

async function selectTask(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	title: string,
): Promise<TaskFacts | null> {
	const worktrees = await listTaskWorktrees(pi);
	if (worktrees.length === 0) {
		ctx.ui.notify("No background tasks available.", "info");
		return null;
	}

	// Display row: "<alias> (<taskStatus>|running, <dirty>) (no session)" —
	// each mark omitted per facts; running = live session, no result yet.
	// Map display strings back to facts to avoid parsing.
	const displayToFacts = new Map<string, TaskFacts>();
	for (const bw of worktrees) {
		const marks: string[] = [];
		if (bw.taskStatus) marks.push(bw.taskStatus);
		else if (bw.sessionExists) marks.push("running");
		if (bw.dirty) marks.push("dirty");
		const mark = marks.length > 0 ? ` (${marks.join(", ")})` : "";
		const noSession = bw.sessionExists ? "" : " (no session)";
		displayToFacts.set(`${bw.name}${mark}${noSession}`, bw);
	}

	const choice = await ctx.ui.select(title, Array.from(displayToFacts.keys()));
	if (!choice) return null;
	return displayToFacts.get(choice) ?? null;
}

type TaskAction = "status" | "addToPrompt" | "result" | "preview" | "vscode" | "close";

/** Action labels for the selector, filtered by facts (worktree → status/vscode/close; settled → result; session file → addToPrompt/preview). */
function taskActionItems(facts: TaskFacts): SelectItem[] {
	const items: SelectItem[] = [];
	if (facts.worktreePath !== undefined) {
		items.push({ value: "status", label: "Status (state / attach)" });
	}
	if (facts.taskStatus) {
		items.push({ value: "result", label: "Add result to prompt" });
	}
	if (facts.sessionFile) {
		items.push({ value: "addToPrompt", label: "Add session to prompt" });
		items.push({ value: "preview", label: "Preview session" });
	}
	if (facts.worktreePath !== undefined) {
		items.push({ value: "vscode", label: "Open in VS Code" });
		items.push({ value: "close", label: "Close (remove worktree + kill session)" });
	}
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
		container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to cancel")));
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
	return showActionMenu<TaskAction>(ctx, `Action for "${facts.name}"`, taskActionItems(facts));
}

// ─── Action Runners (executed directly by the /background-tasks flow) ──────

async function runCloseAction(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	facts: TaskFacts,
): Promise<void> {
	// Worktree existence is a prerequisite for close.
	if (facts.worktreePath === undefined) {
		ctx.ui.notify(`Background task "${facts.name}" does not exist (no worktree).`, "error");
		return;
	}

	// Interactive confirm maps to force:true; never close a dirty worktree without it.
	let force = false;
	if (facts.dirty) {
		const proceed = await ctx.ui.confirm(
			"Dirty Worktree",
			`Background task "${facts.name}" has uncommitted changes. Close anyway?`,
		);
		if (!proceed) {
			ctx.ui.notify("Cancelled.", "info");
			return;
		}
		force = true;
	}

	const result = await closeTask(pi, { name: facts.name, force });
	if (!result.ok) {
		ctx.ui.notify(result.error ?? "close failed", "error");
		return;
	}
	if (result.error) {
		ctx.ui.notify(result.error, "warning");
	}
	ctx.ui.notify(formatCloseText(result), "info");
}

async function runStatusAction(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	facts: TaskFacts,
): Promise<void> {
	const { name: taskName } = facts;

	// Status observes the current task: a missing worktree fails fast.
	if (facts.worktreePath === undefined) {
		ctx.ui.notify(`Background task "${taskName}" does not exist (no worktree).`, "error");
		return;
	}

	const env = await getTasksEnv(pi);
	if (!env) {
		ctx.ui.notify("Failed to resolve repo root for background-task artifacts.", "error");
		return;
	}

	const result = await readTaskResult(env.tasksDir, taskName);
	const startedAt = await readTaskStartedAt(env.tasksDir, taskName);
	const duration = formatDuration(startedAt, result?.finishedAt);

	// Attach line renders only while the tmux session still exists.
	// Include --task-root so the copied command works from any directory.
	const attachCommand = facts.sessionExists ? taskAttachCommand(taskName, env.repoRoot) : undefined;

	let attachCopied = false;
	if (attachCommand) {
		attachCopied = await copyToClipboard(pi, attachCommand);
	}

	const lines = formatLogWidgetLines(taskName, facts.worktreePath, attachCommand, attachCopied, result, duration);
	ctx.ui.setWidget("background-task-status", buildWidget(lines), { placement: "aboveEditor" });
}

async function runVscodeAction(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	facts: TaskFacts,
): Promise<void> {
	if (facts.worktreePath === undefined) {
		ctx.ui.notify(`Background task "${facts.name}" does not exist (no worktree).`, "error");
		return;
	}

	await pi.exec("code", [facts.worktreePath]);
	ctx.ui.notify(`Opened VS Code for "${facts.name}" at ${facts.worktreePath}`, "info");
}

// ─── Child Session History (/background-tasks sessions) ──────────

type SessionAction = "preview" | "resume" | "addToPrompt";

/** Append "read session @<path>" to the editor (files.ts addFileToPrompt variant). */
function addSessionToPrompt(ctx: ExtensionCommandContext, sessionFile: string, mention?: string): void {
	mention ??= `read session @${sessionFile}`;
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
		ctx.ui.notify("Failed to resolve repo root for background-task artifacts.", "error");
		return;
	}
	const result = await readTaskResult(env.tasksDir, facts.name);
	if (!result) {
		ctx.ui.notify(`Background task "${facts.name}" has no settled result.`, "error");
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

/** Sanity cap for picker row labels. */
const SESSION_LABEL_MAX = 100;

/** Session row label: name (set at dispatch: description) or first message. */
function sessionDisplayLabel(info: SessionInfo): string {
	const text = (info.name ?? info.firstMessage ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
	const label = text.length > 0 ? text : "(no title)";
	return label.length > SESSION_LABEL_MAX ? `${label.slice(0, SESSION_LABEL_MAX - 1)}…` : label;
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
async function runSessionsFlow(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("background-tasks sessions requires interactive mode", "error");
		return;
	}

	const env = await getTasksEnv(pi);
	if (!env) {
		ctx.ui.notify("Failed to resolve repo root for background-task artifacts.", "error");
		return;
	}
	const sessionsDir = taskSessionsDir(env.tasksDir);
	if (!existsSync(sessionsDir)) {
		ctx.ui.notify("No background-task sessions yet.", "info");
		return;
	}

	const selected = await pickSession(ctx, {
		// One flat dir: both scopes read it (Tab has no distinct meaning here).
		current: (onProgress) => SessionManager.listAll(sessionsDir, onProgress),
		all: (onProgress) => SessionManager.listAll(sessionsDir, onProgress),
	});
	if (!selected) return;

	const action = await selectSessionAction(ctx, selected);
	if (!action) return;

	if (action === "preview") {
		await previewSessionFile(ctx, sessionDisplayLabel(selected), selected.path);
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

function formatDuration(startedAt: number | undefined, finishedAt = Date.now()): string | undefined {
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
 * settled; worktree line always renders (runStatusAction requires the
 * worktree to exist).
 */
function formatLogWidgetLines(
	alias: string,
	worktreePath: string,
	attachCommand: string | undefined,
	attachCopied: boolean,
	result: BackgroundTaskResult | null,
	duration?: string,
): WidgetLine[] {
	const status = result ? result.status : "running";
	const icon: WidgetSegment =
		status === "completed" ? { text: "✓", color: "success" }
		: status === "failed" ? { text: "✗", color: "error" }
		: { text: "●", color: "warning" };

	const lines: WidgetLine[] = [];
	lines.push([
		icon,
		{ text: " " },
		{ text: alias, color: "toolTitle", bold: true },
		{ text: ` · ${status}${duration ? ` · ${duration}` : ""}`, color: "muted" },
	]);
	if (status === "failed" && result?.error?.trim()) {
		// One truncated line; the full error lives in result.json / the child session.
		const errorFirstLine = result.error.trim().split("\n")[0] ?? "";
		const errorLine = errorFirstLine.length > 160 ? `${errorFirstLine.slice(0, 159)}…` : errorFirstLine;
		lines.push([{ text: `  Error: ${errorLine}`, color: "error" }]);
	}
	if (attachCommand) {
		lines.push([{ text: `  ${attachCommand}${attachCopied ? " (copied)" : ""}`, color: "accent" }]);
	}
	if (result) {
		lines.push([
			{ text: `  ${result.provider ?? ""}/${result.model ?? ""} (${result.thinking ?? ""})`, color: "dim" },
		]);
	}
	lines.push([{ text: `  worktree: ${worktreePath}`, color: "dim" }]);
	lines.push("");
	return lines;
}

// ─── Session Management ───────────────────────────────────────────

async function ensureSession(
	pi: ExtensionAPI,
	socket: string,
	session: string,
	worktreePath: string,
): Promise<boolean> {
	const hasSession = await pi.exec("tmux", ["-S", socket, "has-session", "-t", session]);
	if (hasSession.code === 0) return true;

	await mkdir(path.dirname(socket), { recursive: true });
	const create = () =>
		pi.exec("tmux", ["-S", socket, "new-session", "-d", "-s", session, "-c", worktreePath]);
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
	ok: boolean;
	name: string;
	error?: string;
	needsForce?: "dirty";
	leftoverCount?: number;
}

/**
 * Close a background task: worktree existence is a prerequisite. Removes the
 * worktree (dirty requires force), kills the tmux session when present, and
 * deletes the run dir (task.md + result.json) once cleanup succeeded — the
 * task list is sourced from worktrees, so leftover artifacts would be
 * orphaned. The sessions dir (child session history) is append-only and
 * never touched here.
 */
async function closeTask(
	pi: ExtensionAPI,
	opts: { name: string; force?: boolean },
): Promise<CloseResult> {
	const { name, force = false } = opts;
	const facts = await resolveTaskFacts(pi, name);

	if (facts.worktreePath === undefined) {
		return {
			ok: false,
			name,
			error: `Background task "${name}" does not exist (no worktree).`,
		};
	}

	if (facts.dirty && !force) {
		return {
			ok: false,
			name,
			needsForce: "dirty",
			error: `Background task "${name}" has uncommitted changes. Ask the user, then call again with force: true to close anyway.`,
		};
	}

	const cleanArgs = [WORKTREE_SH, "clean", name];
	if (facts.dirty) cleanArgs.push("--force");
	cleanArgs.push("--json");
	const cleanResult = await pi.exec("bash", cleanArgs);
	if (cleanResult.code !== 0) {
		return {
			ok: false,
			name,
			error: cleanResult.stderr.trim() || "Failed to remove worktree.",
		};
	}
	const cleanOutput = parseCleanOutput(cleanResult.stdout);

	// Kill the session when present; failure is only a warning.
	const env = await getTasksEnv(pi);
	let sessionWarn: string | undefined;
	if (facts.sessionExists) {
		if (env) {
			const killResult = await pi.exec("tmux", [
				"-S", env.socketPath,
				"kill-session", "-t", taskSessionName(taskUuid(name)),
			]);
			if (killResult.code !== 0) {
				sessionWarn = `Worktree removed but tmux session "${name}" could not be killed.`;
			}
		}
	}

	// Remove the run dir (task.md + result.json) after successful cleanup:
	// best-effort, skipped when the session kill failed (the child may still
	// be writing result.json there). Failure to delete is only a warning.
	let runDirWarn: string | undefined;
	if (env && !sessionWarn) {
		try {
			await rm(taskRunDir(env.tasksDir, name), { recursive: true, force: true });
		} catch (error) {
			runDirWarn = `Failed to remove run artifacts: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	return {
		ok: true,
		name,
		leftoverCount: cleanOutput?.leftoverCount ?? 0,
		error: sessionWarn ?? runDirWarn,
	};
}

function formatCloseText(result: CloseResult): string {
	if (result.needsForce) {
		return result.error ?? `Close of "${result.name}" requires force: true (${result.needsForce}).`;
	}
	if (!result.ok) {
		return result.error ?? `Failed to close background task "${result.name}".`;
	}
	let msg = `Background task "${result.name}" closed.`;
	if (result.leftoverCount && result.leftoverCount > 0) {
		msg += ` Warning: ${result.leftoverCount} leftover file(s).`;
	}
	if (result.error) {
		msg += ` ${result.error}`;
	}
	return msg;
}

// ─── Background Task Dispatch ─────────────────────────────────────

/** Result of dispatchBackgroundTask; exposed to the agent tool as details. */
interface DispatchResult {
	ok: boolean;
	alias: string;
	/** sha256(alias) truncated to 16 hex chars — worktree/run/session key. */
	uuid?: string;
	error?: string;
	worktreePath?: string;
	tmuxSession?: string;
	attachCommand?: string;
	/** Slash command the user runs to observe this task. */
	monitorCommand?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	prompt?: string;
}

/**
 * Create a fresh worktree + tmux session for the task alias (fail fast on duplicates), start an
 * interactive child Pi inside its tmux session with the given prompt, and
 * return immediately. Completion is reported via result.json (child reporter)
 * and observed through /background-tasks.
 */
async function dispatchBackgroundTask(
	pi: ExtensionAPI,
	opts: { alias: string; prompt: string; description: string; ctx: ExtensionContext },
): Promise<DispatchResult> {
	const { alias, prompt, description, ctx } = opts;

	// 1. Fail fast on duplicate alias (existing worktree or tmux session).
	const existing = await resolveTaskFacts(pi, alias);
	const existingParts: string[] = [];
	if (existing.worktreePath !== undefined) existingParts.push("worktree");
	if (existing.sessionExists) existingParts.push("tmux session");
	if (existingParts.length > 0) {
		return {
			ok: false,
			alias,
			error: `Background task "${alias}" already exists (${existingParts.join(" + ")}). Choose a different alias.`,
		};
	}

	// 2. Create worktree + branch.
	const wtResult = await pi.exec("bash", [WORKTREE_SH, "open", alias, "--json"]);
	if (wtResult.code !== 0) {
		return { ok: false, alias, error: wtResult.stderr.trim() || "worktree.sh open failed" };
	}
	const output = parseOpenOutput(wtResult.stdout);
	if (!output) {
		return { ok: false, alias, error: "Failed to parse worktree output" };
	}
	const worktreePath = output.worktreePath;

	// 3. Repo-local tasks env (per-repo socket + artifact dirs) + tmux session.
	const env = await getTasksEnv(pi);
	if (!env) {
		return { ok: false, alias, worktreePath, error: "Failed to resolve repo root (worktree.sh root-path)" };
	}
	const uuid = taskUuid(alias);
	const session = taskSessionName(uuid);
	const sessionOk = await ensureSession(pi, env.socketPath, session, worktreePath);
	if (!sessionOk) {
		return { ok: false, alias, worktreePath, error: `Failed to start tmux session "${session}".` };
	}

	// 4. Model inheritance.
	const provider = ctx.model?.provider;
	const model = ctx.model?.id;
	const thinking = pi.getThinkingLevel();
	if (!provider || !model) {
		return { ok: false, alias, worktreePath, error: "No model is active. Cannot dispatch background task." };
	}

	// 5. Run artifacts: latest-wins on the run dir (fixed file names task.md /
	// result.json need wiping); the flat sessions dir is append-only — its
	// `<timestamp>_<uuid>.jsonl` names never collide, old runs stay as history.
	const runDir = taskRunDir(env.tasksDir, alias);
	let resultPath: string;
	let promptPath: string;
	let sessionDir: string;
	try {
		await rm(runDir, { recursive: true, force: true });
		await mkdir(runDir, { recursive: true, mode: 0o700 });
		sessionDir = taskSessionsDir(env.tasksDir);
		await mkdir(sessionDir, { recursive: true, mode: 0o700 });
		promptPath = path.join(runDir, "task.md");
		resultPath = path.join(runDir, "result.json");
		await writeFile(promptPath, `${prompt}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	} catch (error) {
		return {
			ok: false,
			alias,
			worktreePath,
			error: `Failed to prepare run directory: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	// 6. Keep the pane visible after the child Pi exits (settled output view).
	const remain = await pi.exec("tmux", [
		"-S", env.socketPath, "set-window-option", "-t", `${session}:0`, "remain-on-exit", "on",
	]);
	if (remain.code !== 0) {
		return { ok: false, alias, worktreePath, error: remain.stderr.trim() || "Failed to set remain-on-exit." };
	}

	// 7. Child command: interactive Pi, unconditional --approve (autonomous run).
	// Session id is unique per dispatch (<uuid>-<random>): pi resumes an
	// existing session when the id matches, so a fixed uuid id would carry the
	// previous run's context into the re-dispatched task.
	const tmuxTarget = `${session}:0.0`;
	const attachCommand = taskAttachCommand(alias, env.repoRoot);
	const piArgs = [
		...getPiInvocationParts(),
		"--provider", provider,
		"--model", model,
		"--thinking", thinking,
		"--session-dir", sessionDir,
		"--session-id", `${uuid}-${randomUUID().slice(0, 6)}`,
		"--name", description,
		"--approve",
		"--extension", EXTENSION_PATH,
		`@${promptPath}`,
	];
	const childCommand = [
		"exec env",
		`${TASK_CHILD_ENV}=1`,
		`${TASK_RESULT_ENV}=${shellQuote(resultPath)}`,
		`${TASK_ALIAS_ENV}=${shellQuote(alias)}`,
		piArgs.map(shellQuote).join(" "),
	].join(" ");

	// 8. Fire and forget. Errors here leave a created worktree/session behind —
	// point the caller at /background-tasks for cleanup (interactive only).
	const cleanupHint = `worktree/session already created (clean up: user runs /background-tasks, select "${alias}", then Close)`;
	const sent = await pi.exec("tmux", ["-S", env.socketPath, "send-keys", "-t", tmuxTarget, "-l", "--", childCommand]);
	if (sent.code !== 0) {
		return {
			ok: false,
			alias,
			worktreePath,
			error: `${sent.stderr.trim() || "Failed to start child Pi."} (${cleanupHint})`,
		};
	}
	const entered = await pi.exec("tmux", ["-S", env.socketPath, "send-keys", "-t", tmuxTarget, "Enter"]);
	if (entered.code !== 0) {
		return {
			ok: false,
			alias,
			worktreePath,
			error: `${entered.stderr.trim() || "Failed to submit child command."} (${cleanupHint})`,
		};
	}

	// 9. Return immediately — completion is observed via /background-tasks.
	return {
		ok: true,
		alias,
		uuid,
		worktreePath,
		tmuxSession: session,
		attachCommand,
		monitorCommand: "/background-tasks",
		provider,
		model,
		thinking,
		prompt,
	};
}

function formatDispatchText(result: DispatchResult): string {
	if (!result.ok) {
		return result.error ?? `Failed to dispatch background task "${result.alias}".`;
	}
	return [
		`Dispatched background task "${result.alias}" to tmux session "${result.tmuxSession}".`,
		`Worktree: ${result.worktreePath}`,
		`Attach: ${result.attachCommand}`,
		`Monitor: ${result.monitorCommand}`,
		`Clean up when done (user, interactive): run /background-tasks, select "${result.alias}", then Close.`,
	].join("\n");
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
		if (argument.startsWith(`${flag}=`)) return argument.slice(flag.length + 1);
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
		if (argument.startsWith(`${flag}=`)) return argument.slice(flag.length + 1);
	}
	return undefined;
}

/**
 * `pi --attach-background-task <alias> [--task-root <repoRoot>]`: attach to a
 * dispatched task's tmux session and exit (never starts the normal TUI). When
 * `--task-root` is supplied the socket is resolved from that dir; otherwise
 * from cwd's `git rev-parse --show-toplevel`.
 */
function attachToBackgroundTaskAndExit(rawAlias: string, rawRoot?: string): never {
	const alias = rawAlias.trim();
	if (!alias) {
		console.error(`Error: --${ATTACH_FLAG} requires a background-task alias.`);
		process.exit(2);
	}
	let repoRoot: string;
	if (rawRoot !== undefined) {
		const trimmed = rawRoot.trim();
		if (!trimmed) {
			console.error(`Error: --${TASK_ROOT_FLAG} requires a repo root path.`);
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
			console.error(`Error: --${TASK_ROOT_FLAG} "${rawRoot}" does not exist.`);
			process.exit(2);
		}
	} else {
		const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
		if (root.status !== 0 || !root.stdout.trim()) {
			console.error(`Error: --${ATTACH_FLAG} must be run from inside the repository that dispatched the task (or pass --${TASK_ROOT_FLAG} <repoRoot>).`);
			process.exit(2);
		}
		repoRoot = root.stdout.trim();
	}
	const socketPath = path.join(repoRoot, ...TASKS_DIR_PARTS, "tmux.sock");
	if (!existsSync(socketPath)) {
		console.error(`Error: no background-task tmux socket at ${socketPath}. Dispatched a task from this repo?`);
		process.exit(2);
	}

	const session = taskSessionName(taskUuid(alias));
	const probe = spawnSync("tmux", ["-S", socketPath, "has-session", "-t", session], { encoding: "utf8" });
	if (probe.status !== 0) {
		console.error(`Error: no live tmux session for background task "${alias}" (settled or closed).`);
		process.exit(2);
	}

	const sameServer = currentTmuxSocket() === socketPath;
	const args = ["-S", socketPath, sameServer ? "switch-client" : "attach-session", "-t", session];
	const env = { ...process.env };
	if (!sameServer) {
		delete env.TMUX;
		delete env.TMUX_PANE;
	}
	const result = spawnSync("tmux", args, { stdio: "inherit", env });
	if (result.error) console.error(`Failed to run tmux: ${result.error.message}`);
	process.exit(result.status ?? 1);
}

// ─── Session Preview (self-contained overlay + formatter) ─────────

const PREVIEW_TOOL_CALL_ARGS = 120;
const PREVIEW_TOOL_RESULT_CHARS = 300;
const PREVIEW_BASH_OUTPUT_CHARS = 300;

type PreviewMessages = ReturnType<typeof buildSessionContext>["messages"];

/** Concatenate the text parts of a message content (string or parts array). */
function previewPartsText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/** One-line, whitespace-collapsed preview with a hard cut. */
function previewLine(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max)}...` : line;
}

function previewJson(value: unknown, max: number): string {
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch {
		json = "(unserializable arguments)";
	}
	return previewLine(json, max);
}

/**
 * Render a resolved session transcript as compact read_session-style text
 * (## user / → toolCall / ## toolResult stubs / ## bash blocks). Preview-only
 * simplification of the subagent read_session formatter: no entry-id
 * annotations (those are read_session_entry drill handles, pure noise in a
 * human preview) and no ~size hints.
 */
function formatSessionPreview(messages: PreviewMessages): string {
	const blocks: string[] = [];
	for (const msg of messages) {
		switch (msg.role) {
			case "user": {
				const text = previewPartsText(msg.content).trim();
				if (text) blocks.push(`## user\n${text}`);
				break;
			}
			case "assistant": {
				const lines: string[] = [];
				for (const part of msg.content) {
					if (part.type === "text") {
						const text = part.text.trim();
						if (text) lines.push(text);
					} else if (part.type === "toolCall") {
						lines.push(`→ ${part.name}(${previewJson(part.arguments, PREVIEW_TOOL_CALL_ARGS)})`);
					}
					// thinking parts are skipped
				}
				if (lines.length > 0) blocks.push(`## assistant\n${lines.join("\n")}`);
				break;
			}
			case "toolResult": {
				const text = previewPartsText(msg.content).trim();
				const tag = msg.isError ? " (error)" : "";
				blocks.push(
					`## toolResult:${msg.toolName}${tag}\n${previewLine(text, PREVIEW_TOOL_RESULT_CHARS) || "(empty)"}`,
				);
				break;
			}
			case "bashExecution": {
				const full = (msg.output ?? "").replace(/\s+/g, " ").trim();
				const output =
					full.length > PREVIEW_BASH_OUTPUT_CHARS ? `${full.slice(0, PREVIEW_BASH_OUTPUT_CHARS)}...` : full;
				blocks.push(`## bash (exit=${msg.exitCode ?? "?"})\n$ ${msg.command}${output ? `\n${output}` : ""}`);
				break;
			}
			case "compactionSummary":
				blocks.push(`## compactionSummary\n${msg.summary.trim()}`);
				break;
			case "branchSummary":
				blocks.push(`## branchSummary\n${msg.summary.trim()}`);
				break;
			// custom and other roles: skipped (preview-only rendering).
		}
	}
	return blocks.join("\n\n");
}

/**
 * Load a session JSONL file and resolve its active-branch transcript
 * (parse → migrate → buildSessionContext). Strictly read-only:
 * SessionManager.open() is never touched (its migration may rewrite the
 * file); entries are filtered to drop the session header entry.
 */
async function loadPreviewSessionMessages(sessionFile: string): Promise<PreviewMessages> {
	const content = await readFile(sessionFile, "utf8");
	const parsed = parseSessionEntries(content);
	migrateSessionEntries(parsed);
	const entries = parsed.filter((entry): entry is SessionEntry => entry.type !== "session");
	return buildSessionContext(entries, undefined).messages;
}

/**
 * Session preview overlay: self-contained copy of preview.ts's markdown
 * viewer (scroll / half-page / page / fullscreen). Renders the transcript
 * text through the Markdown component so ## headers get heading styles.
 */
class SessionPreviewOverlay {
	private readonly title: string;
	private readonly filePath: string;
	private readonly markdown: Markdown;
	private scrollOffset = 0;
	private viewHeight = 0;
	private totalLines = 0;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly onClose: () => void;
	private fullscreen = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		title: string,
		filePath: string,
		content: string,
		onClose: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.title = title;
		this.filePath = filePath;
		this.onClose = onClose;
		this.markdown = new Markdown(content.trim() ? content : "_Empty session._", 1, 0, getMarkdownTheme());
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (kb.matches(keyData, "tui.select.cancel") || kb.matches(keyData, "tui.select.confirm")) {
			this.onClose();
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			this.scrollBy(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.scrollBy(1);
			return;
		}
		if (matchesKey(keyData, "j")) {
			this.scrollBy(1);
			return;
		}
		if (matchesKey(keyData, "k")) {
			this.scrollBy(-1);
			return;
		}
		if (matchesKey(keyData, Key.ctrl("d"))) {
			this.scrollBy(Math.floor(this.viewHeight / 2) || 1);
			return;
		}
		if (matchesKey(keyData, Key.ctrl("u"))) {
			this.scrollBy(-Math.floor(this.viewHeight / 2) || -1);
			return;
		}
		if (matchesKey(keyData, "f")) {
			this.fullscreen = !this.fullscreen;
			this.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.pageUp") || matchesKey(keyData, Key.left)) {
			this.scrollBy(-this.viewHeight || -1);
			return;
		}
		if (kb.matches(keyData, "tui.select.pageDown") || matchesKey(keyData, Key.right)) {
			this.scrollBy(this.viewHeight || 1);
			return;
		}
	}

	render(width: number): string[] {
		const maxHeight = Math.max(10, Math.floor((this.tui.terminal.rows || 24) * 0.88));
		const headerLines = this.fullscreen ? 0 : 3;
		const footerLines = this.fullscreen ? 0 : 2;
		const innerWidth = Math.max(10, width - 2);
		const contentHeight = Math.max(1, maxHeight - headerLines - footerLines - 2);

		const markdownLines = this.markdown.render(innerWidth);
		this.totalLines = markdownLines.length;
		this.viewHeight = contentHeight;
		const maxScroll = Math.max(0, this.totalLines - contentHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const visibleLines = markdownLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		const lines: string[] = [];
		if (!this.fullscreen) {
			lines.push(this.buildTitleLine(innerWidth));
			lines.push(this.buildMetaLine(innerWidth));
			lines.push("");
		}
		for (const line of visibleLines) {
			lines.push(truncateToWidth(line, innerWidth));
		}
		while (lines.length < headerLines + contentHeight) {
			lines.push("");
		}
		if (!this.fullscreen) {
			lines.push("");
			lines.push(this.buildActionLine(innerWidth));
		}

		const borderColor = (text: string) => this.theme.fg("borderMuted", text);
		const top = borderColor(`┌${"─".repeat(innerWidth)}┐`);
		const bottom = borderColor(`└${"─".repeat(innerWidth)}┘`);
		const framedLines = lines.map((line) => {
			const truncated = truncateToWidth(line, innerWidth);
			const padding = Math.max(0, innerWidth - visibleWidth(truncated));
			return borderColor("│") + truncated + " ".repeat(padding) + borderColor("│");
		});
		return [top, ...framedLines, bottom].map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		// Content never changes while open; kept for Component compatibility.
	}

	private scrollBy(delta: number): void {
		const maxScroll = Math.max(0, this.totalLines - this.viewHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, maxScroll));
	}

	private buildTitleLine(width: number): string {
		const titleText = ` ${this.title} `;
		const titleWidth = visibleWidth(titleText);
		if (titleWidth >= width) {
			return truncateToWidth(this.theme.fg("accent", titleText.trim()), width);
		}
		const leftWidth = Math.max(0, Math.floor((width - titleWidth) / 2));
		const rightWidth = Math.max(0, width - titleWidth - leftWidth);
		return (
			this.theme.fg("borderMuted", "─".repeat(leftWidth)) +
			this.theme.fg("accent", titleText) +
			this.theme.fg("borderMuted", "─".repeat(rightWidth))
		);
	}

	private buildMetaLine(width: number): string {
		return truncateToWidth(this.theme.fg("muted", ` ${this.filePath}`), width);
	}

	private buildActionLine(width: number): string {
		const close = this.theme.fg("accent", "esc") + this.theme.fg("dim", " close");
		const full = this.theme.fg("accent", "f") + this.theme.fg("dim", " fullscreen");
		const nav = this.theme.fg("dim", "j/k: scroll. ctrl+d/u: half page. ←/→: page.");
		let line = [close, full, nav].join(this.theme.fg("muted", " • "));
		if (this.totalLines > this.viewHeight) {
			const start = Math.min(this.totalLines, this.scrollOffset + 1);
			const end = Math.min(this.totalLines, this.scrollOffset + this.viewHeight);
			line += this.theme.fg("dim", ` ${start}-${end}/${this.totalLines}`);
		}
		return truncateToWidth(line, width);
	}
}

/** Open the overlay; single modal instance, errors surface as notifications. */
async function openSessionPreview(
	ctx: ExtensionCommandContext,
	title: string,
	filePath: string,
	content: string,
): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) =>
			new SessionPreviewOverlay(tui, theme, keybindings, title, filePath, content, done),
		{ overlay: true, overlayOptions: { width: "80%", anchor: "center" } },
	).catch((error) => {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	});
}

/** Render a session file and show it in the preview overlay. */
async function previewSessionFile(
	ctx: ExtensionCommandContext,
	title: string,
	sessionFile: string,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Session preview requires interactive mode", "error");
		return;
	}
	let messages: PreviewMessages;
	try {
		messages = await loadPreviewSessionMessages(sessionFile);
	} catch (error) {
		ctx.ui.notify(`Failed to read session: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const text = formatSessionPreview(messages) || "(no messages)";
	await openSessionPreview(ctx, title, sessionFile, text);
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
		description: "Repo root for --attach-background-task (bypasses git rev-parse)",
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
			console.error(`[background-task] ${TASK_RESULT_ENV} is required in child mode.`);
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
		description: "List background tasks and run an action (status / add to prompt / add result / preview / vscode / close); 'sessions' picks a child session (resume / add to prompt)",
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
				const selected = await selectTask(pi, ctx, "Select background task");
				if (!selected) return;

				const action = await selectTaskAction(ctx, selected);
				if (!action) continue;

				switch (action) {
					case "status":
						await runStatusAction(pi, ctx, selected);
						break;
					case "addToPrompt":
						if (!selected.sessionFile) {
							ctx.ui.notify(`Background task "${selected.name}" has no settled session file.`, "error");
							break;
						}
						// Alias (= branch) names the task up front: the session
						// file name only carries a uuid.
						addSessionToPrompt(
							ctx,
							selected.sessionFile,
							`read background task ${selected.name} session @${selected.sessionFile}`,
						);
						// Session added to the editor: the task's purpose is served;
						// returning to the list has no next step. Exit the flow.
						return;
					case "result":
						await runAddResultAction(pi, ctx, selected);
						// Result added to the editor: same as addToPrompt,
						// no next step in the list. Exit the flow.
						return;
					case "preview":
						if (!selected.sessionFile) {
							ctx.ui.notify(`Background task "${selected.name}" has no settled session file.`, "error");
							break;
						}
						await previewSessionFile(ctx, selected.name, selected.sessionFile);
						break;
					case "vscode":
						await runVscodeAction(pi, ctx, selected);
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
	// One-shot background task: fresh worktree + interactive child Pi,
	// dispatched and returned immediately (no waiting / polling).

	pi.registerTool({
		name: "background_task",
		label: "Background task",
		description:
			"Dispatch a one-shot background task: create a fresh git worktree + tmux session named by alias, then start an interactive Pi process inside it with the given prompt. Returns immediately without waiting for the task. Progress and completion are observed by the user via /background-tasks (live pane, settled output, task status). Fails fast if the alias already exists.",
		promptSnippet: "Dispatch a one-shot background task to a fresh isolated worktree; returns immediately.",
		promptGuidelines: [
			"background_task is fire-and-forget — returns immediately, the user observes via /background-tasks.",
			"Keep background_task's prompt free of commit instructions; leave the work uncommitted in the worktree so the user can review before anything lands.",
			"Never clean up a background task yourself (worktree removal, session kill, run dir deletion); the user closes it via /background-tasks after reviewing.",
		],
		parameters: Type.Object({
			alias: Type.String({
				description: "Task alias, used as the branch name (e.g. feat/my-feature). Must not already exist.",
			}),
			prompt: Type.String({
				description: "The task for the agent to perform. Be specific about what needs to be done and include any relevant context.",
			}),
			description: Type.String({
				description: "A very short description of the task that can be displayed to the user.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const alias = typeof params.alias === "string" ? params.alias.trim() : "";
			const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
			const description = typeof params.description === "string" ? params.description.trim() : "";
			if (!alias || !prompt || !description) {
				const error = "background_task requires a non-empty alias, prompt and description.";
				return {
					content: [{ type: "text" as const, text: error }],
					details: { ok: false, alias, error },
				};
			}
			const result = await dispatchBackgroundTask(pi, { alias, prompt, description, ctx });
			return {
				content: [{ type: "text" as const, text: formatDispatchText(result) }],
				details: result,
			};
		},
		renderCall(args, theme) {
			const description = typeof args.description === "string" && args.description.trim() ? args.description.trim() : "...";
			const text = theme.fg("toolTitle", theme.bold("background_task ")) + theme.fg("dim", description);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as DispatchResult | undefined;
			if (!details || !details.ok) {
				const content = result.content.find((part) => part.type === "text");
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}
			if (expanded && details.prompt) {
				const container = new Container();
				container.addChild(
					new Text(
						`${theme.fg("warning", "●")} ${theme.fg("toolTitle", theme.bold(details.alias))}${theme.fg("muted", " · dispatched")}`,
						0,
						0,
					),
				);
				container.addChild(new Text(theme.fg("accent", details.attachCommand ?? ""), 0, 0));
				container.addChild(
					new Text(theme.fg("dim", `${details.provider ?? ""}/${details.model ?? ""} (${details.thinking ?? ""})`), 0, 0),
				);
				container.addChild(new Text(BLANK_ROW, 1, 0));
				container.addChild(new Text(theme.fg("muted", "─── Prompt ───"), 0, 0));
				container.addChild(new Text(theme.fg("dim", details.prompt), 0, 0));
				return container;
			}
			let text = `${theme.fg("warning", "●")} ${theme.fg("toolTitle", theme.bold(details.alias))}`;
			text += theme.fg("muted", " · dispatched");
			text += `\n  ${theme.fg("accent", details.attachCommand ?? "")}`;
			text += `\n  ${theme.fg("dim", `${details.provider ?? ""}/${details.model ?? ""} (${details.thinking ?? ""})`)}`;
			return new Text(text, 0, 0);
		},
	});
}
