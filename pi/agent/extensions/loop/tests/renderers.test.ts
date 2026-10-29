// Renderer formatter tests: pure string format* functions from loop.ts,
// exercised with a passthrough theme (no TUI involved).
import assert from "node:assert/strict";
import test from "node:test";

import {
    formatCreateCall,
    formatCreateResult,
    formatDeleteCall,
    formatDeleteResult,
    formatListResult,
    type LoopCreateDetails,
    type LoopListDetails,
} from "../../loop.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

/** Passthrough theme: asserts see plain strings, colors don't interfere. */
const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme;

const RESULT = (text: string) => ({
    content: [{ type: "text", text }],
    details: undefined,
});

test("formatCreateCall: complete args show human schedule + quoted prompt", () => {
    const out = formatCreateCall(
        { cron: "*/1 * * * *", prompt: "say hello" },
        theme,
        true,
    );
    assert.match(out, /^loop_create /);
    assert.match(out, /Every minute/);
    assert.match(out, /"say hello"/);
    // Raw cron is not echoed next to the humanized form.
    assert.doesNotMatch(out, /\*\/1 \* \* \* \*/);
});

test("formatCreateCall: streaming args stay raw (no humanizing, no facts)", () => {
    const out = formatCreateCall(
        { cron: "*/1 * */", prompt: '"say hel' },
        theme,
        false,
    );
    assert.match(out, /^loop_create /);
    assert.match(out, /\*\/1 \* \*\//); // raw cron visible while streaming
    assert.doesNotMatch(out, /Every \d+ minutes?/);
});

test("formatCreateCall: invalid cron falls back to the raw expression", () => {
    const out = formatCreateCall(
        { cron: "99 * * * *", prompt: "x" },
        theme,
        true,
    );
    assert.match(out, /99 \* \* \* \*/);
});

test("formatCreateCall: terminal-control characters in prompt are neutralized", () => {
    const out = formatCreateCall(
        { cron: "*/5 * * * *", prompt: "a\x1b[2Jb\r\nc\td" },
        theme,
        true,
    );
    assert.ok(!out.includes("\x1b["));
    assert.ok(!out.includes("\r"));
    assert.ok(!out.includes("\n"));
});

test("formatCreateResult: collapsed shows id, kind, scope, first fire", () => {
    const details: LoopCreateDetails = {
        id: "3f9a1c2b",
        cron: "*/1 * * * *",
        recurring: true,
        durable: false,
        nextFireAt: Date.now() + 60_000,
    };
    const out = formatCreateResult(
        { cron: "*/1 * * * *", prompt: "say hello" },
        details,
        RESULT("Scheduled recurring job 3f9a1c2b."),
        { expanded: false },
        theme,
        false,
    );
    assert.match(out, /3f9a1c2b/);
    assert.match(out, /· recurring · session/);
    assert.match(out, /first fire ~/);
    // Collapsed must stay one line, no prompt echo.
    assert.ok(!out.includes("\n"));
    assert.ok(!out.includes("say hello"));
});

test("formatCreateResult: expanded adds key rows with prompt continuation indent", () => {
    const details: LoopCreateDetails = {
        id: "3f9a1c2b",
        cron: "0 9 * * 1-5",
        recurring: true,
        durable: true,
        nextFireAt: null,
    };
    const out = formatCreateResult(
        { cron: "0 9 * * 1-5", prompt: "line one\nline two" },
        details,
        RESULT("Scheduled."),
        { expanded: true },
        theme,
        false,
    );
    assert.match(out, /cron\s+0 9 \* \* 1-5/);
    assert.match(out, /durable — persisted to \.pi\/loop-tasks\.json/);
    assert.match(out, /auto-expires after 7 days/);
    assert.match(out, /prompt\s+line one\n\s+line two/);
    // One-shot wording must not appear for a recurring job.
    assert.doesNotMatch(out, /fires once/);
});

test("formatCreateResult: details-less results fall back to content text", () => {
    const out = formatCreateResult(
        {},
        undefined,
        RESULT("Scheduled recurring job 3f9a1c2b (Every minute). Session-only…"),
        { expanded: false },
        theme,
        false,
    );
    assert.match(out, /Scheduled recurring job 3f9a1c2b/);
    assert.ok(!out.includes("\n"));
});

test("formatCreateResult: error path renders error text, not details", () => {
    const details: LoopCreateDetails = {
        id: "3f9a1c2b",
        cron: "*/1 * * * *",
        recurring: true,
        durable: false,
        nextFireAt: 123,
    };
    const out = formatCreateResult(
        { cron: "*/1 * * * *" },
        details,
        RESULT("Cron expression '*/1 * * * *' does not match any calendar date."),
        { expanded: true },
        theme,
        true,
    );
    assert.match(out, /does not match any calendar date/);
    assert.doesNotMatch(out, /first fire/);
});

test("formatDeleteResult: success hides the result row collapsed and expanded", () => {
    // The call row (`loop_delete <id>`) already says everything.
    const result = RESULT("Cancelled job 3f9a1c2b.");
    const details = { id: "3f9a1c2b", scope: "session" as const };
    assert.equal(formatDeleteResult(details, result, { expanded: false }, theme, false), "");
    assert.equal(formatDeleteResult(details, result, { expanded: true }, theme, false), "");
});

test("formatDeleteResult: unknown details fall back to content text", () => {
    const out = formatDeleteResult(
        undefined,
        RESULT("Cancelled job 3f9a1c2b."),
        { expanded: false },
        theme,
        false,
    );
    assert.match(out, /Cancelled job 3f9a1c2b\./);
});

test("formatListResult: empty list renders a quiet empty state", () => {
    const out = formatListResult(
        { jobs: [] } satisfies LoopListDetails,
        RESULT("No scheduled jobs."),
        { expanded: false },
        theme,
        false,
    );
    assert.match(out, /no scheduled jobs/);
});

function jobsOf(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        id: String(index).padStart(8, "f"),
        cron: "*/1 * * * *",
        recurring: true,
        durable: index % 2 === 0,
        prompt: `job ${index}`,
        createdAt: Date.now(),
    }));
}

