import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { completeSimple, type UserMessage } from "@earendil-works/pi-ai";
import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ─── Script Resolution ────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = path.join(__dirname, "workspace");
const WORKTREE_SH = path.join(WORKSPACE_DIR, "worktree.sh");
const FIND_SESSIONS_SH = path.join(WORKSPACE_DIR, "find-sessions.sh");
const STATE_FILE = ".branch-workspace-current.json";
const TMUX_SOCKET_DIR = "/tmp/claude-tmux-sockets";

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

async function resolveName(
	args: string,
	cwd: string,
	ctx: ExtensionCommandContext,
): Promise<{ name: string; worktreePath?: string } | null> {
	const trimmed = args.trim();
	if (trimmed) return { name: trimmed };

	const state = await readCurrentState(cwd);
	if (state) return state;

	ctx.ui.notify("No name specified and no current workspace set. Run /ws-open <name> first.", "error");
	return null;
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
		"capture-pane", "-S", `-${lines}`, "-p", "-t", paneTarget,
	]);
	return result.code === 0 ? result.stdout : "";
}

function isPaneIdle(output: string): boolean {
	const lines = output.trim().split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) return true;
	const last = lines[lines.length - 1];
	return /^[\$%>❯]\s*$/.test(last);
}

// ─── LLM Status Analysis ─────────────────────────────────────────

const STATUS_SYSTEM_PROMPT = `You are a workspace status analyzer. Given terminal pane output from a coding workspace, provide a concise structured summary:

1. **Current State**: What is currently happening (e.g., running tests, compiling, idle, editing files).
2. **Health Check**: Any visible errors, warnings, or panics. Quote exact error messages if found.
3. **Progress**: Brief progress estimate.
4. **Relevant Snippet**: If there's an error, extract it with ~10 lines of context. Otherwise show the last 10-15 lines.

Keep the response under 200 words. Be direct, no filler.`;

