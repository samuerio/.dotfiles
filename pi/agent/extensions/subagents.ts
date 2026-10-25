/**
 * Subagent extension (single file): the `task` / `finder` / `oracle` /
 * `librarian` tools plus the spawn/parse/envelope/render machinery they share.
 *
 * Registers four native pi tools, all backed by the same `Subagent` class:
 *   - `task`      : inline, general-purpose subagent (no specialized persona)
 *   - `finder`    : code-search subagent; child runs with read + bash
 *   - `oracle`    : reasoning-advisor subagent; child runs with read + bash
 *   - `librarian` : external-repository subagent; ships the `librarian` skill
 *
 * Machinery and specs are co-located on purpose: each spec is ~20-40 lines of
 * persona/config, so a separate `lib/subagent.ts` module boundary cost more
 * than it bought. Per-tool selection is unaffected — pi filters tools by name
 * (`-t finder`, `--exclude-tools`), not by which extension registered them.
 *
 * Layout, invariant first: imports → helpers → `Subagent` class → the four
 * specs (the part that actually gets edited) → `default export` wiring.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/**
 * Resolve a subagent role's model routing from the active mode in modes.json
 * (same file the prompt-editor extension manages). Every role is explicitly
 * pinned — `roles.oracle` serves the oracle subagent, `roles.subagents`
 * serves everything else — and a missing/malformed pin is a hard error
 * (fail fast): the dispatch is aborted with an error naming the file and
 * the missing piece. There is no fallback to the spec's baked-in model.
 */
function resolveRoleRouting(cwd: string, specName: string): { model: string; thinking: string } {
	const role = specName === "oracle" ? "oracle" : "subagents";

	// Mirror prompt-editor's path resolution: project `.pi/modes.json` wins
	// over the global `~/.pi/agent/modes.json`.
	const globalPath = path.join(getAgentDir(), "modes.json");
	let modesPath = globalPath;
	try {
		const projectPath = path.join(cwd, ".pi", "modes.json");
		if (fs.statSync(projectPath).isFile()) modesPath = projectPath;
	} catch {
		/* no project override; use the global file */
	}

	let parsed: any;
	try {
		parsed = JSON.parse(fs.readFileSync(modesPath, "utf-8"));
	} catch (err) {
		throw new Error(`modes.json: failed to read/parse ${modesPath}: ${(err as Error).message}`);
	}

	const currentMode = parsed?.currentMode;
	if (typeof currentMode !== "string" || !currentMode) {
		throw new Error(`modes.json: "currentMode" must be a non-empty string in ${modesPath}`);
	}
	const modeSpec = parsed?.modes?.[currentMode];
	if (!modeSpec || typeof modeSpec !== "object") {
		throw new Error(`modes.json: modes["${currentMode}"] is missing in ${modesPath}`);
	}
	const pin = modeSpec.roles?.[role];
	if (!pin || typeof pin !== "object") {
		throw new Error(
			`modes.json: modes["${currentMode}"].roles.${role} is required (subagent "${specName}" dispatches need an explicit pin) in ${modesPath}`,
		);
	}
	for (const field of ["provider", "modelId", "thinkingLevel"] as const) {
		if (typeof pin[field] !== "string" || !pin[field]) {
			throw new Error(
				`modes.json: modes["${currentMode}"].roles.${role}.${field} must be a non-empty string in ${modesPath}`,
			);
		}
	}
	return { model: `${pin.provider}/${pin.modelId}`, thinking: pin.thinkingLevel };
}

const COLLAPSED_ITEM_COUNT = 10;

export interface SubagentSpec {
	/** Tool name; also used for the session subdir and TUI display. */
	name: string;
	systemPrompt: string;
	model?: string;
	thinking?: string;
	/**
	 * Tool allowlist for the child process: `--tools <list>`. Omitted or
	 * empty = the child runs with no tools (`--no-tools`).
	 */
	tools?: string[];
	/**
	 * Explicit skill allowlist for the child process: file/dir paths passed
	 * via `--skill <path>`. Omitted or empty = the child runs with no skills.
	 */
	skills?: string[];
}

/** Model-facing parameters: `prompt` (the child's task) and `description` (short label). */
const SubagentParams = Type.Object({
	prompt: Type.String({
		description: "The task for the agent to perform. Be specific about what needs to be done and include any relevant context.",
	}),
	description: Type.String({
		description: "A very short description of the task that can be displayed to the user.",
	}),
});

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	prompt: string;
	thinking?: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Absolute path to the child's persisted session JSONL, for observability/debugging. */
	sessionFile?: string;
	/** Child session id from the JSON session header. */
	sessionId?: string;
}

