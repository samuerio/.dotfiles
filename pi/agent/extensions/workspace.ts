import { completeSimple, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, readFileSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ─── Script Resolution ────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = path.join(__dirname, "workspace");
const WORKTREE_SH = path.join(WORKSPACE_DIR, "worktree.sh");
const FIND_SESSIONS_SH = path.join(WORKSPACE_DIR, "find-sessions.sh");
const STATE_FILE = ".branch-workspace-current.json";
const TMUX_SOCKET_DIR = "/tmp/claude-tmux-sockets";

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
const BATCH_ANALYZE_RAW_TAIL = 5;
const SINGLE_ANALYZE_RAW_TAIL = 15;

function buildWidget(lines: string[], footer?: string) {
	return (_tui: { width: number }, theme: { fg: (color: string, text: string) => string }) => {
		const container = new Container();
		for (const line of lines) {
			// Map empty / unicode-whitespace-only rows to BLANK_ROW so Text keeps height
			if (line.length === 0 || line === BLANK_ROW || /^[\s\u00A0]*$/.test(line)) {
				container.addChild(new Text(BLANK_ROW, 1, 0));
				continue;
			}
			container.addChild(new Text(line, 1, 0));
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

// ─── Current State File ───────────────────────────────────────────

interface WorkspaceState {
	name: string;
	worktreePath: string;
}

async function readCurrentState(cwd: string): Promise<WorkspaceState | null> {
	const filePath = path.join(cwd, STATE_FILE);
	try {
		const content = await fs.readFile(filePath, "utf8");
		return JSON.parse(content);
	} catch {
		return null;
	}
}

async function writeCurrentState(cwd: string, name: string, worktreePath: string): Promise<void> {
	await fs.writeFile(path.join(cwd, STATE_FILE), JSON.stringify({ name, worktreePath }), "utf8");
}

async function clearCurrentState(cwd: string): Promise<void> {
	try {
		await fs.unlink(path.join(cwd, STATE_FILE));
	} catch {
		// already gone
	}
}

// ─── UI Select Helpers ────────────────────────────────────────────

async function listAllWorkspaces(pi: ExtensionAPI): Promise<ResolvedWorkspace[]> {
	const wtResult = await pi.exec("bash", [WORKTREE_SH, "list", "--json"]);
	const worktrees = wtResult.code === 0 ? parseWorktreeOutput(wtResult.stdout) : [];

	const socket = await getTmuxSocket(pi);
	let sessions: SessionEntry[] = [];
	if (socket) {
		const sessResult = await pi.exec("bash", [FIND_SESSIONS_SH, "-S", socket, "--json"]);
		if (sessResult.code === 0) {
			sessions = parseSessionsOutput(sessResult.stdout);
		}
	}

	const names = new Set<string>();
	for (const wt of worktrees) names.add(wt.branch);
	for (const s of sessions) names.add(s.session_name);

	const result: ResolvedWorkspace[] = [];
	for (const name of [...names].sort()) {
		const wt = worktrees.find((w) => w.branch === name);
		const sess = sessions.find((s) => s.session_name === name);

		let state: BranchWorkspaceState;
		if (wt && sess) state = "active";
		else if (wt) state = "idle";
		else if (sess) state = "orphan";
		else state = "missing";

		result.push({ name, state, worktreePath: wt?.path, dirty: wt?.dirty });
	}
	return result;
}

async function selectWorkspace(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	title: string,
	cwd?: string,
): Promise<ResolvedWorkspace | null> {
	const workspaces = await listAllWorkspaces(pi);
	if (workspaces.length === 0) {
		ctx.ui.notify("No workspaces available.", "error");
		return null;
	}
	const currentName = cwd ? (await readCurrentState(cwd))?.name : undefined;

	// Build display strings and a robust map to avoid fragile string parsing of names
	const displayToWorkspace = new Map<string, ResolvedWorkspace>();
	for (const ws of workspaces) {
		const marks: string[] = [];
		if (ws.dirty) marks.push("dirty");
		if (ws.name === currentName) marks.push("current");
		const mark = marks.length > 0 ? ` (${marks.join(", ")})` : "";
		const display = `${ws.name} [${ws.state}]${mark}`;
		displayToWorkspace.set(display, ws);
	}

	const choice = await ctx.ui.select(title, Array.from(displayToWorkspace.keys()));
	if (!choice) return null;
	return displayToWorkspace.get(choice) ?? null;
}

type WorkspaceAction = "open" | "log" | "status" | "vscode" | "cancel" | "close";

function getAvailableActions(state: BranchWorkspaceState): WorkspaceAction[] {
	switch (state) {
		case "active": return ["open", "log", "status", "vscode", "cancel", "close"];
		case "idle": return ["open", "status", "vscode", "close"];
		case "orphan": return ["status", "close"];
		default: return [];
	}
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
	cwd: string,
	ctx: ExtensionCommandContext,
	selectFlag: boolean,
): Promise<{ name: string; worktreePath?: string } | null> {
	if (name) return { name };

	if (!selectFlag) {
		const state = await readCurrentState(cwd);
		if (state) return state;
	}

	return selectWorkspace(pi, ctx, "Select workspace", cwd);
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

// ─── Workspace State Resolution ───────────────────────────────────

type BranchWorkspaceState = "active" | "idle" | "orphan" | "missing";

interface ResolvedWorkspace {
	name: string;
	state: BranchWorkspaceState;
	worktreePath?: string;
	dirty?: boolean;
}

async function resolveWorkspaceState(
	pi: ExtensionAPI,
	name: string,
): Promise<ResolvedWorkspace> {
	const socket = await getTmuxSocket(pi);

	// Check worktree
	const wtResult = await pi.exec("bash", [WORKTREE_SH, "list", "--json", "-q", name]);
	const worktrees = wtResult.code === 0 ? parseWorktreeOutput(wtResult.stdout) : [];
	const worktree = worktrees.find((w) => w.branch === name);

	// Check tmux session
	let session: SessionEntry | undefined;
	if (socket) {
		const sessResult = await pi.exec("bash", [FIND_SESSIONS_SH, "-S", socket, "-q", name, "--json"]);
		if (sessResult.code === 0) {
			const sessions = parseSessionsOutput(sessResult.stdout);
			session = sessions.find((s) => s.session_name === name);
		}
	}

	let state: BranchWorkspaceState;
	if (worktree && session) state = "active";
	else if (worktree) state = "idle";
	else if (session) state = "orphan";
	else state = "missing";

	return {
		name,
		state,
		worktreePath: worktree?.path,
		dirty: worktree?.dirty,
	};
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

function isPaneIdle(output: string): boolean {
	const lines = output.trim().split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) return true;
	const last = lines[lines.length - 1];
	return /[\$%>❯]\s*$/.test(last);
}

/**
 * Raw batch tags = current pane state only: idle | busy.
 * (Last-command outcome tags belong to analyze mode: done | error | busy.)
 */
function classifyRawPane(output: string): { tag: "idle" | "busy"; snippet: string } {
	if (!output.trim() || output === "(empty)") {
		return { tag: "idle", snippet: "(no output)" };
	}
	if (output === "(no pane)") {
		return { tag: "idle", snippet: "(no pane target)" };
	}
	const nonEmpty = output
		.trim()
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	const last = nonEmpty[nonEmpty.length - 1] ?? "";
	if (isPaneIdle(output)) {
		return { tag: "idle", snippet: last || "(shell prompt)" };
	}
	return { tag: "busy", snippet: last || "(running)" };
}

function formatBatchRawLines(captures: Array<{ name: string; output: string }>): string[] {
	// Spacer rows (not ""): title ↔ first block, and between workspace blocks
	const lines: string[] = [`Batch · ${captures.length} active`, BLANK_ROW];

	captures.forEach((c, i) => {
		if (i > 0) lines.push(BLANK_ROW);
		const { tag } = classifyRawPane(c.output);
		lines.push(formatBatchNameHeader(c.name, tag));
		if (!c.output.trim() || c.output === "(empty)" || c.output === "(no pane)") {
			lines.push(c.output.trim() || "(no output)");
			return;
		}
		const tail = c.output.split("\n").slice(-BATCH_ANALYZE_RAW_TAIL);
		for (const row of tail) {
			lines.push(row.length === 0 ? BLANK_ROW : row);
		}
	});
	return lines;
}

// ─── Rush Mode Resolution ─────────────────────────────────────────

type ModeSpec = {
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
};

const RUSH_MODE = "rush";

function loadRushModeSpec(cwd: string): ModeSpec | null {
	const candidates = [path.join(cwd, ".pi", "modes.json"), path.join(getAgentDir(), "modes.json")];
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(p, "utf8"));
		} catch {
			continue;
		}
		const modes = parsed && typeof parsed === "object" ? (parsed as { modes?: unknown }).modes : undefined;
		if (!modes || typeof modes !== "object") continue;
		const spec = (modes as Record<string, unknown>)[RUSH_MODE];
		if (!spec || typeof spec !== "object") continue;
		const obj = spec as Record<string, unknown>;
		const provider = typeof obj.provider === "string" ? obj.provider : undefined;
		const modelId = typeof obj.modelId === "string" ? obj.modelId : undefined;
		const thinkingLevel = typeof obj.thinkingLevel === "string" ? obj.thinkingLevel : undefined;
		if (!provider || !modelId) continue;
		return { provider, modelId, thinkingLevel };
	}
	return null;
}

// ─── LLM Status Analysis ─────────────────────────────────────────

/**
 * Shared -a analyzer: structured fields only. Raw pane tail is attached in code.
 * Used by single /ws-log -a and by batch /ws-log -b -a (N parallel calls).
 */
const STATUS_SYSTEM_PROMPT = `You are a workspace status analyzer for a single coding workspace TUI widget.

Given terminal pane output, analyze ONLY the last executed command and its output. Do not summarize the branch, project, or overall session.

TAG vocabulary (last-command outcome — do NOT use "idle"):
  - busy: the last command is still running
  - error: the last command failed (non-zero exit, Error/failed/panic/traceback, etc.) — NEVER use done if it failed
  - done: the last command finished successfully, OR there is no useful last command (shell prompt only)

Reply with EXACTLY three lines, each with a fixed prefix:

status: <done|error|busy>
cmd: <command after shell prompt only>
summary: <one short Simplified Chinese outcome>

Rules for each field:
- status: exactly one of done | error | busy (lowercase)
- cmd: ONLY the command portion after the shell prompt (❯ $ % >). Example: if the log has "~/path ❯ echo foo; true", write "echo foo; true". Copy from the log; do not invent. Do not include the path/prompt. If there is no command, write "(none)".
- summary: Simplified Chinese, max ~40 chars. Do NOT start with "最后命令". State the result only (e.g. "成功，输出 LAST_CMD_OK"). If status is error, you MUST quote key failure text from the log (e.g. include "Error: simulated failure").
- Do NOT guess shell control-flow semantics (no "because there was no next command", no inventing exit codes you cannot see).
- No markdown, no code fences, no bullets, no blank lines, no extra lines.
- Do NOT paste raw pane log — the UI attaches that separately.`;

type AnalyzeFields = { status: string; cmd: string; summary: string };

/**
 * Normalize LLM analyze text into status/cmd/summary.
 * Tolerates missing prefixes when the model returns bare 3-line shape.
 */
function parseAnalyzeFields(analysis: string): AnalyzeFields {
	const raw = analysis
		.trim()
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	let status = "";
	let cmd = "";
	let summary = "";

	for (const line of raw) {
		const m = line.match(/^(status|cmd|summary)\s*:\s*(.*)$/i);
		if (m) {
			const key = m[1].toLowerCase();
			const val = m[2].trim();
			if (key === "status") status = val;
			else if (key === "cmd") cmd = val;
			else summary = val;
		}
	}

	// Bare three-line fallback: tag / cmd / summary
	if (!status && raw.length >= 1) {
		const m = raw[0].match(/^(idle|busy|error|done)\b/i);
		if (m) {
			status = m[1].toLowerCase() === "idle" ? "done" : m[1].toLowerCase();
			if (raw.length >= 2 && !cmd) cmd = raw[1].replace(/^cmd\s*:\s*/i, "");
			if (raw.length >= 3 && !summary) summary = raw[2].replace(/^summary\s*:\s*/i, "");
		}
	}

	if (status === "idle") status = "done";
	if (!status) status = "?";
	if (!cmd) cmd = "(none)";
	if (!summary) {
		summary =
			raw.find(
				(l) => !/^(status|cmd|summary)\s*:/i.test(l) && !/^(idle|busy|error|done)$/i.test(l),
			) ?? "(no summary)";
	}

	return { status, cmd, summary };
}

function appendRawTail(lines: string[], paneOutput: string, rawTailLines: number): void {
	lines.push(BLANK_ROW, "── raw ──");
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

/** Batch workspace banner — longer rules so it doesn't look like ── raw ──. */
function formatBatchNameHeader(name: string, status: string): string {
	return `────── ${name} · ${status} ──────`;
}

/**
 * Single /ws-log without -a: current pane idle|busy + raw tail + Monitor (footer).
 */
function formatSingleRawWidget(paneOutput: string): string[] {
	const { tag } = classifyRawPane(paneOutput);
	const lines = [`status: ${tag}`];
	appendRawTail(lines, paneOutput, SINGLE_ANALYZE_RAW_TAIL);
	return lines;
}

/**
 * Analyze widget body + programmatic raw.
 * - Single (no name): status: / cmd: / summary:  then raw (15)
 * - Batch (with name): ────── name · status ──────, then cmd: / summary: only, then raw (5)
 */
function formatAnalyzeWidget(
	analysis: string,
	paneOutput: string,
	rawTailLines: number,
	name?: string,
): string[] {
	const { status, cmd, summary } = parseAnalyzeFields(analysis);
	const lines: string[] = [];
	if (name) {
		// Batch: status in banner header; raw keeps short ── raw ──
		lines.push(formatBatchNameHeader(name, status));
		lines.push(`cmd: ${cmd}`, `summary: ${summary}`);
	} else {
		lines.push(`status: ${status}`, `cmd: ${cmd}`, `summary: ${summary}`);
	}
	appendRawTail(lines, paneOutput, rawTailLines);
	return lines;
}

/** Local fields when pane is missing/empty — skip LLM. */
function fallbackAnalyzeFields(output: string): string {
	if (output === "(no pane)") {
		return "status: done\ncmd: (none)\nsummary: 无 pane";
	}
	if (!output.trim() || output === "(empty)") {
		return "status: done\ncmd: (none)\nsummary: 无输出";
	}
	return "status: done\ncmd: (none)\nsummary: 仅 shell 提示符，无最近命令";
}

async function analyzeStatus(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	paneOutput: string,
): Promise<AnalysisResult> {
	const rushSpec = loadRushModeSpec(ctx.cwd);
	if (!rushSpec) {
		return { error: "No rush mode configured in modes.json." };
	}

	const model = ctx.modelRegistry.find(rushSpec.provider!, rushSpec.modelId!);
	if (!model) {
		return { error: `Rush model ${rushSpec.provider}/${rushSpec.modelId} not found in registry.` };
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { error: `API key missing for provider ${rushSpec.provider}.` };
	}

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: paneOutput }],
		timestamp: Date.now(),
	};

	const response = await completeSimple(
		model,
		{
			systemPrompt: STATUS_SYSTEM_PROMPT,
			messages: [userMessage],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: ctx.signal,
			reasoning: "off",
		},
	);

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
	return { analysis: text };
}

