import {
	buildSessionContext,
	getMarkdownTheme,
	type ExtensionCommandContext,
	type KeybindingsManager,
	type SessionInfo,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { loadSessionEntries, textOf } from "./session-common.ts";
import type { TranscriptItem } from "./transcript-items.ts";
import { loadTranscriptItems, renderItem, type TranscriptDocument } from "./transcript-render.ts";
import type { Detail } from "./transcript-tool.ts";
import {
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type TUI,
} from "@earendil-works/pi-tui";

// ─── Session Label ───────────────────────────────────────────────

/** Sanity cap for picker row labels. */
const SESSION_LABEL_MAX = 100;

/** Session row label: name (set at dispatch: description) or first message. */
export function sessionDisplayLabel(info: SessionInfo): string {
	const text = (info.name ?? info.firstMessage ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
	const label = text.length > 0 ? text : "(no title)";
	return label.length > SESSION_LABEL_MAX ? `${label.slice(0, SESSION_LABEL_MAX - 1)}…` : label;
}

// ─── Transcript Formatter ─────────────────────────────────────────

const PREVIEW_TOOL_CALL_ARGS = 120;
const PREVIEW_TOOL_RESULT_CHARS = 300;
const PREVIEW_BASH_OUTPUT_CHARS = 300;

type PreviewMessages = ReturnType<typeof buildSessionContext>["messages"];

/** One-line, whitespace-collapsed preview with a hard cut. */
function previewLine(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max)}...` : line;
}

function previewJson(value: unknown, max: number): string {
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch {
		json = "(unserializable arguments)";
	}
	return previewLine(json, max);
}

/**
 * Render a resolved session transcript as compact read_session-style text
 * (## user / → toolCall / ## toolResult stubs / ## bash blocks). Preview-only
 * simplification of the subagent read_session formatter: no entry-id
 * annotations (those are read_session_entry drill handles, pure noise in a
 * human preview) and no ~size hints.
 */
function formatSessionPreview(messages: PreviewMessages): string {
	const blocks: string[] = [];
	for (const msg of messages) {
		switch (msg.role) {
			case "user": {
				const text = textOf(msg.content).trim();
				if (text) blocks.push(`## user\n${text}`);
				break;
			}
			case "assistant": {
				const lines: string[] = [];
				for (const part of msg.content) {
					if (part.type === "text") {
						const text = part.text.trim();
						if (text) lines.push(text);
					} else if (part.type === "toolCall") {
						lines.push(`→ ${part.name}(${previewJson(part.arguments, PREVIEW_TOOL_CALL_ARGS)})`);
					}
					// thinking parts are skipped
				}
				if (lines.length > 0) blocks.push(`## assistant\n${lines.join("\n")}`);
				break;
			}
			case "toolResult": {
				const text = textOf(msg.content).trim();
				const tag = msg.isError ? " (error)" : "";
				blocks.push(
					`## toolResult:${msg.toolName}${tag}\n${previewLine(text, PREVIEW_TOOL_RESULT_CHARS) || "(empty)"}`,
				);
				break;
			}
			case "bashExecution": {
				const full = (msg.output ?? "").replace(/\s+/g, " ").trim();
				const output =
					full.length > PREVIEW_BASH_OUTPUT_CHARS ? `${full.slice(0, PREVIEW_BASH_OUTPUT_CHARS)}...` : full;
				blocks.push(`## bash (exit=${msg.exitCode ?? "?"})\n$ ${msg.command}${output ? `\n${output}` : ""}`);
				break;
			}
			case "compactionSummary":
				blocks.push(`## compactionSummary\n${msg.summary.trim()}`);
				break;
			case "branchSummary":
				blocks.push(`## branchSummary\n${msg.summary.trim()}`);
				break;
			// custom and other roles: skipped (preview-only rendering).
		}
	}
	return blocks.join("\n\n");
}

/**
 * Load a session JSONL file and resolve its active-branch transcript as
 * compact read_session-style text (## user / → toolCall / ## toolResult stubs
 * / ## bash blocks). Strictly read-only: SessionManager.open() is never
 * touched (its migration may rewrite the file).
 */
