/**
 * Session review extension (single file): the read_session tool trio +
 * their registration.
 *
 * Registers three read-only tools over pi session JSONL files, kept in one
 * file at this size (no separate read-compaction / read-entry files): the
 * shared parse/resolve/format helpers below serve all three, and the
 * stub-header formats are a contract between the tools, so they are easiest
 * to keep in sync side by side. Sections:
 *
 *   1. read_session           — resolved transcript viewer.
 *   2. read_session_compaction — compaction span reconstruction.
 *   3. read_session_entry      — single-entry drill-down.
 *
 * Custom TUI rendering: each tool has a renderCall (bold toolTitle + muted
 * argument summary, with $HOME collapsed to ~ on paths and short entry-id
 * markers on drills) and a plain renderTranscriptResult styling via the
 * shared width-aware renderSessionResult helper; all of that lives below
 * the parse/format pipeline, right before the extension entry.
 *
 * ─ read_session ─
 * Given a session reference (file path or session id — pi CLI's
 * `--session <path|id>` semantics, see `resolveSessionRef`), returns an
 * envelope line plus the resolved
 * transcript: the active-branch entries with compaction applied, projected
 * to messages.
 *
 * Built on the pure parse/build pipeline exported by
 * `@earendil-works/pi-coding-agent` (`parseSessionEntries` →
 * `migrateSessionEntries` → `buildContextEntries` / `buildSessionContext`).
 * `SessionManager.open()` is never used: it is a live read/write object whose
 * migration may rewrite the file. The only SessionManager surface here is the
 * static read-only metadata lookup `list`/`listAll` inside
 * `resolveSessionRef` (session id → path, mirroring the CLI's
 * `--session <path|id>`); every tool in this module is strictly read-only.
 *
 * `ctx.messages` elements are AgentMessages dispatched by role. Session
 * entry types are projected by `buildSessionContext`:
 *   message("user"/"assistant"/"toolResult"/"bashExecution") → same roles,
 *   custom_message → role "custom", compaction → "compactionSummary",
 *   branch_summary → "branchSummary". (`!` commands are persisted as plain
 *   message entries with role "bashExecution" by recordBashResult, not as a
 *   dedicated entry type.)
 * Other entry types (custom, label, session_info, ...) do not participate
 * in context and are not rendered.
 *
 * Entry ids are re-attached to the rendered output — the drill handles the
 * other two tools need: compactionSummary block headers carry `id=` +
 * `tokensBefore=` (read_session_compaction drills into the original content
 * the compaction replaced); toolResult stubs and bash (`!` command) block
 * headers carry `id=` (read_session_entry drills into the full result /
 * full output); assistant toolCall lines carry `id=` (read_session_entry
 * drills into the calls' full arguments). The ids are recovered by zipping
 * the resolved message list against the resolved entry list
 * (`buildContextEntries` + `sessionEntryToContextMessages` — the same
 * projection `buildSessionContext` uses, so alignment is exact). Tool calls
 * and results also carry a shared truncated toolCallId key ([call_xxxxxxxx])
 * so parallel calls match to their results; it is derived from the message
 * itself, not the entry zip.
 *
 * ─ read_session_compaction ─
 * Reconstructs the exact content a specific compaction entry's summary was
 * derived from (its full docblock sits on the section divider below). The
 * span is rendered through the same `formatTranscript` read_session uses,
 * which is why the intermediate summaries S(1)..S(n-1) are reachable there.
 *
 * ─ read_session_entry ─
 * Drills into the full content behind a read_session stub (its full docblock
 * sits on the section divider below). Notably, subagent tool results carry
 * their full output in `details`, so this tool is the model-side recovery
 * path for that promise.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	buildContextEntries,
	buildSessionContext,
	type ExtensionAPI,
	keyHint,
	sessionEntryToContextMessages,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { expandHome, loadSessionEntries, resolveSessionRef, textOf } from "./lib/session-common.ts";

const TOOL_CALL_ARGS_PREVIEW = 120;
const TOOL_RESULT_ERROR_PREVIEW = 300;
const BASH_OUTPUT_PREVIEW = 300;

// ============================================================================
// Section 1: read_session
// ============================================================================

export const READ_SESSION_DESCRIPTION =
	"Read a pi session JSONL file and return its resolved transcript. Pass a session file path (~ " +
	"expands) or a session id (pi --session semantics: exact id first, then prefix match — current " +
	"project tier before global, most recently modified wins on prefix ambiguity). Id lookup only " +
	"covers sessions under ~/.pi/agent/sessions/<project>/; sessions outside that layout (e.g. " +
	"subagent sessions) are only reachable by path, which a subagent envelope reports as session=. " +
	"Returns the active-branch " +
	"transcript with compaction applied: user/assistant text, tool calls, error results, and " +
	"compaction/branch summaries, plus a trailing envelope line " +
	"(cwd, entry/message counts, thinking level, model) as a footnote. " +
	"compaction/branch summaries. entries= counts context entries while messages= counts rendered " +
	"messages; state-change entries (model_change, thinking_level_change) project to no messages, " +
	"so entries may exceed messages. compactionSummary block headers carry the compaction entry id " +
	"(id=xxxx tokensBefore=N) and branchSummary headers carry fromId=; pass a compaction id to " +
	"read_session_compaction to read the original content that compaction replaced. Tool calls and results carry a " +
	"shared truncated toolCallId key ([call-xxxx]) so parallel calls match to their results. Entry ids are the drill " +
	"handles for read_session_entry: toolResult stubs (## toolResult:<name> (id=xxxx, ~size)) → full result content, " +
	"toolCall lines (→ name(args) [call-xxxx] (id=xxxx)) → full call arguments, bash blocks (## bash (exit=N)) → the " +
	"command and its output, folded to a one-line preview with a trailing " +
	"[truncated, full output: read_session_entry id=xxxx] marker when over 300 chars (the id lives only in that " +
	"marker — short outputs are fully rendered and need no drill), and successful toolResult stubs carry a " +
	"~size (result text length) telling whether the full result is worth drilling. Read-only. " +
	"Pass leafId to inspect a specific branch tip; omit it for the current leaf (the file's last " +
	"entry).";

export const ReadSessionParams = Type.Object({
	session: Type.String({
		description:
			"Session file path (contains / or \\, or ends .jsonl; ~ expands to the home directory) or a session id (uuid or unambiguous prefix).",
	}),
	leafId: Type.Optional(
		Type.String({
			description:
				"Optional entry id: return the branch ending at this entry instead of the current leaf. Unknown ids fall back to the latest entry.",
		}),
	),
});

export interface ReadSessionDetails {
	path: string;
	/**
	 * Resolved active-branch entry count (`buildContextEntries(sessionEntries, leafId).length`):
	 * the entries that back the returned transcript, after branch/compaction resolution.
	 * NOT the raw on-disk entry total (which also counts other branches and entries that a
	 * compaction summarized away).
	 */
	entryCount: number;
	/** Resolved active-branch message count (`context.messages.length`). */
	messageCount: number;
}