/**
 * Analyze each active workspace in parallel with the shared STATUS_SYSTEM_PROMPT,
 * then render status/cmd/summary + short raw (5 lines) per workspace.
 */
async function analyzeBatchStatusParallel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	items: Array<{ name: string; output: string }>,
): Promise<string[]> {
	const results = await Promise.all(
		items.map(async (item) => {
			if (!item.output.trim() || item.output === "(no pane)" || item.output === "(empty)") {
				return {
					name: item.name,
					analysis: fallbackAnalyzeFields(item.output || "(empty)"),
					output: item.output || "(empty)",
				};
			}
			try {
				const result = await analyzeStatus(pi, ctx, item.output);
				if ("analysis" in result) {
					return { name: item.name, analysis: result.analysis, output: item.output };
				}
				return {
					name: item.name,
					analysis: `status: error\ncmd: (none)\nsummary: 分析失败：${result.error}`,
					output: item.output,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					name: item.name,
					analysis: `status: error\ncmd: (none)\nsummary: 分析失败：${msg}`,
					output: item.output,
				};
			}
		}),
	);

	const lines: string[] = [`Batch · ${results.length} active`, BLANK_ROW];
	results.forEach((r, i) => {
		if (i > 0) lines.push(BLANK_ROW);
		lines.push(
			...formatAnalyzeWidget(r.analysis, r.output, BATCH_ANALYZE_RAW_TAIL, r.name),
		);
	});
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

	await fs.mkdir(path.dirname(socket), { recursive: true });
	const result = await pi.exec("tmux", [
		"-S", socket,
		"new-session", "-d", "-s", name,
		"-c", worktreePath,
	]);
	return result.code === 0;
}