export function loadSessionTranscript(sessionFile: string): string {
	const { entries } = loadSessionEntries(sessionFile);
	const messages = buildSessionContext(entries, undefined).messages;
	return formatSessionPreview(messages) || "(no messages)";
}

// ─── Session Preview Overlay ──────────────────────────────────────

// Frame chrome around the content rows: title, path and a blank above; a blank
// and the actions row below; one border row on each side.
const HEADER_ROWS = 3;
const FOOTER_ROWS = 2;
const BORDER_ROWS = 2;

/** Ctrl+O order for the preview: preview → full → compact. */
const DETAIL_CYCLE: Detail[] = ["preview", "full", "compact"];

/**
 * Session preview overlay: whole-terminal transcript viewer (scroll / half-page
 * / page / top / bottom). Content is a list of transcript items rendered lazily
 * item by item, so an 800-message session paints its first screen without
 * rendering the tail; tool calls go through pi's own renderers with the
 * session's cwd.
 */
class SessionPreviewOverlay {
	private readonly title: string;
	private readonly filePath: string;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly onClose: () => void;
	private readonly onError: (message: string) => void;

	private items: TranscriptItem[];
	private cwd: string;
	private detail: Detail = "preview";
	/** Item index → rendered rows, including each item's trailing separator row. */
	private readonly cache = new Map<number, string[]>();
	/** heights[i] = rows contributed by items 0..i-1, so heights.length - 1 items are rendered. */
	private heights: number[] = [0];
	private renderWidth = 0;
	private scrollOffset = 0;
	private viewHeight = 0;
	private totalLines = 0;
	/** True once every item has been rendered, i.e. totalLines is the real total. */
	private fullyRendered = false;
	private readonly reportedErrors = new Set<string>();

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		title: string,
		filePath: string,
		loaded: TranscriptDocument,
		onClose: () => void,
		onError: (message: string) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.title = title;
		this.filePath = filePath;
		this.items = loaded.items;
		this.cwd = loaded.cwd;
		this.onClose = onClose;
		this.onError = onError;
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (kb.matches(keyData, "tui.select.cancel") || kb.matches(keyData, "tui.select.confirm")) {
			this.onClose();
			return;
		}
		if (matchesKey(keyData, Key.ctrl("o"))) {
			this.cycleDetail();
			return;
		}
		if (matchesKey(keyData, "r")) {
			this.reload();
			return;
		}
		if (matchesKey(keyData, "g")) {
			this.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(keyData, Key.shift("g"))) {
			// The tail is normally unrendered, so the real total needs a full pass.
			this.ensureLines(Number.POSITIVE_INFINITY);
			this.scrollOffset = Math.max(0, this.knownLines() - this.viewHeight);
			this.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			this.scrollBy(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.scrollBy(1);
			return;
		}
		if (matchesKey(keyData, "j")) {
			this.scrollBy(1);
			return;
		}
		if (matchesKey(keyData, "k")) {
			this.scrollBy(-1);
			return;
		}
		if (matchesKey(keyData, Key.ctrl("d"))) {
			this.scrollBy(Math.floor(this.viewHeight / 2) || 1);
			return;
		}
		if (matchesKey(keyData, Key.ctrl("u"))) {
			this.scrollBy(-Math.floor(this.viewHeight / 2) || -1);
			return;
		}
		if (kb.matches(keyData, "tui.select.pageUp") || matchesKey(keyData, Key.left)) {
			this.scrollBy(-this.viewHeight || -1);
			return;
		}
		if (kb.matches(keyData, "tui.select.pageDown") || matchesKey(keyData, Key.right)) {
			this.scrollBy(this.viewHeight || 1);
			return;
		}
	}

