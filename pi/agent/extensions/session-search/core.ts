/**
 * Search core for the hot (file scan) and cold (archive index) sides of
 * session search.
 *
 * Everything here is a pure function of a message or of text, with at most a
 * type-only import from pi. That is deliberate: the archive ingest has to
 * reproduce byte-for-byte what the live scan does, and the only defense
 * against drift is a single implementation both sides import. Anything that
 * cannot be shared (file discovery, SQL, TUI) stays in its own module.
 *
 *   - compileQuery / isRegexQuery  — the query language (literal substring or
 *     `/regex/flags`, with `g`/`y` stripped because they break snippet
 *     positioning and leak `lastIndex` across haystacks).
 *   - messageBodyText / toolCallHaystack / haystackFor — the haystack rule.
 *     The body is the message's own text (via the injected `TextExtractor`);
 *     assistant toolCall arguments are a
 *     separate synthetic `[tool: …]` rendering, opt-in per query.
 *   - buildSnippet — the line-aligned snippet window and its omission counts.
 *   - HitRank / compareRank / betterRank — the ranking key.
 *   - SearchHit — the hit shape both sides emit.
 *
 * The archive builder (`store.ts`) stores exactly `messageBodyText(msg, textOf)` in
 * `entries.text` and `toolCallHaystack(msg)` in `entries.tool_calls`, so a cold
 * hit is re-judged with `haystackFor` parity rather than with a second
 * heuristic.
 *
 * This module has no runtime import at all: the message-content → text rule
 * (`textOf`) is owned by `../lib/session-common.ts` and arrives as an
 * `extractText` argument. Inlining a copy here would fork the projection that
 * hot and cold hits are judged with, and importing session-common would drag
 * pi in at load time, which would make `tests/core.test.ts` unrunnable under
 * plain `node --test`.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** The shared message-content → text rule, injected by the caller. */
export type TextExtractor = (
    content: string | Array<{ type: string; text?: string }>,
) => string;

export const SNIPPET_BEFORE = 120;
export const SNIPPET_AFTER = 240;
/**
 * Upper bound for the line-aligned snippet window. Only reached when the
 * match sits inside one pathologically long line (minified JSON, base64, a
 * wall-of-text paragraph); code blocks and prose lines stay far below it.
 */
export const SNIPPET_MAX_CHARS = 600;
export const MAX_HAYSTACK_CHARS = 256 * 1024; // ReDoS bound: truncate before regex
export const TOOL_CALL_ARGS_PREVIEW = 400;

/**
 * custom_message customTypes excluded from search. Only `custom_message`
 * entries project to role=custom and reach the haystack; plain `custom`
 * bookkeeping entries (viewer-state, preview-state, goal, pi-subagent:*, ...)
 * are dropped by the projection, so listing them here would be dead code.
 * The set is deliberately minimal: answers/goal-continuation/inline are real
 * injected conversation content and stay searchable, so every addition needs
 * its own justification.
 *   - search-sessions: this tool's own output (self-amplification).
 *   - context: the /context panel injection.
 *   - session-breakdown: the breakdown injection.
 */
export const SELF_EXCLUDED_CUSTOM_TYPES = new Set([
    "search-sessions",
    "context",
    "session-breakdown",
]);

/**
 * Compile a query into a match regex. Two forms:
 *
 *   - `/pattern/flags`: a user regex, but the `g` and `y` flags are forced
 *     off. `g` makes String.match drop `.index` (snippet positioning breaks);
 *     `y` (sticky) leaks `lastIndex` state across haystacks, making matches
 *     depend on scan history. Both strip rules come from upstream
 *     (adobe/pi-session-search), where each once caused a real bug.
 *   - Plain string: regex metacharacters escaped, compiled case-insensitive
 *     (a literal substring match).
 */
