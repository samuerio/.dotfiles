import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildSessionContext,
	convertToLlm,
	createAgentSession,
	createExtensionRuntime,
	getMarkdownTheme,
	ToolExecutionComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
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
	Text,
	Input,
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Focusable,
	type KeybindingsManager,
	type OverlayHandle,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	type Component,
	type TUI,
	ScrollView,
	stripTerminalSequences,
	wrapTextWithAnsi,
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

/** Theme token/attribute helpers, as handed to every BTW renderer. */
type BtwTheme = ExtensionContext["ui"]["theme"];

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

/** Minimal structural match for pi-tui's unexported dispatch result: the
 * override contract requires a child target; a self-target keeps the wheel
 * result out of pi's delegated-child bookkeeping. */
type OverlayWheelResult = {
	handled: true;
	render: boolean;
	target: {
		component: Component;
		originX: number;
		originY: number;
		width: number;
		height: number;
	};
};

type ToolCallInfo = {
	toolCallId: string;
	toolName: string;
	/** Raw tool-call arguments, as passed to the native tool renderers. */
	args: unknown;
	/** Raw tool result captured at tool_execution_end; undefined while running. */
	result?: unknown;
	isError: boolean;
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

// ---------------------------------------------------------------------------
// Rendering core — forked from subagent-manager/src/ui/live-agent-view.ts
// (upstream commit 0f0349a). Kept inline in this file; if a second consumer
// ever appears, lift this whole section into pi/agent/extensions/lib/.
// ---------------------------------------------------------------------------

/** Transcript detail level cycled by Ctrl+O: full → preview → compact. */
type TranscriptDetail = "full" | "preview" | "compact";
const DETAIL_CYCLE: TranscriptDetail[] = ["full", "preview", "compact"];
const BTW_PREVIEW_ROWS = 3;
/** Source-size bound before rendering collapsed content. */
const BTW_TEXT_LIMIT = 32768;

let transcriptDetail: TranscriptDetail = "preview";

/** Ctrl+O cycle: full → preview → compact → full. */
function cycleTranscriptDetail(): void {
	transcriptDetail = DETAIL_CYCLE[(DETAIL_CYCLE.indexOf(transcriptDetail) + 1) % DETAIL_CYCLE.length];
}

/** Fully cover the overlay slot; only trusted renderers emit terminal sequences. */
function fillViewport(lines: string[], width: number, height: number): string[] {
	width = Math.max(0, Math.floor(width));
	height = Math.max(1, Math.floor(height));
	const result = lines.slice(0, height).map((line) => {
		const clipped = truncateToWidth(line, width, "", true);
		return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	});
	while (result.length < height) result.push(" ".repeat(width));
	return result;
}

/** Sanitize untrusted text before any renderer or wrapper interpolates it. */
function stripUnsafeTerminalText(value: string): string {
	return stripTerminalSequences(value)
		.replace(/\r\n?/g, "\n")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** ANSI-aware wrapping for plain text (flush-left, no padding per BTW spec). */
function wrapPlain(value: string, width: number): string[] {
	const safe = stripUnsafeTerminalText(value);
	const bounded = safe.length > BTW_TEXT_LIMIT ? safe.slice(0, BTW_TEXT_LIMIT) : safe;
	return bounded.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}

/** Sanitized tools snapshot for a finished turn; aborted calls freeze as errored. */
function snapshotToolCalls(calls: ToolCallInfo[]): ToolCallInfo[] {
	return calls.map((tool) =>
		tool.status === "running" ? { ...tool, isError: true, status: "error" as const } : tool,
	);
}

/** Same themed markdown (incl. code highlighting) as pi's main transcript. */
function markdownToLines(value: string, width: number, theme: BtwTheme, thinking = false): string[] {
	if (!value) return [];
	const safe = stripUnsafeTerminalText(value);
	try {
		const md = new Markdown(
			safe,
			0,
			0,
			mdTheme,
			thinking ? { color: (v) => theme.fg("thinkingText", v), italic: true } : undefined,
		);
		return md.render(Math.max(1, width));
	} catch {
		return wrapPlain(safe, width);
	}
}

type ThreadItemCacheEntry = {
	width: number;
	detail: TranscriptDetail;
	toolsKey: string;
	lines: string[];
};
const transcriptCache = new WeakMap<BtwDetails, ThreadItemCacheEntry>();

/**
 * One Q&A turn as rhythm rows: `you` heading + question, blank line,
 * `assistant` heading + this turn's tool boxes + markdown answer, blank line.
 * Flush-left, no padding.
 */
function renderThreadItem(
	item: BtwDetails,
	theme: BtwTheme,
	width: number,
	detail: TranscriptDetail,
	tools: ToolCallInfo[],
): string[] {
	const toolsKey = tools.map((tc) => `${tc.toolCallId}:${tc.status}`).join(",");
	const cached = transcriptCache.get(item);
	if (cached && cached.width === width && cached.detail === detail && cached.toolsKey === toolsKey) {
		return cached.lines;
	}
	// Agent-manager semantics: detail cycles affect only thinking and tool boxes;
	// question/answer text renders full at every level.
	const lines: string[] = [
		theme.fg("accent", "you"),
		...wrapPlain(item.question, width),
		"",
		theme.fg("accent", "assistant"),
		...renderToolInfos(tools, width),
		...markdownToLines(item.answer, width, theme),
		"",
	];
	transcriptCache.set(item, { width, detail, toolsKey, lines });
	return lines;
}

/**
 * Collapse a rendered answer/thinking block to three rendered rows. Works on
 * rendered output (not source) so markdown structure stays intact per row.
 */
function collapseRendered(lines: string[], theme: BtwTheme, ellipsis: string): string[] {
	if (lines.length <= BTW_PREVIEW_ROWS) return lines;
	return [...lines.slice(0, BTW_PREVIEW_ROWS), theme.fg("dim", ellipsis)];
}

/**
 * Rendered tool boxes cached by toolCallId, serving both the in-flight turn and
 * finished history turns; ids absent from the latest pass are evicted.
 */
type PendingToolCacheEntry = {
	args: unknown;
	result: unknown;
	isError: boolean;
	running: boolean;
	width: number;
	detail: TranscriptDetail;
	lines: string[];
};

/**
 * Native tool boxes for one turn's recorded calls (in flight or finished). Pairs
 * by toolCallId (see the session subscriber); renders via pi's own
 * ToolExecutionComponent wrappers so tools look exactly like pi's main
 * transcript tools.
 */
function renderToolInfos(toolCalls: ToolCallInfo[], width: number): string[] {
	if (toolCalls.length === 0) {
		return [];
	}
	const liveIds = new Set(toolCalls.map((tc) => tc.toolCallId));
	const lines: string[] = [];
	for (const tc of toolCalls) {
		const running = tc.status === "running";
		const cached = pendingToolCache.get(tc.toolCallId);
		if (
			cached &&
			cached.width === width &&
			cached.detail === transcriptDetail &&
			cached.args === tc.args &&
			cached.result === tc.result &&
			cached.isError === tc.isError &&
			cached.running === running
		) {
			lines.push(...cached.lines);
			continue;
		}
		const rendered = renderTranscriptTool(
			tc.toolName,
			tc.toolCallId,
			tc.args,
			tc.result,
			tc.isError,
			running,
			transcriptDetail,
			width,
		);
		lines.push(...rendered);
		pendingToolCache.set(tc.toolCallId, {
			args: tc.args,
			result: tc.result,
			isError: tc.isError,
			running,
			width,
			detail: transcriptDetail,
			lines: rendered,
		});
	}
	for (const id of pendingToolCache.keys()) {
		if (!liveIds.has(id)) pendingToolCache.delete(id);
	}
	return lines;
}

// Pending turn state shared by the renderers above and the extension runtime
// below; resetPendingTurn() drops the pending* fields when a turn or thread
// completes (per-turn tool history deliberately outlives the turn that filled it).
let thread: BtwDetails[] = [];
let pendingQuestion: string | null = null;
let pendingAnswer = "";
let pendingError: string | null = null;
let pendingAssistant: AssistantMessage | null = null;
let pendingToolCalls: ToolCallInfo[] = [];
/** Tool boxes of the turn that threw; rendered above the error for diagnosis. */
let failedTools: ToolCallInfo[] = [];
/** Tool boxes stay bound to the thread item they belong to for the whole session
 * (WeakMap: dropped with the item itself on thread reset/reload). Transient UI
 * state; never persisted to BtwDetails. */
const threadTools = new WeakMap<BtwDetails, ToolCallInfo[]>();
const pendingToolCache = new Map<string, PendingToolCacheEntry>();
const mdTheme = getMarkdownTheme();

/** Drop the in-flight turn: question, stream, error, thinking and tool state. */
function resetPendingTurn(): void {
	pendingQuestion = null;
	pendingAnswer = "";
	pendingError = null;
	pendingAssistant = null;
	pendingToolCalls = [];
	failedTools = [];
	pendingToolCache.clear();
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

// ---------------------------------------------------------------------------
// Tool rendering — verbatim fork of subagent-manager/src/ui/transcript-tool.ts
// (upstream commit 0f0349a). Renders live tool calls through pi's own
// ToolExecutionComponent and trusted built-in tool renderers, with the
// observer-safety patches kept intact:
//   * TUI stub: no execution-lifecycle clock.
//   * edit.renderCall(argsComplete: false): never re-read today's file per
//     paint; use the recorded result diff.
//   * image blocks replaced with text placeholders (no Kitty conversion).
//   * args/content/details all sanitized; unknown tools use a bounded fallback.
// ---------------------------------------------------------------------------

/** Only trusted pi built-ins: observing a transcript must never execute extension renderers. */
type RendererPair = Pick<ToolDefinition<any, any>, "renderCall" | "renderResult">;
const transcriptToolRenderers = new Map<string, RendererPair>(
	[
		createBashToolDefinition(process.cwd()),
		createPowerShellToolDefinition(process.cwd()),
		createReadToolDefinition(process.cwd()),
		createEditToolDefinition(process.cwd()),
		createWriteToolDefinition(process.cwd()),
		createGrepToolDefinition(process.cwd()),
		createFindToolDefinition(process.cwd()),
		createLsToolDefinition(process.cwd()),
	].map((tool) => [
		tool.name,
		{ renderCall: tool.renderCall, renderResult: tool.renderResult } as RendererPair,
	]),
);

// Native edit call previews otherwise read today's file asynchronously. An observer must
// use the recorded result.diff, not inspect a possibly different worktree on every paint.
const transcriptToolEdit = transcriptToolRenderers.get("edit")!;
const transcriptToolEditCall = transcriptToolEdit.renderCall!;
transcriptToolEdit.renderCall = (args, theme, context) =>
	transcriptToolEditCall(args, theme, { ...context, argsComplete: false });

const transcriptToolGeneric: RendererPair = {
	renderResult(result, options, theme) {
		const output = result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const bounded = options.expanded ? output : output.slice(0, BTW_TEXT_LIMIT);
		const component = new Text(theme.fg("toolOutput", bounded), 0, 0);
		return {
			invalidate() {
				component.invalidate();
			},
			render(width) {
				const rows = component.render(width);
				if (options.expanded || (rows.length <= 5 && bounded.length === output.length)) return rows;
				return [...rows.slice(0, 5), theme.fg("muted", "… more lines (Ctrl+O to expand)")];
			},
		};
	},
};

/** Sanitize args, content AND details before trusted renderers interpolate them. */
function sanitizeToolValue(value: unknown, seen = new WeakSet<object>(), depth = 0): any {
	if (typeof value === "string") return stripUnsafeTerminalText(value);
	if (!value || typeof value !== "object") return typeof value === "bigint" ? String(value) : value;
	if (seen.has(value)) return "[Circular]";
	if (depth > 64) return "[Nested data omitted]";
	seen.add(value);
	const safe = Array.isArray(value)
		? value.map((item) => sanitizeToolValue(item, seen, depth + 1))
		: Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				stripUnsafeTerminalText(key),
				sanitizeToolValue(item, seen, depth + 1),
			]),
		);
	seen.delete(value);
	return safe;
}

