/**
 * Session search extension (single file): the search_sessions tool + the
 * /search-sessions slash command.
 *
 * Search capability forked from `adobe/pi-session-search` (compileQuery with
 * its `g`/`y` flag stripping, snippet generation, newest-first ordering, and
 * the no-index realtime-scan stance) but rebuilt on the active-branch parse
 * pipeline shared with read-session.ts (`lib/session-common.ts`): each session
 * file goes through `loadSessionEntries` → `buildContextEntries`, so only the
 * resolved active branch is searched — upstream's raw-JSONL grep hits
 * abandoned branches, which here it cannot.
 *
 * ─ Scope (deliberate) ─
 * Current project only, one level: the file list comes from
 * `SessionManager.list(cwd)` (the same source as the drill tools' id
 * resolution in `resolveSessionRef`), which physically equals "all sessions
 * of the current project" and naturally excludes subagent sessions (they live
 * under `sessions/<tool>/<runId>/`, a different tree). Every emitted session
 * ref is therefore always drillable by the existing tool trio. No index, no
 * cross-project search, no tool-result search (upstream defaults, kept).
 *
 * Summary invariant: a compaction/branch_summary hit never duplicates an
 * original-message hit within the same session — the raw messages compacted
 * away are no longer in buildContextEntries' active-branch projection, so the
 * summary is the only searchable copy of that stretch of history.
 *
 * ─ Output contract ─
 * No fourth read tool. Each hit emits both a session path and a session id:
 *
 *   session=<path> id=<sessionId> entry=<entryId> ts=<timestamp> role=<role>
 *     <snippet>
 *
 * `<path>` (home collapsed to ~) is always drillable by read_session /
 * read_session_entry; `<sessionId>` is the natural id form both drill tools
 * accept; `<entryId>` is the read_session_entry drill handle, recovered with
 * the same entry/message zip `alignAnnotations` uses in read-session.ts.
 * The model's natural next step is read_session or read_session_entry.
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
    type ExtensionAPI,
    keyHint,
    SessionManager,
    type SessionEntry,
    sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadSessionEntries, textOf } from "./lib/session-common.ts";

const SNIPPET_BEFORE = 120;
const SNIPPET_AFTER = 240;
const MAX_HAYSTACK_CHARS = 256 * 1024; // ReDoS bound: truncate before regex
const MAX_SESSION_FILE_BYTES = 5 * 1024 * 1024; // skip oversized files (visible in skippedFiles)
const DEFAULT_MAX_RESULTS = 50;
const HARD_MAX_RESULTS = 1000;
const TOOL_CALL_ARGS_PREVIEW = 400;

/** custom_message customTypes that are THIS family's own injected output; searching them self-amplifies. */
const SELF_EXCLUDED_CUSTOM_TYPES = new Set(["search-sessions"]);

const SEARCH_SESSIONS_DESCRIPTION =
    "Search the CURRENT PROJECT's pi sessions (one level: ~/.pi/agent/sessions/<project>/) for a " +
    "keyword or /regex/, over the resolved active branch of each session (abandoned branches are not " +
    "searched). Searches user/assistant body text, custom injected messages (the search tool's own " +
    "search-sessions output excluded), and branch_summary/compaction summaries; tool results are never " +
    "searched (they contain whole-file contents and command output that drown matches). Custom_message " +
    "and branch_summary hits drill to " +
    "their full text via read_session_entry; compaction originals are restored with " +
    "read_session_compaction. Returns " +
    "hits sorted newest-first, each as " +
    "session=<path> id=<sessionId> entry=<entryId> ts=<timestamp> role=<role> plus a snippet: pass the " +
    "path or id to read_session for the full transcript, or entry=<entryId> to read_session_entry to " +
    "drill into the exact entry. Read-only.";

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
            description: `Maximum hits. Default ${DEFAULT_MAX_RESULTS}, hard cap ${HARD_MAX_RESULTS}. Explicit invalid values (0, negative, NaN, non-integer) throw.`,
        }),
    ),
    includeCurrentSession: Type.Optional(
        Type.Boolean({
            description:
                "Include the live session in the search. Default false (excluded).",
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
}

export interface SearchSessionsDetails {
    path?: string;
    hitCount: number;
    /** Hard cap reached: there were more matches than maxResults. */
    truncated: boolean;
    /** Session files skipped for size (>5 MB); each entry is "path (N KB)". */
    skippedFiles: string[];
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
} {
    let since: string | undefined;
    let until: string | undefined;
    let maxResults: number | undefined;
    let includeToolCalls = false;
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
                default:
                    throw new Error(
                        `unknown flag --${flag} (supported: since, until, max, include-tool-calls).`,
                    );
            }
            continue;
        }
        queryParts.push(token);
    }

    const query = queryParts.join(" ").trim();
    if (!query)
        throw new Error(
            "usage: /search-sessions [--since=ISO] [--until=ISO] [--max=N] [--include-tool-calls] <query>",
        );
    return { query, since, until, maxResults, includeToolCalls };
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
}

export interface SearchSessionsResult {
    hits: SearchHit[];
    truncated: boolean;
    skippedFiles: string[];
    scanned: number;
}