async function analyzeStatus(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	paneOutput: string,
): Promise<string | null> {
	const model = ctx.model;
	if (!model) {
		return null;
	}

	const credentials = ctx.modelRegistry.getApiKeyAndHeaders(model);
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
			apiKey: credentials.apiKey,
			headers: credentials.headers,
			signal: ctx.signal,
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

// ─── Commands ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	// ── /ws-open <name> ──
	pi.registerCommand("ws-open", {
		description: "Open a branch-workspace (git worktree + tmux session). Usage: /ws-open <name>",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /ws-open <name>", "error");
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

			ctx.ui.notify(
				`Workspace "${name}" opened. Worktree: ${output.worktreePath}`,
				"info",
			);
			ctx.ui.notify(
				`Monitor: tmux -S ${socket} attach -t ${name}`,
				"info",
			);
		},
	});

	// ── /ws-list ──
	pi.registerCommand("ws-list", {
		description: "List all branch-workspaces with status (active/idle/orphan).",
		handler: async (_args, ctx) => {
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

			const currentState = await readCurrentState(ctx.cwd);

			// Build workspace map: merge worktrees and sessions by name
			const names = new Set<string>();
			for (const wt of worktrees) names.add(wt.branch);
			for (const s of sessions) names.add(s.session_name);

			if (names.size === 0) {
				ctx.ui.notify("No branch-workspaces found.", "info");
				return;
			}

			const lines: string[] = [];
			for (const name of [...names].sort()) {
				const wt = worktrees.find((w) => w.branch === name);
				const sess = sessions.find((s) => s.session_name === name);

				let status: string;
				if (wt && sess) status = "active";
				else if (wt) status = "idle";
				else status = "orphan";

				const dirtyMark = wt?.dirty ? " (dirty)" : "";
				const currentMark = currentState?.name === name ? " (current)" : "";
				lines.push(`  ${name} [${status}]${dirtyMark}${currentMark}`);
			}

			ctx.ui.notify(`Branch-workspaces:\n${lines.join("\n")}`, "info");
		},
	});

	// ── /ws-close [name] ──
	pi.registerCommand("ws-close", {
		description: "Close a branch-workspace (remove worktree + kill tmux session). Usage: /ws-close [name]",
		handler: async (args, ctx) => {
			const resolved = await resolveName(args, ctx.cwd, ctx);
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

			let msg = `Workspace "${name}" closed.`;
			if (cleanOutput && cleanOutput.leftoverCount > 0) {
				msg += ` Warning: ${cleanOutput.leftoverCount} leftover file(s) in ${cleanOutput.worktreePath}.`;
			}
			ctx.ui.notify(msg, "info");
		},
	});

	// ── /ws-status [name] ──
	pi.registerCommand("ws-status", {
		description: "Show intelligent status of a branch-workspace. Usage: /ws-status [name]",
		handler: async (args, ctx) => {
			const resolved = await resolveName(args, ctx.cwd, ctx);
			if (!resolved) return;
			const { name } = resolved;

			const ws = await resolveWorkspaceState(pi, name);
			if (ws.status === "missing") {
				ctx.ui.notify(`Workspace "${name}" does not exist.`, "error");
				return;
			}
			if (ws.status === "orphan") {
				ctx.ui.notify(`Workspace "${name}" has no worktree (orphan session).`, "error");
				return;
			}

			const socket = await getTmuxSocket(pi);
			if (!socket) {
				ctx.ui.notify("Failed to resolve tmux socket.", "error");
				return;
			}

			if (ws.status === "idle") {
				const ok = await ensureSession(pi, socket, name, ws.worktreePath!);
				if (!ok) {
					ctx.ui.notify(`Failed to recreate tmux session for "${name}".`, "error");
					return;
				}
				ctx.ui.notify(`Recreated tmux session for "${name}".`, "info");
			}

			const paneTarget = await discoverPaneTarget(pi, socket, name);
			if (!paneTarget) {
				ctx.ui.notify(`No pane found for session "${name}".`, "error");
				return;
			}

			const paneOutput = await capturePaneOutput(pi, socket, paneTarget);
			if (!paneOutput.trim()) {
				ctx.ui.notify(`Pane output is empty for "${name}".`, "warning");
				return;
			}

			const analysis = await analyzeStatus(pi, ctx, paneOutput);
			if (analysis) {
				ctx.ui.notify(`Status for "${name}":\n\n${analysis}`, "info");
			} else {
				// Fallback: show raw last 15 lines
				const lines = paneOutput.trim().split("\n");
				const tail = lines.slice(-15).join("\n");
				ctx.ui.notify(`Status for "${name}" (no LLM available, raw output):\n${tail}`, "info");
			}

			ctx.ui.notify(`Monitor: tmux -S ${socket} attach -t ${name}`, "info");
		},
	});

	// ── /ws-vscode [name] ──
	pi.registerCommand("ws-vscode", {
		description: "Open a branch-workspace in VS Code. Usage: /ws-vscode [name]",
		handler: async (args, ctx) => {
			const resolved = await resolveName(args, ctx.cwd, ctx);
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

	// ── /ws-cancel [name] ──
	pi.registerCommand("ws-cancel", {
		description: "Interrupt the running process in a workspace's tmux pane. Usage: /ws-cancel [name]",
		handler: async (args, ctx) => {
			const resolved = await resolveName(args, ctx.cwd, ctx);
			if (!resolved) return;
			const { name } = resolved;

			const ws = await resolveWorkspaceState(pi, name);
			if (ws.status === "missing") {
				ctx.ui.notify(`Workspace "${name}" does not exist.`, "error");
				return;
			}
			if (ws.status === "orphan") {
				ctx.ui.notify(`Workspace "${name}" has no worktree (orphan session).`, "error");
				return;
			}

			const socket = await getTmuxSocket(pi);
			if (!socket) {
				ctx.ui.notify("Failed to resolve tmux socket.", "error");
				return;
			}

			if (ws.status === "idle") {
				const ok = await ensureSession(pi, socket, name, ws.worktreePath!);
				if (!ok) {
					ctx.ui.notify(`Failed to recreate tmux session for "${name}".`, "error");
					return;
				}
				ctx.ui.notify(`Recreated tmux session for "${name}".`, "info");
			}

			const paneTarget = await discoverPaneTarget(pi, socket, name);
			if (!paneTarget) {
				ctx.ui.notify(`No pane found for session "${name}".`, "error");
				return;
			}

			// Check if already idle
			const currentOutput = await capturePaneOutput(pi, socket, paneTarget, 20);
			if (isPaneIdle(currentOutput)) {
				ctx.ui.notify(`Workspace "${name}" is already idle.`, "info");
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
				ctx.ui.notify(`Process in "${name}" interrupted. Workspace is idle.`, "info");
			} else {
				ctx.ui.notify(
					`Sent C-c to "${name}". Process may still be terminating; check with /ws-status.`,
					"warning",
				);
			}
		},
	});
}
