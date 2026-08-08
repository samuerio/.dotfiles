import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ─── Script Resolution ────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRANCH_WORKSPACE_SCRIPTS_DIR = path.join(__dirname, "branch-workspace");
const WORKTREE_SH = path.join(BRANCH_WORKSPACE_SCRIPTS_DIR, "worktree.sh");
const FIND_SESSIONS_SH = path.join(BRANCH_WORKSPACE_SCRIPTS_DIR, "find-sessions.sh");
/** Per-checkout current pointer (under `.pi/`, not repo root). */
const STATE_FILE_REL = path.join(".pi", "branch-workspace-current.json");
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
const BATCH_RAW_TAIL = 10;
const SINGLE_RAW_TAIL = 15;

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

interface CurrentBranchWorkspace {
	name: string;
	worktreePath: string;
}

function stateFilePath(cwd: string): string {
	return path.join(cwd, STATE_FILE_REL);
}

async function readCurrentState(cwd: string): Promise<CurrentBranchWorkspace | null> {
	try {
		const content = await fs.readFile(stateFilePath(cwd), "utf8");
		return JSON.parse(content);
	} catch {
		return null;
	}
}

async function writeCurrentState(cwd: string, name: string, worktreePath: string): Promise<void> {
	const filePath = stateFilePath(cwd);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify({ name, worktreePath }), "utf8");
}

async function clearCurrentState(cwd: string): Promise<void> {
	try {
		await fs.unlink(stateFilePath(cwd));
	} catch {
		// already gone
	}
}

// ─── UI Select Helpers ────────────────────────────────────────────

