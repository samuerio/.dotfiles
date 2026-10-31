import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildSessionContext,
	convertToLlm,
	createAgentSession,
	createExtensionRuntime,
	getMarkdownTheme,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { type AssistantMessage, type Message, type ThinkingLevel as AiThinkingLevel } from "@earendil-works/pi-ai";
import {
	Container,
	Input,
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Focusable,
	type KeybindingsManager,
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";

/** Fork files for side sessions land here and are deleted on side-session dispose. */
const SIDE_SESSION_DIR = join(tmpdir(), "pi-btw-side");
// Created owner-only upfront: forkFrom reuses an existing directory, so fork
// files stay unreadable to other local users on shared hosts.
mkdirSync(SIDE_SESSION_DIR, { recursive: true, mode: 0o700 });
const BTW_ENTRY_TYPE = "btw-thread-entry";
const BTW_RESET_TYPE = "btw-thread-reset";

const BTW_SYSTEM_PROMPT = [
	"You are BTW, a side-channel assistant embedded in the user's coding agent.",
	"You have access to the main conversation context — use it to give informed answers.",
	"Help with focused questions, planning, and quick explorations.",
	"Be direct and practical.",
].join(" ");

const BTW_SUMMARY_PROMPT =
	"Summarize this side conversation for handoff into the main conversation. Keep key decisions, findings, risks, and next actions. Output only the summary.";

type SessionThinkingLevel = "off" | AiThinkingLevel;

type BtwDetails = {
	question: string;
	answer: string;
	timestamp: number;
	provider: string;
	model: string;
	thinkingLevel: SessionThinkingLevel;
	usage?: AssistantMessage["usage"];
};

type BtwResetDetails = {
	timestamp: number;
};

type OverlayRuntime = {
	handle?: OverlayHandle;
	refresh?: () => void;
	close?: () => void;
	finish?: () => void;
	setDraft?: (value: string) => void;
	closed?: boolean;
};

type SideSessionRuntime = {
	session: AgentSession;
	/** File-backed fork source for cleanup; undefined for in-memory fallback sessions. */
	sideFile?: string;
	unsubscribe: () => void;
	/** Main content leaf (non-custom branch tail) the side session's main context covers. */
	contentLeafId: string | null;
};

type ToolCallInfo = {
	toolCallId: string;
	toolName: string;
	args: string;
	status: "running" | "done" | "error";
};

function stripDynamicSystemPromptFooter(systemPrompt: string): string {
	return systemPrompt
		.replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
		.replace(/\nCurrent working directory:[^\n]*$/u, "")
		.trim();
}

function createBtwResourceLoader(ctx: ExtensionContext, appendSystemPrompt: string[] = [BTW_SYSTEM_PROMPT]): ResourceLoader {
	const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());

	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => appendSystemPrompt,
		extendResources: () => {},
		reload: async () => {},
	};
}

function extractText(parts: AssistantMessage["content"]): string {
	return parts
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function extractEventAssistantText(message: unknown): string {
	if (!message || typeof message !== "object") {
		return "";
	}

	const maybeMessage = message as { role?: unknown; content?: unknown };
	if (maybeMessage.role !== "assistant" || !Array.isArray(maybeMessage.content)) {
		return "";
	}

	return maybeMessage.content
		.filter((part): part is { type: "text"; text: string } => {
			return !!part && typeof part === "object" && (part as { type?: unknown }).type === "text";
		})
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
	for (let i = session.state.messages.length - 1; i >= 0; i--) {
		const message = session.state.messages[i];
		if (message.role === "assistant") {
			return message as AssistantMessage;
		}
	}

	return null;
}

/**
 * Replays the BTW Q&A history as seed messages. Main-conversation context comes
 * from the session manager itself; the BTW entries are custom entries, which the
 * session projection skips, so they have to be appended explicitly.
 */
function buildThreadSeedMessages(ctx: ExtensionContext, thread: BtwDetails[]): Message[] {
	const seed: Message[] = [];
	for (const item of thread) {
		seed.push(
			{
				role: "user",
				content: [{ type: "text", text: item.question }],
				timestamp: item.timestamp,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: item.answer }],
				provider: item.provider,
				model: item.model,
				api: ctx.model?.api ?? "openai-responses",
				usage:
					item.usage ??
					{
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				stopReason: "stop",
				timestamp: item.timestamp,
			},
		);
	}
	return seed;
}

