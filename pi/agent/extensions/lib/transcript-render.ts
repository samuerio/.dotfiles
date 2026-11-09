/**
 * Transcript items → terminal lines: the pi-facing half of the session preview.
 *
 * `transcript-items.ts` owns the disk → view-model projection and stays pi-free;
 * this module owns the view model → rendered rows step, which needs pi's themed
 * Markdown and pi's own tool renderers (via `transcript-tool.ts`). Kept apart so
 * the projection can be unit-tested under bare `node --test`.
 *
 * Contract for callers: no raw session text reaches the terminal unsanitized,
 * and the renderer never decides silently to show less. Every item's lines end
 * with a single blank separator row (empty renders produce no rows at all), so
 * the overlay can just sum `lines.length` per item to get its height table.
 */

import { buildSessionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { loadSessionEntries } from "./session-common.ts";
import { buildTranscriptItems, type ContextMessageLike, type TranscriptItem } from "./transcript-items.ts";
import {
	TRANSCRIPT_TEXT_LIMIT,
	renderTranscriptTool,
	stripUnsafeTerminalText,
	type Detail,
} from "./transcript-tool.ts";

/** A loaded transcript: render-ready items plus the cwd the session ran in. */
export interface TranscriptDocument {
	items: TranscriptItem[];
	cwd: string;
}

/**
 * Structural minimum of pi's `Theme`: one color lookup is all a renderer here
 * needs, and a stub (`{ fg: (_c, t) => t }`) makes smoke tests trivial.
 */
export interface RenderTheme {
	fg(color: string, text: string): string;
}

/** Cached theme: token resolution is per-theme global, not per-render. */
const markdownTheme = getMarkdownTheme();

// ─── Loading ──────────────────────────────────────────────────────

/**
 * Read a session file into render-ready items plus the session's own cwd.
 *
 * `cwd` comes from the session header because pi's tool renderers resolve
 * relative paths against the project the session ran in — `process.cwd()` is a
 * different project whenever the preview opens a session from elsewhere.
 */
export function loadTranscriptItems(sessionFile: string): TranscriptDocument {
	const { header, entries } = loadSessionEntries(sessionFile);
	const messages = buildSessionContext(entries, undefined).messages;
	// Structural cast: pi's bashExecution/branchSummary/compactionSummary messages
	// carry no `content`, and ContextMessageLike types every field per-role
	// optional except the ones its own role uses. buildTranscriptItems only reads
	// the fields a role actually has.
	return {
		items: buildTranscriptItems(messages as unknown as ContextMessageLike[]),
		cwd: header?.cwd || process.cwd(),
	};
}

// ─── Text helpers ─────────────────────────────────────────────────

/** Bounded, sanitized plain text: no escapes, no runaway sizes. */
function safeText(value: string): string {
	const safe = stripUnsafeTerminalText(value);
	return safe.length > TRANSCRIPT_TEXT_LIMIT
		? `${safe.slice(0, TRANSCRIPT_TEXT_LIMIT)}\n… [truncated]`
		: safe;
}

/** Wrapped plain text rows, one source line at a time (no re-flow across \n). */
function plainLines(value: string, width: number): string[] {
	return safeText(value)
		.split("\n")
		.flatMap((line) => (line ? wrapTextWithAnsi(line, width) : [""]));
}

/** Same themed markdown (code highlighting included) as pi's main transcript. */
function markdownLines(value: string, width: number): string[] {
	const safe = safeText(value);
	if (!safe.trim()) return [];
	// Failures deliberately propagate: the overlay has a per-item boundary that
	// reports them, and a silent plain-text fallback would hide a real bug.
	return new Markdown(safe, 1, 0, markdownTheme).render(width);
}

/** `theme.fg` with a muted fallback, so a theme missing a color cannot break rendering. */
function fg(theme: RenderTheme, color: string, text: string): string {
	try {
		return theme.fg(color, text);
	} catch {
		return theme.fg("muted", text);
	}
}

// ─── Item rendering ───────────────────────────────────────────────

/**
 * Render one transcript item. `width` is the inner text width (borders already
 * subtracted). Rows are flush-left; the caller owns padding and truncation.
 */
export function renderItem(
	item: TranscriptItem,
	options: { width: number; detail: Detail; cwd: string; theme: RenderTheme },
): string[] {
	const width = Math.max(1, Math.floor(options.width));
	const { detail, cwd, theme } = options;

	let lines: string[];
	switch (item.kind) {
		case "user":
		case "assistant": {
			const label = item.kind === "user" ? "you" : "assistant";
			lines = [theme.fg("accent", label), "", ...markdownLines(item.text, width)];
			break;
		}
		case "thinking": {
			// Thinking is noise outside `full`: the item still exists in the view
			// model so switching detail levels never needs a reload.
			if (detail !== "full") return [];
			lines = [
				theme.fg("muted", "thinking"),
				...plainLines(item.text, width).map((line) => fg(theme, "thinkingText", line)),
			];
			break;
		}
		case "note": {
			lines = [
				theme.fg("muted", stripUnsafeTerminalText(item.label)),
				...plainLines(item.text, width),
			];
			break;
		}
		case "tool": {
			const call = item.call;
			// `durationMs` rides on the result because pi's tool component reads it
			// from there to render its "took Ns" line.
			const result = call.result ? { ...call.result, durationMs: call.durationMs } : undefined;
			lines = renderTranscriptTool(
				call.name,
				call.id,
				call.args,
				result,
				call.isError,
				// No result: the run was killed mid-call or is still streaming.
				result === undefined,
				detail,
				width,
				cwd,
			);
			break;
		}
	}

	return lines.length > 0 ? [...lines, ""] : [];
}