/** One-line, whitespace-collapsed preview. */
function preview(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max)}...` : line;
}

/**
 * Approximate human-readable size of recoverable content, for stub headers.
 * Counted in UTF-16 chars (not bytes), hence the `~` prefix at call sites.
 */
function formatSize(chars: number): string {
	if (chars < 1024) return `${chars}B`;
	if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)}KB`;
	return `${(chars / (1024 * 1024)).toFixed(1)}MB`;
}

function formatToolCallArgs(args: Record<string, unknown>): string {
	let json: string;
	try {
		json = JSON.stringify(args);
	} catch {
		json = "(unserializable arguments)";
	}
	return preview(json, TOOL_CALL_ARGS_PREVIEW);
}

/**
 * Display key linking a tool call to its result: the toolCallId, truncated
 * to the `call_` prefix + first 8 hex (13 chars). Both the toolCall part
 * `id` and the toolResult message `toolCallId` truncate identically, so
 * parallel calls stay matchable. Collision-free within one session (a 50%
 * prefix-collision chance would need ~100k calls).
 */
function shortToolCallId(id: string | undefined): string | undefined {
	if (!id) return undefined;
	return id.length > 13 ? id.slice(0, 13) : id;
}

/**
 * Format the resolved transcript. Dispatch on message role — NOT on session
 * entry type (entry types are projected away by buildSessionContext; see the
 * module docblock for the mapping).
 */
function formatTranscript(
	messages: readonly AgentMessage[],
	annotations: ReadonlyMap<number, string> = new Map(),
): string {
	const blocks: string[] = [];
	for (const [index, msg] of messages.entries()) {
		switch (msg.role) {
			case "user": {
				const text = textOf(msg.content).trim();
				if (text) blocks.push(`## user\n${text}`);
				break;
			}
			case "assistant": {
				// Entries carrying toolCall parts are annotated with id= (the
				// drill handle for the calls' full arguments via
				// read_session_entry). Line rule: content first (tool name +
				// args blob), metadata last ([call_xxx] match key + (id=...)),
				// mirroring the trailing handles on stub and bash blocks.
				const note = annotations.get(index);
				const idTag = note ? `(${note})` : "";
				const lines: string[] = [];
				for (const part of msg.content) {
					if (part.type === "text") {
						const text = part.text.trim();
						if (text) lines.push(text);
					} else if (part.type === "toolCall") {
						const cid = shortToolCallId(part.id);
						const tail = [cid ? `[${cid}]` : undefined, idTag].filter(Boolean).join(" ");
						const body = `${part.name}(${formatToolCallArgs(part.arguments)})`;
						lines.push(tail ? `→ ${body} ${tail}` : `→ ${body}`);
					}
					// thinking parts are skipped
				}
				if (lines.length > 0) blocks.push(`## assistant\n${lines.join("\n")}`);
				break;
			}
			case "toolResult": {
				// Every result renders a one-line stub: [call-key] links it back
				// to the assistant tool call (so parallel calls match their
				// results); id= is the session-entry drill handle for
				// read_session_entry. The trailing ~size is the result text
				// length (chars), telling the reader which stubs are worth
				// drilling and which are not. Errors keep a short preview
				// No annotation (zip dropped) → no stub, as before.
				const note = annotations.get(index);
				const callKey = shortToolCallId(msg.toolCallId);
				const cid = callKey ? `[${callKey}] ` : "";
				if (msg.isError) {
					const text = textOf(msg.content).trim();
					blocks.push(
						`## toolResult:${msg.toolName} ${cid}(error${note ? `, ${note}` : ""})${text ? `\n${preview(text, TOOL_RESULT_ERROR_PREVIEW)}` : ""}`,
					);
				} else if (note) {
					blocks.push(
						`## toolResult:${msg.toolName} ${cid}(${note}, ~${formatSize(textOf(msg.content).length)})`,
					);
				}
				break;
			}
			case "custom": {
				const text = textOf(msg.content).trim();
				if (text) blocks.push(`## custom:${msg.customType}\n${text}`);
				break;
			}
			case "bashExecution": {
				// Unlike stubs and toolCall lines (which render no content and
				// need a permanent id), bash blocks render the output itself:
				// the drill handle is only needed when the output is folded,
				// so the id lives in the truncation marker, not the header.
				// The marker is EXPLICIT for a reason: a bare `...` ending has
				// been misread as a truncated transcript.
				const note = annotations.get(index);
				const full = msg.output ? msg.output.replace(/\s+/g, " ").trim() : "";
				const output =
					full.length > BASH_OUTPUT_PREVIEW
						? `${full.slice(0, BASH_OUTPUT_PREVIEW)}${note ? ` ⋯ [truncated, full output: read_session_entry ${note}]` : " ⋯ [truncated]"}`
						: full;
				blocks.push(
					`## bash (exit=${msg.exitCode ?? "?"})\n$ ${msg.command}${output ? `\n${output}` : ""}`,
				);
				break;
			}
			case "compactionSummary": {
				const note = annotations.get(index);
				blocks.push(`## compactionSummary${note ? ` (${note})` : ""}\n${msg.summary.trim()}`);
				break;
			}
			case "branchSummary": {
				const note = annotations.get(index);
				blocks.push(`## branchSummary${note ? ` (${note})` : ""}\n${msg.summary.trim()}`);
				break;
			}
		}
	}
	return blocks.join("\n\n");
}