function formatThread(thread: BtwDetails[]): string {
	return thread
		.map((item) => `User: ${item.question.trim()}\nAssistant: ${item.answer.trim()}`)
		.join("\n\n---\n\n");
}

function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}


class BtwOverlay extends Container implements Focusable {
	private readonly input: Input;
	private readonly tui: TUI;
	private readonly theme: ExtensionContext["ui"]["theme"];
	private readonly keybindings: KeybindingsManager;
	private readonly getTranscript: (width: number, theme: ExtensionContext["ui"]["theme"]) => string[];
	private readonly getStatus: () => string;
	private readonly onSubmitCallback: (value: string) => void;
	private readonly onDismissCallback: () => void;
	private _focused = false;
	private scrollOffset = 0;
	private followTail = true;
	private lastTotal = 0;
	private lastHeight = 6;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		theme: ExtensionContext["ui"]["theme"],
		keybindings: KeybindingsManager,
		getTranscript: (width: number, theme: ExtensionContext["ui"]["theme"]) => string[],
		getStatus: () => string,
		onSubmit: (value: string) => void,
		onDismiss: () => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.getTranscript = getTranscript;
		this.getStatus = getStatus;
		this.onSubmitCallback = onSubmit;
		this.onDismissCallback = onDismiss;

		this.input = new Input();
		this.input.onSubmit = (value) => {
			// A new question pins the view back to the latest messages.
			this.followTail = true;
			this.scrollOffset = 0;
			this.onSubmitCallback(value);
		};
		this.input.onEscape = () => {
			this.onDismissCallback();
		};
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onDismissCallback();
			return;
		}

		if (matchesKey(data, Key.ctrl("u"))) {
			this.pageBy(-1);
			return;
		}
		if (matchesKey(data, Key.ctrl("d"))) {
			this.pageBy(1);
			return;
		}
		this.input.handleInput(data);
	}

	setDraft(value: string): void {
		this.input.setValue(value);
		this.tui.requestRender();
	}

	getDraft(): string {
		return this.input.getValue();
	}

	private pageBy(direction: 1 | -1): void {
		const halfPage = Math.max(1, Math.floor(this.lastHeight / 2));
		const maxScroll = Math.max(0, this.lastTotal - this.lastHeight);
		const next = this.scrollOffset + direction * halfPage;
		if (direction > 0 && next >= maxScroll) {
			// Scrolled back to the bottom: resume tail-following.
			this.followTail = true;
			this.scrollOffset = maxScroll;
		} else if (next <= 0) {
			this.followTail = false;
			this.scrollOffset = 0;
		} else {
			this.followTail = false;
			this.scrollOffset = next;
		}
		this.tui.requestRender();
	}

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${this.theme.fg("borderMuted", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("borderMuted", "│")}`;
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
		const left = edge === "top" ? "┌" : "└";
		const right = edge === "top" ? "┐" : "┘";
		return this.theme.fg("borderMuted", `${left}${"─".repeat(innerWidth)}${right}`);
	}

	override render(width: number): string[] {
		const dialogWidth = Math.max(56, Math.min(width, Math.floor(width * 0.9)));
		const innerWidth = Math.max(40, dialogWidth - 2);
		const terminalRows = process.stdout.rows ?? 30;
		const dialogHeight = Math.max(16, Math.min(30, Math.floor(terminalRows * 0.75)));
		const chromeHeight = 7;
		const transcriptHeight = Math.max(6, dialogHeight - chromeHeight);

		// Markdown renders to innerWidth already — no manual wrapping needed
		const transcript = this.getTranscript(innerWidth, this.theme);
		this.lastTotal = transcript.length;
		this.lastHeight = transcriptHeight;
		const maxScroll = Math.max(0, transcript.length - transcriptHeight);
		if (this.followTail) {
			this.scrollOffset = maxScroll;
		} else {
			this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
		}
		const visibleTranscript = transcript.slice(this.scrollOffset, this.scrollOffset + transcriptHeight);
		const transcriptPadding = Math.max(0, transcriptHeight - visibleTranscript.length);

		const status = this.getStatus();

		const previousFocused = this.input.focused;
		this.input.focused = false;
		const inputLine = this.input.render(innerWidth)[0] ?? "";
		this.input.focused = previousFocused;

		const lines = [
			this.borderLine(innerWidth, "top"),
			this.frameLine(this.theme.fg("accent", this.theme.bold(" BTW side chat ")), innerWidth),
			this.frameLine(this.theme.fg("dim", "Separate side conversation. Esc closes."), innerWidth),
			this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`),
		];

		for (const line of visibleTranscript) {
			lines.push(this.frameLine(line, innerWidth));
		}
		for (let i = 0; i < transcriptPadding; i++) {
			lines.push(this.frameLine("", innerWidth));
		}

		lines.push(this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`));
		lines.push(this.frameLine(this.theme.fg("warning", status), innerWidth));
		lines.push(
			`${this.theme.fg("borderMuted", "│")}${inputLine}${this.theme.fg("borderMuted", "│")}`,
		);
		const hint = this.followTail
			? "Enter submit · Esc close"
			: "Enter submit · Esc close · ctrl+d back to latest";
		lines.push(this.frameLine(this.theme.fg("dim", hint), innerWidth));
		lines.push(this.borderLine(innerWidth, "bottom"));

		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	let thread: BtwDetails[] = [];
	let pendingQuestion: string | null = null;
	let pendingAnswer = "";
	let pendingError: string | null = null;
	let pendingToolCalls: ToolCallInfo[] = [];
	let sideBusy = false;
	let overlayStatus = "Ready";
	let overlayDraft = "";
	let overlayRuntime: OverlayRuntime | null = null;
	let activeSideSession: SideSessionRuntime | null = null;
	let overlayRefreshTimer: ReturnType<typeof setTimeout> | null = null;

	const mdTheme = getMarkdownTheme();

	function renderMarkdownLines(text: string, width: number): string[] {
		if (!text) return [];
		try {
			const md = new Markdown(text, 0, 0, mdTheme);
			return md.render(width);
		} catch {
			// Fall back to plain text wrapping if Markdown rendering fails
			return text.split("\n").flatMap((line) => {
				if (!line) return [""];
				const wrapped: string[] = [];
				for (let i = 0; i < line.length; i += width) {
					wrapped.push(line.slice(i, i + width));
				}
				return wrapped.length > 0 ? wrapped : [""];
			});
		}
	}

	function formatToolArgs(toolName: string, args: unknown): string {
		if (!args || typeof args !== "object") return "";
		const a = args as Record<string, unknown>;
		switch (toolName) {
			case "bash":
				return typeof a.command === "string" ? truncateToWidth(a.command.split("\n")[0], 50, "…") : "";
			case "read":
			case "write":
			case "edit":
				return typeof a.path === "string" ? a.path : "";
			default: {
				const first = Object.values(a)[0];
				return typeof first === "string" ? truncateToWidth(first.split("\n")[0], 40, "…") : "";
			}
		}
	}

	function renderToolCallLines(toolCalls: ToolCallInfo[], theme: ExtensionContext["ui"]["theme"], width: number): string[] {
		const lines: string[] = [];
		for (const tc of toolCalls) {
			const icon = tc.status === "running" ? "⚙" : tc.status === "error" ? "✗" : "✓";
			const color = tc.status === "error" ? "error" : tc.status === "done" ? "success" : "dim";
			const label = theme.fg(color, `${icon} `) + theme.fg("toolTitle", tc.toolName);
			const argsText = tc.args ? theme.fg("dim", ` ${tc.args}`) : "";
			lines.push(truncateToWidth(`  ${label}${argsText}`, width, ""));
		}
		return lines;
	}

	function getTranscriptLines(width: number, theme: ExtensionContext["ui"]["theme"]): string[] {
		try {
			return getTranscriptLinesInner(width, theme);
		} catch (error) {
			return [theme.fg("error", `Render error: ${error instanceof Error ? error.message : String(error)}`)];
		}
	}

	function getTranscriptLinesInner(width: number, theme: ExtensionContext["ui"]["theme"]): string[] {
		if (thread.length === 0 && !pendingQuestion && !pendingAnswer && !pendingError) {
			return [theme.fg("dim", "No BTW messages yet. Type a question below.")];
		}

		const lines: string[] = [];
		for (const item of thread) {
			// User message
			const userText = item.question.trim().split("\n")[0];
			lines.push(theme.fg("accent", theme.bold("You: ")) + truncateToWidth(userText, width - 5, "…"));
			lines.push("");

			// Assistant message rendered as markdown
			const mdLines = renderMarkdownLines(item.answer, width);
			lines.push(...mdLines);
			lines.push("");
		}

		if (pendingQuestion) {
			const userText = pendingQuestion.trim().split("\n")[0];
			lines.push(theme.fg("accent", theme.bold("You: ")) + truncateToWidth(userText, width - 5, "…"));

			// Show tool calls inline
			if (pendingToolCalls.length > 0) {
				lines.push(...renderToolCallLines(pendingToolCalls, theme, width));
			}

			if (pendingError) {
				lines.push(theme.fg("error", `❌ ${pendingError}`));
			} else if (pendingAnswer) {
				lines.push("");
				const mdLines = renderMarkdownLines(pendingAnswer, width);
				lines.push(...mdLines);
			} else if (pendingToolCalls.length === 0) {
				lines.push(theme.fg("dim", "…"));
			}
		}

		// Trim trailing empty line
		while (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}
		return lines;
	}

	function syncOverlay(): void {
		overlayRuntime?.refresh?.();
	}

	function scheduleOverlayRefresh(): void {
		if (overlayRefreshTimer) {
			return;
		}

		overlayRefreshTimer = setTimeout(() => {
			overlayRefreshTimer = null;
			syncOverlay();
		}, 16);
	}

	function setOverlayStatus(status: string, throttled = false): void {
		overlayStatus = status;
		if (throttled) {
			scheduleOverlayRefresh();
		} else {
			syncOverlay();
		}
	}

	function dismissOverlay(): void {
		overlayRuntime?.close?.();
		overlayRuntime = null;
		if (overlayRefreshTimer) {
			clearTimeout(overlayRefreshTimer);
			overlayRefreshTimer = null;
		}
	}

	function setOverlayDraft(value: string): void {
		overlayDraft = value;
		overlayRuntime?.setDraft?.(value);
	}

	async function disposeSideSession(): Promise<void> {
		const current = activeSideSession;
		activeSideSession = null;
		if (!current) {
			return;
		}

		try {
			current.unsubscribe();
		} catch {
			// Ignore unsubscribe errors during cleanup.
		}

		try {
			await current.session.abort();
		} catch {
			// Ignore abort errors during cleanup.
		}
		current.session.dispose();

		if (current.sideFile) {
			try {
				rmSync(current.sideFile, { force: true });
			} catch {
				// Ignore fork-file cleanup errors (tmpdir, best effort).
			}
		}

		if (overlayRefreshTimer) {
			clearTimeout(overlayRefreshTimer);
			overlayRefreshTimer = null;
		}
	}

	async function resetThread(ctx: ExtensionContext | ExtensionCommandContext, persist = true): Promise<void> {
		thread = [];
		pendingQuestion = null;
		pendingAnswer = "";
		pendingError = null;
		pendingToolCalls = [];
		sideBusy = false;
		setOverlayDraft("");
		setOverlayStatus("Ready");
		await disposeSideSession();
		if (persist) {
			const details: BtwResetDetails = { timestamp: Date.now() };
			pi.appendEntry(BTW_RESET_TYPE, details);
		}
		syncOverlay();
	}

	async function restoreThread(ctx: ExtensionContext): Promise<void> {
		await disposeSideSession();
		thread = [];
		pendingQuestion = null;
		pendingAnswer = "";
		pendingError = null;
		pendingToolCalls = [];
		sideBusy = false;
		overlayStatus = "Ready";
		overlayDraft = "";
		const branch = ctx.sessionManager.getBranch();
		let lastResetIndex = -1;
		for (let i = 0; i < branch.length; i++) {
			const entry = branch[i];
			if (entry.type === "custom" && entry.customType === BTW_RESET_TYPE) {
				lastResetIndex = i;
			}
		}

		for (const entry of branch.slice(lastResetIndex + 1)) {
			if (entry.type !== "custom" || entry.customType !== BTW_ENTRY_TYPE) {
				continue;
			}
			const details = entry.data as BtwDetails | undefined;
			if (!details?.question || !details.answer) {
				continue;
			}
			thread.push(details);
		}

		syncOverlay();
	}

	/**
	 * Forked snapshot: every (re)creation forks a fresh copy of the main session,
	 * so the side LLM sees the main conversation exactly as its own model would,
	 * including the latest compaction. Staleness is tracked in ensureSideSession,
	 * which recreates whenever the main content leaf moves.
	 */
	function buildForkedSessionManager(ctx: ExtensionContext): SessionManager {
		const sourcePath = ctx.sessionManager.getSessionFile();
		if (!sourcePath) {
			throw new Error("main session is not file-backed");
		}
		const forked = SessionManager.forkFrom(sourcePath, ctx.sessionManager.getCwd(), SIDE_SESSION_DIR);
		// forkFrom's leaf is the source file's tail; align it with the main session's
		// current leaf (entry ids survive the verbatim copy, so branch() by the main
		// leaf id works). An empty main session has a null leaf and keeps the tail.
		const mainLeafId = ctx.sessionManager.getLeafId();
		if (mainLeafId) {
			forked.branch(mainLeafId);
		}
		return forked;
	}

	/**
	 * Fallback for when forking is impossible (non-file-backed main session or a
	 * forkFrom failure): an in-memory session manager seeded from the main branch's
	 * projection. convertToLlm turns compaction/branch-summary/custom roles into
	 * plain messages, since appendMessage forbids writing entry-only roles.
	 */
	function buildInMemorySessionManager(ctx: ExtensionContext): SessionManager {
		const fallback = SessionManager.inMemory(ctx.sessionManager.getCwd());
		try {
			const contextMessages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
			for (const message of convertToLlm(contextMessages)) {
				fallback.appendMessage(message);
			}
		} catch (error) {
			// Surface context seed failures; continue with the BTW thread only (no main context).
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `BTW: main context seed failed: ${message}`, "warning");
		}
		return fallback;

	}

	async function createSideSession(ctx: ExtensionCommandContext, contentLeafId: string | null): Promise<SideSessionRuntime | null> {
		if (!ctx.model) {
			return null;
		}

		let sessionManager: SessionManager;
		let sideFile: string | undefined;
		try {
			sessionManager = buildForkedSessionManager(ctx);
			sideFile = sessionManager.getSessionFile();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`BTW: main session fork failed (${message}); falling back to in-memory seed.`);
			sessionManager = buildInMemorySessionManager(ctx);
		}

		try {
			const { session } = await createAgentSession({
				sessionManager,
				model: ctx.model,
				modelRegistry: ctx.modelRegistry as AgentSession["modelRegistry"],
				thinkingLevel: pi.getThinkingLevel() as SessionThinkingLevel,
				tools: ["read", "bash", "edit", "write"],
				resourceLoader: createBtwResourceLoader(ctx),
			});

			// Seed via the session manager: AgentSession's prepareRequest hook rebuilds
			// context from the session manager's projection, so plain
			// agent.state.messages assignment would be discarded at request time.
			for (const message of buildThreadSeedMessages(ctx, thread)) {
				sessionManager.appendMessage(message);
			}

			const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
				if (!sideBusy || !pendingQuestion) {
					return;
				}

				switch (event.type) {
					case "message_start":
					case "message_update":
					case "message_end": {
						const streamed = extractEventAssistantText(event.message);
						if (streamed) {
							pendingAnswer = streamed;
							pendingError = null;
						}
						setOverlayStatus(event.type === "message_end" ? "Finalizing side response..." : "Streaming side response...", true);
						return;
					}
					case "tool_execution_start": {
						const toolName = (event as { toolName?: string }).toolName ?? "unknown";
						try {
							pendingToolCalls.push({
								toolCallId: (event as { toolCallId?: string }).toolCallId ?? "",
								toolName,
								args: formatToolArgs(toolName, (event as { args?: unknown }).args),
								status: "running",
							});
						} catch {
							// Ignore tool tracking failures
						}
						setOverlayStatus(`Running tool: ${toolName}...`, true);
						return;
					}
					case "tool_execution_end": {
						const endToolName = (event as { toolName?: string }).toolName ?? "unknown";
						const tc = pendingToolCalls.find(
							(t) => t.toolName === endToolName && t.status === "running",
						);
						if (tc) {
							tc.status = (event as { isError?: boolean }).isError ? "error" : "done";
						}
						setOverlayStatus("Streaming side response...", true);
						return;
					}
					case "turn_end": {
						setOverlayStatus("Finalizing side response...", true);
						return;
					}
					default:
						return;
				}
			});

			return {
				session,
				sideFile,
				unsubscribe,
				contentLeafId,
			};
		} catch (error) {
			// forkFrom copies the transcript eagerly; drop the file when session
			// creation or seeding fails so no transcript copy outlives this attempt.
			if (sideFile) {
				try {
					rmSync(sideFile, { force: true });
				} catch {
					// Best-effort tmpdir cleanup.
				}
			}
			throw error;
		}
	}

	/**
	 * The side LLM's view of the main conversation ends at the newest non-custom
	 * branch entry: custom entries (BTW thread entries, resets) are skipped by the
	 * session projection, so they do not count as content. That id is the
	 * snapshot key for side-session reuse.
	 */
	function getMainContentLeafId(ctx: ExtensionCommandContext): string | null {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			if (branch[i].type !== "custom") {
				return branch[i].id;
			}
		}
		return null;
	}

	/**
	 * Snapshot-cached: the side session is recreated only when the main
	 * conversation's content moved, so a follow-up within one snapshot reuses the
	 * side session and keeps its tool results.
	 */
	async function ensureSideSession(ctx: ExtensionCommandContext): Promise<SideSessionRuntime | null> {
		if (!ctx.model) {
			return null;
		}

		const contentLeafId = getMainContentLeafId(ctx);
		if (activeSideSession && activeSideSession.contentLeafId === contentLeafId) {
			return activeSideSession;
		}

		await disposeSideSession();
		activeSideSession = await createSideSession(ctx, contentLeafId);
		return activeSideSession;
	}

	async function ensureOverlay(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			return;
		}

		if (overlayRuntime?.handle) {
			overlayRuntime.handle.setHidden(false);
			overlayRuntime.handle.focus();
			overlayRuntime.refresh?.();
			return;
		}

		const runtime: OverlayRuntime = {};
		const closeRuntime = () => {
			if (runtime.closed) {
				return;
			}
			runtime.closed = true;
			runtime.handle?.hide();
			if (overlayRuntime === runtime) {
				overlayRuntime = null;
			}
			runtime.finish?.();
		};
		runtime.close = closeRuntime;
		overlayRuntime = runtime;

		void ctx.ui
			.custom<void>(
				async (tui, theme, keybindings, done) => {
					runtime.finish = () => done();

					const overlay = new BtwOverlay(
						tui,
						theme,
						keybindings,
						(width, t) => getTranscriptLines(width, t),
						() => overlayStatus,
						(value) => {
							void submitFromOverlay(ctx, value);
						},
						() => {
							void closeOverlayFlow(ctx);
						},
					);

					overlay.focused = true;
					overlay.setDraft(overlayDraft);
					runtime.setDraft = (value) => overlay.setDraft(value);
					runtime.refresh = () => {
						overlay.focused = runtime.handle?.isFocused() ?? false;
						tui.requestRender();
					};
					runtime.close = () => {
						overlayDraft = overlay.getDraft();
						closeRuntime();
					};

					if (runtime.closed) {
						done();
					}

					return overlay;
				},
				{
					overlay: true,
					overlayOptions: {
						width: "80%",
						minWidth: 72,
						maxHeight: "78%",
						anchor: "top-center",
						margin: { top: 1, left: 2, right: 2 },
					},
					onHandle: (handle) => {
						runtime.handle = handle;
						handle.focus();
						if (runtime.closed) {
							closeRuntime();
						}
					},
				},
			)
			.catch((error) => {
				if (overlayRuntime === runtime) {
					overlayRuntime = null;
				}
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
			});
	}

	async function summarizeThread(ctx: ExtensionContext, items: BtwDetails[]): Promise<string> {
		const model = ctx.model;
		if (!model) {
			throw new Error("No active model selected.");
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok === false) {
			throw new Error(auth.error);
		}

		const { session } = await createAgentSession({
			sessionManager: SessionManager.inMemory(),
			model,
			modelRegistry: ctx.modelRegistry as AgentSession["modelRegistry"],
			thinkingLevel: "off",
			tools: [],
			resourceLoader: createBtwResourceLoader(ctx, [BTW_SUMMARY_PROMPT]),
		});

		try {
			await session.prompt(formatThread(items), { source: "extension" });
			const response = getLastAssistantMessage(session);
			if (!response) {
				throw new Error("Summary finished without a response.");
			}
			if (response.stopReason === "aborted") {
				throw new Error("Summary request was aborted.");
			}
			if (response.stopReason === "error") {
				throw new Error(response.errorMessage || "Summary request failed.");
			}

			return extractText(response.content) || "(No summary generated)";
		} finally {
			try {
				await session.abort();
			} catch {
				// Ignore abort errors during temporary session teardown.
			}
			session.dispose();
		}
	}

	async function injectSummaryIntoMain(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
		if (thread.length === 0) {
			notify(ctx, "No BTW thread to summarize.", "warning");
			return;
		}

		setOverlayStatus("Summarizing BTW thread for injection...");
		try {
			const summary = await summarizeThread(ctx, thread);
			const message = `Summary of my BTW side conversation:\n\n${summary}`;
			if (ctx.isIdle()) {
				pi.sendUserMessage(message);
			} else {
				pi.sendUserMessage(message, { deliverAs: "followUp" });
			}

			await resetThread(ctx);
			notify(ctx, "Injected BTW summary into main chat.", "info");
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : String(error), "error");
		}
	}

	async function closeOverlayFlow(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
		dismissOverlay();
		if (!ctx.hasUI) {
			return;
		}

		if (thread.length === 0) {
			return;
		}

		const choice = await ctx.ui.select("Close BTW:", ["Keep side thread", "Inject summary into main chat"]);
		if (choice === "Inject summary into main chat") {
			await injectSummaryIntoMain(ctx);
		}
	}

	async function runBtwPrompt(ctx: ExtensionCommandContext, question: string): Promise<void> {
		const model = ctx.model;
		if (!model) {
			setOverlayStatus("No active model selected.");
			notify(ctx, "No active model selected.", "error");
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok === false) {
			const message = auth.error;
			setOverlayStatus(message);
			notify(ctx, message, "error");
			return;
		}

		if (sideBusy) {
			notify(ctx, "BTW is still processing the previous message.", "warning");
			return;
		}
		// Claim the busy slot before the first await: ensureSideSession disposes the
		// previous side session, so a second submit inside that window would abort
		// the in-flight prompt.
		sideBusy = true;

		try {
			const side = await ensureSideSession(ctx);
			if (!side) {
				notify(ctx, "Unable to create BTW side session.", "error");
				return;
			}

			pendingQuestion = question;
			pendingAnswer = "";
			pendingError = null;
			pendingToolCalls = [];
			setOverlayStatus("Streaming side response...");
			syncOverlay();

			await side.session.prompt(question, { source: "extension" });
			const response = getLastAssistantMessage(side.session);
			if (!response) {
				throw new Error("BTW request finished without a response.");
			}
			if (response.stopReason === "aborted") {
				throw new Error("BTW request aborted.");
			}
			if (response.stopReason === "error") {
				throw new Error(response.errorMessage || "BTW request failed.");
			}

			const answer = extractText(response.content) || "(No text response)";
			pendingAnswer = answer;
			const details: BtwDetails = {
				question,
				answer,
				timestamp: Date.now(),
				provider: model.provider,
				model: model.id,
				thinkingLevel: pi.getThinkingLevel() as SessionThinkingLevel,
				usage: response.usage,
			};
			thread.push(details);
			pi.appendEntry(BTW_ENTRY_TYPE, details);

			pendingQuestion = null;
			pendingAnswer = "";
			pendingToolCalls = [];
			setOverlayStatus("Ready for the next side question.");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			pendingError = message;
			setOverlayStatus("BTW request failed.");
			notify(ctx, message, "error");
		} finally {
			sideBusy = false;
			syncOverlay();
		}
	}

	async function submitFromOverlay(ctx: ExtensionContext | ExtensionCommandContext, rawValue: string): Promise<void> {
		const question = rawValue.trim();
		if (!question) {
			setOverlayStatus("Enter a question first.");
			return;
		}

		setOverlayDraft("");
		if (!("waitForIdle" in ctx)) {
			setOverlayStatus("BTW submit requires command context. Re-open with /btw.");
			return;
		}

		await runBtwPrompt(ctx, question);
	}

	pi.registerCommand("btw", {
		description: "Open a simple BTW side-chat popover. `/btw <text>` asks immediately, `/btw` opens the side thread.",
		handler: async (args, ctx) => {
			const question = args.trim();

			if (!question) {
				if (thread.length > 0 && ctx.hasUI) {
					const choice = await ctx.ui.select("BTW side chat:", [
						"Continue previous conversation",
						"Start fresh",
					]);
					if (choice === "Continue previous conversation") {
						setOverlayStatus("Continuing BTW thread.");
						await ensureOverlay(ctx);
					} else if (choice === "Start fresh") {
						await resetThread(ctx, true);
						setOverlayStatus("Ready");
						await ensureOverlay(ctx);
					}
					// null = user cancelled (Esc), do nothing
				} else {
					await resetThread(ctx, true);
					setOverlayStatus("Ready");
					await ensureOverlay(ctx);
				}
				return;
			}

			await ensureOverlay(ctx);
			await runBtwPrompt(ctx, question);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await restoreThread(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreThread(ctx);
	});

	pi.on("session_shutdown", async () => {
		await disposeSideSession();
		dismissOverlay();
	});
}
