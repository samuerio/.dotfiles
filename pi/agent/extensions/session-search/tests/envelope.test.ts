// envelope.ts tests: the answer line's contract. Pure functions, no pi, so
// `node --test` loads this directly. Each case pins one shape that the tool
// description promises to the model.

import assert from "node:assert/strict";
import test from "node:test";
import {
    type EnvelopeInput,
    capList,
    formatEnvelope,
    isEmptyScope,
    noHitsBody,
    truncationNote,
} from "../envelope.ts";

function base(overrides: Partial<EnvelopeInput> = {}): EnvelopeInput {
    return {
        query: "变压器",
        scope: "project",
        allDegraded: false,
        hits: 0,
        archived: 0,
        listed: 3,
        coldState: "absent",
        coldListed: 0,
        unreadable: [],
        ...overrides,
    };
}

test("a plain search reports the query, the scope and the session count only", () => {
    assert.equal(
        formatEnvelope(base({ hits: 3 })),
        "[query=变压器 scope=project hits=3]",
    );
});

test("no coverage counters ever reach the line", () => {
    const line = formatEnvelope(base({ hits: 1 }));
    for (const forbidden of [
        "scanned=",
        "listed=",
        "cold=",
        "coldListed=",
        "coldMatched=",
        "staleSessions=",
        "coldTruncated=",
    ]) {
        assert.ok(
            !line.includes(forbidden),
            `${forbidden} must stay in details, not on the answer line`,
        );
    }
});

test("archived hits are counted over the delivered set", () => {
    assert.equal(
        formatEnvelope(base({ hits: 4, archived: 2 })),
        "[query=变压器 scope=project hits=4 (2 archived)]",
    );
    // Zero archived hits add nothing: absence means "all hot".
    assert.equal(
        formatEnvelope(base({ hits: 4, archived: 0 })),
        "[query=变压器 scope=project hits=4]",
    );
});

test("an empty scope is stated on hits, not as a second counter", () => {
    const empty = base({ hits: 0, listed: 0, coldState: "queried", coldListed: 0 });
    assert.ok(isEmptyScope(empty));
    assert.equal(
        formatEnvelope(empty),
        "[query=变压器 scope=project hits=0 (no sessions in scope)]",
    );
    // The body must not claim "no matches": nothing was searched.
    assert.equal(noHitsBody(empty), "(nothing to search)");
});

test("an unqueried archive blocks the empty-scope claim", () => {
    // Skipped (--hot-only) and incompatible both leave archived sessions
    // uncounted, so "nothing in scope" would be a lie.
    for (const coldState of ["skipped", "incompatible"] as const) {
        const input = base({ hits: 0, listed: 0, coldState });
        assert.equal(isEmptyScope(input), false, coldState);
        assert.ok(!formatEnvelope(input).includes("no sessions in scope"));
    }
    // ...and so does a non-empty archive on the queried path.
    assert.equal(
        isEmptyScope(base({ hits: 0, listed: 0, coldState: "queried", coldListed: 2 })),
        false,
    );
});

test("truncation suppresses the empty-scope claim and qualifies the body", () => {
    const input = base({ hits: 0, listed: 0, truncated: "time-budget" });
    assert.equal(isEmptyScope(input), false);
    assert.equal(
        formatEnvelope(input),
        "[query=变压器 scope=project hits=0 truncated=time-budget (partial; narrow the query)]",
    );
    assert.equal(noHitsBody(input), "(no hits yet; results incomplete)");
});

test("truncation reasons carry a next step instead of a tautology", () => {
    assert.equal(
        truncationNote("maxResults"),
        "truncated=maxResults (cap reached; narrow the query or raise maxResults)",
    );
    assert.equal(
        truncationNote("time-budget"),
        "truncated=time-budget (partial; narrow the query)",
    );
    assert.equal(truncationNote("aborted"), "truncated=aborted (cancelled; partial)");
    // Unknown reasons still print, without inventing advice.
    assert.equal(truncationNote("weird"), "truncated=weird");
    assert.equal(truncationNote(undefined), undefined);
});

test("an unusable archive is a caveat, and the body never says no-match", () => {
    const input = base({
        hits: 3,
        coldState: "incompatible",
        coldUnavailable: "archive.db projection_version is 9, expected 1; run /archive rebuild",
    });
    assert.equal(
        formatEnvelope(input),
        "[query=变压器 scope=project hits=3 coldUnavailable=1 " +
            "(archive.db projection_version is 9, expected 1; run /archive rebuild)]",
    );
    assert.equal(noHitsBody({ ...input, hits: 0 }), "(no hits yet; results incomplete)");
    // A skipped/absent archive with an empty hot side is still "nothing to
    // search" only when the cold side was actually accounted for (it was not,
    // here), so this stays a plain no-match candidate.
    assert.equal(
        noHitsBody(base({ hits: 0, listed: 0, coldState: "skipped" })),
        "(no matches)",
    );
    // A plain zero-hit search is the only shape allowed to say "no matches".
    assert.equal(noHitsBody(base({ hits: 0 })), "(no matches)");
});

test("unreadable names the side and caps the path list", () => {
    assert.equal(
        formatEnvelope(base({ hits: 1, unreadable: ["~/proj/a.jsonl", "~/proj/b.jsonl"] })),
        "[query=变压器 scope=project hits=1 unreadable=2 (hot: ~/proj/a.jsonl, ~/proj/b.jsonl)]",
    );
    const many = Array.from({ length: 13 }, (_, i) => `~/proj/${i}.jsonl`);
    assert.equal(
        formatEnvelope(base({ hits: 1, unreadable: many })),
        "[query=变压器 scope=project hits=1 unreadable=13 (hot: " +
            `${capList(many)})]`,
    );
    assert.ok(capList(many).endsWith("+3 more"));
});

test("a degraded --all is annotated with a space, like every other note", () => {
    assert.equal(
        formatEnvelope(base({ hits: 1, scope: "all", allDegraded: true })),
        "[query=变压器 scope=all (degraded-to-project) hits=1]",
    );
});

test("a multi-line query cannot break the last-line contract", () => {
    const line = formatEnvelope(base({ hits: 1, query: "line1\nline2" }));
    assert.equal(line, "[query=line1\\nline2 scope=project hits=1]");
    assert.ok(!line.includes("\n"));
});
