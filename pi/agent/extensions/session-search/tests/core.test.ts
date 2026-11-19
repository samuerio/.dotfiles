// core.ts tests: the hot/cold shared matcher. Pure
// message-in / text-out cases only (the pi import here is type-only), so no
// session files or pi packages are needed at runtime.

import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import {
    buildSnippet,
    compareRank,
    compileQuery,
    type TextExtractor,
    haystackFor,
    messageBodyText,
    normalizeForTier,
} from "../core.ts";

type AgentMessageLike = AgentMessage;

const user = (text: string) =>
    ({ role: "user", content: [{ type: "text", text }] }) as unknown as AgentMessageLike;
const assistant = (text: string, calls: Array<[string, unknown]> = []) =>
    ({
        role: "assistant",
        content: [
            ...(text ? [{ type: "text", text }] : []),
            ...calls.map(([name, args], index) => ({
                type: "toolCall",
                id: `tc${index}`,
                name,
                arguments: args,
            })),
        ],
    }) as unknown as AgentMessageLike;

// Test double for the shared rule: the real one (`textOf`) lives in
// `lib/session-common.ts`, which imports pi at load time and therefore cannot be
// loaded under plain `node --test`. These tests assert how the core COMPOSES the
// extracted body (role switch, tool-call separator), not the extraction itself.
const textOf: TextExtractor = (content) =>
    typeof content === "string"
        ? content
        : (content ?? [])
              .filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => part.text as string)
              .join("");

test("messageBodyText reads content for chat roles and summary for summary roles", () => {
    assert.equal(messageBodyText(user("你好"), textOf), "你好");
    assert.equal(
        messageBodyText({
            role: "compactionSummary",
            summary: "摘要正文",
        } as unknown as AgentMessageLike, textOf),
        "摘要正文",
    );
    // Tool results are never searchable.
    assert.equal(
        messageBodyText({
            role: "toolResult",
            content: [{ type: "text", text: "整份文件内容" }],
        } as unknown as AgentMessageLike, textOf),
        "",
    );
});

test("haystackFor appends the tool-call rendering only when opted in", () => {
    const msg = assistant("先查一下", [["bash", { command: "rg foo" }]]);
    assert.equal(haystackFor(msg, false, textOf).text, "先查一下");
    const withCalls = haystackFor(msg, true, textOf);
    assert.equal(withCalls.text, '先查一下\n[tool: bash {"command":"rg foo"}]');
    // realEnd stops at the message's own text: the rendering is synthetic.
    assert.equal(withCalls.realEnd, "先查一下".length);
    // The separator is part of the haystack even with no calls (parity with
    // the archive's two-column rejoin).
    assert.equal(haystackFor(assistant("只有正文"), true, textOf).text, "只有正文\n");
});

test("compileQuery keeps the literal/regex split and strips g/y", () => {
    assert.ok(compileQuery("foo.bar").test("foo.bar"));
    assert.ok(!compileQuery("foo.bar").test("fooxbar"));
    const re = compileQuery("/ab+/gy");
    assert.equal(re.flags.includes("g"), false);
    assert.equal(re.flags.includes("y"), false);
    assert.ok(re.test("abbb"));
});

test("normalizeForTier ignores case and whitespace", () => {
    assert.equal(normalizeForTier("追踪 Goal.ts"), normalizeForTier(" 追踪goal.TS "));
});

test("compareRank orders tier, then exact first message, then newest", () => {
    const rank = (tier: number, exact: boolean, ts: number) => ({
        tier,
        exact,
        ts,
        roleWeight: 0,
    });
    assert.ok(compareRank(rank(1, false, 1), rank(2, false, 999)) < 0);
    assert.ok(compareRank(rank(2, true, 1), rank(2, false, 999)) < 0);
    assert.ok(compareRank(rank(2, false, 999), rank(2, false, 1)) < 0);
});

test("buildSnippet keeps line structure and counts what it omitted", () => {
    const text = ["first line", "second line", "MATCH here", "fourth line", "fifth line"].join(
        "\n",
    );
    const index = text.indexOf("MATCH");
    const whole = buildSnippet(text, index);
    assert.equal(whole.text, text); // short message: nothing omitted
    assert.equal(whole.omittedBeforeLines, 0);
    assert.equal(whole.omittedAfterLines, 0);

    const long = ["a", "b", "c", "d", "MATCH", "e", "f", "g"].join("\n") + "\n" + "x\n".repeat(400);
    const windowed = buildSnippet(long, long.indexOf("MATCH"));
    assert.ok(windowed.text.includes("MATCH"));
    assert.ok(windowed.omittedAfterLines > 0);
});

test("buildSnippet caps a pathologically long single line", () => {
    const long = "x".repeat(5000) + "MATCH" + "y".repeat(5000);
    const snippet = buildSnippet(long, 5000);
    assert.ok(snippet.text.length < 1200, `expected a capped window, got ${snippet.text.length}`);
    assert.ok(snippet.text.includes("MATCH"));
});
