/**
 * The answer line: the last line of `search_sessions` output and of the
 * `/search-sessions` command.
 *
 * One rule decides what belongs here: the line reports the ANSWER and the
 * caveats on that answer, nothing about the work that produced it. Every number
 * except the `unreadable` file list is a SESSION count, because results are
 * session-grouped, drilled by `session=`/`id=`, capped by `maxResults` in
 * sessions, and `more=N` is nested inside a session row.
 *
 * The old shape mixed two address spaces on one line (hot-side file/work counts
 * next to cold-side entry counts), so `hits=4 scanned=2 listed=3` could not be
 * reconciled without knowing that cold hits are merged in and that
 * `coldMatched` counted entry rows. Coverage counters live in the tool result's
 * `details` and in the TUI panel prose instead; `scanned < listed` was the worst
 * offender because it *looked* like partial coverage while being full coverage
 * with the raw-text prefilter doing its job.
 *
 * Naming: keys are camelCase and mirror the identifiers/params they report;
 * values are copied verbatim from the parameter or enum they name
 * (`maxResults`, `time-budget`, `aborted`). Annotations are always
 * `key=value (note)`, space separated, so the whole line obeys one shape.
 *
 * Kept pi-free on purpose: `tests/envelope.test.ts` runs under plain
 * `node --test`.
 */

/** Why the archive index did or did not take part in this search. */
export type ColdState =
    /** Queried through the archive index. */
    | "queried"
    /** No archive database exists (never ran `/archive run --apply`). */
    | "absent"
    /** Deliberately skipped (`--hot-only`). */
    | "skipped"
    /** The archive exists but cannot be queried; see `coldUnavailable`. */
    | "incompatible";

export interface EnvelopeInput {
    /** Query as given, escaped to stay on one line. */
    query: string;
    scope: "project" | "all";
    /** An `all` request that had to fall back to project scope. */
    allDegraded: boolean;
    /** Delivered hit count: session groups, after `maxResults`. */
    hits: number;
    /** Delivered hits that came from the archive. */
    archived: number;
    /** Hot-side session files discovered in scope (before any filtering). */
    listed: number;
    coldState: ColdState;
    /** Archived sessions in scope; meaningful for `queried`/`absent` only. */
    coldListed: number;
    /** Reason the archive could not be queried (for `incompatible`). */
    coldUnavailable?: string;
    /** Set when results were cut short: `maxResults`, `time-budget`, `aborted`. */
    truncated?: string;
    /** Hot-side session files that could not be read or parsed. */
    unreadable: string[];
}

/** Comma list with a `+N more` tail, so the line cannot grow unbounded. */
export function capList(items: string[], max = 10): string {
    if (items.length <= max) return items.join(", ");
    return `${items.slice(0, max).join(", ")} +${items.length - max} more`;
}

/**
 * Envelope fragment for a cut-short search: the reason plus the next step.
 * No tautologies ("time-budget (time budget)" tells the reader nothing).
 */
export function truncationNote(truncated: string | undefined): string | undefined {
    if (truncated === undefined) return undefined;
    if (truncated === "maxResults")
        return "truncated=maxResults (cap reached; narrow the query or raise maxResults)";
    if (truncated === "time-budget")
        return "truncated=time-budget (partial; narrow the query)";
    if (truncated === "aborted") return "truncated=aborted (cancelled; partial)";
    return `truncated=${truncated}`;
}

/**
 * True when the search looked at nothing: no session on either side was in
 * scope, and nothing was cut short. This is the one shape where `hits=0` must
 * not be read as "your history has nothing about this" — the honest answer is
 * that the scope was empty (new project, wrong cwd, mistyped `--session-dir`).
 *
 * Not claimed when the cold side was skipped or unusable: then the archived
 * sessions were never counted, so "nothing in scope" would be a lie.
 */
export function isEmptyScope(input: EnvelopeInput): boolean {
    if (input.listed !== 0) return false;
    if (input.truncated !== undefined) return false;
    if (input.coldState === "queried") return input.coldListed === 0;
    return input.coldState === "absent";
}

/**
 * The body line printed instead of hits. Three different zeros, three different
 * sentences: `(no matches)` is only allowed when the scope held sessions and
 * every one of them was judged. Everything else is the exact "reads as
 * no-match but isn't" failure this line exists to prevent.
 */
export function noHitsBody(input: EnvelopeInput): string {
    if (isEmptyScope(input)) return "(nothing to search)";
    if (input.truncated !== undefined) return "(no hits yet; results incomplete)";
    if (input.coldState === "incompatible") return "(no hits yet; results incomplete)";
    return "(no matches)";
}

/** Build the answer line, brackets included. */
export function formatEnvelope(input: EnvelopeInput): string {
    const parts: string[] = [];
    // A query with a newline would break both the one-line contract and the
    // renderer's trailing `[query=` check.
    parts.push(`query=${input.query.replace(/\r?\n/g, "\\n")}`);
    parts.push(
        `scope=${input.scope}${input.allDegraded ? " (degraded-to-project)" : ""}`,
    );

    let hits = `hits=${input.hits}`;
    if (input.archived > 0) hits += ` (${input.archived} archived)`;
    // Glued to hits on purpose: it explains the zero, it is not a second count.
    if (input.hits === 0 && isEmptyScope(input))
        hits += " (no sessions in scope)";
    parts.push(hits);

    if (input.coldState === "incompatible")
        parts.push(
            `coldUnavailable=1 (${input.coldUnavailable ?? "archive index unusable"})`,
        );

    const truncated = truncationNote(input.truncated);
    if (truncated) parts.push(truncated);

    if (input.unreadable.length > 0)
        // The side is named in the value: this is hot-side only (the cold side
        // never reads session files during a query), and a `hot_` key prefix
        // would be the only snake_case token on the line.
        parts.push(
            `unreadable=${input.unreadable.length} (hot: ${capList(input.unreadable)})`,
        );

    return `[${parts.join(" ")}]`;
}