/**
 * Re-attach compaction/branch entry ids to resolved messages. Zips the
 * resolved entry list against the message list through the same deterministic
 * projection `buildSessionContext` uses
 * (`buildContextEntries(...).flatMap(sessionEntryToContextMessages)` — every
 * entry yields 0/1 messages in order), so alignment is exact even across
 * branches and duplicate texts.
 *
 * compactionSummary messages get `id=` + `tokensBefore=`; branchSummary
 * messages get `fromId=`; toolResult and bashExecution (`!` command) messages
 * get `id=` (the drill handles for read_session_entry, rendered on the stub /
 * block header); assistant messages with toolCall parts get `id=` (stamped on
 * each `→` line, the drill handle for the calls' full arguments). Everything
 * else is only consistency-checked.
 * Purely defensive against upstream projection changes: on ANY inconsistency
 * (count or entry-type/message-role pair) drop all annotations rather than
 * risk stamping a wrong id.
 */
function alignAnnotations(
	entries: readonly SessionEntry[],
	messages: readonly AgentMessage[],
): ReadonlyMap<number, string> {
	const annotations = new Map<number, string>();
	let msgIdx = 0;
	for (const entry of entries) {
		for (const msg of sessionEntryToContextMessages(entry)) {
			let note: string | undefined;
			switch (entry.type) {
				case "compaction":
					if (msg.role !== "compactionSummary") return new Map();
					note = `id=${entry.id} tokensBefore=${entry.tokensBefore}`;
					break;
				case "branch_summary":
					if (msg.role !== "branchSummary") return new Map();
					note = `fromId=${entry.fromId}`;
					break;
				case "message":
					// user: fully rendered, no drill needed. assistant: annotated when
					// it carries toolCall parts (the drill handle for the call's full
					// arguments via read_session_entry). toolResult and bashExecution
					// (`!` commands, persisted as plain message entries by
					// recordBashResult) always carry the entry id: the drill handles
					// for the full result / full output via read_session_entry.
					if (msg.role === "assistant") {
						if (msg.content.some((part) => part.type === "toolCall")) note = `id=${entry.id}`;
					} else if (msg.role === "toolResult" || msg.role === "bashExecution") {
						note = `id=${entry.id}`;
					} else if (msg.role !== "user") {
						// Unknown role: projection semantics changed, zip cannot be trusted.
						return new Map();
					}
					break;
				case "custom_message":
					if (msg.role !== "custom") return new Map();
					break;
				default:
					// custom/label/session_info/model_change/thinking_level_change
					// entries project to zero messages; any output here means the
					// projection semantics changed and the zip cannot be trusted.
					return new Map();
			}
			if (note) annotations.set(msgIdx, note);
			msgIdx++;
		}
	}
	return msgIdx === messages.length ? annotations : new Map();
}

/**
 * Parse, migrate, and resolve a session file, then format the transcript +
 * tail envelope. `session` is a file path or a session id (see
 * `resolveSessionRef`). Throws with a descriptive message when the reference
 * does not resolve or the file is unreadable.
 */
export async function readSession(
	session: string,
	leafId: string | undefined,
): Promise<{ text: string; details: ReadSessionDetails }> {
	const sessionPath = await resolveSessionRef(session);
	const { filePath, header, entries: sessionEntries } = loadSessionEntries(sessionPath);

	const context = buildSessionContext(sessionEntries, leafId);
	// The resolved active-branch entry list (post branch/compaction) — exactly the entries
	// buildSessionContext projects into context.messages. Reported as entries= so it pairs
	// with messages= on the same resolution instead of the raw on-disk total.
	const contextEntries = buildContextEntries(sessionEntries, leafId);
	const annotations = alignAnnotations(contextEntries, context.messages);
	const envelopeParts = [
		// No session=/id= echo: the caller passed the path or the id and
		// can reuse it for every drill tool (they accept both forms). The
		// resolved path stays in details for TUI/debugging.
		header?.cwd ? `cwd=${header.cwd}` : undefined,
		`entries=${contextEntries.length}`,
		`messages=${context.messages.length}`,
		`thinkingLevel=${context.thinkingLevel}`,
		context.model?.provider && context.model?.modelId
			? `model=${context.model.provider}/${context.model.modelId}`
			: undefined,
	].filter((part): part is string => part !== undefined);

	const transcript = formatTranscript(context.messages, annotations);
	// Envelope is a tail footnote, not a header: it is provenance metadata
	// (file, counts, model), while the collapsed TUI preview shows the first
	// visual lines — those should be transcript content, not metadata. One
	// blank line separates body and footnote.
	const text = `${transcript || "(no messages)"}\n\n[${envelopeParts.join(" ")}]`;

	return {
		text,
		details: { path: filePath, entryCount: contextEntries.length, messageCount: context.messages.length },
	};
}

