import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	getAgentDir,
	truncateHead,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Script Resolution ────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRANCH_WORKSPACE_SCRIPTS_DIR = path.join(__dirname, "branch-workspace");
const WORKTREE_SH = path.join(BRANCH_WORKSPACE_SCRIPTS_DIR, "worktree.sh");
const FIND_SESSIONS_SH = path.join(BRANCH_WORKSPACE_SCRIPTS_DIR, "find-sessions.sh");
const TMUX_SOCKET_DIR = "/tmp/claude-tmux-sockets";

// ─── Background-task Child Mode ───────────────────────────────────

/** Set on the dispatched child Pi: register only the result reporter. */
const BW_CHILD_ENV = "PI_BW_CHILD";
/** Result file path handed to the child Pi via env. */
const BW_RESULT_ENV = "PI_BW_RESULT";
/** Per repo-root + alias run artifacts, relative to getAgentDir(). */
const BW_RUNS_DIR = "branch-workspaces";
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

/** Programmatic pane log tail density: batch overview vs single drill-down. */
const BATCH_RAW_TAIL = 10;
/** Single /bw-log: pane tail lines while running, output lines once settled. */
const LOG_PANE_TAIL = 12;
const LOG_OUTPUT_LINES = 12;

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

// ─── tmux Socket ──────────────────────────────────────────────────

async function getTmuxSocket(pi: ExtensionAPI): Promise<string | null> {
	const result = await pi.exec("bash", [WORKTREE_SH, "root-name"]);
	if (result.code !== 0) return null;
	const rootName = result.stdout.trim();
	if (!rootName) return null;
	return path.join(TMUX_SOCKET_DIR, `${rootName}.sock`);
}

// ─── Child Reporter (background task result.json) ─────────────────

