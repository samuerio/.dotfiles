/**
 * Session messages → transcript view model.
 *
 * `buildSessionContext` hands out role-dispatch messages; the overlay wants a
 * flat, renderer-friendly item list. This module owns that projection and
 * nothing else.
 *
 * Deliberately pi-free (no `@earendil-works/*` imports, not even type-only):
 * `ContextMessageLike` is the structural minimum the session file yields, so
 * `node --test` can load this module directly. Reusing `textOf` from
 * `session-common.ts` is not an option for the same reason — that module
 * imports pi — hence the local copy below.
 */

/** One way to spell content-part shapes across message roles. */
type ContentPart = {
	type: string;
	text?: string;
	/** pi's `ThinkingContent` stores thought text here, not in `text`. */
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
};

/** A tool call plus whatever result was (or was not) found for it. */
export interface ToolCallView {
	id: string;
	name: string;
	args: unknown;
	/** True when the result exists but its tool call was dropped (post-compaction). */
	argsMissing: boolean;
	result: { content: unknown[]; details?: unknown; isError: boolean } | undefined;
	isError: boolean;
	durationMs?: number;
}

export type TranscriptItem =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "tool"; call: ToolCallView }
	/** bash (`!` command) output, compaction/branch summaries. */
	| { kind: "note"; label: string; text: string };

/**
 * Minimal structural shape shared by the resolved context messages. Fields are
 * per-role and optional on purpose: this describes what any given message may
 * carry, not what every message must carry.
 */
export interface ContextMessageLike {
	role: string;
	/** Only the roles that own a body (user, assistant, toolResult) set this. */
	content?: string | ContentPart[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	durationMs?: number;
	/** Tool result extras the renderers read (edit diffs, read/grep metadata). */
	details?: unknown;
	summary?: string;
	command?: string;
	output?: string;
	exitCode?: number | null;
}

/** Concatenate the text parts of a message body (string bodies are text). */
function textOf(content: string | ContentPart[] | undefined): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const part of content ?? []) {
		if (typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("");
}

/** Tool result bodies are arrays in practice; accept a bare string anyway. */
function resultContent(content: string | ContentPart[] | undefined): unknown[] {
	if (Array.isArray(content)) return content;
	return content ? [{ type: "text", text: content }] : [];
}

export function buildTranscriptItems(messages: ContextMessageLike[]): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	// toolCallId → call view, so a toolResult can backfill an item emitted
	// several messages earlier (pi resolves a parallel batch out of order).
	const pending = new Map<string, ToolCallView>();

	for (const message of messages) {
		switch (message.role) {
			case "user": {
				const text = textOf(message.content).trim();
				if (text) items.push({ kind: "user", text });
				break;
			}
			case "assistant": {
				// Keep part order: a message may be thinking + text + several calls,
				// and the interleaving is what the model actually said.
				const parts: ContentPart[] =
					typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? []);
				for (const part of parts) {
					if (part.type === "text") {
						const text = (part.text ?? "").trim();
						if (text) items.push({ kind: "assistant", text });
					} else if (part.type === "thinking") {
						// Thinking is always its own item: the `full` detail level is the
						// only place it renders, but dropping it here would lose it for good.
						const text = (part.thinking ?? part.text ?? "").trim();
						if (text) items.push({ kind: "thinking", text });
					} else if (part.type === "toolCall") {
						const call: ToolCallView = {
							id: part.id ?? "",
							name: part.name ?? "",
							args: part.arguments,
							argsMissing: false,
							result: undefined,
							isError: false,
						};
						items.push({ kind: "tool", call });
						if (call.id) pending.set(call.id, call);
					}
					// Image parts and unknown part types have nothing to render.
				}
				break;
			}
			case "toolResult": {
				const isError = message.isError === true;
				const result = {
					content: resultContent(message.content),
					details: message.details,
					isError,
				};
				const call = message.toolCallId ? pending.get(message.toolCallId) : undefined;
				if (call) {
					call.result = result;
					call.isError = isError;
					if (typeof message.durationMs === "number") call.durationMs = message.durationMs;
					// Consume the call so a duplicated result shows up on its own
					// instead of silently overwriting the paired one.
					pending.delete(call.id);
				} else {
					// Compaction dropped the assistant message but kept the result;
					// show the result with unknown arguments rather than lose it.
					items.push({
						kind: "tool",
						call: {
							id: message.toolCallId ?? "",
							name: message.toolName ?? "",
							args: undefined,
							argsMissing: true,
							result,
							isError,
							durationMs: message.durationMs,
						},
					});
				}
				break;
			}
			case "bashExecution": {
				const command = message.command ?? "";
				const output = message.output ?? "";
				if (command.trim() || output.trim()) {
					items.push({
						kind: "note",
						label: `bash (exit=${message.exitCode ?? "?"})`,
						text: output ? `$ ${command}\n${output}` : `$ ${command}`,
					});
				}
				break;
			}
			case "compactionSummary":
			case "branchSummary": {
				const text = (message.summary ?? "").trim();
				if (text) items.push({ kind: "note", label: message.role, text });
				break;
			}
			// Unknown roles (custom, system, anything new upstream) are dropped.
		}
	}

	return items;
}