function renderTranscriptTool(
	name: string,
	id: string,
	args: unknown,
	result: unknown,
	isError: boolean,
	running: boolean,
	detail: TranscriptDetail,
	width: number,
): string[] {
	// Pi's tool component owns elapsed-time intervals after markExecutionStarted().
	// An observer has no execution lifecycle to dispose, so don't start that clock.
	const ui = { requestRender() {} } as TUI;
	const component = new ToolExecutionComponent(
		stripUnsafeTerminalText(name),
		stripUnsafeTerminalText(id),
		sanitizeToolValue(args),
		{ showImages: false },
		transcriptToolRenderers.get(name) ?? transcriptToolGeneric,
		ui,
		process.cwd(),
	);
	const data = result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
	const content = data?.content ?? result;
	component.updateResult(
		{
			content: (Array.isArray(content) ? content : content === undefined ? [] : [content]).map(
				(block) => {
					// Never hand image payloads to pi (even showImages:false can trigger Kitty conversion).
					if (block && typeof block === "object" && (block as { type?: string }).type === "image")
						return { type: "text", text: "[Image — text-only observer]" };
					if (block && typeof block === "object" && (block as { type?: string }).type === "text")
						return {
							type: "text",
							text: stripUnsafeTerminalText(String((block as { text?: unknown }).text ?? "")),
						};
					return {
						type: "text",
						text: stripUnsafeTerminalText(
							typeof block === "string" ? block : (JSON.stringify(sanitizeToolValue(block)) ?? ""),
						),
					};
				},
			),
			details: sanitizeToolValue(data?.details),
			isError: isError || data?.isError === true,
		},
		running,
	);
	component.setExpanded(detail === "full");
	const lines = component.render(Math.max(3, width));
	if (detail === "compact")
		return lines.filter((line) => stripTerminalSequences(line).trim()).slice(0, 1);
	return lines;
}