interface BwChildResult {
	version: 1;
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

function registerBwChildReporter(pi: ExtensionAPI, resultPath: string): void {
	let reported = false;

	const report = async (ctx: ExtensionContext, fallbackError?: string): Promise<void> => {
		if (reported) return;
		reported = true;

		const assistant = findLastAssistant(ctx);
		const stopReason = typeof assistant?.stopReason === "string" ? assistant.stopReason : undefined;
		const assistantError = typeof assistant?.errorMessage === "string" ? assistant.errorMessage : undefined;
		const failed = !assistant || stopReason === "error" || stopReason === "aborted" || Boolean(fallbackError);
		const output = assistant ? textFromAssistant(assistant) : "";
		const result: BwChildResult = {
			version: 1,
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
			console.error(`[branch-workspace] Failed to write result: ${error instanceof Error ? error.message : String(error)}`);
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

// ─── Run Artifacts (task.md / result.json / session) ──────────────

function rootNameFromSocket(socket: string): string {
	return path.basename(socket, ".sock");
}

function bwRunDirFromRoot(rootName: string, alias: string): string {
	return path.join(getAgentDir(), BW_RUNS_DIR, rootName, alias);
}

async function readBwResultFromRoot(rootName: string, alias: string): Promise<BwChildResult | null> {
	try {
		return JSON.parse(
			await readFile(path.join(bwRunDirFromRoot(rootName, alias), "result.json"), "utf8"),
		) as BwChildResult;
	} catch {
		return null;
	}
}

/** Dispatch timestamp = task.md mtime (written right before the child starts). */
async function readBwTaskStartedAtFromRoot(rootName: string, alias: string): Promise<number | undefined> {
	try {
		const info = await stat(path.join(bwRunDirFromRoot(rootName, alias), "task.md"));
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

interface SessionEntry {
	session_name: string;
	attached: boolean;
	created: string;
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

function parseSessionsOutput(stdout: string): SessionEntry[] {
	try {
		return JSON.parse(stdout);
	} catch {
		return [];
	}
}

// ─── Branch-workspace Facts ───────────────────────────────────────

/** Task status transposed verbatim from result.json; undefined while running. */
type BwTaskStatus = "completed" | "failed";

/**
 * Independent facts about one branch-workspace name. Worktree existence is
 * expressed by worktreePath being defined (no separate boolean).
 */
interface BranchWorkspaceFacts {
	name: string;
	worktreePath?: string;
	dirty?: boolean;
	sessionExists: boolean;
	taskStatus?: BwTaskStatus;
}

async function resolveBranchWorkspaceFacts(
	pi: ExtensionAPI,
	name: string,
): Promise<BranchWorkspaceFacts> {
	const socket = await getTmuxSocket(pi);

	// Worktree
	const wtResult = await pi.exec("bash", [WORKTREE_SH, "list", "--json", "-q", name]);
	const worktrees = wtResult.code === 0 ? parseWorktreeOutput(wtResult.stdout) : [];
	const worktree = worktrees.find((w) => w.branch === name);

	// tmux session
	let sessionExists = false;
	if (socket) {
		const sessResult = await pi.exec("bash", [FIND_SESSIONS_SH, "-S", socket, "-q", name, "--json"]);
		if (sessResult.code === 0) {
			sessionExists = parseSessionsOutput(sessResult.stdout).some((s) => s.session_name === name);
		}
	}

	// Task status from run artifacts
	const rootName = socket ? rootNameFromSocket(socket) : null;
	const childResult = rootName ? await readBwResultFromRoot(rootName, name) : null;

	return {
		name,
		worktreePath: worktree?.path,
		dirty: worktree?.dirty,
		sessionExists,
		taskStatus: childResult?.status,
	};
}

// ─── UI Select Helpers ────────────────────────────────────────────

/**
 * Task worktree list: worktree.sh output joined with result.json task status
 * and session existence. Source is the worktree list only — session-only
 * leftovers are not listed.
 */
async function listTaskWorktrees(pi: ExtensionAPI): Promise<BranchWorkspaceFacts[]> {
	const wtResult = await pi.exec("bash", [WORKTREE_SH, "list", "--json"]);
	const worktrees = wtResult.code === 0 ? parseWorktreeOutput(wtResult.stdout) : [];
	if (worktrees.length === 0) return [];

	const socket = await getTmuxSocket(pi);
	let sessions: SessionEntry[] = [];
	if (socket) {
		const sessResult = await pi.exec("bash", [FIND_SESSIONS_SH, "-S", socket, "--json"]);
		if (sessResult.code === 0) {
			sessions = parseSessionsOutput(sessResult.stdout);
		}
	}

	const rootName = socket ? rootNameFromSocket(socket) : null;
	const result: BranchWorkspaceFacts[] = [];
	for (const wt of [...worktrees].sort((a, b) => a.branch.localeCompare(b.branch))) {
		// Task status: verbatim result.json status; undefined while running or
		// when the worktree was not created by background_task.
		const childResult = rootName ? await readBwResultFromRoot(rootName, wt.branch) : null;
		result.push({
			name: wt.branch,
			worktreePath: wt.path,
			dirty: wt.dirty,
			sessionExists: sessions.some((s) => s.session_name === wt.branch),
			taskStatus: childResult?.status,
		});
	}
	return result;
}

async function selectBranchWorkspace(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	title: string,
): Promise<BranchWorkspaceFacts | null> {
	const worktrees = await listTaskWorktrees(pi);
	if (worktrees.length === 0) {
		ctx.ui.notify("No branch-workspace worktrees available.", "error");
		return null;
	}

	// Display row: "<alias> (<taskStatus>, <dirty>) (no session)" — each mark
	// omitted per facts. Map display strings back to facts to avoid parsing.
	const displayToFacts = new Map<string, BranchWorkspaceFacts>();
	for (const bw of worktrees) {
		const marks: string[] = [];
		if (bw.taskStatus) marks.push(bw.taskStatus);
		if (bw.dirty) marks.push("dirty");
		const mark = marks.length > 0 ? ` (${marks.join(", ")})` : "";
		const noSession = bw.sessionExists ? "" : " (no session)";
		displayToFacts.set(`${bw.name}${mark}${noSession}`, bw);
	}

	const choice = await ctx.ui.select(title, Array.from(displayToFacts.keys()));
	if (!choice) return null;
	return displayToFacts.get(choice) ?? null;
}

type BranchWorkspaceAction = "log" | "status" | "vscode" | "close";

/** Actions filtered by facts: session → log; worktree → vscode/close; status always. */
function getAvailableActions(facts: BranchWorkspaceFacts): BranchWorkspaceAction[] {
	const actions: BranchWorkspaceAction[] = [];
	if (facts.sessionExists) actions.push("log");
	actions.push("status");
	if (facts.worktreePath !== undefined) actions.push("vscode", "close");
	return actions;
}

function parsePositionalName(args: string, flagPatterns: RegExp[] = []): { name: string | undefined; rest: string } {
	let stripped = args;
	for (const re of flagPatterns) {
		stripped = stripped.replace(re, "");
	}
	const tokens = stripped.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { name: undefined, rest: "" };
	return { name: tokens[0], rest: tokens.slice(1).join(" ") };
}

async function resolveNameOrSelect(
	pi: ExtensionAPI,
	name: string | undefined,
	ctx: ExtensionCommandContext,
): Promise<BranchWorkspaceFacts | null> {
	if (name) return resolveBranchWorkspaceFacts(pi, name);
	return selectBranchWorkspace(pi, ctx, "Select branch-workspace");
}

// ─── tmux Helpers ─────────────────────────────────────────────────

async function discoverPaneTarget(
	pi: ExtensionAPI,
	socket: string,
	name: string,
): Promise<string | null> {
	const result = await pi.exec("tmux", [
		"-S", socket,
		"list-panes", "-s", "-t", name,
		"-F", "#{session_name}:#{window_index}.#{pane_index}",
	]);
	if (result.code !== 0) return null;
	const first = result.stdout.trim().split("\n")[0]?.trim();
	return first || null;
}

async function capturePaneOutput(
	pi: ExtensionAPI,
	socket: string,
	paneTarget: string,
	lines: number = 200,
): Promise<string> {
	// Capture extra history: large terminals pad the bottom with blank lines, so
	// the true tail is often above the last N rows of raw capture.
	const fetchLines = Math.max(lines * 4, 80);
	const result = await pi.exec("tmux", [
		"-S", socket,
		"capture-pane", "-S", `-${fetchLines}`, "-J", "-p", "-t", paneTarget,
	]);
	if (result.code !== 0) return "";
	const allLines = result.stdout.split("\n");
	// Drop trailing blank padding before taking the last N meaningful lines
	while (allLines.length > 0 && allLines[allLines.length - 1].trim() === "") {
		allLines.pop();
	}
	return allLines.slice(-lines).join("\n");
}

// ─── Formatting Helpers ───────────────────────────────────────────

function formatDuration(startedAt: number | undefined, finishedAt = Date.now()): string | undefined {
	if (startedAt === undefined) return undefined;
	const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function truncateBwText(text: string): string {
	const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncated.truncated) return truncated.content;
	return `${truncated.content}\n\n[Output truncated. Full output is available in the child session file.]`;
}

// ─── Pane Log Widgets ─────────────────────────────────────────────

/**
 * Append the last rawTailLines of pane output to lines. Caller supplies the
 * banner (────── name ──────); shared by the batch /bw-log view.
 */
function appendRawTailLines(lines: string[], paneOutput: string, rawTailLines: number): void {
	const cleaned = paneOutput.replace(/\s+$/, "");
	if (
		!cleaned.trim() ||
		cleaned === "(empty)" ||
		cleaned === "(no pane)" ||
		cleaned === "(no output)"
	) {
		lines.push(cleaned.trim() || "(no output)");
		return;
	}
	const tail = cleaned.split("\n").slice(-rawTailLines);
	if (tail.length === 0 || (tail.length === 1 && !tail[0].trim())) {
		lines.push("(no output)");
		return;
	}
	for (const row of tail) {
		lines.push(row.length === 0 ? BLANK_ROW : row);
	}
}

/** Branch-workspace banner. */
function formatBatchNameHeader(name: string): string {
	return `────── ${name} ──────`;
}

/** Batch /bw-log -b: name banner + short raw tail per worktree with a live session. */
function formatBatchRawLines(captures: Array<{ name: string; output: string }>): string[] {
	// Spacer rows (not ""): title ↔ first block, and between branch-workspace blocks
	const lines: string[] = [`Batch · ${captures.length} live`, BLANK_ROW];

	captures.forEach((c, i) => {
		if (i > 0) lines.push(BLANK_ROW);
		lines.push(formatBatchNameHeader(c.name), BLANK_ROW);
		appendRawTailLines(lines, c.output, BATCH_RAW_TAIL);
	});
	return lines;
}

/**
 * Single /bw-log: subagent-style renderResult layout.
 * Running → live pane tail; settled → result output (+ error on failed).
 * The attach line renders only when the tmux session still exists
 * (attachCommand is undefined otherwise).
 */
function formatBwLogWidgetLines(
	alias: string,
	attachCommand: string | undefined,
	result: BwChildResult | null,
	paneOutput: string,
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
	if (attachCommand) lines.push([{ text: `  ${attachCommand}`, color: "accent" }]);
	if (result) {
		lines.push([
			{ text: `  ${result.provider ?? ""}/${result.model ?? ""} (${result.thinking ?? ""})`, color: "dim" },
		]);
	}
	lines.push("");

	if (status === "running") {
		const cleaned = paneOutput.replace(/\s+$/, "");
		const tail = cleaned.split("\n").slice(-LOG_PANE_TAIL);
		if (!cleaned.trim() || tail.length === 0 || (tail.length === 1 && !tail[0].trim())) {
			lines.push([{ text: "(no output yet)", color: "muted" }]);
		} else {
			for (const row of tail) lines.push([{ text: row, color: "dim" }]);
		}
	} else if (result) {
		let rawOutput = result.output.trim();
		if (result.status === "failed" && result.error?.trim()) {
			rawOutput += `${rawOutput ? "\n\n" : ""}Error: ${result.error.trim()}`;
		}
		const output = truncateBwText(rawOutput || "(no text output)");
		const rows = output.split("\n");
		for (const row of rows.slice(0, LOG_OUTPUT_LINES)) {
			lines.push([{ text: row, color: "toolOutput" }]);
		}
		if (rows.length > LOG_OUTPUT_LINES) {
			lines.push([{ text: `… (+${rows.length - LOG_OUTPUT_LINES} more lines)`, color: "muted" }]);
		}
		if (result.sessionFile) {
			lines.push("");
			lines.push([{ text: `  child session: ${result.sessionFile}`, color: "dim" }]);
		}
	}
	return lines;
}

// ─── Session Management ───────────────────────────────────────────

async function ensureSession(
	pi: ExtensionAPI,
	socket: string,
	name: string,
	worktreePath: string,
): Promise<boolean> {
	const hasSession = await pi.exec("tmux", ["-S", socket, "has-session", "-t", name]);
	if (hasSession.code === 0) return true;

	await mkdir(path.dirname(socket), { recursive: true });
	const result = await pi.exec("tmux", [
		"-S", socket,
		"new-session", "-d", "-s", name,
		"-c", worktreePath,
	]);
	return result.code === 0;
}

// ─── Shared lifecycle core (slash commands) ───────────────────────

interface BranchWorkspaceEnv {
	name: string;
	worktreePath?: string;
	socket: string | null;
	session: string;
	paneTarget: string | null;
	sessionExists: boolean;
	dirty?: boolean;
	taskStatus?: BwTaskStatus;
	monitorCmd?: string;
}

interface CloseResult {
	ok: boolean;
	name: string;
	error?: string;
	needsForce?: "dirty";
	leftoverCount?: number;
}

async function buildBranchWorkspaceEnv(pi: ExtensionAPI, name: string): Promise<BranchWorkspaceEnv> {
	const facts = await resolveBranchWorkspaceFacts(pi, name);
	const socket = await getTmuxSocket(pi);
	let paneTarget: string | null = null;
	if (socket && facts.sessionExists) {
		paneTarget = await discoverPaneTarget(pi, socket, name);
	}
	return {
		name,
		worktreePath: facts.worktreePath,
		socket,
		session: name,
		paneTarget,
		sessionExists: facts.sessionExists,
		dirty: facts.dirty,
		taskStatus: facts.taskStatus,
		// Attach only when a tmux session exists.
		monitorCmd: facts.sessionExists && socket ? `tmux -S ${socket} attach -t ${name}` : undefined,
	};
}

/**
 * Close a branch-workspace: worktree existence is a prerequisite. Removes the
 * worktree (dirty requires force) and kills the tmux session when present.
 * Run artifacts (task.md / result.json / session/) are kept on purpose.
 */
async function closeBranchWorkspace(
	pi: ExtensionAPI,
	opts: { name: string; force?: boolean },
): Promise<CloseResult> {
	const { name, force = false } = opts;
	const facts = await resolveBranchWorkspaceFacts(pi, name);

	if (facts.worktreePath === undefined) {
		return {
			ok: false,
			name,
			error: `Branch-workspace "${name}" does not exist (no worktree).`,
		};
	}

	if (facts.dirty && !force) {
		return {
			ok: false,
			name,
			needsForce: "dirty",
			error: `Branch-workspace "${name}" has uncommitted changes. Ask the user, then call again with force: true to close anyway.`,
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
	let sessionWarn: string | undefined;
	if (facts.sessionExists) {
		const socket = await getTmuxSocket(pi);
		if (socket) {
			const killResult = await pi.exec("tmux", ["-S", socket, "kill-session", "-t", name]);
			if (killResult.code !== 0) {
				sessionWarn = `Worktree removed but tmux session "${name}" could not be killed.`;
			}
		}
	}

	return {
		ok: true,
		name,
		leftoverCount: cleanOutput?.leftoverCount ?? 0,
		error: sessionWarn,
	};
}

function formatCloseText(result: CloseResult): string {
	if (result.needsForce) {
		return result.error ?? `Close of "${result.name}" requires force: true (${result.needsForce}).`;
	}
	if (!result.ok) {
		return result.error ?? `Failed to close branch-workspace "${result.name}".`;
	}
	let msg = `Branch-workspace "${result.name}" closed.`;
	if (result.leftoverCount && result.leftoverCount > 0) {
		msg += ` Warning: ${result.leftoverCount} leftover file(s).`;
	}
	if (result.error) {
		msg += ` ${result.error}`;
	}
	return msg;
}

function formatStatusText(env: BranchWorkspaceEnv): string {
	if (env.worktreePath === undefined) {
		return `Branch-workspace "${env.name}" does not exist (no worktree).`;
	}
	return [
		`Branch-workspace "${env.name}" status.`,
		`worktreePath: ${env.worktreePath}`,
		`sessionExists: ${env.sessionExists}`,
		`taskStatus: ${env.taskStatus ?? "(unsettled or not a background task)"}`,
		`dirty: ${env.dirty ?? false}`,
		`socket: ${env.socket ?? ""}`,
		`session: ${env.session}`,
		`paneTarget: ${env.paneTarget ?? ""}`,
		`monitorCmd: ${env.monitorCmd ?? ""}`,
	].join("\n");
}

// ─── Background Task Dispatch ─────────────────────────────────────

/** Result of dispatchBackgroundTask; exposed to the agent tool as details. */
interface DispatchResult {
	ok: boolean;
	alias: string;
	error?: string;
	worktreePath?: string;
	tmuxSession?: string;
	attachCommand?: string;
	/** Slash command the user runs to observe this task. */
	monitorCommand?: string;
	provider?: string;
	model?: string;
	thinking?: string;
}

/**
 * Create a fresh branch-workspace for alias (fail fast on duplicates), start an
 * interactive child Pi inside its tmux session with the given prompt, and
 * return immediately. Completion is reported via result.json (child reporter)
 * and observed through /bw-log and /bw-list.
 */
async function dispatchBackgroundTask(
	pi: ExtensionAPI,
	opts: { alias: string; prompt: string; ctx: ExtensionContext },
): Promise<DispatchResult> {
	const { alias, prompt, ctx } = opts;

	// 1. Fail fast on duplicate alias (existing worktree or tmux session).
	const existing = await resolveBranchWorkspaceFacts(pi, alias);
	const existingParts: string[] = [];
	if (existing.worktreePath !== undefined) existingParts.push("worktree");
	if (existing.sessionExists) existingParts.push("tmux session");
	if (existingParts.length > 0) {
		return {
			ok: false,
			alias,
			error: `Branch-workspace "${alias}" already exists (${existingParts.join(" + ")}). Choose a different alias.`,
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

	// 3. tmux session on the branch-workspace socket.
	const socket = await getTmuxSocket(pi);
	if (!socket) {
		return { ok: false, alias, worktreePath, error: "Failed to resolve tmux socket" };
	}
	const sessionOk = await ensureSession(pi, socket, alias, worktreePath);
	if (!sessionOk) {
		return { ok: false, alias, worktreePath, error: `Failed to start tmux session for "${alias}".` };
	}

	// 4. Model inheritance.
	const provider = ctx.model?.provider;
	const model = ctx.model?.id;
	const thinking = pi.getThinkingLevel();
	if (!provider || !model) {
		return { ok: false, alias, worktreePath, error: "No model is active. Cannot dispatch background task." };
	}

	// 5. Run artifacts: task.md / result.json / session/.
	const rootName = rootNameFromSocket(socket);
	const runDir = bwRunDirFromRoot(rootName, alias);
	let resultPath: string;
	let promptPath: string;
	let sessionDir: string;
	try {
		await mkdir(runDir, { recursive: true, mode: 0o700 });
		sessionDir = path.join(runDir, "session");
		await mkdir(sessionDir, { recursive: true, mode: 0o700 });
		promptPath = path.join(runDir, "task.md");
		resultPath = path.join(runDir, "result.json");
		await writeFile(promptPath, `# Background task: ${alias}\n\n${prompt}\n`, {
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
		"-S", socket, "set-window-option", "-t", `${alias}:0`, "remain-on-exit", "on",
	]);
	if (remain.code !== 0) {
		return { ok: false, alias, worktreePath, error: remain.stderr.trim() || "Failed to set remain-on-exit." };
	}

	// 7. Child command: interactive Pi, unconditional --approve (autonomous run).
	const childSessionId = randomUUID();
	const tmuxTarget = `${alias}:0.0`;
	const attachCommand = `tmux -S ${shellQuote(socket)} attach -t ${shellQuote(alias)}`;
	const piArgs = [
		...getPiInvocationParts(),
		"--provider", provider,
		"--model", model,
		"--thinking", thinking,
		"--session-dir", sessionDir,
		"--session-id", childSessionId,
		"--name", alias,
		"--approve",
		"--extension", EXTENSION_PATH,
		`@${promptPath}`,
	];
	const childCommand = [
		"exec env",
		`${BW_CHILD_ENV}=1`,
		`${BW_RESULT_ENV}=${shellQuote(resultPath)}`,
		piArgs.map(shellQuote).join(" "),
	].join(" ");

	// 8. Fire and forget. Errors here leave a created worktree/session behind —
	// point the caller at /bw-close for cleanup.
	const cleanupHint = `worktree/session already created — clean up with /bw-close ${alias}`;
	const sent = await pi.exec("tmux", ["-S", socket, "send-keys", "-t", tmuxTarget, "-l", "--", childCommand]);
	if (sent.code !== 0) {
		return {
			ok: false,
			alias,
			worktreePath,
			error: `${sent.stderr.trim() || "Failed to start child Pi."} (${cleanupHint})`,
		};
	}
	const entered = await pi.exec("tmux", ["-S", socket, "send-keys", "-t", tmuxTarget, "Enter"]);
	if (entered.code !== 0) {
		return {
			ok: false,
			alias,
			worktreePath,
			error: `${entered.stderr.trim() || "Failed to submit child command."} (${cleanupHint})`,
		};
	}

	// 9. Return immediately — completion is observed via /bw-log and /bw-list.
	return {
		ok: true,
		alias,
		worktreePath,
		tmuxSession: alias,
		attachCommand,
		monitorCommand: `/bw-log ${alias}`,
		provider,
		model,
		thinking,
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
		`Clean up when done: /bw-close ${result.alias}`,
	].join("\n");
}

// ─── Commands & Tools ─────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	// Child mode (dispatched background task): register only the result
	// reporter — no slash commands, no agent tools.
	if (process.env[BW_CHILD_ENV] === "1") {
		const resultPath = process.env[BW_RESULT_ENV];
		if (!resultPath) {
			console.error(`[branch-workspace] ${BW_RESULT_ENV} is required in child mode.`);
			return;
		}
		registerBwChildReporter(pi, resultPath);
		return;
	}

	// Clear bw-log / bw-status widgets when a new turn starts so they don't block conversation output.
	pi.on("turn_start", async (_event, ctx) => {
		ctx.ui.setWidget("bw-log", undefined);
		ctx.ui.setWidget("bw-status", undefined);
	});

	// ── /bw-list ──
	pi.registerCommand("bw-list", {
		description: "List background-task worktrees (task status, dirty, session) and run an action. (For pane log of all sessions: /bw-log -b)",
		handler: async (_args, ctx) => {
			// Select branch-workspace
			const selected = await selectBranchWorkspace(pi, ctx, "Select branch-workspace");
			if (!selected) return;

			// Select action filtered by facts (session → log; worktree → vscode/close)
			const actions = getAvailableActions(selected);
			const action = await ctx.ui.select(`Action for "${selected.name}"`, actions) as BranchWorkspaceAction | undefined;
			if (!action) return;

			// Paste the command using positional argument for the selected branch-workspace.
			// This works for all actions offered here (log / status / vscode / close).
			// For a pane log of every branch-workspace with a live session, use `/bw-log -b` directly.
			const cmd = `/bw-${action} ${selected.name}`;
			ctx.ui.pasteToEditor(cmd);
		},
	});

	// ── /bw-status [name] ──
	// Branch-workspace status = facts + env (not pane log — use /bw-log for that).
	// Display uses the same aboveEditor widget surface as /bw-log.
	pi.registerCommand("bw-status", {
		description:
			"Show branch-workspace status (facts + env: worktreePath, session, dirty, taskStatus, …). Usage: /bw-status [name]",
		handler: async (args, ctx) => {
			const { name } = parsePositionalName(args);

			const resolved = await resolveNameOrSelect(pi, name, ctx);
			if (!resolved) return;
			const { name: bwName } = resolved;

			const env = await buildBranchWorkspaceEnv(pi, bwName);
			const lines = formatStatusText(env).split("\n");

			// Attach hint only when a session exists, matching /bw-log footer.
			let footer: string | undefined;
			if (env.monitorCmd) {
				const copied = await copyToClipboard(pi, env.monitorCmd);
				footer = `Monitor: ${env.monitorCmd}${copied ? " (copied)" : ""}`;
			}

			ctx.ui.setWidget("bw-status", buildWidget(lines, footer), { placement: "aboveEditor" });
		},
	});

	// ── /bw-close [name] ──
	pi.registerCommand("bw-close", {
		description: "Close a branch-workspace (remove worktree + kill tmux session; run artifacts are kept). Usage: /bw-close [name]",
		handler: async (args, ctx) => {
			const { name } = parsePositionalName(args);

			const facts = await resolveNameOrSelect(pi, name, ctx);
			if (!facts) return;
			const { name: bwName } = facts;

			// Worktree existence is a prerequisite for close.
			if (facts.worktreePath === undefined) {
				ctx.ui.notify(`Branch-workspace "${bwName}" does not exist (no worktree).`, "error");
				return;
			}

			// Interactive confirm maps to force:true; never close a dirty worktree without it.
			let force = false;
			if (facts.dirty) {
				const proceed = await ctx.ui.confirm(
					"Dirty Worktree",
					`Branch-workspace "${bwName}" has uncommitted changes. Close anyway?`,
				);
				if (!proceed) {
					ctx.ui.notify("Cancelled.", "info");
					return;
				}
				force = true;
			}

			const result = await closeBranchWorkspace(pi, { name: bwName, force });
			if (!result.ok) {
				ctx.ui.notify(result.error ?? "close failed", "error");
				return;
			}
			if (result.error) {
				ctx.ui.notify(result.error, "warning");
			}
			ctx.ui.notify(formatCloseText(result), "info");
		},
	});

	// ── /bw-log [-b|--batch] [name] ──  (pane log; not /bw-status)
	pi.registerCommand("bw-log", {
		description: "Show background-task log (settled output when done, live pane while running). Usage: /bw-log [-b|--batch] [name]",
		handler: async (args, ctx) => {
			const batch = /(^|\s)(-b|--batch)\b/.test(args);
			const { name } = parsePositionalName(args, [/(^|\s)(-b|--batch)\b/g]);

			if (batch) {
				const socket = await getTmuxSocket(pi);
				if (!socket) {
					ctx.ui.notify("Failed to resolve tmux socket.", "error");
					return;
				}

				const all = await listTaskWorktrees(pi);
				const withSession = all.filter((w) => w.sessionExists);
				if (withSession.length === 0) {
					ctx.ui.notify("No branch-workspaces with a live tmux session.", "info");
					return;
				}

				const captures: Array<{ name: string; output: string }> = [];
				for (const bw of withSession) {
					const target = await discoverPaneTarget(pi, socket, bw.name);
					if (!target) {
						captures.push({ name: bw.name, output: "(no pane)" });
						continue;
					}
					const output = await capturePaneOutput(pi, socket, target, 12);
					captures.push({ name: bw.name, output: output || "(empty)" });
				}

				// Batch is an overview only — no fake multi-target attach line.
				// Drill down with /bw-log <name> (single mode copies a real attach cmd).
				const lines = formatBatchRawLines(captures);
				ctx.ui.setWidget("bw-log", buildWidget(lines), { placement: "aboveEditor" });
				return;
			}

			// Single branch-workspace, three branches:
			// 1. result.json settled → output view
			// 2. unsettled + no session → fast fail
			// 3. unsettled + session → live pane tail
			const facts = await resolveNameOrSelect(pi, name, ctx);
			if (!facts) return;
			const { name: bwName } = facts;

			const socket = await getTmuxSocket(pi);
			if (!socket) {
				ctx.ui.notify("Failed to resolve tmux socket.", "error");
				return;
			}

			const rootName = rootNameFromSocket(socket);
			const result = await readBwResultFromRoot(rootName, bwName);
			const startedAt = await readBwTaskStartedAtFromRoot(rootName, bwName);
			const duration = formatDuration(startedAt, result?.finishedAt);

			// Attach line + footer render only while the session still exists.
			const attachCommand = facts.sessionExists ? `tmux -S ${socket} attach -t ${bwName}` : undefined;

			if (!result && !facts.sessionExists) {
				ctx.ui.notify(
					`Background task "${bwName}" has not settled and its tmux session no longer exists — nothing to observe. Clean up with /bw-close ${bwName}.`,
					"error",
				);
				return;
			}

			let paneOutput = "";
			if (!result) {
				const paneTarget = await discoverPaneTarget(pi, socket, bwName);
				if (!paneTarget) {
					ctx.ui.notify(`No pane found for session "${bwName}".`, "error");
					return;
				}
				paneOutput = await capturePaneOutput(pi, socket, paneTarget, LOG_PANE_TAIL);
			}

			let footer: string | undefined;
			if (attachCommand) {
				const copied = await copyToClipboard(pi, attachCommand);
				footer = `Monitor: ${attachCommand}${copied ? " (copied)" : ""}`;
			}

			const lines = formatBwLogWidgetLines(bwName, attachCommand, result, paneOutput, duration);
			ctx.ui.setWidget("bw-log", buildWidget(lines, footer), { placement: "aboveEditor" });
		},
	});

	// ── /bw-vscode [name] ──
	pi.registerCommand("bw-vscode", {
		description: "Open a branch-workspace in VS Code. Usage: /bw-vscode [name]",
		handler: async (args, ctx) => {
			const { name } = parsePositionalName(args);

			const facts = await resolveNameOrSelect(pi, name, ctx);
			if (!facts) return;

			if (facts.worktreePath === undefined) {
				ctx.ui.notify(`Branch-workspace "${facts.name}" does not exist (no worktree).`, "error");
				return;
			}

			await pi.exec("code", [facts.worktreePath]);
			ctx.ui.notify(`Opened VS Code for "${facts.name}" at ${facts.worktreePath}`, "info");
		},
	});

	// ── Tool: background_task ──
	// One-shot background task: fresh branch-workspace + interactive child Pi,
	// dispatched and returned immediately (no waiting / polling).

	pi.registerTool({
		name: "background_task",
		label: "Background task",
		description:
			"Dispatch a one-shot background task: create a fresh branch-workspace (git worktree + tmux session) named by alias, then start an interactive Pi process inside it with the given prompt. Returns immediately without waiting for the task. Completion is observed by the user via /bw-log (live pane, settled output) and /bw-list (completed/failed task status). Fails fast if the alias already exists.",
		promptSnippet: "Dispatch a one-shot background task to a fresh branch-workspace; returns immediately.",
		promptGuidelines: [
			"alias must be a new branch-workspace name (e.g. feat/my-feature); an existing alias fails fast reporting what already exists (worktree and/or tmux session).",
			"The dispatch returns immediately — do not wait, poll, or assume the task result. The user observes progress via /bw-log and completion via /bw-list.",
			"The background Pi runs autonomously (--approve) in an isolated worktree, inheriting the current provider, model, and thinking level.",
		],
		parameters: Type.Object({
			alias: Type.String({
				description: "Task alias, used as the branch-workspace name (e.g. feat/my-feature). Must not already exist.",
			}),
			prompt: Type.String({ description: "The complete task content for the background Pi process." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const alias = typeof params.alias === "string" ? params.alias.trim() : "";
			const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
			if (!alias || !prompt) {
				const error = "background_task requires a non-empty alias and prompt.";
				return {
					content: [{ type: "text" as const, text: error }],
					details: { ok: false, alias, error },
				};
			}
			const result = await dispatchBackgroundTask(pi, { alias, prompt, ctx });
			return {
				content: [{ type: "text" as const, text: formatDispatchText(result) }],
				details: result,
			};
		},
		renderCall(args, theme) {
			const alias = typeof args.alias === "string" && args.alias.trim() ? args.alias.trim() : "...";
			const task = typeof args.prompt === "string" && args.prompt.trim() ? args.prompt.trim() : "...";
			const firstLine = task.split("\n", 1)[0] ?? task;
			const preview = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
			const text =
				theme.fg("toolTitle", theme.bold("background_task ")) + theme.fg("dim", `${alias} · ${preview}`);
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as DispatchResult | undefined;
			if (!details || !details.ok) {
				const content = result.content.find((part) => part.type === "text");
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}
			let text = `${theme.fg("warning", "●")} ${theme.fg("toolTitle", theme.bold(details.alias))}`;
			text += theme.fg("muted", " · dispatched");
			text += `\n  ${theme.fg("accent", details.attachCommand ?? "")}`;
			text += `\n  ${theme.fg("dim", `${details.provider ?? ""}/${details.model ?? ""} (${details.thinking ?? ""})`)}`;
			text += `\n  ${theme.fg("muted", `monitor: ${details.monitorCommand}`)}`;
			return new Text(text, 0, 0);
		},
	});
}