/**
 * Search the current project's sessions (SessionManager.list(cwd), one level)
 * over the resolved active branch of each session file. Hits are collected
 * then sorted newest-first by message timestamp (no relevance scoring;
 * unparseable timestamps sort last). Stops scanning at maxResults hits —
 * the list is mtime-desc, so early exit biases toward recent sessions.
 *
 * Time bounds bind to MESSAGE timestamps (post-resolution), not file mtime:
 * mtime would let an old session rewritten recently bypass the filter.
 * `since`/`until` and explicit invalid maxResults throw loudly; unreadable
 * files are skipped silently (sessions are written live and may be mid-write).
 */
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
    const includeToolCalls = options.includeToolCalls === true;

    const sessions = await SessionManager.list(process.cwd());
    const currentAbs = options.currentSessionFile
        ? path.resolve(options.currentSessionFile)
        : undefined;

    const hits: SearchHit[] = [];
    const skippedFiles: string[] = [];
    let truncated = false;
    let scanned = 0;

    for (const session of sessions) {
        if (hits.length >= max) {
            truncated = true;
            break;
        }

        // Live-session exclusion: compare resolved absolute paths (the id in the
        // header would also work, but files without a resolvable id still
        // deserve exclusion when they ARE the current session).
        if (
            currentAbs &&
            path.resolve(session.path) === currentAbs &&
            options.includeCurrentSession !== true
        ) {
            continue;
        }

        // Size cap (upstream convention): skip oversized files, keep the skip
        // visible. Sessions are written live and can legitimately grow large.
        let stat: fs.Stats;
        try {
            stat = fs.statSync(session.path);
        } catch {
            continue;
        }
        if (stat.size > MAX_SESSION_FILE_BYTES) {
            skippedFiles.push(
                `${shortenPath(session.path)} (${Math.round(stat.size / 1024)} KB)`,
            );
            continue;
        }

        let header, entries;
        try {
            ({ header, entries } = loadSessionEntries(session.path));
        } catch {
            continue;
        }
        scanned++;

        const sessionId = header?.id ?? session.id;
        // The resolved active-branch entry list — the same list
        // buildSessionContext projects into context.messages (each entry yields
        // 0/1 messages via sessionEntryToContextMessages, in order), so entry →
        // message pairing is exact: the entry id IS the read_session_entry
        // drill handle (same zip read-session.ts's alignAnnotations relies on).
        const contextEntries = buildContextEntries(entries);
        for (const entry of contextEntries) {
            if (hits.length >= max) {
                truncated = true;
                break;
            }
            for (const msg of sessionEntryToContextMessages(entry)) {
                // Self-reference guard: the slash command injects its own
                // result as a custom message; searching it would self-amplify.
                if (
                    msg.role === "custom" &&
                    SELF_EXCLUDED_CUSTOM_TYPES.has(msg.customType)
                )
                    continue;

                // Haystack via haystackFor (empty = unsearchable role), then
                // truncated before matching (ReDoS bound).
                let haystack = haystackFor(msg, includeToolCalls);
                if (!haystack) continue;
                if (haystack.length > MAX_HAYSTACK_CHARS)
                    haystack = haystack.slice(0, MAX_HAYSTACK_CHARS);

                const match = haystack.match(re);
                if (!match) continue;

                const tsMs = Date.parse(entry.timestamp);
                if (
                    sinceMs !== undefined &&
                    !(Number.isFinite(tsMs) && tsMs >= sinceMs)
                )
                    continue;
                if (
                    untilMs !== undefined &&
                    !(Number.isFinite(tsMs) && tsMs <= untilMs)
                )
                    continue;

                hits.push({
                    sessionPath: session.path,
                    sessionId,
                    entryId: entry.id,
                    timestamp: entry.timestamp,
                    role: msg.role,
                    snippet: buildSnippet(haystack, match.index ?? 0),
                });
                if (hits.length >= max) {
                    truncated = true;
                    break;
                }
            }
            if (hits.length >= max) break;
        }
    }

    hits.sort((a, b) => {
        const ta = Date.parse(a.timestamp);
        const tb = Date.parse(b.timestamp);
        return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });

    return { hits, truncated, skippedFiles, scanned };
}

/** Format hits for the tool result / slash command: the output contract lines. */
export function formatHits(
    result: SearchSessionsResult,
    query: string,
): string {
    const lines: string[] = [];
    for (const hit of result.hits) {
        lines.push(
            `session=${shortenPath(hit.sessionPath)} id=${hit.sessionId} entry=${hit.entryId} ts=${hit.timestamp} role=${hit.role}`,
        );
        lines.push(`  ${hit.snippet}`);
    }

    const envelopeParts = [
        `query=${query}`,
        `hits=${result.hits.length}`,
        `scanned=${result.scanned}`,
        result.truncated
            ? `truncated=true (maxResults reached; narrow the query or raise maxResults)`
            : undefined,
        result.skippedFiles.length
            ? `skipped=${result.skippedFiles.length} (${result.skippedFiles.join(", ")})`
            : undefined,
    ].filter((part): part is string => part !== undefined);

    if (lines.length === 0)
        return `(no matches)\n\n[${envelopeParts.join(" ")}]`;
    return `${lines.join("\n")}\n\n[${envelopeParts.join(" ")}]`;
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
            _signal,
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
                    currentSessionFile:
                        ctx.sessionManager.getSessionFile() ?? undefined,
                });
                const text = formatHits(result, params.query);
                return {
                    content: [{ type: "text", text }],
                    details: {
                        hitCount: result.hits.length,
                        truncated: result.truncated,
                        skippedFiles: result.skippedFiles,
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

    pi.registerCommand("search-sessions", {
        description: "Search the current project's pi sessions",
        handler: async (args, ctx) => {
            const parsed = parseSearchArgs(args);
            const result = await searchSessions({
                ...parsed,
                currentSessionFile:
                    ctx.sessionManager.getSessionFile() ?? undefined,
            });
            // Injected as a display-only custom message; no new turn.
            await pi.sendMessage(
                {
                    customType: "search-sessions",
                    content: formatHits(result, parsed.query),
                    display: true,
                },
                { triggerTurn: false },
            );
        },
    });
}
