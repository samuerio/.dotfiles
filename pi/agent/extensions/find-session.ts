/**
 * Session search extension (single file): the search_sessions tool + the
 * /search-sessions slash command.
 *
 * Search capability forked from `adobe/pi-session-search` (compileQuery with
 * its `g`/`y` flag stripping, snippet generation, newest-first ordering, and
 * the no-index realtime-scan stance) but rebuilt on the active-branch parse
 * pipeline shared with read-session.ts (`lib/session-common.ts`): each session
 * file is read once (`readSessionText`), literal queries prefilter on the raw
 * text, and survivors go through `parseSessionText` → `buildContextEntries`,
 * so only the resolved active branch is searched — upstream's raw-JSONL grep
 * hits abandoned branches, which here it cannot.
 *
 * ─ Scope (deliberate) ─
 * Current project only, one level: discovery is readdir+stat over
 * `ctx.sessionManager.getSessionDir()` (the in-memory `--no-session` mode
 * reports "" and falls back to `SessionManager.list(cwd)`), which physically
 * equals "all sessions of the current project" and naturally excludes
 * subagent sessions (they live under `sessions/<tool>/<runId>/`, a different
 * tree). Every emitted session ref is therefore always drillable by the
 * existing tool trio. No index, no cross-project search, no tool-result
 * search (upstream defaults, kept).
 *
 * Summary invariant: a compaction/branch_summary hit never duplicates an
 * original-message hit within the same session — the raw messages compacted
 * away are no longer in buildContextEntries' active-branch projection, so the
 * summary is the only searchable copy of that stretch of history.
 *
 * Summary invariant: a compaction/branch_summary hit never duplicates an
 * original-message hit within the same session — the raw messages compacted
 * away are no longer in buildContextEntries' active-branch projection, so the
 * summary is the only searchable copy of that stretch of history.
 *
 * ─ Command flow (human path) ─
 * `/search-sessions` opens ONE persistent panel: a query Input on top,
 * results below, hint line at the bottom. It writes NOTHING to the session
 * unless the human explicitly picks a hit. Esc while scanning aborts the
 * scan (back to the previous results — `results` only ever changes on a
 * successful scan); Esc while idle closes the panel, a pure search. Each
 * scan owns a CancellableLoader (ctx.signal is only live while the agent
 * streams) and a generation counter that makes stale settlements no-ops.
 * Without a UI (print/json modes) the command degrades to the historical
 * behavior: inject the full result set.
 *
 * Key contract (settled, do not re-litigate): Enter is state-sensitive by
 * design. It re-scans when the box differs from the last scanned query (or
 * nothing has been scanned yet, or the last scan was empty) and injects the
 * selected hit when the box is unchanged and hits are visible. Tab is
 * deliberately NOT the send key: it is the TUI's reserved
 * autocomplete/focus key, and Enter=confirm is the repo-wide picker
 * convention. The hint line always states Enter's current meaning; a
 * mistaken Enter costs at most a redundant re-scan, never a wrong
 * injection. The old two-phase flow (command args → loader → picker with a
 * local filter box) is gone: the filter box could only narrow the already
 * truncated result set, and re-searching cost a full command retype. A
 * query written on the command line is still honored — it prefills the box
 * and runs the first scan immediately.
 *
 * Picking a hit injects it as a framed custom_message (formatSingleHit:
 * custom_message converts to a USER-role message downstream, so bare refs
 * would read as instructions).
 *
 * ctrl+o in the picker opens a preview of the selected hit: the picked
 * message's FULL text (picker rows only ever show a 100-char slice) plus the
 * session's other matching messages (the `more=N` hits the grouped output
 * never shows), re-scanned from that one file through the same
 * collectEntryHits matching. The preview is a second render mode of the
 * picker component, not a nested overlay; it reads one file and writes
 * nothing.
 *
 * ─ Output contract ─
 * No fourth read tool. Each hit emits both a session path and a session id:
 *
 *   session=<path> id=<sessionId> entry=<entryId> ts=<timestamp> role=<role>[ more=N]
 *     <snippet>
 *
 * Hits are grouped per session (one representative hit each; `more=N` counts
 * the session's other matching messages) and ordered by match tier (first-
 * user-message hit > body-only hit, exact first-message match first within
 * the tier) then newest-first. `<path>` (home collapsed to ~) is always
 * drillable by read_session / read_session_entry; `<sessionId>` is the
 * natural id form both drill tools accept; `<entryId>` is the
 * read_session_entry drill handle, recovered with the same entry/message zip
 * `alignAnnotations` uses in read-session.ts. The model's natural next step
 * is read_session or read_session_entry.
 *
 * Sections: pure helpers (compileQuery / snippet / args parsing) →
 * searchSessions core → tool + command registration with TUI rendering
 * (same width-aware collapsed preview pattern as read-session.ts).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
    AgentMessage,
    AgentToolResult,
} from "@earendil-works/pi-agent-core";
import {
    buildContextEntries,
    DynamicBorder,
    type ExtensionAPI,
    getAgentDir,
    keyHint,
    SessionManager,
    type SessionEntry,
    sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
    CancellableLoader,
    Container,
    Input,
    Key,
    matchesKey,
    type SelectItem,
    SelectList,
    Spacer,
    Text,
    truncateToWidth,
    type TUI,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
    parseSessionText,
    readSessionText,
    textOf,
} from "./lib/session-common.ts";

const SNIPPET_BEFORE = 120;
const SNIPPET_AFTER = 240;
const MAX_HAYSTACK_CHARS = 256 * 1024; // ReDoS bound: truncate before regex
const MAX_SESSION_FILE_BYTES = 5 * 1024 * 1024; // skip oversized files (visible in skippedFiles)
const DEFAULT_MAX_RESULTS = 50;
const HARD_MAX_RESULTS = 1000;
const TOOL_CALL_ARGS_PREVIEW = 400;
/**
 * Soft scan budget: a query that outruns it stops early with
 * truncated=time-budget. At the current corpus scale (one project ~0.5s,
 * --all ~1s) this never fires; it is the headroom valve for 10x growth, the
 * pi equivalent of WorkBuddy's 3s rg soft-stop (without detaching rg).
 */
const SOFT_BUDGET_MS = 3000;

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
const SELF_EXCLUDED_CUSTOM_TYPES = new Set([
    "search-sessions",
    "context",
    "session-breakdown",
]);

const SEARCH_SESSIONS_DESCRIPTION =
    "Search the current project's pi sessions (one level: ~/.pi/agent/sessions/<project>/; pass " +
    "scope=\"all\" for every project, current project ranked first) for a " +
    "keyword or /regex/, over the resolved active branch of each session (abandoned branches are not " +
    "searched). Searches user/assistant body text, custom injected messages (the search tool's own " +
    "search-sessions output excluded), and branch_summary/compaction summaries; tool results are never " +
    "searched (they contain whole-file contents and command output that drown matches). Custom_message " +
    "and branch_summary hits drill to " +
    "their full text via read_session_entry; compaction originals are restored with " +
    "read_session_compaction. Returns " +
    "one representative hit per session (the session's other matching messages counted as more=N), " +
    "ordered by match tier (a hit in the session's first user message ranks above body-only hits, an " +
    "exact first-message match first within that tier) then newest-first; maxResults caps sessions, not " +
    "messages. Each hit is " +
    "session=<path> id=<sessionId> entry=<entryId> ts=<timestamp> role=<role> plus a snippet: pass the " +
    "path or id to read_session for the full transcript, or entry=<entryId> to read_session_entry to " +
    "drill into the exact entry. In scope=\"all\", each hit line also carries project=<dir>. The result " +
    "envelope reports query/scope/hits/scanned/listed/unreadable/ms and, when results were cut short, " +
    "truncated=<reason> (maxResults, time-budget, or aborted). Read-only.";