async function listAllBranchWorkspaces(pi: ExtensionAPI): Promise<ResolvedBranchWorkspace[]> {
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

	const result: ResolvedBranchWorkspace[] = [];
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

async function selectBranchWorkspace(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	title: string,
	cwd?: string,
): Promise<ResolvedBranchWorkspace | null> {
	const branchWorkspaces = await listAllBranchWorkspaces(pi);
	if (branchWorkspaces.length === 0) {
		ctx.ui.notify("No branch-workspaces available.", "error");
		return null;
	}
	const currentName = cwd ? (await readCurrentState(cwd))?.name : undefined;

	// Build display strings and a robust map to avoid fragile string parsing of names
	const displayToBranchWorkspace = new Map<string, ResolvedBranchWorkspace>();
	for (const bw of branchWorkspaces) {
		const marks: string[] = [];
		if (bw.dirty) marks.push("dirty");
		if (bw.name === currentName) marks.push("current");
		const mark = marks.length > 0 ? ` (${marks.join(", ")})` : "";
		const display = `${bw.name} [${bw.state}]${mark}`;
		displayToBranchWorkspace.set(display, bw);
	}

	const choice = await ctx.ui.select(title, Array.from(displayToBranchWorkspace.keys()));
	if (!choice) return null;
	return displayToBranchWorkspace.get(choice) ?? null;
}

type BranchWorkspaceAction = "open" | "log" | "status" | "vscode" | "cancel" | "close";

function getAvailableActions(state: BranchWorkspaceState): BranchWorkspaceAction[] {
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

	return selectBranchWorkspace(pi, ctx, "Select branch-workspace", cwd);
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

// ─── Branch-workspace State Resolution ───────────────────────────────────

type BranchWorkspaceState = "active" | "idle" | "orphan" | "missing";

interface ResolvedBranchWorkspace {
	name: string;
	state: BranchWorkspaceState;
	worktreePath?: string;
	dirty?: boolean;
}

async function resolveBranchWorkspaceState(
	pi: ExtensionAPI,
	name: string,
): Promise<ResolvedBranchWorkspace> {
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

// ─── Pane Log Widgets ─────────────────────────────────────────────

/**
 * Append the last rawTailLines of pane output to lines. Caller supplies the
 * banner (────── name ──────); shared by batch and single /bw-log views.
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

/** Batch /bw-log -b: name banner + short raw tail per active workspace. */
function formatBatchRawLines(captures: Array<{ name: string; output: string }>): string[] {
	// Spacer rows (not ""): title ↔ first block, and between branch-workspace blocks
	const lines: string[] = [`Batch · ${captures.length} active`, BLANK_ROW];

	captures.forEach((c, i) => {
		if (i > 0) lines.push(BLANK_ROW);
		lines.push(formatBatchNameHeader(c.name), BLANK_ROW);
		appendRawTailLines(lines, c.output, BATCH_RAW_TAIL);
	});
	return lines;
}

/** Single /bw-log: name banner + raw tail + Monitor (footer). */
function formatSingleRawWidget(paneOutput: string, name: string): string[] {
	const lines = [formatBatchNameHeader(name), BLANK_ROW];
	appendRawTailLines(lines, paneOutput, SINGLE_RAW_TAIL);
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

/** Status-bar chip for current branch-workspace name (not the lifecycle state enum). */
function updateStatusBar(ui: ExtensionUI, name: string | undefined): void {
	if (!name) {
		ui.setStatus("branch-workspace", undefined);
		return;
	}
	const label = ui.theme.fg("accent", "branch-workspace");
	ui.setStatus("branch-workspace", `${label} ${name}`);
}

// ─── Shared lifecycle core (slash commands + tools) ───────────────

interface BranchWorkspaceEnv {
	name: string;
	branch: string;
	worktreePath?: string;
	socket: string | null;
	session: string;
	paneTarget: string | null;
	state: BranchWorkspaceState;
	dirty?: boolean;
	preValidated: boolean;
	monitorCmd?: string;
}

interface ListBranchWorkspaceRow {
	name: string;
	state: BranchWorkspaceState;
	dirty?: boolean;
	worktreePath?: string;
}

interface ListResult {
	ok: true;
	branchWorkspaces: ListBranchWorkspaceRow[];
	socket: string | null;
}

/** Result of openBranchWorkspace. Agent tool exposes only ok/name/warnings/error; slash may use path/created/monitor. */
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

async function listBranchWorkspaces(
	pi: ExtensionAPI,
	opts: { query?: string } = {},
): Promise<ListResult> {
	let branchWorkspaces = await listAllBranchWorkspaces(pi);
	if (opts.query) {
		const q = opts.query.toLowerCase();
		branchWorkspaces = branchWorkspaces.filter((w) => w.name.toLowerCase().includes(q));
	}
	const socket = await getTmuxSocket(pi);
	return {
		ok: true,
		socket,
		branchWorkspaces: branchWorkspaces.map((w) => ({
			name: w.name,
			state: w.state,
			dirty: w.dirty,
			worktreePath: w.worktreePath,
		})),
	};
}

async function buildBranchWorkspaceEnv(pi: ExtensionAPI, name: string): Promise<BranchWorkspaceEnv> {
	const bw = await resolveBranchWorkspaceState(pi, name);
	const socket = await getTmuxSocket(pi);
	let paneTarget: string | null = null;
	if (socket && bw.state === "active") {
		paneTarget = await discoverPaneTarget(pi, socket, name);
	}
	const preValidated = !!(socket && paneTarget && bw.state === "active");
	const hasSession = bw.state === "active" || bw.state === "orphan";
	return {
		name,
		branch: name,
		worktreePath: bw.worktreePath,
		socket,
		session: name,
		paneTarget,
		state: bw.state,
		dirty: bw.dirty,
		preValidated,
		// Attach only when a tmux session exists (active / orphan). Idle has no session.
		monitorCmd: hasSession && socket ? `tmux -S ${socket} attach -t ${name}` : undefined,
	};
}

async function openBranchWorkspace(
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

async function closeBranchWorkspace(
	pi: ExtensionAPI,
	opts: { cwd: string; name: string; force?: boolean; ui?: ExtensionUI },
): Promise<CloseResult> {
	const { cwd, name, force = false, ui } = opts;
	const bw = await resolveBranchWorkspaceState(pi, name);

	if (bw.state === "missing") {
		return {
			ok: false,
			name,
			state: "missing",
			error: `Branch-workspace "${name}" does not exist (no worktree, no session).`,
		};
	}

	if (bw.state === "orphan") {
		if (!force) {
			return {
				ok: false,
				name,
				state: "orphan",
				needsForce: "orphan",
				error: `Branch-workspace "${name}" has an orphaned tmux session (no worktree). Ask the user, then call again with force: true to kill the session.`,
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

	if (bw.dirty && !force) {
		return {
			ok: false,
			name,
			state: bw.state,
			needsForce: "dirty",
			error: `Branch-workspace "${name}" has uncommitted changes. Ask the user, then call again with force: true to close anyway.`,
		};
	}

	const cleanArgs = [WORKTREE_SH, "clean", name];
	if (bw.dirty) cleanArgs.push("--force");
	cleanArgs.push("--json");
	const cleanResult = await pi.exec("bash", cleanArgs);
	if (cleanResult.code !== 0) {
		return {
			ok: false,
			name,
			state: bw.state,
			error: cleanResult.stderr.trim() || "Failed to remove worktree.",
		};
	}
	const cleanOutput = parseCleanOutput(cleanResult.stdout);

	let sessionWarn: string | undefined;
	if (bw.state === "active") {
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
		state: bw.state,
		leftoverCount: cleanOutput?.leftoverCount ?? 0,
		error: sessionWarn,
	};
}

function formatListText(result: ListResult): string {
	if (result.branchWorkspaces.length === 0) {
		return "No branch-workspaces found.";
	}
	return result.branchWorkspaces
		.map((w) => {
			const mark = w.dirty ? " (dirty)" : "";
			return `- ${w.name} [${w.state}]${mark}`;
		})
		.join("\n");
}

function formatOpenText(result: OpenResult): string {
	if (!result.ok) {
		return result.error ?? `Failed to open branch-workspace "${result.name}".`;
	}
	const lines = [`Opened branch-workspace "${result.name}".`];
	if (result.warnings.length > 0) {
		lines.push(`warnings: ${result.warnings.join("; ")}`);
	}
	return lines.join("\n");
}

/** Agent-facing open details: no path/created/env (use bw_status for dispatch readiness). */
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
	if (env.state === "missing") {
		return `Branch-workspace "${env.name}" does not exist (no worktree, no session). Open it with bw_open first.`;
	}
	return [
		`Branch-workspace "${env.name}" status.`,
		`state: ${env.state}`,
		`dirty: ${env.dirty ?? false}`,
		`worktreePath: ${env.worktreePath ?? ""}`,
		`socket: ${env.socket ?? ""}`,
		`session: ${env.session}`,
		`paneTarget: ${env.paneTarget ?? ""}`,
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

	// Clear bw-log / bw-status widgets when a new turn starts so they don't block conversation output.
	pi.on("turn_start", async (_event, ctx) => {
		ctx.ui.setWidget("bw-log", undefined);
		ctx.ui.setWidget("bw-status", undefined);
	});

	// ── /bw-open [-b name] ──
	pi.registerCommand("bw-open", {
		description: "Open a branch-workspace (git worktree + tmux session). Usage: /bw-open [name]",
		handler: async (args, ctx) => {
			let { name } = parsePositionalName(args);
			if (!name) {
				const selected = await selectBranchWorkspace(pi, ctx, "Select branch-workspace", ctx.cwd);
				if (!selected) return;
				name = selected.name;
			}

			const result = await openBranchWorkspace(pi, { cwd: ctx.cwd, name, ui: ctx.ui });
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
				`Branch-workspace "${name}" opened. ${pathLine}${monitorCmd ? `\nMonitor: ${monitorCmd}${copied ? " (copied)" : ""}` : ""}`,
				"info",
			);
		},
	});

	// ── /bw-list ──
	pi.registerCommand("bw-list", {
		description: "List all branch-workspaces and optionally run an action. (For pane log of all active: /bw-log -b)",
		handler: async (_args, ctx) => {
			// Select branch-workspace
			const selected = await selectBranchWorkspace(pi, ctx, "Select branch-workspace", ctx.cwd);
			if (!selected) return;

			// Select action based on branch-workspace state
			const actions = getAvailableActions(selected.state);
			if (actions.length === 0) {
				ctx.ui.notify(`Branch-workspace "${selected.name}" has no available actions.`, "error");
				return;
			}

			const action = await ctx.ui.select(`Action for "${selected.name}"`, actions) as BranchWorkspaceAction | undefined;
			if (!action) return;

			// Paste the command using positional argument for the selected branch-workspace.
			// This works for all actions offered here (open / log / status / vscode / cancel / close).
			// For batch pane log of *all* active branch-workspaces, use `/bw-log -b` (or --batch) directly.
			const cmd = `/bw-${action} ${selected.name}`;
			ctx.ui.pasteToEditor(cmd);
		},
	});

	// ── /bw-status [name] [-s] ──
	// Branch-workspace status = state + env (not pane log — use /bw-log for that).
	// Display uses the same aboveEditor widget surface as /bw-log.
	pi.registerCommand("bw-status", {
		description:
			"Show branch-workspace status (state + env: socket, pane, dirty, …). Usage: /bw-status [name] [-s]",
		handler: async (args, ctx) => {
			const selectFlag = /(^|\s)-s\b/.test(args);
			const { name: branchName } = parsePositionalName(args, [/(^|\s)-s\b/g]);

			const resolved = await resolveNameOrSelect(pi, branchName, ctx.cwd, ctx, selectFlag);
			if (!resolved) return;
			const { name } = resolved;

			const env = await buildBranchWorkspaceEnv(pi, name);
			const lines = formatStatusText(env).split("\n");

			// Attach hint only when a session exists (active / orphan), matching /bw-log footer.
			let footer: string | undefined;
			if (env.monitorCmd && (env.state === "active" || env.state === "orphan")) {
				const copied = await copyToClipboard(pi, env.monitorCmd);
				footer = `Monitor: ${env.monitorCmd}${copied ? " (copied)" : ""}`;
			}

			ctx.ui.setWidget("bw-status", buildWidget(lines, footer), { placement: "aboveEditor" });
		},
	});

	// ── /bw-close [-b name] [-s] ──
	pi.registerCommand("bw-close", {
		description: "Close a branch-workspace (remove worktree + kill tmux session). Usage: /bw-close [name] [-s]",
		handler: async (args, ctx) => {
			const selectFlag = /(^|\s)-s\b/.test(args);
			const { name: branchName } = parsePositionalName(args, [/(^|\s)-s\b/g]);

			const resolved = await resolveNameOrSelect(pi, branchName, ctx.cwd, ctx, selectFlag);
			if (!resolved) return;
			const { name } = resolved;

			// Interactive confirms map to force:true; never call close until user accepts.
			const bw = await resolveBranchWorkspaceState(pi, name);
			if (bw.state === "missing") {
				ctx.ui.notify(`Branch-workspace "${name}" does not exist (no worktree, no session).`, "error");
				return;
			}
			let force = false;
			if (bw.state === "orphan") {
				const kill = await ctx.ui.confirm(
					"Orphaned Session",
					`Branch-workspace "${name}" has an orphaned tmux session (no worktree). Kill it?`,
				);
				if (!kill) {
					ctx.ui.notify("Cancelled. Tmux session left untouched.", "info");
					return;
				}
				force = true;
			} else if (bw.dirty) {
				const proceed = await ctx.ui.confirm(
					"Dirty Worktree",
					`Branch-workspace "${name}" has uncommitted changes. Close anyway?`,
				);
				if (!proceed) {
					ctx.ui.notify("Cancelled.", "info");
					return;
				}
				force = true;
			}

			const result = await closeBranchWorkspace(pi, { cwd: ctx.cwd, name, force, ui: ctx.ui });
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

	// ── /bw-log [-b|--batch] [name] [-s] ──  (pane log; not /bw-status)
	pi.registerCommand("bw-log", {
		description: "Show pane log (not branch-workspace status — use /bw-status). Usage: /bw-log [-b|--batch] [name] [-s]",
		handler: async (args, ctx) => {
			const selectFlag = /(^|\s)-s\b/.test(args);
			const batch = /(^|\s)(-b|--batch)\b/.test(args);
			const flagPatterns = [
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

				const allWs = await listAllBranchWorkspaces(pi);
				const actives = allWs.filter((w) => w.state === "active");
				if (actives.length === 0) {
					ctx.ui.notify("No active branch-workspaces.", "info");
					return;
				}

				const captures: Array<{ name: string; output: string }> = [];
				for (const bw of actives) {
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

			// Single branch-workspace
			const resolved = await resolveNameOrSelect(pi, branchName, ctx.cwd, ctx, selectFlag);
			if (!resolved) return;
			const { name } = resolved;

			const bw = await resolveBranchWorkspaceState(pi, name);
			if (bw.state !== "active") {
				ctx.ui.notify(`Branch-workspace "${name}" is not active (${bw.state}). Log requires a running tmux session.`, "error");
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

			const paneOutput = await capturePaneOutput(pi, socket, paneTarget, SINGLE_RAW_TAIL);
			if (!paneOutput.trim()) {
				ctx.ui.notify(`Pane output is empty for "${name}".`, "warning");
				return;
			}

			const rawCmd = `tmux -S ${socket} attach -t ${name}`;
			const copied = await copyToClipboard(pi, rawCmd);
			const monitorCmd = `Monitor: ${rawCmd}${copied ? " (copied)" : ""}`;

			const lines = formatSingleRawWidget(paneOutput, name);
			ctx.ui.setWidget("bw-log", buildWidget(lines, monitorCmd), { placement: "aboveEditor" });
		},
	});

	// ── /bw-vscode [-b name] [-s] ──
	pi.registerCommand("bw-vscode", {
		description: "Open a branch-workspace in VS Code. Usage: /bw-vscode [name] [-s]",
		handler: async (args, ctx) => {
			const selectFlag = /(^|\s)-s\b/.test(args);
			const { name: branchName } = parsePositionalName(args, [/(^|\s)-s\b/g]);

			const resolved = await resolveNameOrSelect(pi, branchName, ctx.cwd, ctx, selectFlag);
			if (!resolved) return;
			const { name, worktreePath: stateWorktreePath } = resolved;

			let wtPath = stateWorktreePath;
			if (!wtPath) {
				const bw = await resolveBranchWorkspaceState(pi, name);
				if (bw.state === "missing") {
					ctx.ui.notify(`Branch-workspace "${name}" does not exist.`, "error");
					return;
				}
				wtPath = bw.worktreePath;
			}

			if (!wtPath) {
				ctx.ui.notify(`Cannot resolve worktree path for "${name}".`, "error");
				return;
			}

			await pi.exec("code", [wtPath]);
			ctx.ui.notify(`Opened VS Code for "${name}" at ${wtPath}`, "info");
		},
	});

	// ── /bw-cancel [-b name] [-s] ──
	pi.registerCommand("bw-cancel", {
		description: "Interrupt the running process in a branch-workspace's tmux pane. Usage: /bw-cancel [name] [-s]",
		handler: async (args, ctx) => {
			const selectFlag = /(^|\s)-s\b/.test(args);
			const { name: branchName } = parsePositionalName(args, [/(^|\s)-s\b/g]);

			const resolved = await resolveNameOrSelect(pi, branchName, ctx.cwd, ctx, selectFlag);
			if (!resolved) return;
			const { name } = resolved;

			const bw = await resolveBranchWorkspaceState(pi, name);
			if (bw.state !== "active") {
				ctx.ui.notify(`Branch-workspace "${name}" is not active (${bw.state}). Cancel requires a running tmux session.`, "error");
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

			const proceed = await ctx.ui.confirm(
				"Interrupt Process",
				`Send C-c to branch-workspace "${name}"?`,
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

			ctx.ui.notify(`Sent C-c to "${name}". Check with /bw-log to confirm.`, "info");
		},
	});

	// Task / handoff-for-impl orchestration lives in agents/skills/branch-workspace/SKILL.md
	// (tools: bw_list / bw_open / bw_close / bw_status). Task/hfi orchestration is skill-driven.

	// ── Tools: bw_list / bw_open / bw_close / bw_status ──

	pi.registerTool({
		name: "bw_list",
		label: "List branch-workspaces",
		description:
			"List branch-workspaces (git worktree + tmux session) with state and dirty flag. Read-only.",
		promptSnippet: "List branch-workspaces (active/idle/orphan, dirty).",
		promptGuidelines: [
			"Use before bw_open/bw_close when the exact name is unknown; the result provides full names for exact-match identity.",
			"query is substring filter only, not fuzzy identity match.",
		],
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({ description: "Optional substring filter on branch-workspace name (not fuzzy identity)." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await listBranchWorkspaces(pi, {
				query: typeof params.query === "string" ? params.query : undefined,
			});
			return {
				content: [{ type: "text" as const, text: formatListText(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "bw_open",
		label: "Open branch-workspace",
		description:
			"Create or reuse a branch-workspace (git worktree + tmux session). Returns only ok/name/warnings (or error). For state/env/dispatch readiness, call bw_status with the same name. Recreates a missing session for idle; for orphan prefer close-then-open.",
		promptSnippet: "Open/reuse a branch-workspace; then call bw_status with the same name for env.",
		promptGuidelines: [
			"Require an exact full name (e.g. feat/my-feature). Prefer names from bw_list when reusing.",
			"On success, call bw_status with the same name to get state/socket/paneTarget before dispatch.",
			"idle (worktree only): open recreates the session. orphan (session only): prefer bw_close after user confirm, then open — open reuses the residual session without resetting cwd.",
			"First open in a repo may commit .gitignore via worktree.sh (existing behavior).",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Full branch-workspace name (exact match)." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const name = typeof params.name === "string" ? params.name.trim() : "";
			if (!name) {
				return {
					content: [{ type: "text" as const, text: "bw_open requires a non-empty name." }],
					details: { ok: false, error: "name required", warnings: [] as string[] },
				};
			}
			const result = await openBranchWorkspace(pi, { cwd: ctx.cwd, name, ui: ctx.ui });
			return {
				content: [{ type: "text" as const, text: formatOpenText(result) }],
				details: openToolDetails(result),
			};
		},
	});

	pi.registerTool({
		name: "bw_close",
		label: "Close branch-workspace",
		description:
			"Close a branch-workspace (remove worktree + kill tmux session). Fail-closed: dirty worktree or orphan session returns needsForce and requires force:true only after explicit user confirmation. Clean active/idle close without force.",
		promptSnippet: "Close a branch-workspace; force only after user confirms dirty/orphan.",
		promptGuidelines: [
			"Use exact name from bw_list or prior open. Never invent force:true.",
			"needsForce dirty: uncommitted changes — ask the user, then re-call with force:true only if they confirm.",
			"needsForce orphan: residual tmux session with no worktree — ask the user, then re-call with force:true only if they confirm (kills the session).",
			"Do not kill sessions via raw tmux; always use this tool.",
			"Prefer bw_list first when unsure which branch-workspace to close.",
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
					content: [{ type: "text" as const, text: "bw_close requires a non-empty name." }],
					details: { ok: false, error: "name required" },
				};
			}
			const force = params.force === true;
			const result = await closeBranchWorkspace(pi, { cwd: ctx.cwd, name, force, ui: ctx.ui });
			return {
				content: [{ type: "text" as const, text: formatCloseText(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "bw_status",
		label: "Inspect branch-workspace",
		description:
			"Read-only branch-workspace status report: state (active|idle|orphan|missing) + env (worktreePath, socket, session, paneTarget, dirty, monitorCmd). Requires an exact name. No side effects.",
		promptSnippet: "Inspect branch-workspace status (state+env) by exact name.",
		promptGuidelines: [
			"After bw_open, call this with the same name to get state/socket/paneTarget before dispatch. Also use to inspect without opening, or re-check later.",
			"name is required (exact full name). Use bw_list when the name is unknown; never invent a name.",
			"Field state: active (worktree+session, ready for task), idle (worktree only → bw_open), orphan (session only → close with user confirm + force), missing (neither → bw_open to create).",
			"status (this tool) = state + env. Check pane readiness via the tmux SKILL (Checking pane readiness) before dispatching.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Full branch-workspace name (exact match)." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const name = typeof params.name === "string" ? params.name.trim() : "";
			if (!name) {
				return {
					content: [{ type: "text" as const, text: "bw_status requires a non-empty name." }],
					details: { ok: false, error: "name required" },
				};
			}
			const env = await buildBranchWorkspaceEnv(pi, name);
			return {
				content: [{ type: "text" as const, text: formatStatusText(env) }],
				details: { ok: env.state !== "missing", ...env },
			};
		},
	});
}