/** Status-row tone: idle is muted, a failure is an error, anything in flight warns. */
function statusColor(status: string): "dim" | "error" | "warning" {
	if (status.startsWith("Ready")) return "dim";
	if (status.includes("failed")) return "error";
	return "warning";
}

class BtwOverlay extends Container implements Focusable {
	private readonly input: Input;
	private readonly tui: TUI;
	private readonly theme: BtwTheme;
	private readonly keybindings: KeybindingsManager;
	private readonly getTranscript: (width: number, theme: BtwTheme) => string[];
	private readonly getStatus: () => string;
	private readonly onSubmitCallback: (value: string) => void;
	private readonly onDismissCallback: () => void;
	private _focused = false;
	private readonly scroll: ScrollView;
	private content: string[] = [];

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		theme: BtwTheme,
		keybindings: KeybindingsManager,
		getTranscript: (width: number, theme: BtwTheme) => string[],
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
		this.scroll = new ScrollView(
			{ render: () => this.content, invalidate() {} },
			{ follow: "end", overscroll: "contain", scrollbar: "hidden" },
		);
		this.input.onSubmit = (value) => {
			// A new question pins the view back to the latest messages.
			this.scroll.scrollToEnd();
			this.onSubmitCallback(value);
		};
		this.input.onEscape = () => {
			this.onDismissCallback();
		};
	}

	/** Half the visible body, at least one row: the ctrl+u/ctrl+d paging step. */
	private halfPage(): number {
		return Math.max(1, Math.floor(this.scroll.viewportHeight / 2));
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onDismissCallback();
			return;
		}

		if (matchesKey(data, Key.ctrl("u"))) {
			this.scroll.scrollBy(-this.halfPage());
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("d"))) {
			this.scroll.scrollBy(this.halfPage());
			// Paged back to the bottom: explicitly restore follow-end.
			if (this.scroll.scrollTop >= Math.max(0, this.content.length - this.scroll.viewportHeight)) {
				this.scroll.scrollToEnd();
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("o"))) {
			cycleTranscriptDetail();
			// Cached tool renders are keyed by detail, so the cycle drops them all.
			pendingToolCache.clear();
			this.tui.requestRender();
			return;
		}
		this.input.handleInput(data);
	}

	/** Fullscreen wheel events scroll the transcript, even while composing. */
	override handleMouse(event: TuiMouseEvent): OverlayWheelResult | undefined {
		if (event.type !== "wheel") return undefined;
		const delta = Math.trunc(event.wheelDelta ?? 0);
		if (!Number.isFinite(delta) || delta === 0) return undefined;
		this.scroll.scrollBy(delta);
		// The override must structurally match pi-tui's unexported dispatch
		// result, which requires a child target; a self-target keeps the wheel
		// result out of pi's delegated-child bookkeeping (harmless today, and
		// the only shape the type system allows).
		return {
			handled: true,
			render: true,
			target: { component: this, originX: 0, originY: 0, width: 0, height: 0 },
		};
	}

	setDraft(value: string): void {
		this.input.setValue(value);
		this.tui.requestRender();
	}

	getDraft(): string {
		return this.input.getValue();
	}

	override render(width: number): string[] {
		// Fullscreen cover: pi composites exactly these rows over the main
		// transcript, so the component owns the height via its line count.
		const height = Math.max(1, this.tui.terminal.rows);
		// pad2 owns the left- and right-most columns, so content renders at
		// width-2; a wider row would lose its last cell when fillViewport clips.
		const columns = Math.max(1, width - 2);

		this.content = this.getTranscript(columns, this.theme);

		const status = this.getStatus();
		const header = this.theme.bold(this.theme.fg("accent", "BTW side chat"));
		const followState = this.scroll.isFollowingEnd ? "following" : "scrolled";
		const hint = `Enter submit · Esc close · ctrl+u/d page · ctrl+o view: ${transcriptDetail} · ${followState}`;
		// Budgeted to columns: an overflowing hint would clip into the right pad
		// column inside fillViewport and end flush against the terminal edge.
		const hintLine = this.theme.fg("dim", truncateToWidth(hint, columns, "…"));
		// Status text is never trusted (provider errors flow through it): one
		// sanitized row so a newline cannot evict hint/input from the frame.
		const statusLine = this.theme.fg(statusColor(status), wrapPlain(status, columns)[0] ?? "");
		const inputLine = this.input.render(columns)[0] ?? "";

		// LiveAgentView-style side padding keeps headings, bodies, tool bands and
		// chrome off the hard terminal edge; fillViewport clips the rest.
		const pad2 = (lines: string[]): string[] => lines.map((line) => (line ? ` ${line} ` : " "));

		// Under four rows there is no body: the input survives, then the header, then the hint.
		if (height === 1) return fillViewport(pad2([inputLine]), width, height);
		if (height === 2) return fillViewport(pad2([header, inputLine]), width, height);
		if (height === 3) return fillViewport(pad2([header, hintLine, inputLine]), width, height);

		// Full layout spends six chrome rows (header, breathing blank, body,
		// blank, status, hint+input); 4-7-row terminals drop the breathing rows
		// so the input still fits and the body keeps >= 2 rows.
		const breathing = height >= 8;
		const bodyHeight = height - (breathing ? 6 : 4);
		// Layout before slicing: with viewportHeight 0, follow-end silently no-ops.
		this.scroll.updateLayout(this.content.length, bodyHeight, () => this.tui.requestRender());
		const body = this.scroll.render(columns).slice(this.scroll.scrollTop, this.scroll.scrollTop + bodyHeight);
		while (body.length < bodyHeight) body.push("");

		// pad2 is per-row, so padding the composed rows equals padding each segment;
		// these rows fill the slot exactly and fillViewport clips and right-pads.
		const breathingRow = breathing ? [""] : [];
		const rows = [
			header,
			...breathingRow,
			...body,
			...breathingRow,
			statusLine,
			hintLine,
			inputLine,
		];
		return fillViewport(pad2(rows), width, height);
	}
}

