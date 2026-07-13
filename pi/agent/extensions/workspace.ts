import { completeSimple, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, Text } from "@earendil-works/pi-tui";
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

function buildWidget(lines: string[], footer?: string) {
	return (tui: { width: number }, theme: { fg: (color: string, text: string) => string }) => {
		const container = new Container();
		const w = tui.width || 80;
		for (const line of lines) {
			container.addChild(new Text(line.length > w ? line.slice(0, w - 1) + "…" : line, 1, 0));
		}
		if (footer) {
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

async function clearCurrentState(cwd: string, name: string): Promise<void> {
	const state = await readCurrentState(cwd);
	if (state?.name === name) {
		try {
			await fs.unlink(path.join(cwd, STATE_FILE));
		} catch {
			// already gone
		}
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
	const options = workspaces.map((ws) => {
		const marks: string[] = [];
		if (ws.dirty) marks.push("dirty");
		if (ws.name === currentName) marks.push("current");
		const mark = marks.length > 0 ? ` (${marks.join(", ")})` : "";
		return `${ws.name} [${ws.status}]${mark}`;
	});
	const choice = await ctx.ui.select(title, options);
	if (!choice) return null;
	const name = choice.replace(/ \[[^\]]*\]/g, "").replace(/ \([^)]*\)/g, "");
	return workspaces.find((ws) => ws.name === name) ?? null;
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

Each branch-workspace is identified by \`<name>\`. The git branch name and the tmux session name both equal \`<name>\`. The two components share this identity and must be managed together. This skill owns their joint lifecycle.`;

const WS_ROLE_BOUNDARIES_TEXT = `The dispatcher agent owns the branch-workspace lifecycle and all coordination. The tmux pane is a shared execution environment — both agents may run commands there, but only the worker agent may write files:

- **Explore freely**: the dispatcher may read and inspect files in the branch-workspace's worktree at any point — to refine a task with the user, to review results, or to understand context. Use bash or read-only tools directly for speed and efficiency.
- **No direct writes**: the dispatcher must never write to or modify files in the branch-workspace's worktree, even for trivial changes. All file modifications go through the worker agent.
- **Observable tasks**: running commands, running tests, and debugging in the worktree are the dispatcher's responsibility because it is the interaction layer with the user. The dispatcher may use either bash or the branch-workspace's tmux pane to execute these tasks.
- **Review after completion**: after the worker agent signals completion, the dispatcher inspects the result and reports back to the user.

The worker agent performs implementation work inside the branch-workspace. It receives a self-contained task document and runs to completion.

\`worktree.sh\` owns the git worktree side. tmux operations must follow the tmux SKILL. \`<name>\` always means the complete branch-workspace identifier and must be matched exactly; never fuzzy-match or shorten it.`;

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
	const result = await pi.exec("tmux", [
		"-S", socket,
		"capture-pane", "-S", `-${lines}`, "-J", "-p", "-t", paneTarget,
	]);
	if (result.code !== 0) return "";
	const allLines = result.stdout.split("\n");
	return allLines.slice(-lines).join("\n");
}

function isPaneIdle(output: string): boolean {
	const lines = output.trim().split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) return true;
	const last = lines[lines.length - 1];
	return /[\$%>❯]\s*$/.test(last);
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

const STATUS_SYSTEM_PROMPT = `You are a workspace status analyzer. Given terminal pane output from a coding workspace:

1. Identify the last executed command and briefly describe what happened in Simplified Chinese — what it did, whether it succeeded or failed, and any notable output.
2. Show the last command and its output inside a markdown code block (\`\`\`). If the output is 15 lines or fewer, show it in full. If it exceeds 15 lines, extract only the key content (must include the command line and the final result), keeping the snippet within 15 lines. Do NOT truncate with "..." — show selected lines in full.

Keep response under 200 words. Be direct, no filler.`;

type AnalysisResult = { analysis: string } | { error: string };

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

// ─── Commands ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const state = await readCurrentState(ctx.cwd);
		if (state) updateWorkspaceStatus(ctx.ui, state.name);
	});

	// ── /ws-open [-b name] ──
	pi.registerCommand("ws-open", {
		description: "Open a branch-workspace (git worktree + tmux session). Usage: /ws-open [-b name]",
		handler: async (args, ctx) => {
			let { name } = parseBranchFlag(args);
			if (!name) {
				const selected = await selectWorkspace(pi, ctx, "Select workspace", ctx.cwd);
				if (!selected) return;
				name = selected.name;
			}

			const result = await pi.exec("bash", [WORKTREE_SH, "open", name, "--json"]);
			if (result.code !== 0) {
				ctx.ui.notify(result.stderr.trim() || "worktree.sh open failed", "error");
				return;
			}

			const output = parseOpenOutput(result.stdout);
			if (!output) {
				ctx.ui.notify("Failed to parse worktree output", "error");
				return;
			}

			const socket = await getTmuxSocket(pi);
			if (!socket) {
				ctx.ui.notify("Failed to resolve tmux socket", "error");
				return;
			}

			const sessionOk = await ensureSession(pi, socket, name, output.worktreePath);
			if (!sessionOk) {
				ctx.ui.notify(`Worktree created but failed to start tmux session for "${name}".`, "warning");
			}

			await writeCurrentState(ctx.cwd, name, output.worktreePath);
			updateWorkspaceStatus(ctx.ui, name);

			const monitorCmd = `tmux -S ${socket} attach -t ${name}`;
			const copied = await copyToClipboard(pi, monitorCmd);
			ctx.ui.notify(
				`Workspace "${name}" opened. Worktree: ${output.worktreePath}\nMonitor: ${monitorCmd}${copied ? " (copied)" : ""}`,
				"info",
			);
		},
	});

	// ── /ws-list ──
	pi.registerCommand("ws-list", {
		description: "List all branch-workspaces and optionally run an action.",
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

			const cmd = `/ws-${action} -b ${selected.name}`;
			ctx.ui.pasteToEditor(cmd);
		},
	});

	// ── /ws-close [-b name] [-s] ──
	pi.registerCommand("ws-close", {
		description: "Close a branch-workspace (remove worktree + kill tmux session). Usage: /ws-close [-b name] [-s]",
		handler: async (args, ctx) => {
			const selectFlag = /(^|\s)-s\b/.test(args);
			const { name: branchName, rest } = parseBranchFlag(args.replace(/(^|\s)-s\b/g, ""));

			const resolved = await resolveNameOrSelect(pi, branchName, ctx.cwd, ctx, selectFlag);
			if (!resolved) return;
			const { name } = resolved;

			const ws = await resolveWorkspaceState(pi, name);

			if (ws.status === "missing") {
				ctx.ui.notify(`Workspace "${name}" does not exist (no worktree, no session).`, "error");
				return;
			}

			if (ws.status === "orphan") {
				const socket = await getTmuxSocket(pi);
				const kill = await ctx.ui.confirm(
					"Orphaned Session",
					`Workspace "${name}" has an orphaned tmux session (no worktree). Kill it?`,
				);
				if (!kill) {
					ctx.ui.notify("Cancelled. Tmux session left untouched.", "info");
					return;
				}
				if (socket) {
					await pi.exec("tmux", ["-S", socket, "kill-session", "-t", name]);
				}
				ctx.ui.notify(`Orphaned tmux session "${name}" killed.`, "info");
				await clearCurrentState(ctx.cwd, name);
				return;
			}

			if (ws.dirty) {
				const proceed = await ctx.ui.confirm(
					"Dirty Worktree",
					`Workspace "${name}" has uncommitted changes. Close anyway?`,
				);
				if (!proceed) {
					ctx.ui.notify("Cancelled.", "info");
					return;
				}
			}

			const cleanResult = await pi.exec("bash", [WORKTREE_SH, "clean", name, "--json"]);
			if (cleanResult.code !== 0) {
				ctx.ui.notify(cleanResult.stderr.trim() || "Failed to remove worktree.", "error");
				return;
			}

			const cleanOutput = parseCleanOutput(cleanResult.stdout);

			// Kill tmux session if it exists
			if (ws.status === "active") {
				const socket = await getTmuxSocket(pi);
				if (socket) {
					const killResult = await pi.exec("tmux", ["-S", socket, "kill-session", "-t", name]);
					if (killResult.code !== 0) {
						ctx.ui.notify(
							`Worktree removed but tmux session "${name}" could not be killed (orphan).`,
							"warning",
						);
					}
				}
			}

			await clearCurrentState(ctx.cwd, name);
			updateWorkspaceStatus(ctx.ui, undefined);

			let msg = `Workspace "${name}" closed.`;
			if (cleanOutput && cleanOutput.leftoverCount > 0) {
				msg += ` Warning: ${cleanOutput.leftoverCount} leftover file(s) in ${cleanOutput.worktreePath}.`;
			}
			ctx.ui.notify(msg, "info");
		},
	});

	// ── /ws-status [-b name] [-s] [-a|--analyze] ──
	pi.registerCommand("ws-status", {
		description: "Show workspace status. Usage: /ws-status [-b name] [-s] [-a|--analyze]",
		handler: async (args, ctx) => {
			const analyze = /(^|\s)(--analyze|-a)\b/.test(args);
			const selectFlag = /(^|\s)-s\b/.test(args);
			const { name: branchName } = parseBranchFlag(args.replace(/(^|\s)(--analyze|-a)\b/g, "").replace(/(^|\s)-s\b/g, ""));

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
				const lines = paneOutput.trim().split("\n");
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
				const lines = result.analysis.split("\n");
				ctx.ui.setWidget("ws-status", buildWidget(lines, monitorCmd), { placement: "aboveEditor" });
			} else {
				ctx.ui.setWidget("ws-status", undefined);
				const lines = paneOutput.trim().split("\n");
				const tail = lines.slice(-15).join("\n");
				ctx.ui.notify(
					`${result.error} Raw output for "${name}":\n${tail}`,
					"warning",
				);
			}
		},
	});

	// ── /ws-vscode [-b name] [-s] ──
	pi.registerCommand("ws-vscode", {
		description: "Open a branch-workspace in VS Code. Usage: /ws-vscode [-b name] [-s]",
		handler: async (args, ctx) => {
			const selectFlag = /(^|\s)-s\b/.test(args);
			const { name: branchName } = parseBranchFlag(args.replace(/(^|\s)-s\b/g, ""));

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
		description: "Interrupt the running process in a workspace's tmux pane. Usage: /ws-cancel [-b name] [-s]",
		handler: async (args, ctx) => {
			const selectFlag = /(^|\s)-s\b/.test(args);
			const { name: branchName } = parseBranchFlag(args.replace(/(^|\s)-s\b/g, ""));

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

			const ws = await resolveWorkspaceState(pi, name);
			if (ws.status !== "active") {
				ctx.ui.notify(`Workspace "${name}" is not active (${ws.status}). Task requires a running tmux session.`, "error");
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

			const currentOutput = await capturePaneOutput(pi, socket, paneTarget, 20);
			if (!isPaneIdle(currentOutput)) {
				ctx.ui.notify(`Pane in "${name}" is busy. Cancel the running process first or wait for it to finish.`, "error");
				return;
			}

			const headerLines = [
				"[branch-workspace]",
				`name: ${name}`,
				`branch: ${name}`,
				`worktreePath: ${ws.worktreePath}`,
				`socket: ${socket}`,
				`session: ${name}`,
				`paneTarget: ${paneTarget}`,
				"",
				"note: DO NOT verify worktree, session, or pane — all pre-validated.",
			];
			if (chooseModel) headerLines.push("choose-model: yes");

			const content = [
				headerLines.join("\n"),
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

			// Create workspace (same as /ws-open)
			const result = await pi.exec("bash", [WORKTREE_SH, "open", name, "--json"]);
			if (result.code !== 0) {
				ctx.ui.notify(result.stderr.trim() || "worktree.sh open failed", "error");
				return;
			}

			const output = parseOpenOutput(result.stdout);
			if (!output) {
				ctx.ui.notify("Failed to parse worktree output", "error");
				return;
			}

			const socket = await getTmuxSocket(pi);
			if (!socket) {
				ctx.ui.notify("Failed to resolve tmux socket", "error");
				return;
			}

			const sessionOk = await ensureSession(pi, socket, name, output.worktreePath);
			if (!sessionOk) {
				ctx.ui.notify(`Worktree created but failed to start tmux session for "${name}".`, "warning");
			}

			await writeCurrentState(ctx.cwd, name, output.worktreePath);
			updateWorkspaceStatus(ctx.ui, name);

			// Resolve workspace state for full details
			const ws = await resolveWorkspaceState(pi, name);
			if (ws.status !== "active") {
				ctx.ui.notify(`Workspace "${name}" is not active (${ws.status}).`, "error");
				return;
			}

			const paneTarget = await discoverPaneTarget(pi, socket, name);
			if (!paneTarget) {
				ctx.ui.notify(`No pane found for session "${name}".`, "error");
				return;
			}

			const currentOutput = await capturePaneOutput(pi, socket, paneTarget, 20);
			if (!isPaneIdle(currentOutput)) {
				ctx.ui.notify(`Pane in "${name}" is busy. Cancel the running process first or wait for it to finish.`, "error");
				return;
			}

			// Build structured input
			const headerLines = [
				"[branch-workspace handoff-for-impl]",
				`name: ${name}`,
				`branch: ${name}`,
				`worktreePath: ${ws.worktreePath}`,
				`socket: ${socket}`,
				`session: ${name}`,
				`paneTarget: ${paneTarget}`,
				"",
				"note: DO NOT verify worktree, session, or pane — all pre-validated.",
			];
			if (chooseModel) headerLines.push("choose-model: yes");

			const hfiContext = `## Concept

${WS_CONCEPT_TEXT}

## Role Boundaries

${WS_ROLE_BOUNDARIES_TEXT}

## Handoff for Implementation

${WS_HFI_SKILL_TEXT}`;

			const content = [
				headerLines.join("\n"),
				hfiContext,
			].join("\n\n---\n\n");

			pi.sendMessage(
				{ customType: "branch-workspace-hfi", content, display: true },
				{ triggerTurn: true },
			);
		},
	});
}