type RunOpts = Record<string, never>;

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

type OnUpdateCallback = (partial: AgentToolResult<SingleResult>) => void;

const NON_SUCCESS_STOP_REASONS = new Set(["error", "aborted"]);

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
	thinking?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	if (thinking) parts.push(thinking);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	// cwd-relative when the path lives under the process cwd, otherwise
	// $HOME collapsed to `~`.
	const shortenPath = (p: string) => {
		const resolved = path.resolve(p);
		if (resolved === process.cwd() || resolved.startsWith(process.cwd() + path.sep)) {
			return path.relative(process.cwd(), resolved);
		}
		const home = os.homedir();
		return resolved.startsWith(home) ? `~${resolved.slice(home.length)}` : resolved;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "finder":
		case "oracle":
		case "task": {
			const description = typeof args.description === "string" ? args.description : "...";
			return themeFg("muted", `${toolName} `) + themeFg("toolOutput", description);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || NON_SUCCESS_STOP_REASONS.has(result.stopReason ?? "");
}

/** Single-word status for the model-facing envelope. */
function statusOf(result: SingleResult): string {
	if (result.stopReason === "aborted") return "aborted";
	return isFailedResult(result) ? "failed" : "done";
}

/**
 * The terse, model-facing header line. Carries only what the *tool* uniquely
 * knows (status, model, session, cost). The child's own output is passed
 * through verbatim by the caller — the tool does not impose a payload format.
 */
function buildEnvelope(result: SingleResult): string {
	const parts: string[] = [];
	parts.push(`agent=${result.agent}`);
	parts.push(`status=${statusOf(result)}`);
	if (result.model) parts.push(`model=${result.model}`);
	if (result.thinking) parts.push(`thinking=${result.thinking}`);
	if (result.usage.turns) parts.push(`turns=${result.usage.turns}`);
	if (result.usage.cost) parts.push(`cost=${result.usage.cost.toFixed(4)}`);
	parts.push(`exit=${result.stopReason ?? "end"}`);
	if (result.sessionFile) parts.push(`session=${result.sessionFile}`);
	return `[${parts.join(" ")}]`;
}

/** Envelope header + the child's verbatim output. */
function buildTaskBlock(result: SingleResult): string {
	return `${buildEnvelope(result)}\n${getResultOutput(result)}`;
}
/** Identity color fn: strips theme colors for plain-text contexts (error throw). */
const plainFg = (_color: any, text: string): string => text;

/**
 * Collapsed (non-expanded) text: last N tool-call lines + usage + session path.
 * `themeFg` controls coloring; pass `plainFg` for uncolored plain text.
 */
function buildCollapsedText(
	result: SingleResult,
	themeFg: (color: any, text: string) => string,
): string {
	const displayItems = getDisplayItems(result.messages);
	const toolCalls = displayItems.filter((it) => it.type === "toolCall");
	let text = "";
	const toShow = toolCalls.slice(-COLLAPSED_ITEM_COUNT);
	const skipped = toolCalls.length > COLLAPSED_ITEM_COUNT ? toolCalls.length - COLLAPSED_ITEM_COUNT : 0;
	if (skipped > 0) text += themeFg("muted", `... ${skipped} earlier calls\n`);
	for (const item of toShow) {
		text += `${themeFg("muted", "→ ") + formatToolCall((item as { name: string; args: Record<string, any> }).name, (item as { name: string; args: Record<string, any> }).args, themeFg)}\n`;
	}
	text = text.trimEnd();
	const usageStr = formatUsageStats(result.usage, result.model, result.thinking);
	if (usageStr) text += `${text ? "\n" : ""}${themeFg("dim", usageStr)}`;
	if (result.sessionFile) text += `${text ? "\n" : ""}${themeFg("dim", `session: ${result.sessionFile}`)}`;
	return text;
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

/**
 * A Subagent instance binds a `SubagentSpec` to the spawn/parse/envelope/render
 * machinery. Each of the four specs below is wired to a tool via `registerTool`
 * at extension load; execute and the renderers are private. `run` stays public
 * as the direct execution entry point for callers that are not tool-shaped.
 */
export class Subagent {
	constructor(readonly spec: SubagentSpec) {}

	/**
	 * Register this subagent as a native pi tool under the spec's name, wiring
	 * name/label/parameters and the execute/renderCall/renderResult delegates.
	 * Wiring a tool therefore reduces to a SPEC + DESCRIPTION constant pair plus
	 * `new Subagent(SPEC).registerTool(pi, DESCRIPTION)`.
	 */
	registerTool(pi: ExtensionAPI, description: string): void {
		pi.registerTool({
			name: this.spec.name,
			label: this.spec.name.charAt(0).toUpperCase() + this.spec.name.slice(1),
			description,
			parameters: SubagentParams,
			execute: (id, params, signal, onUpdate, ctx) =>
				this.execute(id, params, signal, onUpdate, ctx),
			renderCall: (args, theme, _context) => this.renderCall(args, theme),
			renderResult: (result, opts, theme, context) =>
				this.renderResult(result, opts, theme, context),
		});
	}

	/**
	 * Spawn an isolated child `pi --mode json -p` process for `prompt`, parse its
	 * JSON event stream, and return a terse envelope + verbatim output. The
	 * child's session is persisted under `sessions/<spec.name>/<runId>/` so
	 * aborted work stays inspectable.
	 */
	async run(
		cwd: string,
		prompt: string,
		signal: AbortSignal | undefined,
		onUpdate: OnUpdateCallback | undefined,
		opts?: RunOpts,
	): Promise<SingleResult> {
		const { spec } = this;
		// Persist the child's session so the main agent can read the full transcript
		// for debugging. This is the observability bridge: a path, not a framework.
		const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const sessionDir = path.join(getAgentDir(), "sessions", spec.name, runId);
		try {
			await fs.promises.mkdir(sessionDir, { recursive: true });
		} catch {
			/* best effort; pi will fall back to its default session dir */
		}

		const args: string[] = ["--mode", "json", "-p", "--session-dir", sessionDir];
		// Model routing goes through the active mode's roles in modes.json (fail
		// fast): every subagent role is explicitly pinned there. The spec's own
		// model/thinking serve only as documentation; dispatch always uses the mode.
		const resolved = resolveRoleRouting(cwd, spec.name);
		args.push("--model", resolved.model);
		args.push("--thinking", resolved.thinking);
		if (spec.tools && spec.tools.length > 0) args.push("--tools", spec.tools.join(","));
		else args.push("--no-tools");
		// Discovery off; `--no-skills` does not suppress explicitly passed
		// `--skill` entries, so the two flags compose into an exact allowlist.
		args.push("--no-skills");
		for (const skillPath of spec.skills ?? []) args.push("--skill", skillPath);

		let tmpPromptDir: string | null = null;
		let tmpPromptPath: string | null = null;

		const currentResult: SingleResult = {
			agent: spec.name,
			prompt,
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: resolved.model,
			thinking: resolved.thinking,
		};

		/** Resolve the child's persisted session JSONL (single file in our run dir). Idempotent. */
		const resolveSessionFile = () => {
			if (currentResult.sessionFile) return;
			try {
				const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
				if (files.length > 0) currentResult.sessionFile = path.join(sessionDir, files[0]);
			} catch {
				/* ignore */
			}
		};

		const emitUpdate = () => {
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
					details: currentResult,
				});
			}
		};

		try {
			if (spec.systemPrompt.trim()) {
				const tmp = await writePromptToTempFile(spec.name, spec.systemPrompt);
				tmpPromptDir = tmp.dir;
				tmpPromptPath = tmp.filePath;
				args.push("--system-prompt", tmpPromptPath);
			}

			args.push(prompt);
			let wasAborted = false;

			const exitCode = await new Promise<number>((resolve) => {
				const invocation = getPiInvocation(args);
				const proc = spawn(invocation.command, invocation.args, {
					cwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let buffer = "";

				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};

				const processLine = (line: string) => {
					if (!line.trim()) return;
					let event: any;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}

					if (event.type === "session" && event.id) {
						currentResult.sessionId = event.id;
						// The child writes its JSONL at session start, so the path is
						// available immediately — surface it live (for the human) and so it
						// is already attached if the run is aborted mid-flight.
						resolveSessionFile();
						emitUpdate();
					}

					if (event.type === "message_end" && event.message) {
						const msg = event.message as Message;
						currentResult.messages.push(msg);

						if (msg.role === "assistant") {
							currentResult.usage.turns++;
							const usage = msg.usage;
							if (usage) {
								currentResult.usage.input += usage.input || 0;
								currentResult.usage.output += usage.output || 0;
								currentResult.usage.cacheRead += usage.cacheRead || 0;
								currentResult.usage.cacheWrite += usage.cacheWrite || 0;
								currentResult.usage.cost += usage.cost?.total || 0;
								currentResult.usage.contextTokens = usage.totalTokens || 0;
							}
							const reportedModel = msg.model as string | undefined;
							if (reportedModel && !currentResult.model) currentResult.model = reportedModel;
							if (msg.stopReason) currentResult.stopReason = msg.stopReason;
							if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
						}
						emitUpdate();
					}

					if (event.type === "tool_result_end" && event.message) {
						currentResult.messages.push(event.message as Message);
						emitUpdate();
					}
				};

				proc.stdout.on("data", (data) => {
					buffer += data.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) processLine(line);
				});

				proc.stderr.on("data", (data) => {
					currentResult.stderr += data.toString();
				});

				proc.on("close", (code) => {
					if (buffer.trim()) processLine(buffer);
					resolve(code ?? 0);
				});

				proc.on("error", () => {
					resolve(1);
				});

				if (signal) {
					const onAbort = () => killProc();
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
			});

			currentResult.exitCode = exitCode;
			// Resolve the persisted session file path (fallback if the start event was missed).
			resolveSessionFile();
			// Abort no longer throws: return the partial result so completed work
			// is never discarded and the session path stays inspectable.
			if (wasAborted) currentResult.stopReason = "aborted";
			return currentResult;
		} finally {
			if (tmpPromptPath)
				try {
					fs.unlinkSync(tmpPromptPath);
				} catch {
					/* ignore */
				}
			if (tmpPromptDir)
				try {
					fs.rmdirSync(tmpPromptDir);
				} catch {
					/* ignore */
				}
		}
	}

	private buildTaskBlock(result: SingleResult): string {
		return buildTaskBlock(result);
	}

	private isFailed(result: SingleResult): boolean {
		return isFailedResult(result);
	}

	/**
	 * Standard tool execute body shared by all subagent tools. Spawns the child
	 * for `params.prompt`, returns the envelope + verbatim output.
	 */
	private async execute(
		_toolCallId: string,
		params: { prompt: string; description: string },
		signal: AbortSignal | undefined,
		onUpdate: OnUpdateCallback | undefined,
		ctx: { cwd: string },
	): Promise<AgentToolResult<SingleResult>> {
		const result = await this.run(ctx.cwd, params.prompt, signal, onUpdate);
		// Signal failure the way pi expects (docs/extensions.md: "Signaling errors"):
		// throw from execute. The harness catches it, sets isError=true on the result,
		// and reports it to the LLM. details are wiped by createErrorToolResult, so the
		// failure reason rides in the thrown Error message instead.
		if (this.isFailed(result)) {
			// Throw plain text: collapsed layout (tool calls + usage + session) with
			// a final `Error:<reason>` line. No theme colors — the harness dyes the
			// whole thrown message in error color regardless.
			const collapsed = buildCollapsedText(result, plainFg);
			const reason = result.stopReason === "aborted" ? "abort" : (result.errorMessage || "unknown");
			throw new Error([collapsed, `Error: ${reason}`].filter(Boolean).join("\n\n"));
		}
		return {
			content: [{ type: "text", text: this.buildTaskBlock(result) }],
			details: result,
		};
	}

	private renderCall(args: Record<string, unknown>, theme: any): Text {
		// Show the model-provided short description inline after the tool name. The
		// full prompt is displayed in renderResult, not here.
		const description = typeof args.description === "string" ? args.description : "...";
		const text = `${theme.fg("toolTitle", theme.bold(this.spec.name))} ${theme.fg("muted", description)}`;
		return new Text(text, 0, 0);
	}

	private renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: unknown },
		{ expanded }: { expanded: boolean },
		theme: any,
		context?: { isError?: boolean },
	): Text | Container {
		// On the throw path, createErrorToolResult wipes details to {}. Guard for
		// that: details may lack the SingleResult fields. Render from content alone.
		const r = result.details as SingleResult | undefined;
		if (!r?.messages) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
			// On the throw path the harness already renders the tool-name header;
			// mirror unified-edit and just dye the content (envelope + child
			// output) in error color, without an extra icon/name row.
			if (context?.isError) return new Text(theme.fg("error", text), 0, 0);
			return new Text(text, 0, 0);
		}

		const mdTheme = getMarkdownTheme();

		// Success path: execute only returns (with details) on success; failures
		// throw and are rendered via the empty-details branch above. Mirror
		// unified-edit: render just the body, no icon/tool-name header (the
		// harness renders the call header).
		const displayItems = getDisplayItems(r.messages);
		const finalOutput = getFinalOutput(r.messages);

		if (expanded) {
			const container = new Container();
			container.addChild(new Text(theme.fg("muted", "─── Prompt ───"), 0, 0));
			container.addChild(new Text(theme.fg("dim", r.prompt), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
			if (displayItems.length === 0 && !finalOutput) {
				container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
			} else {
				for (const item of displayItems) {
					if (item.type === "toolCall")
						container.addChild(
							new Text(
								theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0, 0,
							),
						);
				}
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}
			}
			const usageStr = formatUsageStats(r.usage, r.model, r.thinking);
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
			}
			if (r.sessionFile) container.addChild(new Text(theme.fg("dim", `session: ${r.sessionFile}`), 0, 0));
			return container;
		}

		const text = buildCollapsedText(r, theme.fg.bind(theme));
		return new Text(text, 0, 0);
	}
}