// ============================================================================
// Section 2: read_session_compaction
// ============================================================================

/**
 * Reconstruct the exact content a specific compaction entry's summary was
 * derived from.
 *
 * A compaction's summary is `update(previousSummary, newly-expired raw)`, so
 * its input is two things: the previous compaction's summary S(n-1) and the
 * raw messages that just stopped being recent. This tool returns both.
 *
 * Derivation (mirrors pi's repeated-compaction rule, #2608): resolve the live
 * context as it was right before this compaction fired by calling
 * `buildContextEntries(entries, target.parentId)` — the entry just before the
 * compaction is the leaf. That drops the previous compaction's summarized
 * prefix and hoists its summary to the front, yielding
 * [S(n-1)] + [raw up to target.parent]. Then cut off everything at/after the
 * target's `firstKeptEntryId` (its new retained tail, which it did not
 * summarize). What remains is exactly what this compaction folded in.
 *
 * The span is rendered whole through the same `formatTranscript` read_session
 * uses: the previous compaction renders as its native `compactionSummary`
 * block at the top, followed by the raw messages. This is why the
 * intermediate summaries S(1)..S(n-1) are reachable here — each S(k) surfaces
 * exactly once, as the compactionSummary block of compaction C_{k+1}. Output
 * is untruncated (both the summary and the raw are the requested content).
 *
 * Abandoned-branch compactions are not discoverable via `read_session` (only
 * the active branch is resolved) but remain drillable here: the resolution
 * follows `target.parent`'s own parent chain.
 */

export const READ_SESSION_COMPACTION_DESCRIPTION =
	"Reconstruct the content a specific compaction's summary was derived from: the previous " +
	"compaction summary plus the raw messages that compaction summarized. Pass a pi session (file " +
	"path or session id, same rules as read_session) and a compaction entry id (from a compactionSummary " +
	"block header in read_session output). Returns the previous summary as a compactionSummary " +
	"block, then the raw messages summarized, plus a trailing envelope line (counts, " +
	"span=<firstRawId>..<firstKeptEntryId>). For the first compaction there is no previous " +
	"summary, so only the raw is returned. Output is not truncated. Read-only.";

export const ReadSessionCompactionParams = Type.Object({
	session: Type.String({
		description:
			"Session file path (contains / or \\, or ends .jsonl; ~ expands to the home directory) or a session id (uuid or unambiguous prefix).",
	}),
	entryId: Type.String({
		description:
			"Compaction entry id to drill into. Ids are listed on compactionSummary block headers in read_session output (id=xxxx tokensBefore=N).",
	}),
});

export interface ReadSessionCompactionDetails {
	path: string;
	/** Raw on-disk entry total (whole session file, before any resolution). */
	entryCount: number;
	/** Messages in the returned body: the previous-summary block(s) + the summarized raw. */
	messageCount: number;
	/** Entries in the cut span (previous compaction + summarized raw), before projection. */
	spanEntryCount: number;
}

/**
 * Locate the target compaction entry, slice its summarized span off the
 * parent-chain path, render the span raw, and wrap it in an envelope.
 * `session` is a file path or a session id (see `resolveSessionRef`). Throws
 * with a descriptive message for unresolvable session references, unknown
 * ids, non-compaction ids, and unreadable files.
 */
