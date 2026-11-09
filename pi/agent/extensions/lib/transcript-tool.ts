/**
 * Tool-call rendering for transcript observers (btw, session preview).
 *
 * Fork of subagent-manager/src/ui/transcript-tool.ts (upstream commit 0f0349a),
 * lifted into lib/ so a second observer does not fork it again. Calls are
 * rendered through pi's own ToolExecutionComponent and trusted built-in tool
 * renderers, with the observer-safety patches kept intact:
 *   * TUI stub: no execution-lifecycle clock.
 *   * edit.renderCall(argsComplete: false): never re-read today's file per
 *     paint; use the recorded result diff.
 *   * image blocks replaced with text placeholders (no Kitty conversion).
 *   * args/content/details all sanitized; unknown tools use a bounded fallback.
 * Only two additions over that fork: the caller passes the observed session's
 * `cwd` (renderers resolve relative paths against it), and the result's
 * `durationMs` is forwarded so pi can draw its elapsed-time line.
 */

import {
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
} from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";

/** Source-size bound before rendering collapsed content. */
export const TRANSCRIPT_TEXT_LIMIT = 32768;

/** Verbosity for tool boxes and thinking blocks. */
export type Detail = "full" | "preview" | "compact";

/** Sanitize untrusted text before any renderer or wrapper interpolates it. */
export function stripUnsafeTerminalText(value: string): string {
	return stripTerminalSequences(value)
		.replace(/\r\n?/g, "\n")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Only trusted pi built-ins: observing a transcript must never execute extension renderers. */
type RendererPair = Pick<ToolDefinition<any, any>, "renderCall" | "renderResult">;
// The definition cwd only feeds the execute closures, never the render path
// (built-in renderers read `context.cwd` from the component instead), so one
// map serves every observed session.
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
		const bounded = options.expanded ? output : output.slice(0, TRANSCRIPT_TEXT_LIMIT);
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

/**
 * Render one recorded tool call as transcript lines. `cwd` is the observed
 * session's own working directory (session header), not this process's: tool
 * renderers resolve relative paths against it.
 */
export function renderTranscriptTool(
	name: string,
	id: string,
	args: unknown,
	result: unknown,
	isError: boolean,
	running: boolean,
	detail: Detail,
	width: number,
	cwd: string,
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
		cwd,
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
			// Forwarded so pi's component can render its elapsed-time line.
			durationMs: typeof data?.durationMs === "number" ? data.durationMs : undefined,
		},
		running,
	);
	component.setExpanded(detail === "full");
	const lines = component.render(Math.max(3, width));
	if (detail === "compact")
		return lines.filter((line) => stripTerminalSequences(line).trim()).slice(0, 1);
	return lines;
}