// ─── task ─── inline, general-purpose subagent (no specialized persona) ───

/**
 * Base system prompt for the inline `task` tool (no specialized persona).
 * Replaces the verbose default coding-assistant prompt so the child gets a lean,
 * focused persona. The caller's instructions go into the `prompt`. Mentions
 * `finder` because finder is now a native tool the inline child may whitelist.
 */
const INLINE_BASE_SYSTEM_PROMPT = `You are pi, a powerful AI coding agent.

When invoking the Read tool, ALWAYS use absolute paths.
When reading a file, read the complete file, not specific line ranges.
If you've already used the Read tool to read an entire file, do NOT invoke Read on that file again.

If AGENTS.md exists, treat it as ground truth for commands, style, structure. If you discover a recurring command that's missing, ask to append it there.

For any coding task that involves thoroughly searching or understanding the codebase, use the finder tool to intelligently locate relevant code, functions, or patterns. This helps in understanding existing implementations, locating dependencies, and finding similar code before making changes.`;

/**
 * Inline `task` config, hardcoded like the specialized specs below. Empty
 * `tools`/`skills` mean the child runs without them (`--no-tools`/`--no-skills`).
 */
const TASK_SPEC: SubagentSpec = {
	name: "task",
	systemPrompt: INLINE_BASE_SYSTEM_PROMPT,
	model: "opencode-go/space-bunny",
	thinking: "medium",
	tools: ["write", "edit", "read", "bash", "finder"],
	skills: [],
};