export async function readSessionCompaction(
	session: string,
	entryId: string,
): Promise<{ text: string; details: ReadSessionCompactionDetails }> {
	const sessionPath = await resolveSessionRef(session);
	const { filePath, header, entries: sessionEntries } = loadSessionEntries(sessionPath);

	const target = sessionEntries.find((entry) => entry.id === entryId);
	if (!target) {
		throw new Error(
			`read_session_compaction: no entry with id "${entryId}" in ${filePath} (${sessionEntries.length} entries). ` +
				"Compaction ids are listed on compactionSummary block headers in read_session output.",
		);
	}
	if (target.type !== "compaction") {
		throw new Error(`read_session_compaction: entry "${entryId}" is a ${target.type} entry, not a compaction entry.`);
	}

	// Reconstruct the live context as it was right before this compaction
	// fired: the entry just before the compaction (target.parentId) is the
	// leaf. buildContextEntries drops the previous compaction's summarized
	// prefix and hoists its summary to the front, giving
	// [S(n-1)] + [raw up to target.parent] — the exact input this compaction's
	// update consumed (the #2608 repeated-compaction rule lives upstream, so
	// we inherit it). Guard the leaf: buildSessionPath silently falls back to
	// the global latest entry for a falsy/unknown leafId, which would resolve
	// the wrong branch.
	if (!target.parentId) {
		throw new Error(
			`read_session_compaction: compaction entry "${target.id}" has no parent entry; cannot resolve the pre-compaction context.`,
		);
	}
	const contextEntries = buildContextEntries(sessionEntries, target.parentId);

	// This compaction kept everything from firstKeptEntryId onward as its new
	// retained tail; that tail is NOT part of what it summarized. Cut it off:
	// keep strictly the entries before firstKeptEntryId (the previous summary +
	// the newly-expired raw). Dangling firstKeptEntryId -> keep everything.
	const cutIdx = contextEntries.findIndex((entry) => entry.id === target.firstKeptEntryId);
	const span = cutIdx >= 0 ? contextEntries.slice(0, cutIdx) : contextEntries;

	// Render the whole span (previous summary + raw) with the same formatter
	// read_session uses; the previous compaction renders as its native
	// compactionSummary block at the top.
	const messages = span.flatMap(sessionEntryToContextMessages);
	const spanText = formatTranscript(messages, alignAnnotations(span, messages));
	const body = spanText || "(no summarized content for this compaction)";

	// The raw entry range this compaction covered, for the envelope span=.
	// Skip the hoisted previous-summary block so the range spans raw entries.
	const firstRaw = span.find((entry) => entry.type !== "compaction");

	const envelopeParts = [
		// No session=/id= echo, same rationale as read_session: the caller
		// passed the ref and can reuse it; the path stays in details.
		header?.cwd ? `cwd=${header.cwd}` : undefined,
		`entries=${sessionEntries.length}`,
		`messages=${messages.length}`,
		`span=${firstRaw?.id ?? "?"}..${target.firstKeptEntryId}`,
	].filter((part): part is string => part !== undefined);

	// Tail footnote envelope, same rationale as read_session.
	const text = `${body}\n\n[${envelopeParts.join(" ")}]`;

	return {
		text,
		details: {
			path: filePath,
			entryCount: sessionEntries.length,
			messageCount: messages.length,
			spanEntryCount: span.length,
		},
	};
}

// ============================================================================
// Section 3: read_session_entry
// ============================================================================

/**
 * Drill into the full content of a specific entry inside a pi session.
 *
 * `read_session` renders the transcript as compact stubs: tool results as
 * one-line `## toolResult:<name> (id=xxxx, ~size)` stubs (errors keep a short
 * preview), tool calls as `→ name(120-char args preview) [call_xxx] (id=xxxx)` lines, and `!`
 * bash commands as `## bash (exit=N)` blocks with 300-char output
 * previews. The full content behind those stubs — tool results (including
 * `details`, where subagent results keep their full untruncated output),
 * tool call arguments, bash output — is what the agent actually saw, and it
 * is unreachable any other way: session JSONL lines are far too long for the
 * native read tool. This tool takes a stub's `id=` and returns the complete
 * content, untruncated, dispatched on the target entry's kind:
 *
 *   - toolResult message  → full text parts + non-text placeholders +
 *                           `details` rendered as JSON.
 *   - bashExecution message (`!` commands are persisted as plain message
 *     entries by recordBashResult) → `$ command` + the full multiline
 *     output, verbatim (no one-line collapsing, no preview cut).
 *   - assistant message with toolCall parts → each call's name + full
 *     pretty-printed arguments (the counterpart to the 120-char preview).
 *   - custom_message entry → the full text of `content` (string content
 *     verbatim; array content's text parts joined with blank lines; image and
 *     other non-text parts are silently skipped). `details` is extension-
 *     internal metadata and is NOT returned.
 *   - branch_summary entry → the `summary` text in full.
 *   - user message → the full text (`textOf`: text parts only, non-text
 *     parts silently ignored).
 *
 * Same discovery → drill pairing as `read_session_compaction`: the stub
 * header formats are the contract between the tools.
 *
 * Strictly read-only (no `SessionManager.open()`); `session` accepts a path
 * or id via `resolveSessionRef`; output is untruncated by design — re-reads
 * of sessions collapse stubs via `formatTranscript`, so size does not
 * compound.
 */

export const READ_ENTRY_DESCRIPTION =
	"Read the full content of a specific entry inside a pi session — the content a read_session " +
	"stub truncates. Pass a session (file path or session id, same rules as read_session) and an " +
	"entry id — the id= on a ## toolResult:<name> (id=xxxx, ~size) stub line, on a → tool-call line " +
	"(→ name(args) [call-xxxx] (id=xxxx)), or in the [truncated, full output: read_session_entry id=xxxx] marker of " +
	"a ## bash (exit=N) block whose output was folded, in read_session " +
	"output or read_session_compaction span output. Returns the complete content dispatched by " +
	"entry kind: toolResult → text parts verbatim, non-text parts as placeholders, and the tool's " +
	"details rendered as JSON when present (subagent results keep their full output in details); " +
	"bashExecution (`!` command) → the command plus its full multiline output; assistant toolCall " +
	"→ each call's full pretty-printed arguments; custom_message → the full text of its content " +
	"(non-text parts are not rendered; details is extension-internal metadata and is not returned); " +
	"branch_summary → the summary text in full; user message → the full text. Untruncated. Read-only.";

export const ReadEntryParams = Type.Object({
	session: Type.String({
		description:
			"Session file path (contains / or \\, or ends .jsonl; ~ expands to the home directory) or a session id (uuid or unambiguous prefix).",
	}),
	entryId: Type.String({
		description:
			"Entry id to drill into. Ids are listed on ## toolResult:<name> (id=xxxx, ~size) stub lines, → tool-call lines (→ name(args) [call-xxxx] (id=xxxx)), and in the [truncated, full output: read_session_entry id=xxxx] marker of folded ## bash (exit=N) blocks in read_session output and read_session_compaction span output; ids for user, custom_message, and branch_summary entries come from the entry= handle on search_sessions hits.",
	}),
});