// ─── Status Bar ────────────────────────────────────────────────────

type ExtensionUI = ExtensionCommandContext["ui"];

/** Status-bar chip for current branch-workspace name (not workspace state enum). */
function updateStatusBar(ui: ExtensionUI, name: string | undefined): void {
	if (!name) {
		ui.setStatus("branch-workspace", undefined);
		return;
	}
	const label = ui.theme.fg("accent", "branch-workspace");
	ui.setStatus("branch-workspace", `${label} ${name}`);
}

// ─── Shared lifecycle core (slash commands + tools) ───────────────

interface WorkspaceEnv {
	name: string;
	branch: string;
	worktreePath?: string;
	socket: string | null;
	session: string;
	paneTarget: string | null;
	state: BranchWorkspaceState;
	dirty?: boolean;
	paneIdle?: boolean;
	preValidated: boolean;
	monitorCmd?: string;
}

interface ListWorkspaceRow {
	name: string;
	state: BranchWorkspaceState;
	dirty?: boolean;
	worktreePath?: string;
	current: boolean;
}

interface ListResult {
	ok: true;
	workspaces: ListWorkspaceRow[];
	currentName?: string;
	socket: string | null;
}

/** Result of openWorkspace. Agent tool exposes only ok/name/warnings/error; slash may use path/created/monitor. */
interface OpenResult {
	ok: boolean;
	name: string;
	error?: string;
	warnings: string[];
	/** Slash/UI only — not part of the agent tool contract. */
	worktreePath?: string;
	worktreeCreated?: boolean;
	monitorCmd?: string;
}