export default function (pi: ExtensionAPI) {
	let sideBusy = false;
	let overlayStatus = "Ready";
	let overlayDraft = "";
	let overlayRuntime: OverlayRuntime | null = null;
	let activeSideSession: SideSessionRuntime | null = null;
	let overlayRefreshTimer: ReturnType<typeof setTimeout> | null = null;

	function renderPendingThinking(width: number, theme: BtwTheme): string[] {
		if (!pendingAssistant) return [];
		const content = Array.isArray(pendingAssistant.content) ? pendingAssistant.content : [];
		const lines: string[] = [];
		for (const block of content) {
			if (!block || typeof block !== "object" || (block as { type?: string }).type !== "thinking") {
				continue;
			}
			const thinkingText = String((block as { thinking?: string }).thinking ?? "[redacted thinking]");
			if (transcriptDetail === "compact") {
				lines.push(theme.fg("dim", "[Thinking hidden · ctrl+o cycles view]"));
				continue;
			}
			const rendered = markdownToLines(thinkingText, width, theme, true);
			lines.push(...(transcriptDetail === "full" ? rendered : collapseRendered(rendered, theme, "...")));
		}
		return lines;
	}

	function getTranscriptLines(width: number, theme: BtwTheme): string[] {
		try {
			return getTranscriptLinesInner(width, theme);
		} catch (error) {
			return [theme.fg("error", `Render error: ${error instanceof Error ? error.message : String(error)}`)];
		}
	}

	function getTranscriptLinesInner(width: number, theme: BtwTheme): string[] {
		if (thread.length === 0 && !pendingQuestion && !pendingAssistant && !pendingError) {
			return [theme.fg("dim", "No BTW messages yet. Type a question below.")];
		}

		const lines: string[] = [];
		for (const item of thread) {
			// Items hit the (item, width, detail, toolsKey) cache; a flying tool
			// status flip re-renders only the owning item. One throwing renderer
			// degrades to one line instead of hiding the whole transcript.
			try {
				lines.push(...renderThreadItem(item, theme, width, transcriptDetail, threadTools.get(item) ?? []));
			} catch (error) {
				const label = stripUnsafeTerminalText(item.question).slice(0, 40);
				lines.push(theme.fg("error", `[render error: ${label}] ${error instanceof Error ? error.message : String(error)}`));
			}
		}

		if (pendingQuestion) {
			lines.push(theme.fg("accent", "you"), ...wrapPlain(pendingQuestion, width), "");

			if (pendingError) {
				// The calls that ran before the throw stay visible above the error,
				// so a failure after N tools is diagnosable from the transcript.
				lines.push(
					theme.fg("error", "assistant"),
					...failedTools.map((tool) =>
						theme.fg("error", `  ✗ ${stripUnsafeTerminalText(tool.toolName)} (${tool.toolCallId})`),
					),
					...wrapPlain(`✗ ${pendingError}`, width).map((line) => theme.fg("error", line)),
				);
				return lines;
			}

			const thinkingLines = renderPendingThinking(width, theme);
			const toolLines = renderToolInfos(pendingToolCalls, width);
			const answerLines = pendingAnswer ? markdownToLines(pendingAnswer, width, theme) : [];
			const bodyLines = [...thinkingLines, ...toolLines, ...answerLines];
			if (bodyLines.length > 0) {
				lines.push(theme.fg("accent", "assistant"), ...bodyLines);
			} else {
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
		resetPendingTurn();
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
		resetPendingTurn();
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
						// message_update carries the cumulative message — no delta work.
						const assistantMessage = event.message;
						if (assistantMessage?.role === "assistant") {
							pendingAssistant = assistantMessage;
						}
						const streamed = extractEventAssistantText(assistantMessage);
						if (streamed) {
							pendingAnswer = streamed;
							pendingError = null;
						}
						setOverlayStatus(event.type === "message_end" ? "Finalizing side response..." : "Streaming side response...", true);
						return;
					}
					case "tool_execution_start": {
						try {
							const toolCallId = event.toolCallId ?? "";
							if (!toolCallId) {
								return;
							}
							const toolName = event.toolName ?? "unknown";
							const args = event.args;
							// Pair by toolCallId end-to-end; concurrent same-name tools stay distinct.
							const existing = pendingToolCalls.find((t) => t.toolCallId === toolCallId);
							if (existing) {
								existing.args = args;
								existing.status = "running";
							} else {
								pendingToolCalls.push({
									toolCallId,
									toolName,
									args,
									result: undefined,
									isError: false,
									status: "running",
								});
							}
							setOverlayStatus(`Running tool: ${toolName}...`, true);
						} catch {
							// Ignore tool tracking failures
						}
						return;
					}
					case "tool_execution_end": {
						const toolCallId = event.toolCallId ?? "";
						const tc = pendingToolCalls.find((t) => t.toolCallId === toolCallId);
						if (tc) {
							tc.result = event.result;
							tc.isError = event.isError === true;
							tc.status = tc.isError ? "error" : "done";
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
						width: "100%",
						maxHeight: "100%",
						row: 0,
						col: 0,
						margin: 0,
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

			resetPendingTurn();
			pendingQuestion = question;
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

			// Finished tool boxes stay attached to this turn's item for the whole
			// session; snapshot before the pending reset drops live state.
			threadTools.set(details, snapshotToolCalls(pendingToolCalls));
			resetPendingTurn();
			setOverlayStatus("Ready for the next side question.");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			pendingError = message;
			// Keep which calls ran (frozen as errored) for the error view; drop
			// raw pending references and their volatile render cache.
			failedTools = snapshotToolCalls(pendingToolCalls);
			pendingToolCalls = [];
			pendingToolCache.clear();
			setOverlayStatus(wrapPlain(message, 60)[0] ?? "BTW request failed.");
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