export interface ReadEntryDetails {
	path: string;
	entryCount: number;
	/** Resolved entry kind — filled at execute time (renderCall only has the id). */
	kind: "toolResult" | "bashExecution" | "toolCall" | "customMessage" | "branchSummary" | "user";
	/** kind=toolResult. */
	tool?: string;
	callId?: string;
	isError?: boolean;
	/** kind=bashExecution. */
	command?: string;
	exitCode?: number;
	/** kind=toolCall. */
	calls?: number;
	/** kind=toolCall. Compact TUI preview lines: `name {json}` per call. */
	preview?: string;
	/** kind=customMessage. */
	customType?: string;
	/** kind=customMessage. TUI display flag of the originating custom_message entry. */
	display?: boolean;
	/** kind=branchSummary. Id of the entry the branch forked from. */
	fromId?: string;
}

type ToolResultAgentMessage = Extract<AgentMessage, { role: "toolResult" }>;
type BashExecutionAgentMessage = Extract<AgentMessage, { role: "bashExecution" }>;
type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;

/**
 * Render the full content of a tool result message: text parts verbatim,
 * non-text parts as bracketed placeholders, then `details` as pretty-printed
 * JSON when present (details carry e.g. a subagent's full untruncated output).
 */
function renderToolResultContent(msg: ToolResultAgentMessage): string {
	const blocks: string[] = [];
	for (const part of msg.content) {
		if (part.type === "text") blocks.push(part.text);
		else if (part.type === "image") blocks.push("[image part omitted]");
		else blocks.push("[unknown part]");
	}
	if (msg.details !== undefined) {
		let json: string;
		try {
			json = JSON.stringify(msg.details, null, 2);
		} catch {
			json = "(unserializable details)";
		}
		blocks.push(`## details\n${json}`);
	}
	return blocks.join("\n\n").trim();
}

/**
 * Render the full content of a bashExecution message (`!` command): the
 * command followed by its output verbatim — no whitespace collapsing, no
 * preview cut (read_session's `## bash` block previews only 300 collapsed
 * chars; this is the recovery path for the rest).
 */
function renderBashExecutionContent(msg: BashExecutionAgentMessage): string {
	const blocks = [`$ ${msg.command}`];
	if (msg.output) blocks.push(msg.output);
	return blocks.join("\n\n").trim();
}

/**
 * Render the full toolCall parts of an assistant message: each call's name
 * plus its complete arguments pretty-printed (the counterpart to
 * read_session's 120-char one-line preview).
 */
function renderAssistantToolCallsContent(msg: AssistantAgentMessage): string {
	const blocks: string[] = [];
	for (const part of msg.content) {
		if (part.type !== "toolCall") continue;
		let json: string;
		try {
			json = JSON.stringify(part.arguments, null, 2);
		} catch {
			json = "(unserializable arguments)";
		}
		blocks.push(`## toolCall ${part.name}${part.id ? ` [${part.id}]` : ""}\n${json}`);
	}
	return blocks.join("\n\n").trim();
}

/**
 * Locate the target entry and render its full content verbatim (no envelope:
 * the transcript stub already carries the identity metadata). Dispatches
 * first on the entry's type (custom_message / branch_summary entries drill
 * directly), then on the message role within message entries; throws with a
 * descriptive
 * message for unresolvable session references, unknown ids, and entry kinds
 * with nothing to drill into (state-metadata entry types project no
 * transcript content; compaction entries belong to read_session_compaction).
 */