interface CloseResult {
	ok: boolean;
	name: string;
	state?: BranchWorkspaceState;
	error?: string;
	needsForce?: "dirty" | "orphan";
	leftoverCount?: number;
}

async function listWorkspaces(
	pi: ExtensionAPI,
	opts: { cwd?: string; query?: string } = {},
): Promise<ListResult> {
	let workspaces = await listAllWorkspaces(pi);
	if (opts.query) {
		const q = opts.query.toLowerCase();
		workspaces = workspaces.filter((w) => w.name.toLowerCase().includes(q));
	}
	const currentName = opts.cwd ? (await readCurrentState(opts.cwd))?.name : undefined;
	const socket = await getTmuxSocket(pi);
	return {
		ok: true,
		currentName,
		socket,
		workspaces: workspaces.map((w) => ({
			name: w.name,
			state: w.state,
			dirty: w.dirty,
			worktreePath: w.worktreePath,
			current: w.name === currentName,
		})),
	};
}

async function buildWorkspaceEnv(pi: ExtensionAPI, name: string): Promise<WorkspaceEnv> {
	const ws = await resolveWorkspaceState(pi, name);
	const socket = await getTmuxSocket(pi);
	let paneTarget: string | null = null;
	let paneIdle: boolean | undefined;
	if (socket && (ws.state === "active" || ws.state === "idle")) {
		if (ws.state === "active") {
			paneTarget = await discoverPaneTarget(pi, socket, name);
			if (paneTarget) {
				const out = await capturePaneOutput(pi, socket, paneTarget, 20);
				paneIdle = isPaneIdle(out);
			}
		}
	}
	const preValidated = !!(socket && paneTarget && ws.state === "active");
	const hasSession = ws.state === "active" || ws.state === "orphan";
	return {
		name,
		branch: name,
		worktreePath: ws.worktreePath,
		socket,
		session: name,
		paneTarget,
		state: ws.state,
		dirty: ws.dirty,
		paneIdle,
		preValidated,
		// Attach only when a tmux session exists (active / orphan). Idle has no session.
		monitorCmd: hasSession && socket ? `tmux -S ${socket} attach -t ${name}` : undefined,
	};
}

async function openWorkspace(
	pi: ExtensionAPI,
	opts: { cwd: string; name: string; ui?: ExtensionUI },
): Promise<OpenResult> {
	const { cwd, name, ui } = opts;
	const warnings: string[] = [];

	const result = await pi.exec("bash", [WORKTREE_SH, "open", name, "--json"]);
	if (result.code !== 0) {
		return {
			ok: false,
			name,
			warnings,
			error: result.stderr.trim() || "worktree.sh open failed",
		};
	}

	const output = parseOpenOutput(result.stdout);
	if (!output) {
		return {
			ok: false,
			name,
			warnings,
			error: "Failed to parse worktree output",
		};
	}

	const socket = await getTmuxSocket(pi);
	if (!socket) {
		return {
			ok: false,
			name,
			warnings,
			worktreePath: output.worktreePath,
			worktreeCreated: output.worktreeCreated,
			error: "Failed to resolve tmux socket",
		};
	}

	const sessionOk = await ensureSession(pi, socket, name, output.worktreePath);
	if (!sessionOk) {
		warnings.push(`Worktree created but failed to start tmux session for "${name}".`);
	}

	await writeCurrentState(cwd, name, output.worktreePath);
	if (ui) updateStatusBar(ui, name);

	// Agent tool contract is slim (ok/name/warnings). Path/created/monitor are for slash UI only.
	return {
		ok: true,
		name,
		warnings,
		worktreePath: output.worktreePath,
		worktreeCreated: output.worktreeCreated,
		monitorCmd: `tmux -S ${socket} attach -t ${name}`,
	};
}