export function compileQuery(query: string): RegExp {
    const m = query.match(/^\/(.+)\/([gimsuy]*)$/);
    if (m) {
        const safeFlags = m[2].replace(/[gy]/g, "");
        return new RegExp(m[1], safeFlags);
    }
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

/** A `/regex/flags` query (as opposed to a literal keyword). */
export function isRegexQuery(query: string): boolean {
    return /^\/(.+)\/([gimsuy]*)$/.test(query);
}

/**
 * Normalization for tier-1 comparison: lowercase + whitespace removed, so
 * "追踪 Goal.ts" and "追踪goal.ts" compare equal.
 */
export function normalizeForTier(text: string): string {
    return text.toLowerCase().replace(/\s+/g, "");
}

/** One-line, whitespace-collapsed preview (shared shape with read-session.ts). */
export function preview(text: string, max: number): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, max)}...` : line;
}

/**
 * Assistant toolCall parts formatted for the haystack, opt-in via
 * includeToolCalls: `[tool: <name> <args preview>]` per call, args JSON
 * truncated to 400 chars. Tool RESULTS are never searched — they carry whole
 * file contents and command output that drown meaningful matches.
 */
export function toolCallHaystack(
    msg: Extract<AgentMessage, { role: "assistant" }>,
): string {
    const blocks: string[] = [];
    for (const part of msg.content) {
        if (part.type !== "toolCall") continue;
        let json: string;
        try {
            json = JSON.stringify(part.arguments);
        } catch {
            json = "(unserializable arguments)";
        }
        blocks.push(
            `[tool: ${part.name} ${preview(json, TOOL_CALL_ARGS_PREVIEW)}]`,
        );
    }
    return blocks.join("\n");
}

/**
 * The message's own searchable text; empty string means not searchable. Role
 * knowledge converges here: user/assistant/custom carry their body in
 * msg.content, branchSummary/compactionSummary carry it in msg.summary
 * (content is absent on those), and every other role (toolResult,
 * bashExecution, ...) is unsearchable.
 *
 * This is exactly what the archive stores in `entries.text`, so a cold hit is
 * re-judged against the same string the hot scan would have searched.
 */
export function messageBodyText(
    msg: AgentMessage,
    extractText: TextExtractor,
): string {
    if (
        msg.role === "user" ||
        msg.role === "assistant" ||
        msg.role === "custom"
    ) {
        return extractText(msg.content);
    }
    if (msg.role === "branchSummary" || msg.role === "compactionSummary") {
        return msg.summary;
    }
    return "";
}

/**
 * Extract the searchable haystack for one message; empty string means not
 * searchable. Assistant toolCall text is appended opt-in via
 * includeToolCalls.
 *
 * realEnd marks where the MESSAGE's own text ends: the tool-call blocks are
 * synthetic `[tool: …]` renderings rather than entry text, so omission
 * counts must stop there or they would promise "lines of this message" that
 * exist only in that rendering.
 *
 * The archive splits this into two stored columns (`entries.text` = body,
 * `entries.tool_calls` = rendering) and rejoins them with the same rule, so
 * the `\n` between the two is reproduced even when the rendering is empty.
 */
export function haystackFor(
    msg: AgentMessage,
    includeToolCalls: boolean,
    extractText: TextExtractor,
): { text: string; realEnd: number } {
    const text = messageBodyText(msg, extractText);
    if (msg.role === "assistant" && includeToolCalls) {
        return {
            text: `${text}\n${toolCallHaystack(msg)}`,
            realEnd: text.length,
        };
    }
    return { text, realEnd: text.length };
}

/**
 * Role weight for representative-hit selection and same-tier tiebreaks:
 * user > branch/compaction summary > assistant > custom. Never a sort key on
 * its own.
 */
export const ROLE_WEIGHTS: Record<string, number> = {
    user: 1.0,
    branchSummary: 0.9,
    compactionSummary: 0.9,
    assistant: 0.75,
    custom: 0.5,
};

export function roleWeightForRole(role: string): number {
    return ROLE_WEIGHTS[role] ?? 0;
}

export function roleWeightOf(msg: AgentMessage): number {
    return roleWeightForRole(msg.role);
}

/**
 * Message timestamp in ms (the runtime's getMessageActivityTime prefers the
 * message timestamp over the entry timestamp); undefined when absent.
 */
export function messageTimestampMs(msg: AgentMessage): number | undefined {
    const ts = (msg as { timestamp?: unknown }).timestamp;
    return typeof ts === "number" && Number.isFinite(ts) ? ts : undefined;
}

/** Ranking key of one hit within its session. */
export interface HitRank {
    /** 1 = query hits the session's first user message; 2 = body-only hit. */
    tier: number;
    /** Literal query exactly equals the first user message (normalized). */
    exact: boolean;
    /** Message timestamp in ms (NaN sorts last). */
    ts: number;
    roleWeight: number;
}

/** Order hits/sessions: tier asc, exact-first-message, newest, role weight. */
export function compareRank(a: HitRank, b: HitRank): number {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (a.ts !== b.ts)
        return (Number.isFinite(b.ts) ? b.ts : 0) - (Number.isFinite(a.ts) ? a.ts : 0);
    return b.roleWeight - a.roleWeight;
}

/** True when rank `a` outranks `b` for representative-hit selection. */
export function betterRank(a: HitRank, b: HitRank): boolean {
    return compareRank(a, b) < 0;
}

/**
 * One hit as both sides emit it. The session layer (path + id) and the
 * message layer (entry id + timestamp + role) are separate drill handles;
 * `stale` marks a cold hit whose archived file no longer matches what was
 * ingested, which voids the entry-level handle (see store.ts).
 */
export interface SearchHit {
    /** Resolved absolute session file path (the always-drillable ref). */
    sessionPath: string;
    /** Session id from the JSONL header (the natural read_session argument). */
    sessionId: string;
    /** Session entry id — the read_session_entry drill handle. */
    entryId: string;
    /** Message timestamp from the session entry. */
    timestamp: string;
    /** Message role as emitted by sessionEntryToContextMessages. */
    role: string;
    /** Match plus surrounding context (120 chars before / 240 after). */
    snippet: string;
    /** Line breaks the snippet window skipped in the message text BEFORE
     *  the window (0 = the snippet starts at the message start). */
    omittedBeforeLines: number;
    /** Line breaks the snippet window skipped AFTER the window (0 = the
     *  snippet runs to the message end). */
    omittedAfterLines: number;
    /**
     * The session's OTHER matching messages, when this hit is the session's
     * representative (grouping output); absent for single-hit sessions.
     */
    more?: number;
    /** Cold hit from an archived session. */
    archived?: true;
    /**
     * The archived file changed since ingest (size/mtime mismatch): the entry
     * id is no longer a valid `read_session_entry` handle, so the entry ref is
     * withheld and only the session ref is emitted.
     */
    stale?: true;
}

/**
 * Build the snippet for a match at `index` in `haystack`: the window
 * SNIPPET_BEFORE before / SNIPPET_AFTER after the match EXTENDED TO LINE
 * BOUNDARIES, with horizontal whitespace collapsed but line structure kept
 * (session text is prose/markdown/code, where line breaks carry real signal
 * — a hit inside a code block is unreadable as one run-on line). The
 * before/after values are therefore minimums, not exact sizes.
 *
 * The cap is the escape hatch for the one case line alignment cannot serve: a
 * match inside a single pathologically long line (minified JSON, base64, a
 * wall-of-text paragraph) would otherwise drag the whole line in. There the
 * raw character window is the correct output — there are no meaningful line
 * boundaries to align to. Mid-line truncation of a long single-line message
 * is intended behavior, not a bug.
 *
 * Pure text transform: no indentation here (the two formatters indent via
 * indentBlock; pre-indenting would double-indent the preview panel's
 * fallback path). The omission counts travel WITH the text, because a bare
 * snippet cannot disclose that it is a window: the consumer sees text and
 * has no way to know the message continued past it.
 *
 * `haystack` is the SEARCHED text (the ReDoS bound truncates it) and must be
 * a prefix of `fullText`, the untruncated projection: the window and the
 * visible text come from the searched prefix (byte-identical to searching
 * the whole thing), while the omission counts may look past it, so a match
 * near the search bound still reports the message text that follows instead
 * of falsely claiming completeness. Both counts are line breaks in the
 * omitted spans (a blank-only span counts as nothing omitted); the cap case
 * still reports the line breaks its raw window skipped, only its first/last
 * visible line is additionally cut mid-line.
 */
export function buildSnippet(
    haystack: string,
    index: number,
    bounds: { fullText?: string; realEnd?: number } = {},
): { text: string; omittedBeforeLines: number; omittedAfterLines: number } {
    const fullText = bounds.fullText ?? haystack;
    // Where the message's own text ends (see haystackFor): omission counts
    // stop there so they never promise message lines that only exist in the
    // synthetic tool-call rendering.
    const realEnd = Math.min(bounds.realEnd ?? fullText.length, fullText.length);
    const from = Math.max(0, index - SNIPPET_BEFORE);
    const to = index + SNIPPET_AFTER;
    const lineStart = haystack.lastIndexOf("\n", from) + 1;
    const lineEndAt = haystack.indexOf("\n", to);
    const lineEnd = lineEndAt === -1 ? haystack.length : lineEndAt;
    const capped = lineEnd - lineStart > SNIPPET_MAX_CHARS;
    const window = capped
        ? haystack.slice(from, to)
        : haystack.slice(lineStart, lineEnd);
    // The capped window is a raw slice, so its visible end clamps to the
    // searched length (a match within SNIPPET_AFTER of the search bound
    // would otherwise start the omission count past real content).
    const windowStart = capped ? from : lineStart;
    const windowEnd = capped ? Math.min(to, haystack.length) : lineEnd;
    const text = window
        .replace(/\r\n/g, "\n") // CRLF first: a lone \r would otherwise
        // survive as trailing whitespace on its line
        .replace(/[^\S\n]+/g, " ") // horizontal runs only
        .replace(/\n{3,}/g, "\n\n") // cap blank-line runs
        .trim();
    // Line breaks in an omitted span, blank-only spans excluded: "…\n\n…"
    // before the window omits no information. indexOf scanning rather than
    // trim+split: a span can be a whole large message and the count must not
    // allocate a copy of it.
    const breaksIn = (span: string): number => {
        if (!/[^\s]/.test(span)) return 0;
        let count = 0;
        let at = span.indexOf("\n");
        while (at !== -1) {
            count += 1;
            at = span.indexOf("\n", at + 1);
        }
        return count;
    };
    return {
        text,
        // Before the window the searched text IS the full text (the search
        // bound only ever cuts the tail), so either source counts the same.
        // After it the count looks into fullText (past the search bound, so
        // "no note = complete message" survives it) but stops at realEnd (so
        // synthetic tool-call lines are never promised as message lines).
        omittedBeforeLines: breaksIn(fullText.slice(0, windowStart)),
        omittedAfterLines: breaksIn(fullText.slice(windowEnd, realEnd)),
    };
}
