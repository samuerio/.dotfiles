import { completeSimple, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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

		let status: WorkspaceStatus;
		if (wt && sess) status = "active";
		else if (wt) status = "idle";
		else if (sess) status = "orphan";
		else status = "missing";

		result.push({ name, status, worktreePath: wt?.path, dirty: wt?.dirty });
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
		const display = `${ws.name} [${ws.status}]${mark}`;
		displayToWorkspace.set(display, ws);
	}

	const choice = await ctx.ui.select(title, Array.from(displayToWorkspace.keys()));
	if (!choice) return null;
	return displayToWorkspace.get(choice) ?? null;
}

type WorkspaceAction = "open" | "status" | "vscode" | "cancel" | "close";

function getAvailableActions(status: WorkspaceStatus): WorkspaceAction[] {
	switch (status) {
		case "active": return ["open", "status", "vscode", "cancel", "close"];
		case "idle": return ["open", "vscode", "close"];
		case "orphan": return ["close"];
		default: return [];
	}
}

function parseBranchFlag(args: string): { name: string | undefined; rest: string } {
	const match = args.match(/(?:^|\s)(?:-b|--branch-workspace)\s+(\S+)/);
	if (!match) return { name: undefined, rest: args };
	const name = match[1];
	const rest = args.replace(match[0], "").trim();
	return { name, rest };
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

type WorkspaceStatus = "active" | "idle" | "orphan" | "missing";

interface ResolvedWorkspace {
	name: string;
	status: WorkspaceStatus;
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

	let status: WorkspaceStatus;
	if (worktree && session) status = "active";
	else if (worktree) status = "idle";
	else if (session) status = "orphan";
	else status = "missing";

	return {
		name,
		status,
		worktreePath: worktree?.path,
		dirty: worktree?.dirty,
	};
}

// ─── SKILL Context Constants ──────────────────────────────────────

const WS_CONCEPT_TEXT = `A **branch-workspace** is an isolated execution environment bound to a single branch. It is composed of two coupled components:

- a **\`git worktree\`**: a writable, branch-scoped filesystem where the worker agent edits code without disturbing the main checkout.
- a **\`tmux\` session**: an observable, persistent execution environment for that branch. The pane is shared — the worker agent runs implementation commands there, and the dispatcher agent runs observable tasks (tests, debugging, runtime checks) there directly. The user or dispatcher can attach to watch either.

Each branch-workspace is identified by \`<name>\`. The git branch name and the tmux session name both equal \`<name>\`. The two components share this identity and must be managed together.

Lifecycle (list / open / close) is provided by the \`ws_list\`, \`ws_open\`, and \`ws_close\` tools (or the matching user slash commands). This skill only orchestrates **task** dispatch and **handoff-for-impl**.`;

const WS_ROLE_BOUNDARIES_TEXT = `The dispatcher agent owns coordination. The tmux pane is a shared execution environment — both agents may run commands there, but only the worker agent may write files:

- **Explore freely**: the dispatcher may read and inspect files in the branch-workspace's worktree at any point — to refine a task with the user, to review results, or to understand context. Use bash or read-only tools directly for speed and efficiency.
- **No direct writes**: the dispatcher must never write to or modify files in the branch-workspace's worktree, even for trivial changes. All file modifications go through the worker agent.
- **Observable tasks**: running commands, running tests, and debugging in the worktree are the dispatcher's responsibility because it is the interaction layer with the user. The dispatcher may use either bash or the branch-workspace's tmux pane to execute these tasks.
- **Review after completion**: after the worker agent signals completion, the dispatcher inspects the result and reports back to the user.

The worker agent performs implementation work inside the branch-workspace. It receives a self-contained task document and runs to completion.

Use \`ws_list\` / \`ws_open\` / \`ws_close\` for discovery and lifecycle — do not reimplement worktree/session management via bash. \`<name>\` always means the complete branch-workspace identifier and must be matched exactly; never fuzzy-match or shorten it. When the injected header says worktree/session/pane are pre-validated, trust those fields and do not rediscover them.`;

const WS_TASK_SKILL_TEXT = `2. **Task Triage (Intent Classification)**: Before dispatching, evaluate the complexity and clarity of the \`<task>\`:
   - **Fast Path (Direct Dispatch)**: If the task is trivial, unambiguous, and self-contained (e.g., "fix typo in README", "bump version to 2.0", "add a specific unit test for function X"), **skip the interactive Q&A of \`refine-task\`**. The dispatcher should internally draft a clear, self-contained task description for the worker and proceed directly to step 3. Do not ask the user for confirmation.
   - **Standard Path (Refine & Confirm)**: If the task is ambiguous, broad, involves multiple files, or requires architectural decisions (e.g., "refactor the auth module", "implement a new caching layer"), strictly apply the \`refine-task\` SKILL. The dispatcher must proactively explore the worktree to answer questions from context. If critical information is still missing, ask the user targeted questions. **Wait for explicit user confirmation** of the refined task before proceeding to step 3.

   After \`refine-task\` completes (including any clarifying exchange with the user), resume from step 3 using the refined task text as \`<task>\`. The dispatcher reviews the worker's output once the worker signals completion.
3. The dispatcher must choose how to route the work, but it must not implement file changes itself. If the task output is expected to be code, docs, tests, review comments, or any other file modification, send it to the worker path.
4. Determine how to dispatch:
   - **worker path** (default for any task whose output is file changes — writing code, docs, tests, or review comments):
     1. Construct a \`pi -p\` command following the \`pi-headless\` SKILL **Print Mode**. Use \`--no-session\`.
     2. Write the refined task text to \`/tmp/task/<YYYY-MM-DD-HHMMSS>-<slug>.md\` (create the directory with \`mkdir -p /tmp/task\` if needed), where \`<slug>\` is a short meaningful kebab-case English phrase derived from the task content. Write the refined task text in the same language as the original \`<task>\` input.
     3. **Append the Structured Handoff Instruction** to the task text:
        \`\`\`
        When you have completed the task, you must do the following two things in order:
        1. Write a concise, structured summary of your work to \`/tmp/task/<YYYY-MM-DD-HHMMSS>-<slug>.result.md\`. The summary must include:
           - **Files Modified**: A list of files you created or changed.
           - **Key Changes**: A brief description of the core logic or implementation details.
           - **Issues/Blockers**: Any unexpected problems encountered or things the user should review.
        2. Print the exact marker \`DONE:<YYYY-MM-DD-HHMMSS>-<slug>\` on a line by itself in the terminal.
        \`\`\`
        *(Note: Ensure the \`<YYYY-MM-DD-HHMMSS>-<slug>\` in the instruction exactly matches the filename stem).*
     4. Pass the task file to pi via \`@/tmp/task/<filename>.md\`. If \`choose-model: yes\` was given, follow the \`pi-headless\` SKILL model-selection flow; otherwise use defaults.
     5. Send the command to the tmux pane via the tmux SKILL **Sending input safely** and use **Watching output** (poll mode) with pattern \`DONE:<YYYY-MM-DD-HHMMSS>-<slug>\` to wait for completion.
     6. **Post-Execution Review**: Once the \`DONE\` marker is detected, **do not parse the raw tmux pane output**. Instead, read the content of \`/tmp/task/<YYYY-MM-DD-HHMMSS>-<slug>.result.md\` to understand the worker's output. Present this structured summary to the user.
   - **dispatcher path** (for tasks requiring observability — running tests, executing commands, checking runtime errors): execute the command using either bash or the branch-workspace's tmux pane, capturing the output for the user.

   If a task requires both (e.g. run tests then fix failures, or fix code then verify with a command), handle the observable step via the dispatcher and the file-change step via the worker — in whichever order the task demands. Pass findings between steps in the task doc.`;

const TASK_SKILL_CONTEXT = `## Concept

${WS_CONCEPT_TEXT}

## Role Boundaries

${WS_ROLE_BOUNDARIES_TEXT}

## Task Execution

${WS_TASK_SKILL_TEXT}`;

const WS_HFI_SKILL_TEXT = `3. Choose the implementation command:

   If \`choose-model: yes\` is present in the header, follow the \`pi-headless\` SKILL model-selection flow before constructing any \`pi\` command.

   **Ralph path** — if the \`ralph\` SKILL has been used in the current conversation and \`task.json\` exists on disk with a corresponding Ralph execution command:

   - Send that Ralph command to the workspace pane via the tmux SKILL **Sending input safely** convention.

   **plan doc path** — if the conversation references a plan document (a file the user points to, e.g. \`plan.md\`, \`design.md\`, or similar) but no handoff doc has been generated:

   - Follow the \`pi-headless\` SKILL **Running pi as an Implementation Worker — Plan without implementation instruction** pattern to construct the command.
   - Send the constructed command via the tmux SKILL **Sending input safely** convention.

   **handoff doc path** — if the \`draft-impl-handoff\` SKILL has already been run in the current conversation and produced a handoff file:

   - Follow the \`pi-headless\` SKILL **Running pi as an Implementation Worker — Plan with implementation instruction** pattern to construct the command.
   - Send the constructed command via the tmux SKILL **Sending input safely** convention.

   **generate then run path** — otherwise (no plan doc, no handoff doc):

   - First run the \`draft-impl-handoff\` SKILL to generate a handoff document, then follow the **handoff doc path** above.

4. Do not wait for completion.
5. Do not capture pane output after sending.
6. Report only:
   - the branch-workspace name
   - that the command was sent
   - the monitor command from the tmux SKILL`;

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
 * Used by single /ws-status -a and by batch /ws-status -b -a (N parallel calls).
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
 * Single /ws-status without -a: current pane status (idle|busy) + raw tail + Monitor (footer).
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

// ─── Session History Helpers ──────────────────────────────────────

type ConversationEntry = {
	type: string;
	id?: string;
	message?: AgentMessage;
	summary?: string;
	tokensBefore?: number;
	timestamp?: string;
	firstKeptEntryId?: string;
};

function entryToMessage(entry: ConversationEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary ?? "",
			tokensBefore: entry.tokensBefore ?? 0,
			timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now(),
		} as AgentMessage;
	}
	return undefined;
}