// Declare the child's tool surface to the parent model: the explicit
// allowlist, or an honest "none" instead of a misleading empty tail.
const TASK_TOOLS_DESC =
	TASK_SPEC.tools && TASK_SPEC.tools.length > 0
		? TASK_SPEC.tools.join(", ")
		: "none (it can only reason from the prompt)";
const TASK_DESCRIPTION = `Perform a task (a sub-task of the user's overall task) using a sub-agent that has access to the following tools: ${TASK_TOOLS_DESC}`;

// ─── finder ─── code search; child runs with read + bash ───

const FINDER_DESCRIPTION = `Intelligently search your codebase: Use it for complex, multi-step search tasks where you need to find code based on functionality or concepts rather than exact matches. Anytime you want to chain multiple grep calls you should use this tool.

**WHEN TO USE THIS TOOL:**

* You must locate code by behavior or concept
* You need to run multiple greps in sequence
* You must correlate or look for connection between several areas of the codebase.
* You must filter broad terms ("config", "logger", "cache") by context.
* You need answers to questions such as "Where do we validate JWT authentication headers?" or "Which module handles file-watcher retry logic"

**WHEN NOT TO USE THIS TOOL:**

* When you know the exact file path - use Read directly
* When looking for specific symbols or exact strings - use glob or Grep
* When you need to create, modify files, or run terminal commands

**USAGE GUIDELINES:**

1. Always spawn multiple finder agents in parallel to maximise speed, with a maximum of 3 concurrent agents.
2. Formulate your query as a precise engineering request.
   ✓ "Find every place we build an HTTP error response."
   ✗ "error handling search"
3. Name concrete artefacts, patterns, or APIs to narrow scope (e.g., "Express middleware", "fs.watch debounce").
4. State explicit success criteria so the agent knows when to stop (e.g., "Return file paths and line numbers for all JWT verification calls").
5. Never issue vague or exploratory commands - be definitive and goal-oriented.`;