export const SearchSessionsParams = Type.Object({
    query: Type.String({
        description:
            "Search query: a plain keyword (case-insensitive substring, regex metacharacters escaped) or a " +
            "/regex/flags form. The g and y flags are stripped if present (they break index-based snippet " +
            "positioning and leak lastIndex state across messages).",
    }),
    since: Type.Optional(
        Type.String({
            description:
                "Only messages with timestamp >= this ISO time. Bounds the MESSAGE timestamp, not file mtime.",
        }),
    ),
    until: Type.Optional(
        Type.String({
            description:
                "Only messages with timestamp <= this ISO time. Bounds the MESSAGE timestamp, not file mtime.",
        }),
    ),
    includeToolCalls: Type.Optional(
        Type.Boolean({
            description:
                "Append formatted toolCall text ([tool: name args...]) to assistant haystacks. Default false.",
        }),
    ),
    maxResults: Type.Optional(
        Type.Number({
            description: `Maximum sessions returned (one representative hit per session; that session's remaining matching messages are counted as more=N). Default ${DEFAULT_MAX_RESULTS}, hard cap ${HARD_MAX_RESULTS}. Explicit invalid values (0, negative, NaN, non-integer) throw.`,
        }),
    ),
    includeCurrentSession: Type.Optional(
        Type.Boolean({
            description:
                "Include the live session in the search. Default false (excluded).",
        }),
    ),
    scope: Type.Optional(
        Type.Union([Type.Literal("project"), Type.Literal("all")], {
            description:
                "Search scope. 'project' (default) searches the current project's sessions only. " +
                "'all' searches every project directory under the sessions root " +
                "(~/.pi/agent/sessions/<project>/), ranking the current project's sessions first; " +
                "subagent session trees (sessions/<tool>/<runId>/) stay excluded. Under a custom " +
                "--session-dir outside the sessions root, 'all' degrades to 'project'.",
        }),
    ),
});

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
    /**
     * The session's OTHER matching messages, when this hit is the session's
     * representative (grouping output); absent for single-hit sessions.
     */
    more?: number;
}

export interface SearchSessionsDetails {
    path?: string;
    hitCount: number;
    /** Set when results were cut short: "maxResults" or "aborted". */
    truncated?: string;
    /** Session files skipped for size (>5 MB); each entry is "path (N KB)". */
    skippedFiles: string[];
    /** Files that could not be stat'd, parsed, or had no session header. */
    unreadable: string[];
    /** Session files discovered in the session directory (one level). */
    listed: number;
    /** Session files actually searched. */
    scanned: number;
    /** Scan wall time in milliseconds. */
    ms: number;
    /** Scope actually searched ('all' can degrade to 'project'). */
    scope: "project" | "all";
    /** True when an 'all' request degraded to project scope. */
    allDegraded: boolean;
}

// ============================================================================
// Pure helpers
// ============================================================================

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

/**
 * Normalization for tier-1 comparison: lowercase + whitespace removed, so
 * "追踪 Goal.ts" and "追踪goal.ts" compare equal.
 */
function normalizeForTier(text: string): string {
    return text.toLowerCase().replace(/\s+/g, "");
}

/** A `/regex/flags` query (as opposed to a literal keyword). */
function isRegexQuery(query: string): boolean {
    return /^\/(.+)\/([gimsuy]*)$/.test(query);
}

/**
 * Role weight for representative-hit selection and same-tier tiebreaks:
 * user > branch/compaction summary > assistant > custom. Never a sort key on
 * its own.
 */
const ROLE_WEIGHTS: Record<string, number> = {
    user: 1.0,
    branchSummary: 0.9,
    compactionSummary: 0.9,
    assistant: 0.75,
    custom: 0.5,
};

function roleWeightOf(msg: AgentMessage): number {
    return ROLE_WEIGHTS[msg.role] ?? 0;
}

/**
 * Message timestamp in ms (the runtime's getMessageActivityTime prefers the
 * message timestamp over the entry timestamp); undefined when absent.
 */
function messageTimestampMs(msg: AgentMessage): number | undefined {
    const ts = (msg as { timestamp?: unknown }).timestamp;
    return typeof ts === "number" && Number.isFinite(ts) ? ts : undefined;
}

/** Ranking key of one hit within its session. */
interface HitRank {
    /** 1 = query hits the session's first user message; 2 = body-only hit. */
    tier: number;
    /** Literal query exactly equals the first user message (normalized). */
    exact: boolean;
    /** Message timestamp in ms (NaN sorts last). */
    ts: number;
    roleWeight: number;
}

/** Order hits/sessions: tier asc, exact-first-message, newest, role weight. */
function compareRank(a: HitRank, b: HitRank): number {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (a.ts !== b.ts) return (Number.isFinite(b.ts) ? b.ts : 0) - (Number.isFinite(a.ts) ? a.ts : 0);
    return b.roleWeight - a.roleWeight;
}

/** True when rank `a` outranks `b` for representative-hit selection. */
function betterRank(a: HitRank, b: HitRank): boolean {
    return compareRank(a, b) < 0;
}