function getHandoffMessages(branch: ConversationEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) {
		return branch.map(entryToMessage).filter((message) => message !== undefined);
	}

	const compaction = branch[compactionIndex];
	const firstKeptIndex =
		compaction.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
	const compactedBranch = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return compactedBranch.map(entryToMessage).filter((message) => message !== undefined);
}

const NAME_INFERENCE_SYSTEM_PROMPT = `You are a branch name generator. Given a conversation history, generate a short kebab-case branch name for the implementation work being described.

Rules:
- Default format: feat/<feature-name>
- If the conversation indicates a bug fix: fix/<name>
- If it's a refactor: refactor/<name>
- If it's a chore or experiment: chore/<name> or exp/<name>
- Use short, descriptive kebab-case names (2-4 words max)
- Return ONLY the branch name, nothing else`;

const NAME_INFERENCE_USER_PROMPT = `Based on the conversation above, generate a short kebab-case branch name for the implementation work being described. Return ONLY the branch name, nothing else.`;

// ─── Status Bar ────────────────────────────────────────────────────

type ExtensionUI = ExtensionCommandContext["ui"];

function updateWorkspaceStatus(ui: ExtensionUI, name: string | undefined): void {
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
	status: WorkspaceStatus;
	dirty?: boolean;
	paneIdle?: boolean;
	preValidated: boolean;
	monitorCmd?: string;
}