const FINDER_SPEC: SubagentSpec = {
	name: "finder",
	systemPrompt: `You are a fast, parallel code search agent.

## Task
Find files and line ranges relevant to the user's query (provided in the first message).

## Execution Strategy
- Search through the codebase with the tools that are available to you.
- Your goal is to return a list of relevant filenames with ranges. Your goal is NOT to explore the complete codebase to construct an essay of an answer.
- **Maximize parallelism**: On EVERY turn, make **8+ parallel tool calls** with diverse, scoped search strategies using the tools available to you.
- **Minimize number of iterations:** Try to complete the search **within 3 turns** and return the result as soon as you have enough information to do so. Do not continue to search if you have found enough results.
- **Prioritize source code**: Always prefer source code files (.ts, .js, .py, .go, .rs, .java, etc.) over documentation (.md, .txt, README).
- **Be exhaustive when completeness is implied**: When the query asks for "all", "every", "each", or implies a complete list (e.g., call sites, usages, implementations), find ALL occurrences, not just the first match. Search breadth-first across the codebase.
- **Scope filename globs aggressively**: Prefer directory-scoped patterns such as \`core/**/*watchdog*\` over root-wide patterns like \`**/*watchdog*\`, which still require traversing most of the workspace.
- **Avoid repeated repo-wide filename scans**: Do not spend parallel calls on multiple broad root-level \`glob\` searches; prefer \`grep\` first or narrow to likely directories.
- \`rg\` is available through the \`bash\` tool and should be preferred for fast text search.

## Output format
- **Ultra concise**: Write a very brief and concise summary (maximum 1-2 lines) of your search findings and then output the relevant files as markdown links.
- Format each file as a markdown link with a file:// URI: [relativePath#L{start}-L{end}](file://{absolutePath}#L{start}-L{end})
- **Line ranges**: Include line ranges (#L{start}-L{end}) when you can identify specific relevant sections, especially for large files. For small files or when the entire file is relevant, the range can be omitted.
- **Use generous ranges**: When including ranges, extend them to capture complete logical units (full functions, classes, or blocks). Add 5-10 lines of buffer above and below the match to ensure context is included.

### Example (assuming workspace root is /Users/alice/project):
User: Find how JWT authentication works in the codebase.
Response: JWT tokens are created in the auth middleware, validated via the token service, and user sessions are stored in Redis.

Relevant files:
- [src/middleware/auth.ts#L45-L82](file:///Users/alice/project/src/middleware/auth.ts#L45-L82)
- [src/services/token-service.ts#L12-L58](file:///Users/alice/project/src/services/token-service.ts#L12-L58)
- [src/cache/redis-session.ts#L23-L41](file:///Users/alice/project/src/cache/redis-session.ts#L23-L41)
- [src/types/auth.d.ts#L1-L15](file:///Users/alice/project/src/types/auth.d.ts#L1-L15)`,
	model: "opencode-go/deepseek-v4-flash",
	thinking: "medium",
	tools: ["read", "bash"],
	skills: [],
};

