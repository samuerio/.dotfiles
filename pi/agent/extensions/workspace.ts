import { completeSimple, type ThinkingLevel, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
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
	const name = choice.replace(/ \[.*\]$/, "").replace(/ \(.*\)$/, "");
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

async function resolveNameOrSelect(
	pi: ExtensionAPI,
	args: string,
	cwd: string,
	ctx: ExtensionCommandContext,
	selectFlag: boolean,
): Promise<{ name: string; worktreePath?: string } | null> {
	const nameArgs = args.trim();
	if (nameArgs && !selectFlag) return { name: nameArgs };

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

// ─── tmux Helpers ─────────────────────────────────────────────────

async function discoverPaneTarget(
	pi: ExtensionAPI,
	socket: string,
	name: string,
): Promise<string | null> {
	const result = await pi.exec("tmux", [
		"-S", socket,
		"list-panes", "-s", "-t", name,
		"-F", "#{pane_id}",
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
	return /^[\$%>❯]\s*$/.test(last);
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

1. Provide a brief summary in Simplified Chinese describing the pane's current state — what's running, any errors or warnings, and overall progress. If there's an error, quote the exact message.
2. Append the most relevant log snippet: if there's an error, extract ~10 lines of context around it; otherwise show the last 10-15 lines.

Keep response under 200 words. Be direct, no filler.`;

async function analyzeStatus(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	paneOutput: string,
): Promise<string | null> {
	const rushSpec = loadRushModeSpec(ctx.cwd);
	if (!rushSpec) {
		return null;
	}

	const model = ctx.modelRegistry.find(rushSpec.provider!, rushSpec.modelId!);
	if (!model) {
		return null;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return null;
	}

	const thinkingLevels: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];
	const reasoning: ThinkingLevel | undefined =
		rushSpec.thinkingLevel && thinkingLevels.includes(rushSpec.thinkingLevel as ThinkingLevel)
			? (rushSpec.thinkingLevel as ThinkingLevel)
			: undefined;

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
			...(reasoning ? { reasoning } : {}),
		},
	);

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
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

	// ── /ws-open <name> ──
	pi.registerCommand("ws-open", {
		description: "Open a branch-workspace (git worktree + tmux session). Usage: /ws-open [name]",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				const selected = await selectWorkspace(pi, ctx, "Select workspace", ctx.cwd);
				if (!selected) return;

				const actions = getAvailableActions(selected.status);
				if (actions.length === 0) {
					ctx.ui.notify(`Workspace "${selected.name}" has no available actions.`, "error");
					return;
				}

				const action = await ctx.ui.select(`Action for "${selected.name}"`, actions) as WorkspaceAction | undefined;
				if (!action) return;

				ctx.ui.pasteToEditor(`/ws-${action} ${selected.name}`);
				return;
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

			const cmd = `/ws-${action} ${selected.name}`;
			ctx.ui.pasteToEditor(cmd);
		},
	});

	// ── /ws-close [name] [-s] ──
	pi.registerCommand("ws-close", {
		description: "Close a branch-workspace (remove worktree + kill tmux session). Usage: /ws-close [name] [-s]",
		handler: async (args, ctx) => {
			const selectFlag = /(^|\s)-s\b/.test(args);
			const nameArgs = args.replace(/(^|\s)-s\b/g, "").trim();

			const resolved = await resolveNameOrSelect(pi, nameArgs, ctx.cwd, ctx, selectFlag);
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

	// ── /ws-status [name] [-s] [-a|--analyze] ──
	pi.registerCommand("ws-status", {
		description: "Show workspace status. Usage: /ws-status [name] [-s] [-a|--analyze]",
		handler: async (args, ctx) => {
			const analyze = /(^|\s)(--analyze|-a)\b/.test(args);
			const selectFlag = /(^|\s)-s\b/.test(args);
			const nameArgs = args.replace(/(^|\s)(--analyze|-a)\b/g, "").replace(/(^|\s)-s\b/g, "").trim();

			const resolved = await resolveNameOrSelect(pi, nameArgs, ctx.cwd, ctx, selectFlag);
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

			let analysis: string | null = null;
			try {
				analysis = await analyzeStatus(pi, ctx, paneOutput);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.setWidget("ws-status", undefined);
				ctx.ui.notify(`LLM analysis failed: ${msg}`, "warning");
				return;
			}

			if (analysis) {
				const lines = analysis.split("\n");
				ctx.ui.setWidget("ws-status", buildWidget(lines, monitorCmd), { placement: "aboveEditor" });
			} else {
				ctx.ui.setWidget("ws-status", undefined);
				const lines = paneOutput.trim().split("\n");
				const tail = lines.slice(-15).join("\n");
				ctx.ui.notify(
					`No rush mode configured in modes.json. Raw output for "${name}":\n${tail}`,
					"warning",
				);
			}
		},
	});

	// ── /ws-vscode [name] [-s] ──
	pi.registerCommand("ws-vscode", {
		description: "Open a branch-workspace in VS Code. Usage: /ws-vscode [name] [-s]",
		handler: async (args, ctx) => {
			const selectFlag = /(^|\s)-s\b/.test(args);
			const nameArgs = args.replace(/(^|\s)-s\b/g, "").trim();

			const resolved = await resolveNameOrSelect(pi, nameArgs, ctx.cwd, ctx, selectFlag);
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

	// ── /ws-cancel [name] [-s] ──
	pi.registerCommand("ws-cancel", {
		description: "Interrupt the running process in a workspace's tmux pane. Usage: /ws-cancel [name] [-s]",
		handler: async (args, ctx) => {
			const selectFlag = /(^|\s)-s\b/.test(args);
			const nameArgs = args.replace(/(^|\s)-s\b/g, "").trim();

			const resolved = await resolveNameOrSelect(pi, nameArgs, ctx.cwd, ctx, selectFlag);
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
}