	render(width: number): string[] {
		// The overlay already owns the whole terminal, so take every row.
		const maxHeight = Math.max(10, this.tui.terminal.rows || 24);
		const innerWidth = Math.max(10, width - 2);
		const contentHeight = Math.max(1, maxHeight - HEADER_ROWS - FOOTER_ROWS - BORDER_ROWS);
		this.viewHeight = contentHeight;

		if (innerWidth !== this.renderWidth) {
			// Rows are wrapped at render time, so a resize invalidates every cached one.
			this.renderWidth = innerWidth;
			this.resetCache();
		}

		this.ensureLines(this.scrollOffset + contentHeight);
		this.totalLines = this.knownLines();
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, this.totalLines - contentHeight)));

		const visibleLines =
			this.items.length === 0
				? new Markdown("_Empty session._", 1, 0, getMarkdownTheme()).render(innerWidth)
				: this.sliceLines(this.scrollOffset, contentHeight);
		const lines = [this.buildTitleLine(innerWidth), this.buildMetaLine(innerWidth), "", ...visibleLines];
		while (lines.length < HEADER_ROWS + contentHeight) {
			lines.push("");
		}
		lines.push("", this.buildActionLine(innerWidth));

		const borderColor = (text: string) => this.theme.fg("borderMuted", text);
		const top = borderColor(`┌${"─".repeat(innerWidth)}┐`);
		const bottom = borderColor(`└${"─".repeat(innerWidth)}┘`);
		const framedLines = lines.map((line) => {
			const truncated = truncateToWidth(line, innerWidth);
			const padding = Math.max(0, innerWidth - visibleWidth(truncated));
			return borderColor("│") + truncated + " ".repeat(padding) + borderColor("│");
		});
		return [top, ...framedLines, bottom].map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		// pi invalidates on a live theme change, and cached rows carry the old
		// theme's ANSI codes; refilling lazily keeps this cheap.
		this.resetCache();
	}

	private scrollBy(delta: number): void {
		// While the tail is unrendered the real total is unknown, so the only cap
		// that can be trusted here is the top; render() extends and re-clamps.
		this.scrollOffset = Math.max(0, this.scrollOffset + delta);
		if (this.fullyRendered) {
			this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, this.totalLines - this.viewHeight));
		}
	}

	/** Rendered item count (heights has one entry per boundary). */
	private renderedItems(): number {
		return this.heights.length - 1;
	}

	/** Rows known so far; the tail may still be unrendered. */
	private knownLines(): number {
		return this.heights[this.heights.length - 1];
	}

	/**
	 * Drop every cached row. Scroll position survives so a reload or a detail
	 * switch keeps the reader where they were (render() re-clamps the end).
	 */
	private resetCache(): void {
		this.cache.clear();
		this.heights = [0];
		this.fullyRendered = false;
	}

	/** Render items in order until the prefix covers `uptoLine` rows. */
	private ensureLines(uptoLine: number): void {
		let index = this.renderedItems();
		while (index < this.items.length && this.heights[index] < uptoLine) {
			const lines = this.renderItemLines(index);
			this.cache.set(index, lines);
			this.heights[index + 1] = this.heights[index] + lines.length;
			index++;
		}
		if (index >= this.items.length) this.fullyRendered = true;
	}

	private renderItemLines(index: number): string[] {
		const item = this.items[index];
		try {
			return renderItem(item, {
				width: this.renderWidth,
				detail: this.detail,
				cwd: this.cwd,
				theme: this.theme,
			});
		} catch (error) {
			// One broken item (huge diff, odd tool payload) must not blank the preview.
			const message = error instanceof Error ? error.message : String(error);
			this.reportError(`Failed to render ${item.kind} item: ${message}`);
			return [this.theme.fg("error", `⚠ failed to render ${item.kind} item`), ""];
		}
	}

	/** Report a failure once per distinct message; the same item re-renders often. */
	private reportError(message: string): void {
		if (this.reportedErrors.has(message)) return;
		this.reportedErrors.add(message);
		this.onError(message);
	}

	/** Index of the item containing `line` (binary search over the prefix table). */
	private itemAt(line: number): number {
		const rendered = this.renderedItems();
		if (rendered === 0) return 0;
		let low = 0;
		let high = rendered - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if (this.heights[mid] <= line) low = mid;
			else high = mid - 1;
		}
		return low;
	}

	/**
	 * Rows [from, from+count) assembled from the cached items that intersect that
	 * window only — never from a fully concatenated document.
	 */
	private sliceLines(from: number, count: number): string[] {
		const rows: string[] = [];
		const end = from + count;
		const rendered = this.renderedItems();
		for (let index = this.itemAt(from); index < rendered && this.heights[index] < end; index++) {
			const itemLines = this.cache.get(index);
			if (!itemLines) continue;
			const base = this.heights[index];
			const first = Math.max(0, from - base);
			const last = Math.min(itemLines.length, end - base);
			for (let i = first; i < last; i++) rows.push(itemLines[i]);
		}
		return rows;
	}

	private cycleDetail(): void {
		this.detail = DETAIL_CYCLE[(DETAIL_CYCLE.indexOf(this.detail) + 1) % DETAIL_CYCLE.length];
		this.resetCache();
		this.tui.requestRender();
	}

	/** Re-read the session file: a live run keeps appending after the preview opens. */
	private reload(): void {
		let loaded: TranscriptDocument;
		try {
			loaded = loadTranscriptItems(this.filePath);
		} catch (error) {
			this.onError(`Failed to read session: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		this.items = loaded.items;
		this.cwd = loaded.cwd;
		this.resetCache();
		this.tui.requestRender();
	}

	private buildTitleLine(width: number): string {
		const titleText = ` ${this.title} `;
		const titleWidth = visibleWidth(titleText);
		if (titleWidth >= width) {
			return truncateToWidth(this.theme.fg("accent", titleText.trim()), width);
		}
		const leftWidth = Math.max(0, Math.floor((width - titleWidth) / 2));
		const rightWidth = Math.max(0, width - titleWidth - leftWidth);
		return (
			this.theme.fg("borderMuted", "─".repeat(leftWidth)) +
			this.theme.fg("accent", titleText) +
			this.theme.fg("borderMuted", "─".repeat(rightWidth))
		);
	}

	private buildMetaLine(width: number): string {
		return truncateToWidth(this.theme.fg("muted", ` ${this.filePath}`), width);
	}

	private buildActionLine(width: number): string {
		// Narrow terminals cut the line from the right, so close and the detail
		// switch (the two keys people hunt for) lead; the rest degrade away.
		const close = this.theme.fg("accent", "esc") + this.theme.fg("dim", " close");
		const detail = this.theme.fg("accent", "ctrl+o") + this.theme.fg("dim", ` ${this.detail}`);
		const scroll = this.theme.fg("accent", "j/k") + this.theme.fg("dim", " scroll");
		const halfPage = this.theme.fg("accent", "ctrl+d/u") + this.theme.fg("dim", " half page");
		const page = this.theme.fg("accent", "←/→") + this.theme.fg("dim", " page");
		const ends = this.theme.fg("accent", "g/G") + this.theme.fg("dim", " top/bottom");
		let line = [close, detail, scroll, halfPage, page, ends].join(this.theme.fg("muted", " • "));
		if (this.totalLines > this.viewHeight) {
			const start = Math.min(this.totalLines, this.scrollOffset + 1);
			const end = Math.min(this.totalLines, this.scrollOffset + this.viewHeight);
			// A provisional total (tail not rendered yet) would read as "you are at
			// the end" while most of the session is below: show it as open-ended.
			const total = this.fullyRendered ? `/${this.totalLines}` : "+";
			line += this.theme.fg("dim", ` ${start}-${end}${total}`);
		}
		return truncateToWidth(line, width);
	}
}

/** Open the overlay; single modal instance, errors surface as notifications. */
async function openSessionPreview(
	ctx: ExtensionCommandContext,
	title: string,
	filePath: string,
	loaded: TranscriptDocument,
): Promise<void> {
	const reportError = (message: string) => ctx.ui.notify(message, "error");
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) =>
			new SessionPreviewOverlay(tui, theme, keybindings, title, filePath, loaded, done, reportError),
		{
			overlay: true,
			overlayOptions: {
				width: "100%",
				maxHeight: "100%",
				row: 0,
				col: 0,
				margin: 0,
			},
			onHandle: (handle) => handle.focus(),
		},
	).catch((error) => {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	});
}

/** Render a session file and show it in the preview overlay. */
export async function previewSessionFile(
	ctx: ExtensionCommandContext,
	title: string,
	sessionFile: string,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Session preview requires interactive mode", "error");
		return;
	}
	let loaded: TranscriptDocument;
	try {
		loaded = loadTranscriptItems(sessionFile);
	} catch (error) {
		ctx.ui.notify(`Failed to read session: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	await openSessionPreview(ctx, title, sessionFile, loaded);
}