// ─── oracle ─── reasoning advisor; child runs with read + bash ───

const ORACLE_DESCRIPTION = `Consult the Oracle - an AI advisor powered by OpenAI's GPT-5 reasoning model that can plan, review, and provide expert guidance.

The Oracle has access to the following tools: Read, Grep, glob, web_search, read_web_page, read_thread.

The Oracle acts as your senior engineering advisor and can help with:

**WHEN TO USE THE ORACLE:**

* Code reviews and architecture feedback
* Finding a bug in multiple files
* Planning complex implementations or refactoring
* Analyzing code quality and suggesting improvements
* Answering complex technical questions that require deep reasoning

**WHEN NOT TO USE THE ORACLE:**

* Simple file reading or searching tasks (use Read or Grep directly)
* Codebase searches (use finder)
* Web browsing and searching (use read_web_page or web_search)
* Basic code modifications and when you need to execute code changes (do it yourself or use Task)

**USAGE GUIDELINES:**

1. Be specific about what you want the Oracle to review, plan, or debug
2. Provide relevant context about what you're trying to achieve. If you know that 3 files are involved, list them and they will be attached.`;

const ORACLE_SPEC: SubagentSpec = {
	name: "oracle",
	systemPrompt: `You are the Oracle - an expert AI advisor with advanced reasoning capabilities.

Your role is to provide high-quality technical guidance, code reviews, architectural advice, and strategic planning for software engineering tasks.

You are a subagent inside an AI coding system, called when the main agent needs a smarter, more capable model. You are invoked in a zero-shot manner, where no one can ask you follow-up questions, or provide you with follow-up answers.

Key responsibilities:
- Analyze code and architecture patterns
- Provide specific, actionable technical recommendations
- Plan implementations and refactoring strategies
- Answer deep technical questions with clear reasoning
- Suggest best practices and improvements
- Identify potential issues and propose solutions

Operating principles (simplicity-first):
- Default to the simplest viable solution that meets the stated requirements and constraints.
- Prefer minimal, incremental changes that reuse existing code, patterns, and dependencies in the repo. Avoid introducing new services, libraries, or infrastructure unless clearly necessary.
- Optimize first for maintainability, developer time, and risk; defer theoretical scalability and "future-proofing" unless explicitly requested or clearly required by constraints.
- Apply YAGNI and KISS; avoid premature optimization.
- Provide one primary recommendation. Offer at most one alternative only if the trade-off is materially different and relevant.
- Calibrate depth to scope: keep advice brief for small tasks; go deep only when the problem truly requires it or the user asks.
- Include a rough effort/scope signal (e.g., S <1h, M 1–3h, L 1–2d, XL >2d) when proposing changes.
- Stop when the solution is "good enough." Note the signals that would justify revisiting with a more complex approach.

Tool usage:
- Use attached files and provided context first. Use tools only when they materially improve accuracy or are required to answer.
- Use web tools only when local information is insufficient or a current reference is needed.
- When calling local file tools, resolve repo-relative paths against the current working directory.
- Never invent placeholder roots like /workspace, /repo, or /project.
- If you only know a repo-relative path, resolve it from the current working directory before calling local file tools.
- If the working directory is unknown, use file-search tools first instead of guessing absolute paths.

Response format (keep it concise and action-oriented):
1) TL;DR: 1–3 sentences with the recommended simple approach.
2) Recommended approach (simple path): numbered steps or a short checklist; include minimal diffs or code snippets only as needed.
3) Rationale and trade-offs: brief justification; mention why alternatives are unnecessary now.
4) Risks and guardrails: key caveats and how to mitigate them.
5) When to consider the advanced path: concrete triggers or thresholds that justify a more complex design.
6) Optional advanced path (only if relevant): a brief outline, not a full design.

Guidelines:
- Use your reasoning to provide thoughtful, well-structured, and pragmatic advice.
- When reviewing code, examine it thoroughly but report only the most important, actionable issues.
- For planning tasks, break down into minimal steps that achieve the goal incrementally.
- Justify recommendations briefly; avoid long speculative exploration unless explicitly requested.
- Consider alternatives and trade-offs, but limit them per the simplicity-first principles above.
- Be thorough but concise - focus on the highest-leverage insights.

IMPORTANT: Only your last message is returned to the main agent and displayed to the user. Your last message should be comprehensive yet focused, with a clear, simple recommendation that helps the user act immediately.`,
	model: "opencode-go/hy4-preview",
	thinking: "high",
	tools: ["read", "bash"],
	skills: [],
};