async function closeWorkspace(
	pi: ExtensionAPI,
	opts: { cwd: string; name: string; force?: boolean; ui?: ExtensionUI },
): Promise<CloseResult> {
	const { cwd, name, force = false, ui } = opts;
	const ws = await resolveWorkspaceState(pi, name);

	if (ws.state === "missing") {
		return {
			ok: false,
			name,
			state: "missing",
			error: `Workspace "${name}" does not exist (no worktree, no session).`,
		};
	}

	if (ws.state === "orphan") {
		if (!force) {
			return {
				ok: false,
				name,
				state: "orphan",
				needsForce: "orphan",
				error: `Workspace "${name}" has an orphaned tmux session (no worktree). Ask the user, then call again with force: true to kill the session.`,
			};
		}
		const socket = await getTmuxSocket(pi);
		if (socket) {
			await pi.exec("tmux", ["-S", socket, "kill-session", "-t", name]);
		}
		const currentState = await readCurrentState(cwd);
		if (currentState?.name === name) {
			await clearCurrentState(cwd);
			if (ui) updateStatusBar(ui, undefined);
		}
		return { ok: true, name, state: "orphan" };
	}

	if (ws.dirty && !force) {
		return {
			ok: false,
			name,
			state: ws.state,
			needsForce: "dirty",
			error: `Workspace "${name}" has uncommitted changes. Ask the user, then call again with force: true to close anyway.`,
		};
	}

	const cleanArgs = [WORKTREE_SH, "clean", name];
	if (ws.dirty) cleanArgs.push("--force");
	cleanArgs.push("--json");
	const cleanResult = await pi.exec("bash", cleanArgs);
	if (cleanResult.code !== 0) {
		return {
			ok: false,
			name,
			state: ws.state,
			error: cleanResult.stderr.trim() || "Failed to remove worktree.",
		};
	}
	const cleanOutput = parseCleanOutput(cleanResult.stdout);

	let sessionWarn: string | undefined;
	if (ws.state === "active") {
		const socket = await getTmuxSocket(pi);
		if (socket) {
			const killResult = await pi.exec("tmux", ["-S", socket, "kill-session", "-t", name]);
			if (killResult.code !== 0) {
				sessionWarn = `Worktree removed but tmux session "${name}" could not be killed (orphan).`;
			}
		}
	}

	const currentState = await readCurrentState(cwd);
	if (currentState?.name === name) {
		await clearCurrentState(cwd);
		if (ui) updateStatusBar(ui, undefined);
	}

	return {
		ok: true,
		name,
		state: ws.state,
		leftoverCount: cleanOutput?.leftoverCount ?? 0,
		error: sessionWarn,
	};
}

function formatListText(result: ListResult): string {
	if (result.workspaces.length === 0) {
		return "No branch-workspaces found.";
	}
	const lines = result.workspaces.map((w) => {
		const marks: string[] = [];
		if (w.dirty) marks.push("dirty");
		if (w.current) marks.push("current");
		const mark = marks.length > 0 ? ` (${marks.join(", ")})` : "";
		return `- ${w.name} [${w.state}]${mark}`;
	});
	if (result.currentName) {
		lines.push("", `current: ${result.currentName}`);
	}
	return lines.join("\n");
}

function formatOpenText(result: OpenResult): string {
	if (!result.ok) {
		return result.error ?? `Failed to open workspace "${result.name}".`;
	}
	const lines = [`Opened workspace "${result.name}".`];
	if (result.warnings.length > 0) {
		lines.push(`warnings: ${result.warnings.join("; ")}`);
	}
	return lines.join("\n");
}

/** Agent-facing open details: no path/created/env (use ws_status for dispatch readiness). */
function openToolDetails(result: OpenResult): {
	ok: boolean;
	name: string;
	error?: string;
	warnings: string[];
} {
	return {
		ok: result.ok,
		name: result.name,
		error: result.error,
		warnings: result.warnings,
	};
}

function formatCloseText(result: CloseResult): string {
	if (result.needsForce) {
		return result.error ?? `Close of "${result.name}" requires force: true (${result.needsForce}).`;
	}
	if (!result.ok) {
		return result.error ?? `Failed to close workspace "${result.name}".`;
	}
	let msg = `Workspace "${result.name}" closed.`;
	if (result.leftoverCount && result.leftoverCount > 0) {
		msg += ` Warning: ${result.leftoverCount} leftover file(s).`;
	}
	if (result.error) {
		msg += ` ${result.error}`;
	}
	return msg;
}

function formatStatusText(env: WorkspaceEnv): string {
	if (env.state === "missing") {
		return `Workspace "${env.name}" does not exist (no worktree, no session). Open it with ws_open first.`;
	}
	return [
		`Workspace "${env.name}" status.`,
		`state: ${env.state}`,
		`dirty: ${env.dirty ?? false}`,
		`worktreePath: ${env.worktreePath ?? ""}`,
		`socket: ${env.socket ?? ""}`,
		`session: ${env.session}`,
		`paneTarget: ${env.paneTarget ?? ""}`,
		`paneIdle: ${env.paneIdle ?? "?"}`,
		`preValidated: ${env.preValidated}`,
		`monitorCmd: ${env.monitorCmd ?? ""}`,
	].join("\n");
}