/** One-line, whitespace-collapsed preview (shared shape with read-session.ts). */
function preview(text: string, max: number): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, max)}...` : line;
}

/**
 * Assistant toolCall parts formatted for the haystack, opt-in via
 * includeToolCalls: `[tool: <name> <args preview>]` per call, args JSON
 * truncated to 400 chars. Tool RESULTS are never searched — they carry whole
 * file contents and command output that drown meaningful matches.
 */
function toolCallHaystack(
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
 * Extract the searchable haystack for one message; empty string means not
 * searchable. Role knowledge converges here: user/assistant/custom carry
 * their body in msg.content, branchSummary/compactionSummary carry it in
 * msg.summary (content is absent on those), and every other role
 * (toolResult, bashExecution, ...) is unsearchable. Assistant toolCall text
 * is appended opt-in via includeToolCalls.
 */
function haystackFor(msg: AgentMessage, includeToolCalls: boolean): string {
    if (
        msg.role === "user" ||
        msg.role === "assistant" ||
        msg.role === "custom"
    ) {
        let text = textOf(msg.content);
        if (msg.role === "assistant" && includeToolCalls) {
            text += `\n${toolCallHaystack(msg)}`;
        }
        return text;
    }
    if (msg.role === "branchSummary" || msg.role === "compactionSummary") {
        return msg.summary;
    }
    return "";
}

/**
 * Validate an explicitly passed maxResults. Invalid explicit values throw
 * loudly (0, negative, NaN, non-integer); silently correcting them would hide
 * a caller bug. The hard cap is applied silently (a larger value is a
 * resource request, not a logic error).
 */
function validateMaxResults(max: number | undefined): number {
    if (max === undefined) return DEFAULT_MAX_RESULTS;
    if (!Number.isFinite(max) || !Number.isInteger(max) || max < 1) {
        throw new Error(
            `search_sessions: invalid maxResults ${max} (must be a positive integer).`,
        );
    }
    return Math.min(max, HARD_MAX_RESULTS);
}

/**
 * Build the snippet for a match at `index` in `haystack`: up to
 * SNIPPET_BEFORE chars before and SNIPPET_AFTER after the match, collapsed to
 * one line. Whitespace-collapsed because session text is prose/command output
 * where line breaks carry no snippet signal.
 */
export function buildSnippet(haystack: string, index: number): string {
    return haystack
        .slice(Math.max(0, index - SNIPPET_BEFORE), index + SNIPPET_AFTER)
        .replace(/\s+/g, " ")
        .trim();
}

/** Parse a slash-command argument string into search options + the query. */
export function parseSearchArgs(args: string): {
    query: string;
    since: string | undefined;
    until: string | undefined;
    maxResults: number | undefined;
    includeToolCalls: boolean;
    all: boolean;
} {
    let since: string | undefined;
    let until: string | undefined;
    let maxResults: number | undefined;
    let includeToolCalls = false;
    let all = false;
    const queryParts: string[] = [];

    for (const token of args.trim().split(/\s+/).filter(Boolean)) {
        if (token.startsWith("--")) {
            const [flag, value] = token.slice(2).split("=", 2);
            switch (flag) {
                case "since":
                    since = value;
                    break;
                case "until":
                    until = value;
                    break;
                case "max":
                    maxResults = Number(value);
                    break;
                case "include-tool-calls":
                    includeToolCalls = true;
                    break;
                case "all":
                    all = true;
                    break;
                default:
                    throw new Error(
                        `unknown flag --${flag} (supported: since, until, max, include-tool-calls, all).`,
                    );
            }
            continue;
        }
        queryParts.push(token);
    }

    // Query is OPTIONAL on the command path: a bare /search-sessions opens the
    // search panel with an empty box (the interactive path is the primary one
    // now). Unknown-flag errors stay loud — only the missing-query error is
    // gone.
    const query = queryParts.join(" ").trim();
    return { query, since, until, maxResults, includeToolCalls, all };
}

/** Display-only path shortening (matches read-session.ts shortenPath): cwd-relative or ~-collapsed. */
function shortenPath(p: string): string {
    const resolved = path.resolve(p);
    if (
        resolved === process.cwd() ||
        resolved.startsWith(process.cwd() + path.sep)
    ) {
        return path.relative(process.cwd(), resolved);
    }
    const home = os.homedir();
    return resolved.startsWith(home)
        ? `~${resolved.slice(home.length)}`
        : resolved;
}

/** Envelope list rendering: show the first few entries, count the rest. */
function capList(items: string[], max = 10): string {
    if (items.length <= max) return items.join(", ");
    return `${items.slice(0, max).join(", ")} +${items.length - max} more`;
}

// ============================================================================
// searchSessions core
// ============================================================================

export interface SearchSessionsOptions {
    query: string;
    since?: string;
    until?: string;
    includeToolCalls?: boolean;
    maxResults?: number;
    includeCurrentSession?: boolean;
    /** Live session file path + id, when running inside a pi session (exclusion). */
    currentSessionFile?: string;
    /**
     * Session directory to scan (ctx.sessionManager.getSessionDir()). Empty or
     * omitted falls back to SessionManager.list(cwd), the only correct source
     * in the in-memory (--no-session) mode where getSessionDir() is "".
     */
    sessionDir?: string;
    /** Project cwd for the header.cwd filter; defaults to process.cwd(). */
    cwd?: string;
    /** Cancellation signal, observed between files (absent on the command path). */
    signal?: AbortSignal;
    /**
     * Search scope: 'project' (default) or 'all' (every project under the
     * sessions root, current project ranked first).
     */
    scope?: "project" | "all";
}

export interface SearchSessionsResult {
    hits: SearchHit[];
    /** Set when results were cut short: "maxResults" or "aborted". */
    truncated?: string;
    skippedFiles: string[];
    /** Files that could not be stat'd, parsed, or had no session header. */
    unreadable: string[];
    scanned: number;
    /** Session files discovered across the searched project directories. */
    listed: number;
    /** Scan wall time in milliseconds. */
    ms: number;
    /** Scope actually searched (an 'all' request can degrade to 'project'). */
    scope: "project" | "all";
    /** True when an 'all' request degraded to project scope. */
    allDegraded: boolean;
}

/**
 * Search the current project's sessions over the resolved active branch of
 * each session file. Discovery is one level of the session directory
 * (`ctx.sessionManager.getSessionDir()` via options.sessionDir, readdir +
 * stat, no parse); the in-memory (--no-session) mode reports "" and falls
 * back to `SessionManager.list(cwd)` — the pre-P0 source, which costs a full
 * stream-parse of every file but is the only correct source there.
 *
 * Hits are collected across ALL sessions, grouped per session (one
 * representative hit: best rank, remaining matches counted as more=N),
 * ordered by (tier asc, exact-first-message, message timestamp desc, role
 * weight) and truncated at maxResults — which caps SESSIONS, not messages.
 * Tier 1 = the query hits the session's first user message (the active-
 * branch projection's first role=user message, i.e. the first kept one after
 * a compaction); tier 2 = body-only hit. No early exit: a chatty recent
 * session can no longer fill the whole budget before older sessions are
 * scanned.
 *
 * Time bounds bind to MESSAGE timestamps (post-resolution), not file mtime:
 * mtime would let an old session rewritten recently bypass the filter.
 * `since`/`until` and explicit invalid maxResults throw loudly. Files that
 * cannot be stat'd, parsed, or that carry no session header are reported in
 * the `unreadable` envelope field instead of being skipped silently. The
 * scan yields to the event loop between files and observes `signal` at the
 * yield point (the slash-command path has no signal and never aborts).
 *
 * Perf: literal queries prefilter on each file's raw text before parsing
 * (read once, parse only candidates); a 3s soft budget stops the scan early
 * with truncated=time-budget. Both are headroom for corpus growth, inert at
 * the current scale.
 */
/**
 * Match one session's resolved active-branch projection, with the same
 * tier/rank logic the scan uses. Extracted from searchSessions so the
 * picker's ctrl+o preview can re-run the exact matching against a single
 * session file (its full hit list, including the `more=N` hits the grouped
 * scan output never shows) without duplicating any of it.
 *
 * `withFullText` attaches the untruncated message text to every record; the
 * scan leaves it off (holding every matched message's full text for a whole
 * corpus in memory is the one thing the grouped output does not need).
 */
function collectEntryHits(
    entries: SessionEntry[],
    match: {
        re: RegExp;
        /** The query was in /regex/flags form (no equality semantics). */
        regexQuery: boolean;
        normalizedQuery: string;
        sinceMs?: number;
        untilMs?: number;
        includeToolCalls: boolean;
    },
    session: { sessionPath: string; sessionId: string },
    options: { withFullText?: boolean } = {},
): Array<{ hit: SearchHit; rank: HitRank; fullText?: string }> {
    const out: Array<{ hit: SearchHit; rank: HitRank; fullText?: string }> =
        [];
    // First user message of the ACTIVE-BRANCH projection: after a compaction
    // this is the first KEPT user message, not the file's first user message.
    // Non-user roles are skipped (a compaction's systemMessage can lead the
    // projection).
    let firstUserEntryId: string | undefined;
    let firstUserText: string | undefined;

    // The resolved active-branch entry list — the same list
    // buildSessionContext projects into context.messages (each entry yields
    // 0/1 messages via sessionEntryToContextMessages, in order), so entry →
    // message pairing is exact: the entry id IS the read_session_entry
    // drill handle (same zip read-session.ts's alignAnnotations relies on).
    const contextEntries = buildContextEntries(entries);
    for (const entry of contextEntries) {
        for (const msg of sessionEntryToContextMessages(entry)) {
            // Self-reference guard: the slash command injects its own result
            // as a custom message; searching it would self-amplify. (Only
            // custom_message entries project to role=custom at all; plain
            // `custom` bookkeeping entries never reach this loop.)
            if (
                msg.role === "custom" &&
                SELF_EXCLUDED_CUSTOM_TYPES.has(msg.customType)
            )
                continue;

            if (msg.role === "user" && firstUserEntryId === undefined) {
                firstUserEntryId = entry.id;
                firstUserText = textOf(msg.content);
            }

            // Haystack via haystackFor (empty = unsearchable role), then
            // truncated before matching (ReDoS bound).
            const rawHaystack = haystackFor(msg, match.includeToolCalls);
            if (!rawHaystack) continue;
            const haystack =
                rawHaystack.length > MAX_HAYSTACK_CHARS
                    ? rawHaystack.slice(0, MAX_HAYSTACK_CHARS)
                    : rawHaystack;

            const found = haystack.match(match.re);
            if (!found) continue;

            // Message timestamp preferred (runtime getMessageActivityTime
            // semantics), entry timestamp as fallback.
            const msgTs = messageTimestampMs(msg);
            const tsMs = msgTs ?? Date.parse(entry.timestamp);
            if (
                match.sinceMs !== undefined &&
                !(Number.isFinite(tsMs) && tsMs >= match.sinceMs)
            )
                continue;
            if (
                match.untilMs !== undefined &&
                !(Number.isFinite(tsMs) && tsMs <= match.untilMs)
            )
                continue;

            // Tier 1: the query hits the session's first user message (pi's
            // de-facto title); tier 2: body-only hit. Exact equality on the
            // first user message is the first intra-tier-1 tiebreak (literal
            // queries only — a regex has no equality semantics).
            const tier =
                firstUserText !== undefined &&
                entry.id === firstUserEntryId &&
                match.re.test(firstUserText)
                    ? 1
                    : 2;
            const rank: HitRank = {
                tier,
                exact:
                    tier === 1 &&
                    !match.regexQuery &&
                    normalizeForTier(firstUserText ?? "") ===
                        match.normalizedQuery,
                ts: tsMs,
                roleWeight: roleWeightOf(msg),
            };

            out.push({
                hit: {
                    sessionPath: session.sessionPath,
                    sessionId: session.sessionId,
                    entryId: entry.id,
                    timestamp:
                        msgTs !== undefined
                            ? new Date(msgTs).toISOString()
                            : entry.timestamp,
                    role: msg.role,
                    snippet: buildSnippet(haystack, found.index ?? 0),
                },
                rank,
                fullText: options.withFullText ? rawHaystack : undefined,
            });
        }
    }
    return out;
}

export async function searchSessions(
    options: SearchSessionsOptions,
): Promise<SearchSessionsResult> {
    const re = compileQuery(options.query);
    const max = validateMaxResults(options.maxResults);
    const sinceMs =
        options.since !== undefined ? Date.parse(options.since) : undefined;
    const untilMs =
        options.until !== undefined ? Date.parse(options.until) : undefined;
    if (sinceMs !== undefined && Number.isNaN(sinceMs))
        throw new Error(`search_sessions: invalid since "${options.since}".`);
    if (untilMs !== undefined && Number.isNaN(untilMs))
        throw new Error(`search_sessions: invalid until "${options.until}".`);
    const startedAt = Date.now();
    const includeToolCalls = options.includeToolCalls === true;
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const signal = options.signal;
    const normalizedQuery = normalizeForTier(options.query);

    // Discovery: one level of the session directory (readdir + stat, no
    // parse). SessionManager.list streams and JSON.parses every line of every
    // file just to hand back paths that readdir already provides. The
    // in-memory (--no-session) mode reports sessionDir "", where the default
    // directory derived from cwd is the only correct source.
    const sessionDir = options.sessionDir?.trim() || undefined;
    const scope = options.scope === "all" ? "all" : "project";

    // Discovery yields one entry per session file. Project scope is one
    // readdir of the session directory. --all enumerates the sessions root's
    // project directories: subagent tool dirs (sessions/finder/, ...) keep
    // their jsonl one level deeper (sessions/<tool>/<runId>/) and contribute
    // nothing, so the subagent trees stay excluded by construction.
    const discovered: Array<{ path: string; id?: string }> = [];
    let viaList = false;
    let allDegraded = false;

    const readJsonlDir = (
        dir: string,
    ): Array<{ path: string; id?: string }> => {
        try {
            return fs
                .readdirSync(dir)
                .filter((name) => name.endsWith(".jsonl"))
                .map((name) => ({ path: path.join(dir, name) }));
        } catch {
            return [];
        }
    };

    if (scope === "all" && sessionDir) {
        const root = path.join(getAgentDir(), "sessions");
        const currentDirAbs = path.resolve(sessionDir);
        if (path.dirname(currentDirAbs) === path.resolve(root)) {
            let dirNames: string[] = [];
            try {
                dirNames = fs
                    .readdirSync(root, { withFileTypes: true })
                    .filter((entry) => entry.isDirectory())
                    .map((entry) => entry.name);
            } catch {
                dirNames = [];
            }
            for (const name of dirNames) {
                discovered.push(...readJsonlDir(path.join(root, name)));
            }
        } else {
            // Custom --session-dir outside the sessions root: the root no
            // longer describes this installation, so --all degrades to
            // project scope instead of scanning unrelated directories.
            allDegraded = true;
            discovered.push(...readJsonlDir(sessionDir));
        }
    } else if (sessionDir) {
        discovered.push(...readJsonlDir(sessionDir));
    } else {
        // In-memory mode (--no-session): getSessionDir() is "", so the
        // SessionManager listings are the only correct source (double parse
        // accepted in this degraded mode). For --all, SessionInfo.cwd is the
        // ownership key since there is no sessionDir to compare against.
        const infos =
            scope === "all"
                ? await SessionManager.listAll()
                : await SessionManager.list(cwd);
        for (const info of infos) {
            discovered.push({ path: info.path, id: info.id });
        }
        viaList = true;
    }

    const currentAbs = options.currentSessionFile
        ? path.resolve(options.currentSessionFile)
        : undefined;

    // Stat up front: the size cap needs it, mtime-desc keeps a familiar scan
    // order (it no longer influences results — truncation happens after
    // sorting), and stat failures become visible instead of silent.
    const files: Array<{
        path: string;
        id?: string;
        size: number;
        mtimeMs: number;
    }> = [];
    const unreadable: string[] = [];
    for (const item of discovered) {
        try {
            const st = fs.statSync(item.path);
            files.push({ ...item, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
            unreadable.push(shortenPath(item.path));
        }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    // Session-level grouping: one representative hit per session (best rank),
    // the session's remaining matching messages counted as more=N. This is
    // what keeps a chatty session from filling the whole result budget.
    const groups = new Map<
        string,
        {
            sessionPath: string;
            sessionId: string;
            best: SearchHit;
            rank: HitRank;
            total: number;
            /** --all ownership key: the current project's sessions rank first. */
            isCurrentProject: boolean;
        }
    >();
    const skippedFiles: string[] = [];
    let scanned = 0;
    let truncated: string | undefined;
    for (const file of files) {
        if (signal?.aborted) {
            truncated = "aborted";
            break;
        }
        if (Date.now() - startedAt > SOFT_BUDGET_MS) {
            truncated = "time-budget";
            break;
        }
        // Yield between files: the parse loop below is fully synchronous and
        // would otherwise freeze the TUI for the whole scan. The yield point
        // doubles as the cancellation checkpoint (the slash-command path has
        // no signal, so it simply never aborts).
        await new Promise((resolve) => setImmediate(resolve));
        if (signal?.aborted) {
            truncated = "aborted";
            break;
        }

        // Live-session exclusion: compare resolved absolute paths (the id in the
        // header would also work, but files without a resolvable id still
        // deserve exclusion when they ARE the current session).
        if (
            currentAbs &&
            path.resolve(file.path) === currentAbs &&
            options.includeCurrentSession !== true
        ) {
            continue;
        }

        // Size cap (upstream convention): skip oversized files, keep the skip
        // visible. Sessions are written live and can legitimately grow large.
        if (file.size > MAX_SESSION_FILE_BYTES) {
            skippedFiles.push(
                `${shortenPath(file.path)} (${Math.round(file.size / 1024)} KB)`,
            );
            continue;
        }

        // Read once, parse only when the raw text can match: a literal query
        // that does not appear in the file's raw JSONL text cannot appear in
        // any parsed haystack either, so the parse is skipped entirely. This
        // is the rg coarse-filter role, minus the second read on hits (the
        // text is already in hand) and minus abandoned-branch false hits
        // (the active-branch projection happens after the prefilter).
        let rawText: string;
        try {
            rawText = readSessionText(file.path);
        } catch {
            unreadable.push(shortenPath(file.path));
            continue;
        }
        // Case-insensitive: the literal query regex carries the `i` flag, so
        // a case-sensitive prefilter would drop real hits ("Goal" vs "goal").
        // A regex test is ~8x cheaper than lowercasing the whole file (no
        // 50MB+ allocation). JSON-special characters (quote, backslash,
        // control chars) appear escaped on disk, so those queries fall back
        // to the escaped-needle substring test. Known gap: a query spanning
        // two text parts of one message matches the joined haystack but not
        // the raw line — rare, accepted.
        if (!isRegexQuery(options.query)) {
            const jsonSafe = !/["\\\u0000-\u001f]/.test(options.query);
            const prefilterHit = jsonSafe
                ? re.test(rawText)
                : rawText
                      .toLowerCase()
                      .includes(
                          JSON.stringify(options.query)
                              .slice(1, -1)
                              .toLowerCase(),
                      );
            if (!prefilterHit) continue;
        }

        let header, entries;
        try {
            ({ header, entries } = parseSessionText(rawText));
        } catch {
            unreadable.push(shortenPath(file.path));
            continue;
        }
        // SessionManager.list silently drops files whose first line is not a
        // session header (buildSessionInfo returns null); readdir discovery
        // has no such filter, so enforce it here — and never let a sessionId
        // degrade to undefined.
        if (!header) {
            unreadable.push(shortenPath(file.path));
            continue;
        }
        // Project-scope cwd filter, mirroring SessionManager.list's filterCwd
        // (sessionCwdMatches): a custom --session-dir can hold sessions of
        // several projects. A missing header cwd is not grounds for exclusion.
        // The list fallback already applied this filter; --all deliberately
        // skips it (cross-project results are the point).
        if (scope === "project" && !viaList) {
            const sessionCwd =
                typeof header.cwd === "string" ? header.cwd : "";
            if (sessionCwd && path.resolve(sessionCwd) !== cwd) continue;
        }
        scanned++;

        const sessionId = header.id ?? file.id ?? "";
        // Ownership key for --all ordering: the current project's sessions
        // rank first. In-memory --all has no sessionDir to compare against,
        // so header.cwd is the key there.
        const isCurrentProject =
            scope === "project"
                ? true
                : viaList
                  ? typeof header.cwd === "string" &&
                    path.resolve(header.cwd) === cwd
                  : path.dirname(file.path) === path.resolve(sessionDir ?? "");
        const matched = collectEntryHits(
            entries,
            {
                re,
                regexQuery: isRegexQuery(options.query),
                normalizedQuery,
                sinceMs,
                untilMs,
                includeToolCalls,
            },
            { sessionPath: file.path, sessionId },
        );
        for (const { hit, rank } of matched) {
            const group = groups.get(file.path);
            if (group) {
                group.total++;
                if (betterRank(rank, group.rank)) {
                    group.best = hit;
                    group.rank = rank;
                }
            } else {
                groups.set(file.path, {
                    sessionPath: file.path,
                    sessionId,
                    best: hit,
                    rank,
                    total: 1,
                    isCurrentProject,
                });
            }
        }
    }

    // Session-level output: one representative hit per session, ordered by
    // (current project first, tier asc, exact-first-message, newest, role
    // weight), then truncated. Truncation happens after the full scan +
    // ordering, so the budget is spent on the best sessions rather than on
    // whichever was scanned first.
    const ordered = [...groups.values()].sort((a, b) => {
        if (a.isCurrentProject !== b.isCurrentProject)
            return a.isCurrentProject ? -1 : 1;
        return compareRank(a.rank, b.rank);
    });
    const representatives: SearchHit[] = ordered.map((g) =>
        g.total > 1 ? { ...g.best, more: g.total - 1 } : g.best,
    );
    const finalHits = representatives.slice(0, max);
    if (representatives.length > finalHits.length && truncated === undefined)
        truncated = "maxResults";

    return {
        hits: finalHits,
        truncated,
        skippedFiles,
        unreadable,
        scanned,
        listed: discovered.length,
        ms: Date.now() - startedAt,
        scope,
        allDegraded,
    };
}

/** Format hits for the tool result / slash command: the output contract lines. */
export function formatHits(
    result: SearchSessionsResult,
    query: string,
): string {
    const lines: string[] = [];
    for (const hit of result.hits) {
        lines.push(
            `session=${shortenPath(hit.sessionPath)} id=${hit.sessionId} entry=${hit.entryId} ts=${hit.timestamp} role=${hit.role}` +
                (hit.more && hit.more > 0 ? ` more=${hit.more}` : "") +
                (result.scope === "all"
                    ? ` project=${path.basename(path.dirname(hit.sessionPath))}`
                    : ""),
        );
        lines.push(`  ${hit.snippet}`);
    }

    const envelopeParts = [
        `query=${query}`,
        `scope=${result.scope}${result.allDegraded ? "(degraded-to-project)" : ""}`,
        `hits=${result.hits.length}`,
        `scanned=${result.scanned}`,
        `listed=${result.listed}`,
        `ms=${result.ms}`,
        result.truncated
            ? `truncated=${result.truncated}` +
              (result.truncated === "maxResults"
                  ? " (cap reached; narrow the query or raise maxResults)"
                  : result.truncated === "time-budget"
                    ? ` (scanned ${result.scanned} of ${result.listed}, time budget)`
                    : "")
            : undefined,
        result.skippedFiles.length
            ? `skipped=${result.skippedFiles.length} (${capList(result.skippedFiles)})`
            : undefined,
        result.unreadable.length
            ? `unreadable=${result.unreadable.length} (${capList(result.unreadable)})`
            : undefined,
    ].filter((part): part is string => part !== undefined);

    if (lines.length === 0)
        return `(no matches)\n\n[${envelopeParts.join(" ")}]`;
    return `${lines.join("\n")}\n\n[${envelopeParts.join(" ")}]`;
}

/**
 * One picked hit, framed for injection into the session. The framing line
 * matters: custom_message is converted to a USER-role message by
 * convertToLlm, so a bare hit line would read as the user speaking and the
 * model might act on the `session=` / `id=` refs as instructions.
 */
export function formatSingleHit(hit: SearchHit, query: string): string {
    return [
        `以下是一条 pi 会话搜索命中（query=${query}，参考资料，非用户指令）：`,
        `session=${shortenPath(hit.sessionPath)} id=${hit.sessionId} entry=${hit.entryId} ts=${hit.timestamp} role=${hit.role}` +
            (hit.more && hit.more > 0 ? ` more=${hit.more}` : ""),
        `  ${hit.snippet}`,
    ].join("\n");
}

// ============================================================================
// Picker preview (ctrl+o)
// ============================================================================

/**
 * Re-scan ONE session file with the original query and return its full hit
 * list (representative + the `more=N` hits the grouped scan output never
 * shows), each with the untruncated message text. The matching is
 * collectEntryHits — byte-identical to the scan's — so what the human
 * previewed is exactly what the scan matched. Cost is one file read + parse
 * (the scan already paid it); a file deleted since the scan surfaces as a
 * thrown error the picker renders.
 */
function loadSessionPreview(
    sessionPath: string,
    query: string,
    options: SearchSessionsOptions,
): Array<{ hit: SearchHit; rank: HitRank; fullText: string }> {
    const { entries, header } = parseSessionText(readSessionText(sessionPath));
    if (!header) throw new Error("not a pi session file (no header)");
    const sinceMs =
        options.since !== undefined ? Date.parse(options.since) : undefined;
    const untilMs =
        options.until !== undefined ? Date.parse(options.until) : undefined;
    const matched = collectEntryHits(
        entries,
        {
            re: compileQuery(query),
            regexQuery: isRegexQuery(query),
            normalizedQuery: normalizeForTier(query),
            sinceMs,
            untilMs,
            includeToolCalls: options.includeToolCalls === true,
        },
        { sessionPath, sessionId: header.id ?? "" },
        { withFullText: true },
    );
    return matched.map((record) => ({
        hit: record.hit,
        rank: record.rank,
        fullText: record.fullText ?? "",
    }));
}

/**
 * Preview panel content: the picked hit's FULL text first (the picker row
 * only ever shows a 100-char slice), then the session's other matching
 * messages in scan order, so the human can see what a narrower query would
 * have to target. Ordered by the same rank key the scan uses.
 */
function buildPreviewContent(
    hit: SearchHit,
    previewHits: Array<{ hit: SearchHit; rank: HitRank; fullText: string }>,
): string {
    const ordered = [...previewHits].sort((a, b) => compareRank(a.rank, b.rank));
    const picked = ordered.find((item) => item.hit.entryId === hit.entryId);
    const others = ordered.filter((item) => item.hit.entryId !== hit.entryId);
    const lines: string[] = [];
    lines.push(
        `  session=${shortenPath(hit.sessionPath)} id=${hit.sessionId}`,
    );
    lines.push("");
    lines.push(
        `  ── picked hit · ${hit.role} · ${hit.timestamp} · entry=${hit.entryId} ──`,
    );
    lines.push(...indentBlock(picked?.fullText || hit.snippet));
    if (others.length > 0) {
        lines.push("");
        lines.push(
            `  ── other hits in this session (${others.length}) ──`,
        );
        for (const item of others) {
            lines.push("");
            lines.push(
                `  ▸ ${item.hit.timestamp} · ${item.hit.role} · entry=${item.hit.entryId}`,
            );
            lines.push(...indentBlock(item.fullText || item.hit.snippet));
        }
    } else {
        lines.push("");
        lines.push("  (no other hits in this session)");
    }
    return lines.join("\n");
}

/** Indent a (possibly multi-line) block by two spaces. */
function indentBlock(text: string): string[] {
    return text
        .split("\n")
        .map((line) => (line.trim() ? `  ${line}` : line));
}

/**
 * Windowed plain-text viewer for the preview panel (the scroll pattern from
 * lib/session-preview.ts, minus markdown): wraps once per width, keeps its
 * own scroll offset, and clamps it to the content. Height is budgeted from
 * the terminal so the panel never claims the whole screen — the picker's
 * list viewport is the reference size.
 */
class PreviewText {
    private wrapped: string[] | undefined;
    private wrappedWidth = 0;
    private scrollOffset = 0;
    private viewHeight = 0;

    constructor(
        private readonly tui: TUI,
        private readonly text: string,
    ) {}

    render(width: number): string[] {
        const rows = this.tui.terminal.rows || 24;
        const contentHeight = Math.max(
            4,
            Math.min(12, Math.floor(rows * 0.4)),
        );
        if (this.wrapped === undefined || this.wrappedWidth !== width) {
            this.wrapped = wrapTextWithAnsi(this.text, Math.max(10, width));
            this.wrappedWidth = width;
        }
        this.viewHeight = contentHeight;
        const maxScroll = Math.max(0, this.wrapped.length - contentHeight);
        this.scrollOffset = Math.max(
            0,
            Math.min(this.scrollOffset, maxScroll),
        );
        const visible = this.wrapped.slice(
            this.scrollOffset,
            this.scrollOffset + contentHeight,
        );
        const lines = visible.map((line) => truncateToWidth(line, width));
        while (lines.length < contentHeight) lines.push("");
        return lines;
    }

    invalidate(): void {
        this.wrapped = undefined;
    }

    scrollBy(delta: number): void {
        const total = this.wrapped?.length ?? 0;
        const maxScroll = Math.max(0, total - this.viewHeight);
        this.scrollOffset = Math.max(
            0,
            Math.min(this.scrollOffset + delta, maxScroll),
        );
    }

    /** Visible line count (0 before the first render); drives page scrolls. */
    get viewport(): number {
        return this.viewHeight;
    }
}

// ============================================================================
// TUI rendering (same pattern as read-session.ts)
// ============================================================================

/** Bold toolTitle + muted summary on the component slot the harness allocated. */
function searchCallComponent(
    theme: any,
    context: any,
    title: string,
    muted: string,
) {
    const text =
        theme.fg("toolTitle", theme.bold(`${title} `)) +
        theme.fg("muted", muted);
    const component =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    component.setText(text);
    return component;
}

/**
 * Width-aware collapsed preview: first 5 visual lines at the current terminal
 * width plus the "more lines, expand" hint (same trick as read-session.ts's
 * renderSessionResult). ToolExecutionComponent stacks call + result with no
 * gap, so the renderer self-supplies the leading blank line.
 */
function renderSearchResult(styled: string, expanded: boolean, theme: any) {
    if (!expanded) {
        const state: { width?: number; lines?: string[]; skipped?: number } =
            {};
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
                              theme.fg(
                                  "muted",
                                  `... (${state.skipped} more lines,`,
                              ) +
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
    return new Text(`\n${styled}`, 0, 0);
}

// ============================================================================
// Extension entry
// ============================================================================

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "search_sessions",
        label: "Search Sessions",
        description: SEARCH_SESSIONS_DESCRIPTION,
        parameters: SearchSessionsParams,

        renderCall(args, theme, context) {
            const query = typeof args.query === "string" ? args.query : "";
            return searchCallComponent(
                theme,
                context,
                "search_sessions",
                preview(query, 80) || "?",
            );
        },

        async execute(
            _toolCallId,
            params,
            signal,
            _onUpdate,
            ctx,
        ): Promise<AgentToolResult<SearchSessionsDetails>> {
            try {
                const result = await searchSessions({
                    query: params.query,
                    since: params.since,
                    until: params.until,
                    includeToolCalls: params.includeToolCalls,
                    maxResults: params.maxResults,
                    includeCurrentSession: params.includeCurrentSession,
                    scope: params.scope,
                    currentSessionFile:
                        ctx.sessionManager.getSessionFile() ?? undefined,
                    sessionDir: ctx.sessionManager.getSessionDir(),
                    cwd: ctx.cwd,
                    signal,
                });
                const text = formatHits(result, params.query);
                return {
                    content: [{ type: "text", text }],
                    details: {
                        hitCount: result.hits.length,
                        truncated: result.truncated,
                        skippedFiles: result.skippedFiles,
                        unreadable: result.unreadable,
                        listed: result.listed,
                        scanned: result.scanned,
                        ms: result.ms,
                        scope: result.scope,
                        allDegraded: result.allDegraded,
                    },
                };
            } catch (error) {
                // Loudly surface query/validation errors (invalid regex, bad
                // maxResults/since/until): the model should retry with a fixed
                // query, not treat the search as silently empty.
                throw new Error(
                    `search_sessions: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        },

        renderResult(result, { expanded }, theme, context) {
            const content = result.content
                .map((part: any) =>
                    part.type === "text" && typeof part.text === "string"
                        ? part.text
                        : "",
                )
                .join("");
            if (context.isError)
                return new Text(theme.fg("error", content), 0, 0);
            const styled = content
                .split("\n")
                .map((line: string) => theme.fg("toolOutput", line))
                .join("\n");
            return renderSearchResult(styled, expanded, theme);
        },
    });


    // ── /search-sessions ─────────────────────────────────────────────────
    // ONE persistent panel (the no-arg invocation is the primary human path):
    // a query Input on top, results below, hint line at the bottom. NOTHING is
    // written to the session unless the human explicitly picks a hit. Esc
    // while scanning aborts the scan (back to the previous results); Esc while
    // idle closes the panel writing nothing — a pure search.
    //
    // Key contract (settled, do not re-litigate): Enter is state-sensitive by
    // design. It re-scans when the box differs from the last scanned query (or
    // nothing has been scanned yet) and injects the selected hit when the box
    // is unchanged and hits are visible. Tab is deliberately NOT the send key:
    // it is the TUI's reserved autocomplete/focus key, and Enter=confirm is
    // the repo-wide picker convention. The hint line always states Enter's
    // current meaning; a mistaken Enter costs at most a redundant re-scan,
    // never a wrong injection.
    //
    // Without a UI (print/json modes) the command degrades to the historical
    // behavior: inject the full result set.
    pi.registerCommand("search-sessions", {
        description:
            "Search pi sessions interactively (opens a search panel; --all for every project)",
        handler: async (args, ctx) => {
            const parsed = parseSearchArgs(args);
            const options: SearchSessionsOptions = {
                query: parsed.query,
                since: parsed.since,
                until: parsed.until,
                maxResults: parsed.maxResults,
                includeToolCalls: parsed.includeToolCalls,
                scope: parsed.all ? "all" : "project",
                currentSessionFile:
                    ctx.sessionManager.getSessionFile() ?? undefined,
                sessionDir: ctx.sessionManager.getSessionDir(),
                cwd: ctx.cwd,
            };

            if (!ctx.hasUI) {
                const result = await searchSessions(options);
                await pi.sendMessage(
                    {
                        customType: "search-sessions",
                        content: formatHits(result, parsed.query),
                        display: true,
                    },
                    { triggerTurn: false },
                );
                return;
            }

            const picked = await ctx.ui.custom<{
                hit: SearchHit;
                query: string;
            } | null>((tui, theme, keybindings, done) => {
                const accent = (str: string) => theme.fg("accent", str);
                const dim = (str: string) => theme.fg("dim", str);

                // ── state ──
                // `results` only ever changes on a SUCCESSFUL scan, so an
                // aborted scan restores the previous results by construction.
                let results: SearchSessionsResult | null = null;
                let lastScannedQuery = "";
                let scanError: string | null = null;
                let scanGen = 0;
                let loader: CancellableLoader | null = null;
                let mode: "list" | "preview" = "list";
                let previewText: PreviewText | null = null;
                let selectList: SelectList | null = null;

                // ── static chrome (header) ──
                const root = new Container();
                const header = new Container();
                header.addChild(new DynamicBorder(accent));
                const scopeLabel = parsed.all ? "all projects" : "this project";
                const bounds = [
                    parsed.since ? `since ${parsed.since}` : "",
                    parsed.until ? `until ${parsed.until}` : "",
                    parsed.maxResults !== undefined
                        ? `max ${parsed.maxResults}`
                        : "",
                ]
                    .filter(Boolean)
                    .join(" · ");
                header.addChild(
                    new Text(
                        accent(
                            theme.bold(
                                ` Search sessions (${scopeLabel})${bounds ? ` — ${bounds}` : ""}`,
                            ),
                        ),
                        0,
                        0,
                    ),
                );
                const queryInput = new Input();
                header.addChild(queryInput);
                header.addChild(new Spacer(1));

                const listArea = new Container();
                const footer = new Container();
                // Persistent chrome lines: the hint must track every
                // keystroke (its whole job is stating what Enter will do
                // right now), and rebuilding the footer per keypress would
                // reset the list selection.
                const envelopeLineText = new Text("", 0, 0);
                const hintLine = new Text("", 0, 0);
                footer.addChild(envelopeLineText);
                footer.addChild(hintLine);
                footer.addChild(new DynamicBorder(accent));
                root.addChild(header);
                root.addChild(listArea);
                root.addChild(footer);

                // ── rendering ──
                const buildItems = (): SelectItem[] =>
                    (results?.hits ?? []).map((hit, index) => ({
                        value: String(index),
                        label:
                            `${shortenPath(hit.sessionPath)}  ${hit.timestamp}  ${hit.role}` +
                            (hit.more && hit.more > 0 ? `  (+${hit.more})` : ""),
                        description: preview(hit.snippet, 100),
                    }));

                /**
                 * The scan envelope, visible in the panel: re-scanning is the
                 * primary narrowing lever now, so a maxResults-truncated result
                 * the human cannot see would send them in circles.
                 */
                const envelopeLine = (): string | null => {
                    if (!results) return null;
                    const parts = [
                        `${results.hits.length} hit${results.hits.length === 1 ? "" : "s"}`,
                        `scanned ${results.scanned} of ${results.listed} files`,
                        `${results.ms}ms`,
                    ];
                    if (results.truncated)
                        parts.push(`truncated=${results.truncated}`);
                    if (results.allDegraded)
                        parts.push("scope degraded to this project");
                    if (results.skippedFiles.length)
                        parts.push(`skipped=${results.skippedFiles.length}`);
                    if (results.unreadable.length)
                        parts.push(`unreadable=${results.unreadable.length}`);
                    return parts.join(" · ");
                };

                /** Dynamic hint: always states what Enter will do right now. */
                const hintText = (): string => {
                    if (loader)
                        return "searching… · esc: abort (keeps previous results)";
                    if (scanError) return "enter: retry · esc: close";
                    if (!results)
                        return "type a query · enter: search · esc: close (nothing is written)";
                    if (results.hits.length === 0)
                        return "no matches · enter: re-search · esc: close";
                    const box = queryInput.getValue().trim();
                    if (box !== lastScannedQuery)
                        return `↑↓ select · enter: re-search "${box}" · the list is results for "${lastScannedQuery}" · esc: close`;
                    return "↑↓ select · enter: send hit into session · ctrl+o: preview · esc: close";
                };

                /** Repaint the two footer lines from current state. */
                const updateChrome = () => {
                    const envelope = envelopeLine();
                    envelopeLineText.setText(envelope ? dim(` ${envelope}`) : "");
                    hintLine.setText(dim(` ${hintText()}`));
                };

                const render = () => {
                    if (mode !== "list") return;
                    listArea.clear();
                    envelopeLineText.setText("");
                    selectList = null;
                    if (loader) {
                        listArea.addChild(loader);
                    } else if (scanError) {
                        listArea.addChild(
                            new Text(theme.fg("error", ` ${scanError}`), 0, 0),
                        );
                    } else if (!results) {
                        listArea.addChild(
                            new Text(
                                dim(" (no search yet — type a query above)"),
                                0,
                                0,
                            ),
                        );
                    } else if (results.hits.length === 0) {
                        listArea.addChild(
                            new Text(
                                theme.fg("warning", " No matching hits"),
                                0,
                                0,
                            ),
                        );
                    } else {
                        const items = buildItems();
                        selectList = new SelectList(
                            items,
                            Math.min(items.length, 12),
                            {
                                selectedPrefix: (text) => accent(text),
                                selectedText: (text) => accent(text),
                                description: (text) => theme.fg("muted", text),
                                scrollInfo: (text) => dim(text),
                                noMatch: (text) => theme.fg("warning", text),
                            },
                        );
                        listArea.addChild(selectList);
                    }
                    updateChrome();
                    // The scan settles asynchronously (and disposes its
                    // loader, which owned the repaint loop): without an
                    // explicit request the screen freezes on the last painted
                    // frame — the loader.
                    tui.requestRender();
                };

                const showList = () => {
                    mode = "list";
                    previewText = null;
                    root.clear();
                    root.addChild(header);
                    root.addChild(listArea);
                    root.addChild(footer);
                };

                // Preview is the picker's second render mode (not a nested
                // overlay). It re-scans the ONE session file with
                // lastScannedQuery — the query the visible results actually
                // came from, never the half-edited box content.
                const showPreview = () => {
                    const item = selectList?.getSelectedItem();
                    if (!item || !results) return;
                    const hit = results.hits[Number(item.value)];
                    if (!hit) return;
                    const previewView = new Container();
                    previewView.addChild(new DynamicBorder(accent));
                    previewView.addChild(
                        new Text(
                            accent(
                                theme.bold(
                                    ` Preview: "${lastScannedQuery}" — ${hit.role} · ${hit.timestamp}`,
                                ),
                            ),
                            0,
                            0,
                        ),
                    );
                    let content: string;
                    try {
                        content = buildPreviewContent(
                            hit,
                            loadSessionPreview(
                                hit.sessionPath,
                                lastScannedQuery,
                                options,
                            ),
                        );
                    } catch (error) {
                        content = `  (preview failed: ${error instanceof Error ? error.message : String(error)})`;
                    }
                    previewText = new PreviewText(tui, content);
                    previewView.addChild(previewText);
                    previewView.addChild(
                        new Text(
                            dim(
                                " esc/o: back to the list • ↑/↓ or j/k: scroll • ctrl+d/u: half page",
                            ),
                            0,
                            0,
                        ),
                    );
                    previewView.addChild(new DynamicBorder(accent));
                    mode = "preview";
                    root.clear();
                    root.addChild(previewView);
                };

                // ── scan runner ──
                // One generation counter guards against stale results: a newer
                // scan (or an abort) makes older settlements no-ops. Each scan
                // owns its loader and disposes the previous one.
                const startScan = (query: string) => {
                    loader?.dispose();
                    const gen = ++scanGen;
                    scanError = null;
                    const next = new CancellableLoader(
                        tui,
                        accent,
                        dim,
                        `searching "${query}"...`,
                    );
                    loader = next;
                    next.onAbort = () => {
                        if (gen !== scanGen) return;
                        // Invalidate the pending settlement: an aborted scan
                        // still RESOLVES (with a partial result and
                        // truncated=aborted), and without the bump it would
                        // overwrite the previous results the hint just
                        // promised to keep.
                        scanGen++;
                        loader?.dispose();
                        loader = null;
                        render(); // back to the previous results (or empty)
                    };
                    next.start();
                    searchSessions({ ...options, query, signal: next.signal })
                        .then((result) => {
                            if (gen !== scanGen) return;
                            loader?.dispose();
                            loader = null;
                            results = result;
                            lastScannedQuery = query;
                            render();
                        })
                        .catch((error) => {
                            if (gen !== scanGen) return;
                            loader?.dispose();
                            loader = null;
                            scanError =
                                error instanceof Error
                                    ? error.message
                                    : String(error);
                            render();
                        });
                    render();
                };

                // Enter commit: re-scan when the box is dirty (or nothing has
                // been scanned, or the last scan came back empty — a retry is
                // the only sensible action), otherwise inject the picked hit.
                // Typing DURING a scan is allowed (keystrokes are never
                // swallowed) but Enter is a no-op until the scan settles.
                queryInput.onSubmit = (value) => {
                    const query = value.trim();
                    if (!query || loader) return;
                    if (
                        !results ||
                        results.hits.length === 0 ||
                        query !== lastScannedQuery
                    ) {
                        startScan(query);
                        return;
                    }
                    const item = selectList?.getSelectedItem();
                    if (!item) return;
                    const hit = results.hits[Number(item.value)];
                    if (!hit) return;
                    done({ hit, query: lastScannedQuery });
                };

                if (parsed.query) {
                    // Old muscle memory (/search-sessions goal): prefill the box
                    // and run the first scan immediately.
                    queryInput.setValue(parsed.query);
                    startScan(parsed.query);
                } else {
                    render();
                }

                return {
                    render: (width: number) => root.render(width),
                    invalidate: () => root.invalidate(),
                    handleInput: (data: string) => {
                        if (mode === "preview") {
                            if (
                                keybindings.matches(data, "tui.select.cancel") ||
                                keybindings.matches(data, "tui.select.confirm") ||
                                matchesKey(data, "o") ||
                                matchesKey(data, Key.ctrl("o"))
                            ) {
                                showList();
                                tui.requestRender();
                                return;
                            }
                            if (
                                keybindings.matches(data, "tui.select.up") ||
                                matchesKey(data, "k")
                            ) {
                                previewText?.scrollBy(-1);
                                tui.requestRender();
                                return;
                            }
                            if (
                                keybindings.matches(data, "tui.select.down") ||
                                matchesKey(data, "j")
                            ) {
                                previewText?.scrollBy(1);
                                tui.requestRender();
                                return;
                            }
                            if (matchesKey(data, Key.ctrl("d"))) {
                                previewText?.scrollBy(
                                    Math.floor(
                                        (previewText?.viewport ?? 12) / 2,
                                    ),
                                );
                                tui.requestRender();
                                return;
                            }
                            if (matchesKey(data, Key.ctrl("u"))) {
                                previewText?.scrollBy(
                                    -Math.floor(
                                        (previewText?.viewport ?? 12) / 2,
                                    ),
                                );
                                tui.requestRender();
                                return;
                            }
                            if (
                                keybindings.matches(data, "tui.select.pageUp") ||
                                matchesKey(data, Key.left)
                            ) {
                                previewText?.scrollBy(
                                    -(previewText?.viewport ?? 12),
                                );
                                tui.requestRender();
                                return;
                            }
                            if (
                                keybindings.matches(data, "tui.select.pageDown") ||
                                matchesKey(data, Key.right)
                            ) {
                                previewText?.scrollBy(
                                    previewText?.viewport ?? 12,
                                );
                                tui.requestRender();
                                return;
                            }
                            // Swallow everything else: typing must not reach
                            // the (hidden) query box.
                            return;
                        }
                        // Esc: scanning aborts the scan; idle closes the panel.
                        if (keybindings.matches(data, "tui.select.cancel")) {
                            if (loader) {
                                loader.handleInput(data); // → onAbort
                            } else {
                                done(null);
                            }
                            tui.requestRender();
                            return;
                        }
                        if (matchesKey(data, Key.ctrl("o"))) {
                            showPreview();
                            tui.requestRender();
                            return;
                        }
                        if (
                            keybindings.matches(data, "tui.select.up") ||
                            keybindings.matches(data, "tui.select.down")
                        ) {
                            selectList?.handleInput(data);
                            tui.requestRender();
                            return;
                        }
                        // Everything else is typing (Enter reaches the Input's
                        // onSubmit — it is deliberately NOT intercepted here,
                        // and it never goes to the list).
                        queryInput.handleInput(data);
                        // The hint states Enter's CURRENT meaning, so it has
                        // to track every keystroke, not just state changes.
                        updateChrome();
                        tui.requestRender();
                    },
                };
            });

            if (!picked) return; // Esc: nothing written
            // Injected as a display-only custom message; no new turn. The
            // customType stays in SELF_EXCLUDED_CUSTOM_TYPES so neither this
            // injection nor the historical full-result ones self-amplify.
            await pi.sendMessage(
                {
                    customType: "search-sessions",
                    content: formatSingleHit(picked.hit, picked.query),
                    display: true,
                },
                { triggerTurn: false },
            );
        },
    });
}