// ─── librarian ─── external repositories; ships the `librarian` skill ───

// The only subagent with a resource dir: the `librarian` skill lives next to
// this file under `librarian/skills/librarian`, resolved at module load and
// passed to the child as an explicit `--skill <path>` allowlist entry. This
// file must stay directly under `extensions/` for that path to hold.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIBRARIAN_SKILL_DIR = path.join(__dirname, "librarian", "skills", "librarian");

const LIBRARIAN_DESCRIPTION = `The Librarian is a codebase-understanding subagent for repositories outside the local workspace.

It can read git repositories in two ways: an existing local checkout or a remote repository (any git repository your git credentials can access: GitHub, GitLab, Bitbucket, or plain URLs).

Use this when you need deep understanding of existing code across one or more repositories:
- explaining architecture, flows, or subsystem design
- finding where a feature is implemented in an external codebase
- comparing patterns across repositories
- understanding how code evolved through commit history
- reading or diffing files in a remote repository

Do not use this for:
- local workspace reads or searches
- code modifications or implementations
- simple local lookups when a direct local tool is enough
- questions unrelated to understanding existing repositories

Guidance:
- name the repository or project when you know it
- ask a specific question or describe the feature or codepath you want understood
- include context about what you are trying to achieve
- for a repository already checked out locally, pass its absolute path so it reads that copy instead of re-cloning
- expect a thorough answer suitable for sharing
- return the answer in full rather than summarizing it

Examples:
- "How does authentication work in the Kubernetes codebase?"
- "Explain the architecture of the React rendering system"
- "Compare how different web frameworks handle routing"
- "What changed in commit abc123 in my private repository?"
- "Read the README from the main API repo"`;