interface ListWorkspaceRow {
	name: string;
	status: WorkspaceStatus;
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

interface OpenResult extends WorkspaceEnv {
	ok: boolean;
	error?: string;
	worktreeCreated?: boolean;
	warnings: string[];
}

interface CloseResult {
	ok: boolean;
	name: string;
	status?: WorkspaceStatus;
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
			status: w.status,
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
	if (socket && (ws.status === "active" || ws.status === "idle")) {
		if (ws.status === "active") {
			paneTarget = await discoverPaneTarget(pi, socket, name);
			if (paneTarget) {
				const out = await capturePaneOutput(pi, socket, paneTarget, 20);
				paneIdle = isPaneIdle(out);
			}
		}
	}
	const preValidated = !!(socket && paneTarget && ws.status === "active");
	return {
		name,
		branch: name,
		worktreePath: ws.worktreePath,
		socket,
		session: name,
		paneTarget,
		status: ws.status,
		dirty: ws.dirty,
		paneIdle,
		preValidated,
		monitorCmd: socket ? `tmux -S ${socket} attach -t ${name}` : undefined,
	};
}

function formatEnvHeader(title: string, env: WorkspaceEnv, extraLines: string[] = []): string {
	return [
		title,
		`name: ${env.name}`,
		`branch: ${env.branch}`,
		`worktreePath: ${env.worktreePath ?? ""}`,
		`socket: ${env.socket ?? ""}`,
		`session: ${env.session}`,
		`paneTarget: ${env.paneTarget ?? ""}`,
		"",
		"note: DO NOT verify worktree, session, or pane — all pre-validated.",
		...extraLines,
	].join("\n");
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
			branch: name,
			socket: null,
			session: name,
			paneTarget: null,
			status: "missing",
			preValidated: false,
			warnings,
			error: result.stderr.trim() || "worktree.sh open failed",
		};
	}

	const output = parseOpenOutput(result.stdout);
	if (!output) {
		return {
			ok: false,
			name,
			branch: name,
			socket: null,
			session: name,
			paneTarget: null,
			status: "missing",
			preValidated: false,
			warnings,
			error: "Failed to parse worktree output",
		};
	}

	const socket = await getTmuxSocket(pi);
	if (!socket) {
		return {
			ok: false,
			name,
			branch: name,
			worktreePath: output.worktreePath,
			socket: null,
			session: name,
			paneTarget: null,
			status: "idle",
			preValidated: false,
			worktreeCreated: output.worktreeCreated,
			warnings,
			error: "Failed to resolve tmux socket",
		};
	}

	const sessionOk = await ensureSession(pi, socket, name, output.worktreePath);
	if (!sessionOk) {
		warnings.push(`Worktree created but failed to start tmux session for "${name}".`);
	}

	await writeCurrentState(cwd, name, output.worktreePath);
	if (ui) updateWorkspaceStatus(ui, name);

	const env = await buildWorkspaceEnv(pi, name);
	return {
		ok: true,
		...env,
		worktreePath: env.worktreePath ?? output.worktreePath,
		worktreeCreated: output.worktreeCreated,
		monitorCmd: env.monitorCmd ?? `tmux -S ${socket} attach -t ${name}`,
		warnings,
	};
}