test("formatListResult: collapsed header counts durable vs session", () => {
    const out = formatListResult(
        { jobs: jobsOf(3) },
        RESULT("3 — Every minute (recurring): job 0\n…"),
        { expanded: false },
        theme,
        false,
    );
    assert.match(out, /3 jobs · 2 durable · 1 session/);
});

test("formatListResult: collapsed caps rows at 5 with a hint", () => {
    const out = formatListResult(
        { jobs: jobsOf(8) },
        RESULT("8 lines"),
        { expanded: false },
        theme,
        false,
    );
    const rows = out.split("\n");
    assert.equal(rows.length, 7); // header + 5 rows + more-hint
    assert.match(out, /… 3 more jobs · .*expand/);
});

test("formatListResult: expanded shows every job plus a detail line", () => {
    const out = formatListResult(
        { jobs: jobsOf(3) },
        RESULT("3 lines"),
        { expanded: true },
        theme,
        false,
    );
    const lines = out.split("\n");
    // header + 3 rows + 3 detail lines; no truncation hint.
    assert.equal(lines.length, 7);
    assert.match(out, /cron \*\/1 \* \* \* \* · created /);
    assert.match(out, /fires while session idle/);
    assert.doesNotMatch(out, /more jobs/);
});

test("formatListResult: details-less results fall back to the raw text lines", () => {
    const out = formatListResult(
        undefined,
        RESULT("3f9a1c2b — Every minute (recurring): legacy"),
        { expanded: false },
        theme,
        false,
    );
    assert.match(out, /legacy/);
});

test("formatListResult: invalid cron keeps the raw body and still fits the row", () => {
    const out = formatListResult(
        {
            jobs: [
                {
                    id: "beefbeef",
                    cron: "99 * * * *",
                    recurring: true,
                    durable: true,
                    prompt: "x",
                    createdAt: Date.now(),
                },
            ],
        },
        RESULT("beefbeef — invalid cron (recurring): x"),
        { expanded: false },
        theme,
        false,
    );
    assert.match(out, /invalid cron/);
});