// ─── Commands ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const state = await readCurrentState(ctx.cwd);
		if (state) updateStatusBar(ctx.ui, state.name);
	});

	// ── /ws-open [-b name] ──
	pi.registerCommand("ws-open", {
		description: "Open a branch-workspace (git worktree + tmux session). Usage: /ws-open [name]",
		handler: async (args, ctx) => {
			let { name } = parsePositionalName(args);
			if (!name) {
				const selected = await selectWorkspace(pi, ctx, "Select workspace", ctx.cwd);
				if (!selected) return;
				name = selected.name;
			}

			const result = await openWorkspace(pi, { cwd: ctx.cwd, name, ui: ctx.ui });
			if (!result.ok) {
				ctx.ui.notify(result.error ?? "open failed", "error");
				return;
			}
			for (const w of result.warnings) {
				ctx.ui.notify(w, "warning");
			}
			const created = result.worktreeCreated ? "new worktree" : "reused worktree";
			const pathLine = result.worktreePath ? `Worktree (${created}): ${result.worktreePath}` : created;
			const monitorCmd = result.monitorCmd ?? "";
			const copied = monitorCmd ? await copyToClipboard(pi, monitorCmd) : false;
			ctx.ui.notify(
				`Workspace "${name}" opened. ${pathLine}${monitorCmd ? `\nMonitor: ${monitorCmd}${copied ? " (copied)" : ""}` : ""}`,
				"info",
			);
		},
	});

	// ── /ws-list ──
	pi.registerCommand("ws-list", {
		description: "List all branch-workspaces and optionally run an action. (For pane log of all active: /ws-log -b)",
		handler: async (_args, ctx) => {
			// Select workspace
			const selected = await selectWorkspace(pi, ctx, "Select workspace", ctx.cwd);
			if (!selected) return;

			// Select action based on workspace state
			const actions = getAvailableActions(selected.state);
			if (actions.length === 0) {
				ctx.ui.notify(`Workspace "${selected.name}" has no available actions.`, "error");
				return;
			}

			const action = await ctx.ui.select(`Action for "${selected.name}"`, actions) as WorkspaceAction | undefined;
			if (!action) return;

			// Paste the command using positional argument for the selected workspace.
			// This works for all actions offered here (open / log / status / vscode / cancel / close).
			// For batch pane log of *all* active workspaces, use `/ws-log -b` (or --batch) directly.
			const cmd = `/ws-${action} ${selected.name}`;
			ctx.ui.pasteToEditor(cmd);
		},
	});

	// ── /ws-status [name] [-s] ──
	// Workspace status = state + env (not pane log — use /ws-log for that).
	// Display uses the same aboveEditor widget surface as /ws-log.
	pi.registerCommand("ws-status", {
		description:
			"Show branch-workspace status (state + env: socket, pane, dirty, …). Usage: /ws-status [name] [-s]",
		handler: async (args, ctx) => {
			const selectFlag = /(^|\s)-s\b/.test(args);
			const { name: branchName } = parsePositionalName(args, [/(^|\s)-s\b/g]);

			const resolved = await resolveNameOrSelect(pi, branchName, ctx.cwd, ctx, selectFlag);
			if (!resolved) return;
			const { name } = resolved;

			const env = await buildWorkspaceEnv(pi, name);
			const lines = formatStatusText(env).split("\n");

			// Attach hint only when a session exists (active / orphan), matching /ws-log footer.
			let footer: string | undefined;
			if (env.monitorCmd && (env.state === "active" || env.state === "orphan")) {
				const copied = await copyToClipboard(pi, env.monitorCmd);
				footer = `Monitor: ${env.monitorCmd}${copied ? " (copied)" : ""}`;
			}

			ctx.ui.setWidget("ws-status", buildWidget(lines, footer), { placement: "aboveEditor" });
		},
	});

	// ── /ws-close [-b name] [-s] ──
	pi.registerCommand("ws-close", {
		description: "Close a branch-workspace (remove worktree + kill tmux session). Usage: /ws-close [name] [-s]",
		handler: async (args, ctx) => {
			const selectFlag = /(^|\s)-s\b/.test(args);
			const { name: branchName } = parsePositionalName(args, [/(^|\s)-s\b/g]);

			const resolved = await resolveNameOrSelect(pi, branchName, ctx.cwd, ctx, selectFlag);
			if (!resolved) return;
			const { name } = resolved;

			// Interactive confirms map to force:true; never call close until user accepts.
			const ws = await resolveWorkspaceState(pi, name);
			if (ws.state === "missing") {
				ctx.ui.notify(`Workspace "${name}" does not exist (no worktree, no session).`, "error");
				return;
			}
			let force = false;
			if (ws.state === "orphan") {
				const kill = await ctx.ui.confirm(
					"Orphaned Session",
					`Workspace "${name}" has an orphaned tmux session (no worktree). Kill it?`,
				);
				if (!kill) {
					ctx.ui.notify("Cancelled. Tmux session left untouched.", "info");
					return;
				}
				force = true;
			} else if (ws.dirty) {
				const proceed = await ctx.ui.confirm(
					"Dirty Worktree",
					`Workspace "${name}" has uncommitted changes. Close anyway?`,
				);
				if (!proceed) {
					ctx.ui.notify("Cancelled.", "info");
					return;
				}
				force = true;
			}

			const result = await closeWorkspace(pi, { cwd: ctx.cwd, name, force, ui: ctx.ui });
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

	// ── /ws-log [-b|--batch] [name] [-s] [-a|--analyze] ──  (pane log; not /ws-status)
	pi.registerCommand("ws-log", {
		description: "Show pane log and last-command outcome (not workspace status — use /ws-status). Usage: /ws-log [-b|--batch] [name] [-s] [-a|--analyze]",
		handler: async (args, ctx) => {
			const analyze = /(^|\s)(--analyze|-a)\b/.test(args);
			const selectFlag = /(^|\s)-s\b/.test(args);
			const batch = /(^|\s)(-b|--batch)\b/.test(args);
			const flagPatterns = [
				/(^|\s)(--analyze|-a)\b/g,
				/(^|\s)-s\b/g,
				/(^|\s)(-b|--batch)\b/g,
			];
			const { name: branchName } = parsePositionalName(args, flagPatterns);

			if (batch) {
				const socket = await getTmuxSocket(pi);
				if (!socket) {
					ctx.ui.notify("Failed to resolve tmux socket.", "error");
					return;
				}

				const allWs = await listAllWorkspaces(pi);
				const actives = allWs.filter((w) => w.state === "active");
				if (actives.length === 0) {
					ctx.ui.notify("No active workspaces.", "info");
					return;
				}

				const captures: Array<{ name: string; output: string }> = [];
				for (const ws of actives) {
					const target = await discoverPaneTarget(pi, socket, ws.name);
					if (!target) {
						captures.push({ name: ws.name, output: "(no pane)" });
						continue;
					}
					// Match single-workspace capture depth when analyzing so each parallel call gets full context
					const capLines = analyze ? 200 : 12;
					const output = await capturePaneOutput(pi, socket, target, capLines);
					captures.push({ name: ws.name, output: output || "(empty)" });
				}

				// Batch is an overview only — no fake multi-target attach line.
				// Drill down with /ws-log <name> (single mode copies a real attach cmd).
				if (!analyze) {
					const lines = formatBatchRawLines(captures);
					ctx.ui.setWidget("ws-log", buildWidget(lines), { placement: "aboveEditor" });
					return;
				}

				ctx.ui.setWidget(
					"ws-log",
					buildWidget([`Analyzing ${captures.length} workspaces in parallel...`]),
					{ placement: "aboveEditor" },
				);

				try {
					const lines = await analyzeBatchStatusParallel(pi, ctx, captures);
					ctx.ui.setWidget("ws-log", buildWidget(lines), { placement: "aboveEditor" });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					ctx.ui.setWidget("ws-log", undefined);
					ctx.ui.notify(`LLM batch analysis failed: ${msg}`, "warning");
				}
				return;
			}

			// Single workspace (existing behavior)
			const resolved = await resolveNameOrSelect(pi, branchName, ctx.cwd, ctx, selectFlag);
			if (!resolved) return;
			const { name } = resolved;

			const ws = await resolveWorkspaceState(pi, name);
			if (ws.state !== "active") {
				ctx.ui.notify(`Workspace "${name}" is not active (${ws.state}). Log requires a running tmux session.`, "error");
				return;
			}

			const socket = await getTmuxSocket(pi);
			if (!socket) {
				ctx.ui.notify("Failed to resolve tmux socket.", "error");
				return;
			}

			const paneTarget = await discoverPaneTarget(pi, socket, name);
			if (!paneTarget) {
				ctx.ui.notify(`No pane found for session "${name}".`, "error");
				return;
			}

			const captureLines = analyze ? 200 : 15;
			const paneOutput = await capturePaneOutput(pi, socket, paneTarget, captureLines);
			if (!paneOutput.trim()) {
				ctx.ui.notify(`Pane output is empty for "${name}".`, "warning");
				return;
			}

			const rawCmd = `tmux -S ${socket} attach -t ${name}`;
			const copied = await copyToClipboard(pi, rawCmd);
			const monitorCmd = `Monitor: ${rawCmd}${copied ? " (copied)" : ""}`;

			if (!analyze) {
				const lines = formatSingleRawWidget(paneOutput);
				ctx.ui.setWidget("ws-log", buildWidget(lines, monitorCmd), { placement: "aboveEditor" });
				return;
			}

			ctx.ui.setWidget("ws-log", buildWidget([`Analyzing pane log for "${name}"...`]), { placement: "aboveEditor" });

			let result: AnalysisResult;
			try {
				result = await analyzeStatus(pi, ctx, paneOutput);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.setWidget("ws-log", undefined);
				ctx.ui.notify(`LLM analysis failed: ${msg}`, "warning");
				return;
			}

			if ("analysis" in result) {
				const lines = formatAnalyzeWidget(
					result.analysis,
					paneOutput,
					SINGLE_ANALYZE_RAW_TAIL,
				);
				ctx.ui.setWidget("ws-log", buildWidget(lines, monitorCmd), { placement: "aboveEditor" });
			} else {
				ctx.ui.setWidget("ws-log", undefined);
				const lines = paneOutput.trim().split("\n");
				const tail = lines.slice(-SINGLE_ANALYZE_RAW_TAIL).join("\n");
				ctx.ui.notify(
					`${result.error} Raw output for "${name}":\n${tail}`,
					"warning",
				);
			}
		},
	});

	// ── /ws-vscode [-b name] [-s] ──
	pi.registerCommand("ws-vscode", {
		description: "Open a branch-workspace in VS Code. Usage: /ws-vscode [name] [-s]",
		handler: async (args, ctx) => {
			const selectFlag = /(^|\s)-s\b/.test(args);
			const { name: branchName } = parsePositionalName(args, [/(^|\s)-s\b/g]);

			const resolved = await resolveNameOrSelect(pi, branchName, ctx.cwd, ctx, selectFlag);
			if (!resolved) return;
			const { name, worktreePath: stateWorktreePath } = resolved;

			let wtPath = stateWorktreePath;
			if (!wtPath) {
				const ws = await resolveWorkspaceState(pi, name);
				if (ws.state === "missing") {
					ctx.ui.notify(`Workspace "${name}" does not exist.`, "error");
					return;
				}
				wtPath = ws.worktreePath;
			}

			if (!wtPath) {
				ctx.ui.notify(`Cannot resolve worktree path for "${name}".`, "error");
				return;
			}

			await pi.exec("code", [wtPath]);
			ctx.ui.notify(`Opened VS Code for "${name}" at ${wtPath}`, "info");
		},
	});

	// ── /ws-cancel [-b name] [-s] ──
	pi.registerCommand("ws-cancel", {
		description: "Interrupt the running process in a workspace's tmux pane. Usage: /ws-cancel [name] [-s]",
		handler: async (args, ctx) => {
			const selectFlag = /(^|\s)-s\b/.test(args);
			const { name: branchName } = parsePositionalName(args, [/(^|\s)-s\b/g]);

			const resolved = await resolveNameOrSelect(pi, branchName, ctx.cwd, ctx, selectFlag);
			if (!resolved) return;
			const { name } = resolved;

			const ws = await resolveWorkspaceState(pi, name);
			if (ws.state !== "active") {
				ctx.ui.notify(`Workspace "${name}" is not active (${ws.state}). Cancel requires a running tmux session.`, "error");
				return;
			}

			const socket = await getTmuxSocket(pi);
			if (!socket) {
				ctx.ui.notify("Failed to resolve tmux socket.", "error");
				return;
			}

			const paneTarget = await discoverPaneTarget(pi, socket, name);
			if (!paneTarget) {
				ctx.ui.notify(`No pane found for session "${name}".`, "error");
				return;
			}

			// Check if already idle
			const currentOutput = await capturePaneOutput(pi, socket, paneTarget, 20);
			if (isPaneIdle(currentOutput)) {
				ctx.ui.notify(`No running process in workspace "${name}".`, "info");
				return;
			}

			const proceed = await ctx.ui.confirm(
				"Interrupt Process",
				`Send C-c to workspace "${name}"?`,
			);
			if (!proceed) {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}

			// Send C-c
			const sendResult = await pi.exec("tmux", [
				"-S", socket,
				"send-keys", "-t", paneTarget, "C-c",
			]);
			if (sendResult.code !== 0) {
				ctx.ui.notify("Failed to send interrupt signal.", "error");
				return;
			}

			// Wait briefly then check
			await new Promise((r) => setTimeout(r, 2000));
			const afterOutput = await capturePaneOutput(pi, socket, paneTarget, 5);

			if (isPaneIdle(afterOutput)) {
				ctx.ui.notify(`Process in "${name}" interrupted.`, "info");
			} else {
				ctx.ui.notify(
					`Sent C-c to "${name}". Process may still be terminating; check with /ws-log.`,
					"warning",
				);
			}
		},
	});

	// Task / handoff-for-impl orchestration lives in agents/skills/branch-workspace/SKILL.md
	// (tools: ws_list / ws_open / ws_close / ws_status). Task/hfi orchestration is skill-driven.

	// ── Tools: ws_list / ws_open / ws_close / ws_status ──

	pi.registerTool({
		name: "ws_list",
		label: "List workspaces",
		description:
			"List branch-workspaces (git worktree + tmux session) with state (active=worktree+session, idle=worktree only, orphan=session only; field name state), dirty flag, and current marker. Read-only. missing never appears (list is worktree ∪ session). Use before open/close when the exact name is unknown.",
		promptSnippet: "List branch-workspaces (active/idle/orphan, dirty, current).",
		promptGuidelines: [
			"Prefer ws_list when the exact branch-workspace name is unknown or before closing.",
			"Use the full exact name from the result for ws_open / ws_close — never invent short aliases.",
			"query is substring filter only; identity for open/close is still exact name match.",
			"Workspace state vocabulary (field state): active | idle | orphan (missing only appears on name-targeted ws_status).",
		],
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({ description: "Optional substring filter on workspace name (not fuzzy identity)." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await listWorkspaces(pi, {
				cwd: ctx.cwd,
				query: typeof params.query === "string" ? params.query : undefined,
			});
			return {
				content: [{ type: "text" as const, text: formatListText(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "ws_open",
		label: "Open workspace",
		description:
			"Open or reuse a branch-workspace (git worktree + tmux session) and set it as current. Returns only ok/name/warnings (or error). For state/env/dispatch readiness, call ws_status next. Recreates a missing session for idle; for orphan prefer close-then-open.",
		promptSnippet: "Open/reuse a branch-workspace; then call ws_status for env.",
		promptGuidelines: [
			"Require an exact full name (e.g. feat/my-feature). Prefer names from ws_list when reusing.",
			"On success, call ws_status (same name or omit for current) to get state/socket/paneTarget/paneIdle before dispatch.",
			"Does not return worktreePath, state, or env — use ws_status for those.",
			"idle (worktree only): open recreates the session. orphan (session only): prefer ws_close after user confirm, then open — open reuses the residual session without resetting cwd.",
			"First open in a repo may commit .gitignore via worktree.sh (existing behavior).",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Full branch-workspace name (exact match)." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const name = typeof params.name === "string" ? params.name.trim() : "";
			if (!name) {
				return {
					content: [{ type: "text" as const, text: "ws_open requires a non-empty name." }],
					details: { ok: false, error: "name required", warnings: [] as string[] },
				};
			}
			const result = await openWorkspace(pi, { cwd: ctx.cwd, name, ui: ctx.ui });
			return {
				content: [{ type: "text" as const, text: formatOpenText(result) }],
				details: openToolDetails(result),
			};
		},
	});

	pi.registerTool({
		name: "ws_close",
		label: "Close workspace",
		description:
			"Close a branch-workspace (remove worktree + kill tmux session). Fail-closed: dirty worktree or orphan session returns needsForce and requires force:true only after explicit user confirmation. Clean active/idle close without force.",
		promptSnippet: "Close a branch-workspace; force only after user confirms dirty/orphan.",
		promptGuidelines: [
			"Use exact name from ws_list or prior open. Never invent force:true.",
			"needsForce dirty: uncommitted changes — ask the user, then re-call with force:true only if they confirm.",
			"needsForce orphan: residual tmux session with no worktree — ask the user, then re-call with force:true only if they confirm (kills the session).",
			"Do not kill sessions via raw tmux; always use this tool.",
			"Prefer ws_list first when unsure which workspace to close.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Full branch-workspace name (exact match)." }),
			force: Type.Optional(
				Type.Boolean({
					description:
						"Required true when needsForce is dirty (uncommitted changes) or orphan (session-only residual), after explicit user confirmation.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const name = typeof params.name === "string" ? params.name.trim() : "";
			if (!name) {
				return {
					content: [{ type: "text" as const, text: "ws_close requires a non-empty name." }],
					details: { ok: false, error: "name required" },
				};
			}
			const force = params.force === true;
			const result = await closeWorkspace(pi, { cwd: ctx.cwd, name, force, ui: ctx.ui });
			return {
				content: [{ type: "text" as const, text: formatCloseText(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "ws_status",
		label: "Inspect workspace",
		description:
			"Read-only workspace status report: state (active|idle|orphan|missing) + env (worktreePath, socket, session, paneTarget, paneIdle, dirty, monitorCmd). Omit name to use the current branch-workspace. No side effects.",
		promptSnippet: "Inspect workspace status (state+env); omit name for current.",
		promptGuidelines: [
			"After ws_open, call this to get state/socket/paneTarget/paneIdle before dispatch. Also use to inspect without opening, or re-check later.",
			"Omit name for current; pass an exact full name for a non-current workspace; use ws_list when the name is unknown.",
			"If no current is set, the tool fails with: no current workspace.",
			"Field state: active (worktree+session, ready for task), idle (worktree only → ws_open), orphan (session only → close with user confirm + force), missing (neither → ws_open to create).",
			"status (this tool) = state + env. Workspace idle ≠ paneIdle.",
		],
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({ description: "Full branch-workspace name (exact match). Omit to use current." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let name = typeof params.name === "string" ? params.name.trim() : "";
			if (!name) {
				const current = await readCurrentState(ctx.cwd);
				if (!current?.name) {
					return {
						content: [{ type: "text" as const, text: "no current workspace" }],
						details: { ok: false, error: "no current workspace" },
					};
				}
				name = current.name;
			}
			const env = await buildWorkspaceEnv(pi, name);
			return {
				content: [{ type: "text" as const, text: formatStatusText(env) }],
				details: { ok: env.state !== "missing", ...env },
			};
		},
	});
}
