import {
	buildSessionContext,
	getMarkdownTheme,
	type ExtensionCommandContext,
	type KeybindingsManager,
	type SessionInfo,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { loadSessionEntries, textOf } from "./session-common.ts";
import {
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type TUI,
} from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";

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
 * Load a session JSONL file and resolve its active-branch transcript
 * (parse → migrate → buildSessionContext). Strictly read-only:
 * SessionManager.open() is never touched (its migration may rewrite the
 * file); entries are filtered to drop the session header entry.
 */
async function loadPreviewSessionMessages(sessionFile: string): Promise<PreviewMessages> {
	const { entries } = loadSessionEntries(sessionFile);
	return buildSessionContext(entries, undefined).messages;
}

// ─── Session Preview Overlay ──────────────────────────────────────

/**
 * Session preview overlay: self-contained copy of viewer.ts's markdown
 * viewer (scroll / half-page / page / fullscreen). Renders the transcript
 * text through the Markdown component so ## headers get heading styles.
 */
class SessionPreviewOverlay {
	private readonly title: string;
	private readonly filePath: string;
	private readonly markdown: Markdown;
	private scrollOffset = 0;
	private viewHeight = 0;
	private totalLines = 0;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly onClose: () => void;
	private fullscreen = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		title: string,
		filePath: string,
		content: string,
		onClose: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.title = title;
		this.filePath = filePath;
		this.onClose = onClose;
		this.markdown = new Markdown(content.trim() ? content : "_Empty session._", 1, 0, getMarkdownTheme());
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (kb.matches(keyData, "tui.select.cancel") || kb.matches(keyData, "tui.select.confirm")) {
			this.onClose();
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
		if (matchesKey(keyData, "f")) {
			this.fullscreen = !this.fullscreen;
			this.tui.requestRender();
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
		const maxHeight = Math.max(10, Math.floor((this.tui.terminal.rows || 24) * 0.88));
		const headerLines = this.fullscreen ? 0 : 3;
		const footerLines = this.fullscreen ? 0 : 2;
		const innerWidth = Math.max(10, width - 2);
		const contentHeight = Math.max(1, maxHeight - headerLines - footerLines - 2);

		const markdownLines = this.markdown.render(innerWidth);
		this.totalLines = markdownLines.length;
		this.viewHeight = contentHeight;
		const maxScroll = Math.max(0, this.totalLines - contentHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const visibleLines = markdownLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		const lines: string[] = [];
		if (!this.fullscreen) {
			lines.push(this.buildTitleLine(innerWidth));
			lines.push(this.buildMetaLine(innerWidth));
			lines.push("");
		}
		for (const line of visibleLines) {
			lines.push(truncateToWidth(line, innerWidth));
		}
		while (lines.length < headerLines + contentHeight) {
			lines.push("");
		}
		if (!this.fullscreen) {
			lines.push("");
			lines.push(this.buildActionLine(innerWidth));
		}

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
		// Content never changes while open; kept for Component compatibility.
	}

	private scrollBy(delta: number): void {
		const maxScroll = Math.max(0, this.totalLines - this.viewHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, maxScroll));
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
		const close = this.theme.fg("accent", "esc") + this.theme.fg("dim", " close");
		const full = this.theme.fg("accent", "f") + this.theme.fg("dim", " fullscreen");
		const nav = this.theme.fg("dim", "j/k: scroll. ctrl+d/u: half page. ←/→: page.");
		let line = [close, full, nav].join(this.theme.fg("muted", " • "));
		if (this.totalLines > this.viewHeight) {
			const start = Math.min(this.totalLines, this.scrollOffset + 1);
			const end = Math.min(this.totalLines, this.scrollOffset + this.viewHeight);
			line += this.theme.fg("dim", ` ${start}-${end}/${this.totalLines}`);
		}
		return truncateToWidth(line, width);
	}
}

/** Open the overlay; single modal instance, errors surface as notifications. */
async function openSessionPreview(
	ctx: ExtensionCommandContext,
	title: string,
	filePath: string,
	content: string,
): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) =>
			new SessionPreviewOverlay(tui, theme, keybindings, title, filePath, content, done),
		{ overlay: true, overlayOptions: { width: "80%", anchor: "center" } },
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
	let messages: PreviewMessages;
	try {
		messages = await loadPreviewSessionMessages(sessionFile);
	} catch (error) {
		ctx.ui.notify(`Failed to read session: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const text = formatSessionPreview(messages) || "(no messages)";
	await openSessionPreview(ctx, title, sessionFile, text);
}