export async function readSessionEntry(
	session: string,
	entryId: string,
): Promise<{ text: string; details: ReadEntryDetails }> {
	const sessionPath = await resolveSessionRef(session);
	const { filePath, entries: sessionEntries } = loadSessionEntries(sessionPath);

	const target = sessionEntries.find((entry) => entry.id === entryId);
	if (!target) {
		throw new Error(
			`read_session_entry: no entry with id "${entryId}" in ${filePath} (${sessionEntries.length} entries). ` +
				"Entry ids are listed on ## toolResult:<name> (id=xxxx, ~size) stub lines, → tool-call lines (→ name(args) [call-xxxx] (id=xxxx)), " +
				"and in the truncation marker of folded ## bash (exit=N) blocks in read_session output.",
		);
	}
	let body: string;
	let kind: ReadEntryDetails["kind"];
	let kindDetails: Partial<ReadEntryDetails> = {};
	if (target.type === "custom_message") {
		// details is extension-internal metadata (never sent to the LLM), so
		// it is deliberately NOT rendered into the body; it surfaces only via
		// the customType/display fields in the returned details.
		body =
			typeof target.content === "string"
				? target.content
				: target.content
						.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
						.filter((text) => text !== "")
						.join("\n\n");
		if (!body.trim()) body = "(no text content)";
		kind = "customMessage";
		kindDetails = { customType: target.customType, display: target.display };
		return { text: body, details: { path: filePath, entryCount: sessionEntries.length, kind, ...kindDetails } };
	} else if (target.type === "branch_summary") {
		// The upstream projection only emits a message when summary exists;
		// a missing summary means there is nothing to drill into.
		if (!target.summary) {
			throw new Error(`read_session_entry: branch_summary entry "${entryId}" carries no summary.`);
		}
		body = target.summary;
		kind = "branchSummary";
		kindDetails = { fromId: target.fromId };
		return { text: body, details: { path: filePath, entryCount: sessionEntries.length, kind, ...kindDetails } };
	} else if (target.type === "compaction") {
		// Compaction entries DO project (compactionSummary blocks in
		// read_session, annotated id= tokensBefore=) and DO have drillable
		// content — just not here: read_session_compaction reconstructs the
		// original messages the summary replaced.
		throw new Error(
			`read_session_entry: entry "${entryId}" is a compaction entry. Use read_session_compaction for compaction entries.`,
		);
	} else if (target.type !== "message") {
		throw new Error(
			`read_session_entry: entry "${entryId}" is a ${target.type} entry; ${target.type} entries are ` +
				"state metadata that do not project into the transcript and carry no drillable content.",
		);
	}
	const msg = target.message;

	if (msg.role === "toolResult") {
		const toolMsg: ToolResultAgentMessage = msg;
		body = renderToolResultContent(toolMsg) || "(empty tool result)";
		kind = "toolResult";
		kindDetails = { tool: toolMsg.toolName, callId: toolMsg.toolCallId, isError: toolMsg.isError };
	} else if (msg.role === "bashExecution") {
		const bashMsg: BashExecutionAgentMessage = msg;
		body = renderBashExecutionContent(bashMsg) || "(no output)";
		kind = "bashExecution";
		kindDetails = { command: bashMsg.command, exitCode: bashMsg.exitCode };
	} else if (msg.role === "assistant") {
		const assistantMsg: AssistantAgentMessage = msg;
		body = renderAssistantToolCallsContent(assistantMsg);
		kind = "toolCall";
		if (!body) {
			throw new Error(
				`read_session_entry: assistant entry "${entryId}" carries no tool calls (its text is already rendered in full by read_session).`,
			);
		}
		const calls = assistantMsg.content.filter((part) => part.type === "toolCall").length;
		kindDetails = {
			calls,
			preview: assistantMsg.content
				.filter((part) => part.type === "toolCall")
				.map((part) => `${part.name} ${JSON.stringify(part.arguments)}`)
				.join("\n"),
		};
	} else if (msg.role === "user") {
		// Defensive: search hits should only ever land here for entries that
		// carry text, but handle the empty case instead of returning "".
		body = textOf(msg.content) || "(no text)";
		kind = "user";
		kindDetails = {};
	} else {
		throw new Error(
			`read_session_entry: entry "${entryId}" is a message with unexpected role "${msg.role}"; only toolResult, bashExecution, and assistant-with-toolCalls messages carry drillable content.`,
		);
	}

	// No envelope: the caller just saw this entry's stub in the read_session
	// transcript (tool name, call id, command, exit code are all on the stub
	// line / block header), so echoing them back adds nothing. Identity
	// metadata stays in details for TUI/debugging.
	return { text: body, details: { path: filePath, entryCount: sessionEntries.length, kind, ...kindDetails } };
}

// ============================================================================
// TUI rendering helpers + extension entry
// ============================================================================

/**
 * Shared result renderer for the session viewers. ToolExecutionComponent
 * stacks the call line and the result with no gap, so the renderer
 * self-supplies the leading blank line (same trick as the built-in
 * bash/read renderers). Collapsed: FIRST 5 visual lines at the current
 * terminal width (long lines wrap first, so the preview never exceeds 5
 * screen rows), plus the read renderer's "more lines" hint. Built as a
 * width-aware component because ToolRenderResultOptions carries no width.
 */
function renderSessionResult(styled: string, expanded: boolean, theme: any) {
	if (!expanded) {
		const state: { width?: number; lines?: string[]; skipped?: number } = {};
		const lead = [""];
		return {
			render: (width: number) => {
				if (state.lines === undefined || state.width !== width) {
					const all = new Text(styled, 0, 0).render(width);
					state.lines = all.slice(0, 5);
					state.skipped = Math.max(0, all.length - 5);
					state.width = width;
				}
				const hint =
					state.skipped && state.skipped > 0
						? [
								theme.fg("muted", `... (${state.skipped} more lines,`) +
									` ${keyHint("app.tools.expand", "to expand")}` +
									theme.fg("muted", ")"),
							]
						: [];
				return [...lead, ...state.lines, ...hint];
			},
			invalidate: () => {
				state.width = undefined;
				state.lines = undefined;
				state.skipped = undefined;
			},
		};
	}
	// Expanded: full content.
	return new Text(`\n${styled}`, 0, 0);
}

/**
 * Display-only path shortening, matching the built-in read renderer's
 * convention (see the show_markdown viewer work): cwd-relative when the
 * path lives under the process cwd, otherwise the $HOME prefix collapsed
 * to `~`. Purely cosmetic (expandHome reverses both forms); used in
 * renderCall text.
 */
function shortenPath(p: string): string {
	const resolved = path.resolve(p);
	if (resolved === process.cwd() || resolved.startsWith(process.cwd() + path.sep)) {
		return path.relative(process.cwd(), resolved);
	}
	const home = os.homedir();
	return resolved.startsWith(home) ? `~${resolved.slice(home.length)}` : resolved;
}

/**
 * Drill-call line builder shared by all three session tools' renderCall:
 * bold toolTitle + muted argument summary, reusing the component slot the
 * harness already allocated.
 */
function drillCallComponent(theme: any, context: any, title: string, muted: string) {
	const text = theme.fg("toolTitle", theme.bold(`${title} `)) + theme.fg("muted", muted);
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	component.setText(text);
	return component;
}

