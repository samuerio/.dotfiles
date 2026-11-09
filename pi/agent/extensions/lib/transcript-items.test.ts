// transcript-items.ts tests: the messages → view-model projection only, all
// inputs hand-built so no session files or pi packages are needed.

import assert from "node:assert/strict";
import test from "node:test";

import {
	buildTranscriptItems,
	type ContextMessageLike,
	type ToolCallView,
	type TranscriptItem,
} from "./transcript-items.ts";

function toolCalls(items: TranscriptItem[]): ToolCallView[] {
	return items.flatMap((item) => (item.kind === "tool" ? [item.call] : []));
}

// ─── text ordering ────────────────────────────────────────────────

test("keeps user / assistant text in message order", () => {
	const items = buildTranscriptItems([
		{ role: "user", content: "first" },
		{ role: "assistant", content: [{ type: "text", text: "second" }] },
		{
			role: "user",
			content: [
				{ type: "text", text: "third " },
				{ type: "text", text: "part" },
			],
		},
	]);

	assert.deepEqual(items, [
		{ kind: "user", text: "first" },
		{ kind: "assistant", text: "second" },
		{ kind: "user", text: "third part" },
	]);
});

test("thinking is its own item and keeps part order", () => {
	const items = buildTranscriptItems([
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "pondering" },
				{ type: "text", text: "answer" },
				// legacy / normalized shape where thought text sits in `text`
				{ type: "thinking", text: "again" },
			],
		},
	]);

	assert.deepEqual(items, [
		{ kind: "thinking", text: "pondering" },
		{ kind: "assistant", text: "answer" },
		{ kind: "thinking", text: "again" },
	]);
});

// ─── tool calls ───────────────────────────────────────────────────

test("multiple tool calls in one assistant message each become an item in order", () => {
	const items = buildTranscriptItems([
		{
			role: "assistant",
			content: [
				{ type: "text", text: "reading both files" },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "c2", name: "read", arguments: { path: "b.ts" } },
			],
		},
	]);

	assert.deepEqual(
		items.map((item) => item.kind),
		["assistant", "tool", "tool"],
	);
	const calls = toolCalls(items);
	assert.deepEqual(
		calls.map((call) => call.id),
		["c1", "c2"],
	);
	assert.deepEqual(
		calls.map((call) => call.name),
		["read", "read"],
	);
	assert.deepEqual(calls[0].args, { path: "a.ts" });
	assert.deepEqual(calls[1].args, { path: "b.ts" });
	for (const call of calls) {
		assert.equal(call.argsMissing, false);
		assert.equal(call.result, undefined);
	}
});

test("tool results pair with calls emitted several messages earlier", () => {
	const items = buildTranscriptItems([
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
		},
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "c2", name: "read", arguments: { path: "x.ts" } }],
		},
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text", text: "out1" }],
			isError: false,
			durationMs: 12,
		},
		{ role: "user", content: "interjection" },
		{
			role: "toolResult",
			toolCallId: "c2",
			toolName: "read",
			content: [{ type: "text", text: "out2" }],
			details: { lineCount: 3 },
			isError: true,
			durationMs: 34,
		},
	]);

	const calls = toolCalls(items);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0].result?.content, [{ type: "text", text: "out1" }]);
	assert.equal(calls[0].result?.isError, false);
	assert.equal(calls[0].isError, false);
	assert.equal(calls[0].durationMs, 12);
	assert.deepEqual(calls[1].result?.content, [{ type: "text", text: "out2" }]);
	assert.deepEqual(calls[1].result?.details, { lineCount: 3 });
	assert.equal(calls[1].result?.isError, true);
	assert.equal(calls[1].isError, true);
	assert.equal(calls[1].durationMs, 34);
	for (const call of calls) assert.equal(call.argsMissing, false);
});

test("a call with no result stays result === undefined (run killed mid-tool)", () => {
	const items = buildTranscriptItems([
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "sleep 600" } }],
		},
	]);

	const [call] = toolCalls(items);
	assert.equal(call.result, undefined);
	assert.equal(call.argsMissing, false);
	assert.equal(call.isError, false);
	assert.ok(!("durationMs" in call));
});

test("an orphan tool result becomes an argsMissing item", () => {
	const items = buildTranscriptItems([
		{ role: "compactionSummary", summary: "earlier work" },
		{
			role: "toolResult",
			toolCallId: "gone",
			toolName: "edit",
			content: [{ type: "text", text: "ok" }],
			details: {},
			isError: false,
			durationMs: 5,
		},
	]);

	const calls = toolCalls(items);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].argsMissing, true);
	assert.equal(calls[0].id, "gone");
	assert.equal(calls[0].name, "edit");
	assert.equal(calls[0].args, undefined);
	assert.deepEqual(calls[0].result?.content, [{ type: "text", text: "ok" }]);
	assert.deepEqual(calls[0].result?.details, {});
	assert.equal(calls[0].result?.isError, false);
	assert.equal(calls[0].durationMs, 5);
});

// ─── noise filtering ──────────────────────────────────────────────

test("empty text and unknown roles are dropped", () => {
	const items = buildTranscriptItems([
		{ role: "user", content: "   " },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "\n" },
				{ type: "thinking", thinking: "  " },
			],
		},
		{ role: "custom", content: "extension-injected note" },
		{ role: "system", content: "system prompt" },
		{ role: "user", content: [{ type: "image", id: "img-1" }] },
	]);

	assert.deepEqual(items, []);
});

// ─── notes ────────────────────────────────────────────────────────

test("bash executions become notes with the command and output", () => {
	const items = buildTranscriptItems([
		{ role: "bashExecution", command: "ls -la", output: "total 0\n", exitCode: 0 },
		{ role: "bashExecution", command: "false", output: "", exitCode: 1 },
		{ role: "bashExecution", command: "sleep 1", output: "killed", exitCode: null },
	]);

	assert.deepEqual(items, [
		{ kind: "note", label: "bash (exit=0)", text: "$ ls -la\ntotal 0\n" },
		{ kind: "note", label: "bash (exit=1)", text: "$ false" },
		{ kind: "note", label: "bash (exit=?)", text: "$ sleep 1\nkilled" },
	]);
});

test("compaction and branch summaries become notes, empty ones dropped", () => {
	const items = buildTranscriptItems([
		{ role: "compactionSummary", summary: "  compacted history \n" },
		{ role: "branchSummary", summary: "returned from a branch" },
		{ role: "compactionSummary", summary: "   " },
	]);

	assert.deepEqual(items, [
		{ kind: "note", label: "compactionSummary", text: "compacted history" },
		{ kind: "note", label: "branchSummary", text: "returned from a branch" },
	]);
});

test("a string-bodied internal message shape still lands as text", () => {
	const message = { role: "assistant", content: "plain string body" } satisfies ContextMessageLike;
	assert.deepEqual(buildTranscriptItems([message]), [{ kind: "assistant", text: "plain string body" }]);
});