async function closeWorkspace(
	pi: ExtensionAPI,
	opts: { cwd: string; name: string; force?: boolean; ui?: ExtensionUI },
): Promise<CloseResult> {
	const { cwd, name, force = false, ui } = opts;
	const ws = await resolveWorkspaceState(pi, name);

	if (ws.status === "missing") {
		return {
			ok: false,
			name,
			status: "missing",
			error: `Workspace "${name}" does not exist (no worktree, no session).`,
		};
	}

	if (ws.status === "orphan") {
		if (!force) {
			return {
				ok: false,
				name,
				status: "orphan",
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
			if (ui) updateWorkspaceStatus(ui, undefined);
		}
		return { ok: true, name, status: "orphan" };
	}

	if (ws.dirty && !force) {
		return {
			ok: false,
			name,
			status: ws.status,
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
			status: ws.status,
			error: cleanResult.stderr.trim() || "Failed to remove worktree.",
		};
	}
	const cleanOutput = parseCleanOutput(cleanResult.stdout);

	let sessionWarn: string | undefined;
	if (ws.status === "active") {
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
		if (ui) updateWorkspaceStatus(ui, undefined);
	}

	return {
		ok: true,
		name,
		status: ws.status,
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
		return `- ${w.name} [${w.status}]${mark}`;
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
	const lines = [
		`Opened workspace "${result.name}".`,
		`status: ${result.status}`,
		`worktreePath: ${result.worktreePath ?? ""}`,
		`worktreeCreated: ${result.worktreeCreated ?? false}`,
		`socket: ${result.socket ?? ""}`,
		`session: ${result.session}`,
		`paneTarget: ${result.paneTarget ?? ""}`,
		`paneIdle: ${result.paneIdle ?? "?"}`,
		`preValidated: ${result.preValidated}`,
		`monitorCmd: ${result.monitorCmd ?? ""}`,
	];
	if (result.warnings.length > 0) {
		lines.push(`warnings: ${result.warnings.join("; ")}`);
	}
	return lines.join("\n");
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

function formatStateText(env: WorkspaceEnv): string {
	if (env.status === "missing") {
		return `Workspace "${env.name}" does not exist (no worktree, no session). Open it with ws_open first.`;
	}
	return [
		`Workspace "${env.name}" state.`,
		`status: ${env.status}`,
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
		if (state) updateWorkspaceStatus(ctx.ui, state.name);
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
			const monitorCmd = result.monitorCmd ?? "";
			const copied = monitorCmd ? await copyToClipboard(pi, monitorCmd) : false;
			ctx.ui.notify(
				`Workspace "${name}" opened. Worktree: ${result.worktreePath}\nMonitor: ${monitorCmd}${copied ? " (copied)" : ""}`,
				"info",
			);
		},
	});

	// ── /ws-list ──
	pi.registerCommand("ws-list", {
		description: "List all branch-workspaces and optionally run an action. (For status of all active: /ws-status -b)",
		handler: async (_args, ctx) => {
			// Select workspace
			const selected = await selectWorkspace(pi, ctx, "Select workspace", ctx.cwd);
			if (!selected) return;

			// Select action based on status
			const actions = getAvailableActions(selected.status);
			if (actions.length === 0) {
				ctx.ui.notify(`Workspace "${selected.name}" has no available actions.`, "error");
				return;
			}

			const action = await ctx.ui.select(`Action for "${selected.name}"`, actions) as WorkspaceAction | undefined;
			if (!action) return;

			// Paste the command using positional argument for the selected workspace.
			// This works for all actions offered here (open / status / vscode / cancel / close).
			// For batch status of *all* active workspaces, use `/ws-status -b` (or --batch) directly.
			const cmd = `/ws-${action} ${selected.name}`;
			ctx.ui.pasteToEditor(cmd);
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
			if (ws.status === "missing") {
				ctx.ui.notify(`Workspace "${name}" does not exist (no worktree, no session).`, "error");
				return;
			}
			let force = false;
			if (ws.status === "orphan") {
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

	// ── /ws-status [-b|--batch] [name] [-s] [-a|--analyze] ──
	pi.registerCommand("ws-status", {
		description: "Show workspace status. Usage: /ws-status [-b|--batch] [name] [-s] [-a|--analyze]",
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
				const actives = allWs.filter((w) => w.status === "active");
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
				// Drill down with /ws-status <name> (single mode copies a real attach cmd).
				if (!analyze) {
					const lines = formatBatchRawLines(captures);
					ctx.ui.setWidget("ws-status", buildWidget(lines), { placement: "aboveEditor" });
					return;
				}

				ctx.ui.setWidget(
					"ws-status",
					buildWidget([`Analyzing ${captures.length} workspaces in parallel...`]),
					{ placement: "aboveEditor" },
				);

				try {
					const lines = await analyzeBatchStatusParallel(pi, ctx, captures);
					ctx.ui.setWidget("ws-status", buildWidget(lines), { placement: "aboveEditor" });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					ctx.ui.setWidget("ws-status", undefined);
					ctx.ui.notify(`LLM batch analysis failed: ${msg}`, "warning");
				}
				return;
			}

			// Single workspace (existing behavior)
			const resolved = await resolveNameOrSelect(pi, branchName, ctx.cwd, ctx, selectFlag);
			if (!resolved) return;
			const { name } = resolved;

			const ws = await resolveWorkspaceState(pi, name);
			if (ws.status !== "active") {
				ctx.ui.notify(`Workspace "${name}" is not active (${ws.status}). Status requires a running tmux session.`, "error");
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
				ctx.ui.setWidget("ws-status", buildWidget(lines, monitorCmd), { placement: "aboveEditor" });
				return;
			}

			ctx.ui.setWidget("ws-status", buildWidget([`Analyzing status for "${name}"...`]), { placement: "aboveEditor" });

			let result: AnalysisResult;
			try {
				result = await analyzeStatus(pi, ctx, paneOutput);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.setWidget("ws-status", undefined);
				ctx.ui.notify(`LLM analysis failed: ${msg}`, "warning");
				return;
			}

			if ("analysis" in result) {
				const lines = formatAnalyzeWidget(
					result.analysis,
					paneOutput,
					SINGLE_ANALYZE_RAW_TAIL,
				);
				ctx.ui.setWidget("ws-status", buildWidget(lines, monitorCmd), { placement: "aboveEditor" });
			} else {
				ctx.ui.setWidget("ws-status", undefined);
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
				if (ws.status === "missing") {
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
			if (ws.status !== "active") {
				ctx.ui.notify(`Workspace "${name}" is not active (${ws.status}). Cancel requires a running tmux session.`, "error");
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
					`Sent C-c to "${name}". Process may still be terminating; check with /ws-status.`,
					"warning",
				);
			}
		},
	});

	// ── /ws-task + /ws-hfi (DISABLED) ──
	// Orchestration is skill-driven (branch-workspace SKILL: /ws task, /ws hfi).
	// Keep handlers out of the slash command surface so agents load the skill
	// instead of the extension injecting a turn. Set true to re-enable.
	const ENABLE_WS_TASK_HFI_COMMANDS = false;
	if (ENABLE_WS_TASK_HFI_COMMANDS) {
		// ── /ws-task [-b name] [-m|--choose-model] <task> ──
		pi.registerCommand("ws-task", {
			description: "Dispatch a task to a branch-workspace. Usage: /ws-task [-b name] [-m|--choose-model] <task>",
			handler: async (args, ctx) => {
				const chooseModel = /(^|\s)(-m|--choose-model)\b/.test(args);
				const { name: branchName, rest: taskArgs } = parseBranchFlag(
					args.replace(/(^|\s)(-m|--choose-model)\b/g, ""),
				);
				const task = taskArgs.trim();

				let name = branchName;
				if (!name) {
					const state = await readCurrentState(ctx.cwd);
					if (state) name = state.name;
				}

				if (!name) {
					const selected = await selectWorkspace(pi, ctx, "Select workspace", ctx.cwd);
					if (!selected) return;
					name = selected.name;
				}

				if (!task) {
					ctx.ui.notify("No task specified.", "error");
					return;
				}

				const env = await buildWorkspaceEnv(pi, name);
				if (env.status !== "active") {
					ctx.ui.notify(`Workspace "${name}" is not active (${env.status}). Task requires a running tmux session.`, "error");
					return;
				}
				if (!env.socket) {
					ctx.ui.notify("Failed to resolve tmux socket.", "error");
					return;
				}
				if (!env.paneTarget) {
					ctx.ui.notify(`No pane found for session "${name}".`, "error");
					return;
				}
				if (env.paneIdle === false) {
					ctx.ui.notify(`Pane in "${name}" is busy. Cancel the running process first or wait for it to finish.`, "error");
					return;
				}

				const extra = chooseModel ? ["choose-model: yes"] : [];
				const content = [
					formatEnvHeader("[branch-workspace]", env, extra),
					`[Task]\n${task}`,
					TASK_SKILL_CONTEXT,
				].join("\n\n---\n\n");

				pi.sendMessage(
					{ customType: "branch-workspace-task", content, display: true },
					{ triggerTurn: true },
				);
			},
		});

		// ── /ws-hfi [-b name] [-m|--choose-model] ──
		pi.registerCommand("ws-hfi", {
			description: "Silently kick off implementation in a new branch-workspace. Usage: /ws-hfi [-b name] [-m|--choose-model]",
			handler: async (args, ctx) => {
				const chooseModel = /(^|\s)(-m|--choose-model)\b/.test(args);
				const { name: branchName } = parseBranchFlag(
					args.replace(/(^|\s)(-m|--choose-model)\b/g, ""),
				);

				let name = branchName;

				// Name inference via LLM if not provided
				if (!name) {
					if (!ctx.model) {
						ctx.ui.notify("No model selected. Cannot infer branch name. Use -b <name>.", "error");
						return;
					}

					const messages = getHandoffMessages(ctx.sessionManager.getBranch() as ConversationEntry[]);
					if (messages.length === 0) {
						ctx.ui.notify("No conversation history. Use -b <name>.", "error");
						return;
					}

					const llmMessages = convertToLlm(messages);
					const systemPrompt = ctx.getSystemPrompt() ?? "";

					const userMessage: UserMessage = {
						role: "user",
						content: [{ type: "text", text: NAME_INFERENCE_USER_PROMPT }],
						timestamp: Date.now(),
					};

					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
					if (!auth.ok) {
						ctx.ui.notify(`Failed to get API key: ${auth.error}`, "error");
						return;
					}

					const response = await completeSimple(
						ctx.model,
						{
							systemPrompt,
							messages: [...llmMessages, userMessage],
						},
						{
							apiKey: auth.apiKey,
							headers: auth.headers,
							signal: ctx.signal,
							reasoning: "off",
						},
					);

					const inferredName = response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("")
						.trim();

					if (!inferredName) {
						ctx.ui.notify(`Failed to infer branch name. Use -b <name>.`, "error");
						return;
					}

					name = inferredName.includes("/") ? inferredName : `feat/${inferredName}`;
					ctx.ui.notify(`Inferred branch name: ${name}`, "info");
				}

				const openResult = await openWorkspace(pi, { cwd: ctx.cwd, name, ui: ctx.ui });
				if (!openResult.ok) {
					ctx.ui.notify(openResult.error ?? "open failed", "error");
					return;
				}
				for (const w of openResult.warnings) {
					ctx.ui.notify(w, "warning");
				}

				const env = openResult.preValidated
					? openResult
					: await buildWorkspaceEnv(pi, name);
				if (env.status !== "active") {
					ctx.ui.notify(`Workspace "${name}" is not active (${env.status}).`, "error");
					return;
				}
				if (!env.paneTarget) {
					ctx.ui.notify(`No pane found for session "${name}".`, "error");
					return;
				}
				if (env.paneIdle === false) {
					ctx.ui.notify(`Pane in "${name}" is busy. Cancel the running process first or wait for it to finish.`, "error");
					return;
				}

				const extra = chooseModel ? ["choose-model: yes"] : [];
				const hfiContext = `## Concept

${WS_CONCEPT_TEXT}

## Role Boundaries

${WS_ROLE_BOUNDARIES_TEXT}

## Handoff for Implementation

${WS_HFI_SKILL_TEXT}`;

				const content = [
					formatEnvHeader("[branch-workspace handoff-for-impl]", env, extra),
					hfiContext,
				].join("\n\n---\n\n");

				pi.sendMessage(
					{ customType: "branch-workspace-hfi", content, display: true },
					{ triggerTurn: true },
				);
			},
		});
	}

	// ── Tools: ws_list / ws_open / ws_close ──

	pi.registerTool({
		name: "ws_list",
		label: "List workspaces",
		description:
			"List branch-workspaces (git worktree + tmux session) with state (active=worktree+session, idle=worktree only, orphan=session only; field name status), dirty flag, and current marker. Read-only. missing never appears (list is worktree ∪ session). Use before open/close when the exact name is unknown.",
		promptSnippet: "List branch-workspaces (active/idle/orphan, dirty, current).",
		promptGuidelines: [
			"Prefer ws_list when the exact branch-workspace name is unknown or before closing.",
			"Use the full exact name from the result for ws_open / ws_close — never invent short aliases.",
			"query is substring filter only; identity for open/close is still exact name match.",
			"Workspace state vocabulary (field status): active | idle | orphan (missing only appears on name-targeted ws_state).",
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
			"Open or reuse a branch-workspace (git worktree + tmux session), set it as current, and return the full dispatch environment envelope (name, worktreePath, socket, session, paneTarget, monitorCmd, …). Recreates a missing session for idle; for orphan prefer close-then-open.",
		promptSnippet: "Open/reuse a branch-workspace; returns socket and paneTarget.",
		promptGuidelines: [
			"Require an exact full name (e.g. feat/my-feature). Prefer names from ws_list when reusing.",
			"On success, use returned socket/paneTarget/worktreePath for tmux dispatch — do not re-run worktree list or find-sessions.",
			"Open does not fail if the pane is busy; check paneIdle before sending work.",
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
					details: { ok: false, error: "name required" },
				};
			}
			const result = await openWorkspace(pi, { cwd: ctx.cwd, name, ui: ctx.ui });
			return {
				content: [{ type: "text" as const, text: formatOpenText(result) }],
				details: result,
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
		name: "ws_state",
		label: "Inspect workspace",
		description:
			"Read-only: return the dispatch environment envelope (name, worktreePath, socket, session, paneTarget, paneIdle, workspace state in field status: active|idle|orphan|missing, dirty, monitorCmd). Omit name to use the current branch-workspace. No side effects (does not create sessions or change current).",
		promptSnippet: "Inspect workspace env; omit name for current.",
		promptGuidelines: [
			"Before dispatching to the current branch-workspace, call ws_state with no name to get socket/paneTarget/paneIdle.",
			"Pass an exact full name only when targeting a non-current workspace; use ws_list when the name is unknown.",
			"If no current is set, the tool fails with: no current workspace.",
			"Workspace state (field status): active (worktree+session, ready for task), idle (worktree only → ws_open), orphan (session only → close with user confirm + force), missing (neither → ws_open to create). Stale current is resolved as-is (no silent switch).",
			"Workspace idle ≠ paneIdle: the former means no session; the latter means the pane is free for input.",
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
				content: [{ type: "text" as const, text: formatStateText(env) }],
				details: { ok: env.status !== "missing", ...env },
			};
		},
	});
}