// ─── Renderer hardening (reviewed failure modes) ───────────────────

test("renderer hardening: malformed details and content never throw", () => {
    // prompt / createdAt of the wrong runtime type, null content,
    // garbage job entries — the underlying strip/format must hold.
    formatListResult(
        { jobs: [{ id: "a", cron: "*/5 * * * *", prompt: 42, recurring: true, durable: true, createdAt: "x" }] } as unknown as LoopListDetails,
        { content: null as unknown as [] },
        { expanded: false },
        theme,
        false,
    );
    formatListResult(
        // @ts-expect-error hand-edited session data
        { jobs: [{ id: "b", cron: "*/5 * * * *" }] },
        { content: undefined as unknown as [] },
        { expanded: true },
        theme,
        false,
    );
    formatCreateResult(
        undefined as unknown as Record<string, never>,
        undefined,
        { content: undefined as unknown as [] },
        { expanded: false },
        theme,
        true,
    );
    // All four calls must fall back without raising.
});

test("renderer hardening: null/undefined args in call rows never throw", () => {
    assert.equal(formatCreateCall(null as unknown as {}, theme, true), "loop_create …");
    assert.equal(formatDeleteCall(undefined as unknown as {}, theme, true), "loop_delete …");
});

test("renderer hardening: ANSI in cron and id is neutralized (not only prompt)", () => {
    const call = formatCreateCall(
        { cron: "*/5 * * * *\u001b]0;pwned\u0007" },
        theme,
        true,
    );
    assert.ok(!call.includes("\u001b"), "cron sequences must be stripped");
    const del = formatDeleteCall({ id: "id\u001b[2J" }, theme, true);
    assert.ok(!del.includes("\u001b"), "id sequences must be stripped");
    const listed = formatListResult(
        {
            jobs: [
                {
                    id: "id\u001b[2J",
                    cron: "*/1 * * * *",
                    recurring: true,
                    durable: true,
                    prompt: "x",
                    createdAt: Number.NaN,
                },
            ],
        },
        { content: [] },
        { expanded: true },
        theme,
        false,
    );
    assert.ok(!listed.includes("\u001b"), "list rows must strip id/cron");
    assert.doesNotMatch(listed, /Invalid Date/);
});

test("padTo / list rows are CJK width-safe (double-width cells still align)", () => {
    const out = formatListResult(
        {
            jobs: [
                {
                    id: "beefbeef",
                    cron: "0 9 * * 1-5",
                    recurring: true,
                    durable: true,
                    prompt: "周一站会",
                    createdAt: Date.now(),
                },
                {
                    id: "f00df00d",
                    cron: "0 9 * * 1-5",
                    recurring: true,
                    durable: true,
                    prompt: "standup meeting",
                    createdAt: Date.now(),
                },
            ],
        },
        { content: [] },
        { expanded: false },
        theme,
        false,
    );
    // Both rows keep the fixed-column layout even with double-width glyphs.
    const lines = out.split("\n").slice(1).filter(Boolean);
    const strip = (l: string) => l.replace(/\u001b\[[0-9;]*m/g, "");
    assert.equal(strip(lines[0]).indexOf("recurring"), strip(lines[1]).indexOf("recurring"));
});

test("list row budget stays within the 100-column HTML export", () => {
    const visible = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "").length;
    const make = (expanded: boolean) => {
        const out = formatListResult(
            {
                jobs: [
                    {
                        id: "beefbeef",
                        cron: "0 9 * * 1-5",
                        recurring: true,
                        durable: true,
                        prompt: "x".repeat(80),
                        createdAt: Date.now(),
                    },
                ],
            },
            { content: [] },
            { expanded },
            theme,
            false,
        );
        return visible(out.split("\n")[1] ?? "");
    };
    assert.ok(make(false) <= 100, "collapsed row fits width 100");
    assert.ok(make(true) <= 100, "expanded row fits width 100");
});