const LIBRARIAN_SPEC: SubagentSpec = {
	name: "librarian",
	systemPrompt: `You are the Librarian, a specialized codebase understanding agent that helps users answer questions about large, complex codebases across repositories.

Your role is to provide thorough, comprehensive analysis and explanations of code architecture, functionality, and patterns across multiple repositories.

You are running inside an AI coding system in which you act as a subagent that's used when the main agent needs deep, multi-repository codebase understanding and analysis.

Key responsibilities:
- Explore repositories to answer questions
- Understand and explain architectural patterns and relationships across repositories
- Find specific implementations and trace code flow across codebases
- Explain how features work end-to-end across multiple repositories
- Understand code evolution through commit history
- Create visual diagrams when helpful for understanding complex systems

Guidelines:
- Use available tools extensively to explore repositories
- Execute tools in parallel when possible for efficiency
- Read files thoroughly to understand implementation details
- Search for patterns and related code across multiple repositories
- Use git log to understand how code evolved over time
- Focus on thorough understanding and comprehensive explanation across repositories
- Create mermaid diagrams to visualize complex relationships or flows

## Repository access

You can work with two kinds of repositories:

1. An existing local checkout. If the caller provides a path to a repository
   already on disk, treat it as read-only and analyze it in place; do not
   re-clone it or involve the shared cache.
2. A remote repository. You do NOT have remote repository APIs: resolve it
   through the \`librarian\` skill. It caches a reusable checkout under
   ~/.cache/checkouts/<host>/<org>/<repo> via its checkout.sh command,
   refreshing it when stale. Treat every cached checkout as read-only: never
   commit or edit inside the shared cache.

Once you have the checkout path, use your file tools and bash (rg, git, ls) on
it like any local codebase. Use \`git log\` inside the checkout for history
questions.

## Tool usage guidelines
You should use all available tools to thoroughly explore the codebase before answering.
Use tools in parallel whenever possible for efficiency.

## Communication
You must use Markdown for formatting your responses.

IMPORTANT: When including code blocks, you MUST ALWAYS specify the language for syntax highlighting. Always add the language identifier after the opening backticks.

NEVER refer to tools by their names. Example: NEVER say "I can use the read tool", instead say "I'm going to read the file"

### Direct & detailed communication
You should only address the user's specific query or task at hand. Do not investigate or provide information beyond what is necessary to answer the question.

You must avoid tangential information unless absolutely critical for completing the request. Avoid long introductions, explanations, and summaries. Avoid unnecessary preamble or postamble, unless the user asks you to.

Answer the user's question directly, without elaboration, explanation, or details. You MUST avoid text before/after your response, such as "The answer is <answer>.", "Here is the content of the file..." or "Based on the information provided, the answer is..." or "Here is what I will do next...".

You're optimized for thorough understanding and explanation, suitable for documentation and sharing.

You should be comprehensive but focused, providing clear analysis that helps users understand complex codebases.

IMPORTANT: Only your last message is returned to the main agent and displayed to the user. Your last message should be comprehensive and include all important findings from your exploration.

Prefer "fluent" linking style. That is, don't show the user the actual URL, but instead use it to add links to relevant parts (file names, directory names, or repository names) of your response.
Whenever you mention a file, directory or repository by name, you MUST link to it in this way, and the link must point into the local checkout, NOT the web.
ONLY link if the mention is by name.

Linking:
- Link files as \`file://<absolutePath>#L<start>-L<end>\`

Example:
file:///home/alice/.cache/checkouts/github.com/foo_org/bar_repo/src/test.py#L32-L42`,
	model: "opencode-go/deepseek-v4-flash",
	thinking: "medium",
	tools: ["read", "bash"],
	skills: [LIBRARIAN_SKILL_DIR],
};

export default function (pi: ExtensionAPI) {
	new Subagent(TASK_SPEC).registerTool(pi, TASK_DESCRIPTION);
	new Subagent(FINDER_SPEC).registerTool(pi, FINDER_DESCRIPTION);
	new Subagent(ORACLE_SPEC).registerTool(pi, ORACLE_DESCRIPTION);
	new Subagent(LIBRARIAN_SPEC).registerTool(pi, LIBRARIAN_DESCRIPTION);
}