/**
 * Shared renderCall for the two drill tools (`read_session_compaction`,
 * `read_session_entry`): fires before execute, when only session + entryId
 * are known, so highlight just the drill id (the thing the stubs in
 * read_session output reference). The session file is omitted: drills
 * immediately follow a read_session call, so the session context is
 * implied.
 */
function renderDrillCall(toolName: string, args: Record<string, unknown>, theme: any, context: any) {
	const entryId = typeof args.entryId === "string" ? args.entryId : "";
	const shortId = entryId ? entryId.slice(0, 8) : "?";
	return drillCallComponent(theme, context, toolName, shortId);
}

/**
 * Plain-text result renderer for `read_session` / `read_session_compaction`.
 * Styling matches read_session_entry exactly: per-line toolOutput coloring
 * (transcript has no `## details` marker lines, so the dim special case
 * doesn't apply), separator blank line + collapsed preview from the shared
 * helper. Error results dye the whole message error-colored with no
 * leading blank, matching read_session_entry's throw path.
 */
function renderTranscriptResult(result: any, opts: { expanded: boolean }, theme: any, context: any) {
	const content = result.content
		.map((part: any) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("");
	if (context.isError) return new Text(theme.fg("error", content), 0, 0);
	const styled = content.split("\n").map((line: string) => theme.fg("toolOutput", line)).join("\n");
	return renderSessionResult(styled, opts.expanded, theme);
}

export default function (pi: ExtensionAPI) {
	// --- read_session: read-only viewer for pi session JSONL files. Custom
	// renderResult only self-supplies the call/result separator blank line
	// (ToolExecutionComponent stacks them with no gap); collapsed preview
	// and expansion come from the shared renderSessionResult helper.
	pi.registerTool({
		name: "read_session",
		label: "Read Session",
		description: READ_SESSION_DESCRIPTION,
		parameters: ReadSessionParams,

		// renderCall: bold title + muted session ref (path with $HOME collapsed
		// to ~; id form shown as passed so it stays copyable into a drill
		// tool) plus a short leaf marker when leafId is set.
		renderCall(args, theme, context) {
			const session = typeof args.session === "string" ? args.session : "";
			const leafId = typeof args.leafId === "string" ? args.leafId : "";
			const muted = [session ? shortenPath(session) : "?", leafId ? `leaf=${leafId.slice(0, 8)}` : ""]
				.filter(Boolean)
				.join(" ");
			return drillCallComponent(theme, context, "read_session", muted);
		},
		async execute(_toolCallId, params): Promise<AgentToolResult<ReadSessionDetails>> {
			const { text, details } = await readSession(params.session, params.leafId);
			return { content: [{ type: "text", text }], details };
		},
		renderResult: renderTranscriptResult,
	});

	// --- read_session_compaction: drill into the original content a compaction
	// entry replaced. Same plain-text rendering pattern as read_session
	// (renderTranscriptResult: separator blank line + collapsed preview).
	pi.registerTool({
		name: "read_session_compaction",
		label: "Read Session Compaction",
		description: READ_SESSION_COMPACTION_DESCRIPTION,
		parameters: ReadSessionCompactionParams,
		renderCall: (args, theme, context) => renderDrillCall("read_session_compaction", args, theme, context),

		async execute(_toolCallId, params): Promise<AgentToolResult<ReadSessionCompactionDetails>> {
			const { text, details } = await readSessionCompaction(params.session, params.entryId);
			return { content: [{ type: "text", text }], details };
		},
		renderResult: renderTranscriptResult,
	});

	// --- read_session_entry: drill into the full content of a specific entry
	// (tool result / tool call arguments / bash output — the id= on the
	// matching stub in read_session output). Rendering follows the other
	// session viewers (renderSessionResult: separator blank line + preview).
	pi.registerTool({
		name: "read_session_entry",
		label: "Read Session Entry",
		description: READ_ENTRY_DESCRIPTION,
		parameters: ReadEntryParams,

		async execute(_toolCallId, params): Promise<AgentToolResult<ReadEntryDetails>> {
			const { text, details } = await readSessionEntry(params.session, params.entryId);
			return { content: [{ type: "text", text }], details };
		},

		renderCall: (args, theme, context) => renderDrillCall("read_session_entry", args, theme, context),

		renderResult(result, { expanded }, theme, context) {
			const d = result.details as ReadEntryDetails | undefined;
			const content = result.content
				.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
				.join("");
			// Throw path: createErrorToolResult wipes details to {}. Fall back
			// to the raw message, dyed error-colored (no kind to show).
			if (!d?.kind) {
				return new Text(context.isError ? theme.fg("error", content) : content, 0, 0);
			}
			// toolCall gets the compact one-line-per-call preview from details;
			// other kinds render the body as-is.
			const tuiContent = d.kind === "toolCall" ? (d.preview ?? content) : content;
			// No headers anywhere: every kind's content self-identifies (bash
			// `$ command`, toolCall `## toolCall <name>`) or is bare text the
			// caller just saw as a stub (toolResult; callId/(error) add
			// nothing the transcript stub didn't already show). Per-line
			// toolOutput styling; the leading blank line + collapsed preview
			// come from the shared renderSessionResult helper. The
			// `## details` marker line is dimmed: payload separator, not body.
			const styled = tuiContent
				.split("\n")
				.map((line) => (line === "## details" ? theme.fg("dim", line) : theme.fg("toolOutput", line)))
				.join("\n");
			return renderSessionResult(styled, expanded, theme);
		},
	});
}
