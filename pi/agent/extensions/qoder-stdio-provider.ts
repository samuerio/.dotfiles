/**
 * Qoder CLI stdio provider extension
 *
 * Registers a "qoder-stdio" provider that spawns qodercli as a child process,
 * reads stream-json output, and converts it into Pi's AssistantMessageEventStream.
 *
 * Pi controls the tool loop. qodercli's own tools are disabled by default.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    createAssistantMessageEventStream,
    type AssistantMessage,
    type AssistantMessageEventStream,
    type Context,
    type Model,
    type SimpleStreamOptions,
    type ToolCall,
    type TextContent,
    type Tool,
    type Usage,
} from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const MODEL_DEFS = [
    {
        id: "auto",
        name: "Qoder CLI Auto",
    },
    {
        id: "ultimate",
        name: "Qoder CLI Ultimate",
    },
    {
        id: "performance",
        name: "Qoder CLI Performance",
    },
] as const;

function makeModelConfig(id: string, name: string) {
    return {
        id,
        name,
        reasoning: false,
        input: ["text"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
    };
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildPrompt(context: Context): string {
    const parts: string[] = [];

    // 1. System prompt
    if (context.systemPrompt) {
        parts.push(context.systemPrompt);
    }

    // 2. Tool instructions
    if (context.tools && context.tools.length > 0) {
        parts.push("You have access to the following tools:");
        for (const tool of context.tools) {
            parts.push(`\nTool: ${tool.name}`);
            parts.push(`Description: ${tool.description}`);
            parts.push(
                `Parameters JSON schema: ${JSON.stringify(tool.parameters)}`,
            );
        }
        parts.push(
            "\nWhen you need to use tools, respond with one or more XML blocks in this exact format:",
        );
        parts.push(
            '<pi_tool_calls>\n[\n  { "name": "<tool_name>", "arguments": { ... } },\n  { "name": "<tool_name>", "arguments": { ... } }\n]\n</pi_tool_calls>',
        );
        parts.push(
            'Rules:\n- Each new tool call must have "name" (string) and "arguments" (JSON object).\n- For new tool calls, do not generate "id"; Pi will assign ids automatically.\n- Historical tool calls shown in the conversation may contain "id" only because they were already executed.\n- You may include multiple tool calls in one block.\n- You may include multiple <pi_tool_calls> blocks; all will be merged.\n- Explanatory text outside the XML blocks is preserved.\n- If you do not need any tools, respond with plain text only (no XML block).',
        );
    }

    // 3. Messages: single chronological conversation log
    const messages = context.messages;
    if (messages.length > 0) {
        const convoParts: string[] = [];
        for (const msg of messages) {
            switch (msg.role) {
                case "user": {
                    const text = extractText(msg.content);
                    convoParts.push(`User:\n${text}`);
                    break;
                }
                case "assistant": {
                    const blocks: string[] = [];
                    const historicalToolCalls: {
                        id: string;
                        name: string;
                        arguments: Record<string, any>;
                    }[] = [];

                    for (const c of msg.content) {
                        if (c.type === "text") {
                            blocks.push(c.text);
                        } else if (c.type === "toolCall") {
                            historicalToolCalls.push({
                                id: c.id,
                                name: c.name,
                                arguments: c.arguments,
                            });
                        }
                    }

                    if (historicalToolCalls.length > 0) {
                        blocks.push(
                            `Historical assistant tool calls already executed:\n<pi_tool_calls>\n${JSON.stringify(historicalToolCalls, null, 2)}\n</pi_tool_calls>`,
                        );
                    }

                    convoParts.push(`Assistant:\n${blocks.join("\n")}`);
                    break;
                }
                case "toolResult": {
                    const text = extractText(msg.content);
                    convoParts.push(
                        `Tool result (already executed):\ntool_call_id: ${msg.toolCallId}\nname: ${msg.toolName}\nis_error: ${msg.isError}\ncontent:\n${text}`,
                    );
                    break;
                }
            }
        }

        convoParts.push("Your response:");

        parts.push(convoParts.join("\n\n"));
    }

    return parts.join("\n\n");
}

function extractText(
    content: string | { type: string; text?: string }[],
): string {
    if (typeof content === "string") return content;
    return content
        .filter(
            (c): c is { type: string; text: string } =>
                "text" in c && typeof c.text === "string",
        )
        .map((c) => c.text)
        .join("\n");
}

// ---------------------------------------------------------------------------
// JSONL line parsing
// ---------------------------------------------------------------------------

function extractTextFromLine(line: string): string | null {
    try {
        const parsed = JSON.parse(line);
        if (parsed.type === "system" || parsed.type === "result") return null;
        const data = parsed.data ?? parsed;
        if (typeof data.message?.content === "string") {
            return data.message.content;
        }
        if (Array.isArray(data.message?.content)) {
            const parts = data.message.content
                .map((p: any) => p.text ?? p.value ?? "")
                .filter(Boolean)
                .join("");
            if (parts) return parts;
        }
        if (typeof data.text === "string") return data.text;
        if (typeof data.output === "string") return data.output;
        return null;
    } catch {
        if (!line.startsWith("{")) return line;
        return null;
    }
}

// ---------------------------------------------------------------------------
// Tool call detection
// ---------------------------------------------------------------------------

interface DetectedToolCall {
    name: string;
    arguments: Record<string, any>;
}

interface DetectResult {
    text: string;
    toolCalls: DetectedToolCall[];
    errors: string[];
}

function detectToolCalls(raw: string, tools: Tool[]): DetectResult {
    const errors: string[] = [];
    const toolCalls: DetectedToolCall[] = [];
    const toolNames = new Set(tools.map((t) => t.name));

    // Check for incomplete XML blocks
    const openTags = [...raw.matchAll(/<pi_tool_calls>/g)];
    const closeTags = [...raw.matchAll(/<\/pi_tool_calls>/g)];
    if (openTags.length > closeTags.length) {
        errors.push(
            "Incomplete <pi_tool_calls> block: missing </pi_tool_calls> closing tag.",
        );
    }

    // Extract all <pi_tool_calls>...</pi_tool_calls> blocks
    const blockRegex = /<pi_tool_calls>([\s\S]*?)<\/pi_tool_calls>/g;
    let match: RegExpExecArray | null;
    while ((match = blockRegex.exec(raw)) !== null) {
        const jsonStr = match[1].trim();
        if (!jsonStr) continue;

        let parsed: unknown;
        try {
            parsed = JSON.parse(jsonStr);
        } catch (e) {
            errors.push(
                `Invalid JSON inside <pi_tool_calls>: ${e instanceof Error ? e.message : String(e)}`,
            );
            continue;
        }

        if (!Array.isArray(parsed)) {
            errors.push(
                `<pi_tool_calls> content must be a JSON array, got ${typeof parsed}.`,
            );
            continue;
        }

        for (const item of parsed) {
            if (
                !item ||
                typeof item !== "object" ||
                typeof item.name !== "string" ||
                !item.arguments ||
                typeof item.arguments !== "object" ||
                Array.isArray(item.arguments)
            ) {
                errors.push(
                    `Invalid tool call entry: each must have "name" (string) and "arguments" (object). Got: ${JSON.stringify(item)}`,
                );
                continue;
            }

            if (!toolNames.has(item.name)) {
                errors.push(
                    `Unknown tool name "${item.name}". Available: ${[...toolNames].join(", ")}`,
                );
                continue;
            }

            toolCalls.push({ name: item.name, arguments: item.arguments });
        }
    }

    // Remove all XML blocks from raw to get the plain text
    const text = raw
        .replace(/<pi_tool_calls>[\s\S]*?<\/pi_tool_calls>/g, "")
        .trim();

    return { text, toolCalls, errors };
}

let toolCallCounter = 0;

function makeToolCallId(index: number): string {
    return `tc_qoder_${Date.now()}_${toolCallCounter++}_${index}`;
}

// ---------------------------------------------------------------------------
// Stream handler
// ---------------------------------------------------------------------------

function streamQoderCli(
    model: Model<string>,
    context: Context,
    options?: SimpleStreamOptions,
): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    let child: ChildProcess | null = null;
    let aborted = false;

    // Abort support
    if (options?.signal) {
        if (options.signal.aborted) {
            aborted = true;
            const msg = makeAbortedMessage(model);
            stream.push({ type: "start", partial: msg });
            stream.push({ type: "error", reason: "aborted", error: msg });
            stream.push({ type: "done", reason: "error", message: msg });
            stream.end();
            return stream;
        }
        options.signal.addEventListener(
            "abort",
            () => {
                aborted = true;
                child?.kill("SIGTERM");
                const msg = makeAbortedMessage(model);
                stream.push({ type: "start", partial: msg });
                stream.push({ type: "error", reason: "aborted", error: msg });
                stream.push({ type: "done", reason: "stop", message: msg });
                stream.end();
            },
            { once: true },
        );
    }

    // Build prompt
    const prompt = buildPrompt(context);

    // Build args
    const qoderBin = process.env.QODERCLI_BIN ?? "qodercli";
    const args: string[] = [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "-w",
        process.cwd(),
    ];
    if (model.id && model.id !== "auto") {
        args.push("--model", model.id);
    }
    const toolsFilter = process.env.QODERCLI_TOOLS ?? "";
    args.push("--tools", toolsFilter);

    // Spawn
    try {
        child = spawn(qoderBin, args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, NO_BROWSER: "1", CI: "1" },
            windowsHide: true,
        });
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const msg = makeErrorMessage(
            model,
            `Failed to spawn qodercli: ${errMsg}`,
        );
        stream.push({ type: "start", partial: msg });
        stream.push({ type: "error", reason: "error", error: msg });
        stream.push({ type: "done", reason: "error", message: msg });
        stream.end();
        return stream;
    }

    let stderrBuf = "";
    const textBuffer: string[] = [];
    const hasTools = !!context.tools?.length;
    let firstLine = true;

    // Read stdout line by line
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

    rl.on("line", (line: string) => {
        if (aborted) return;
        const text = extractTextFromLine(line);
        if (text) {
            // Always buffer text for final message construction
            textBuffer.push(text);

            if (hasTools) {
                // Buffer all text for post-hoc tool call detection (already done above)
            } else {
                // Stream text directly: start + text_start on first line, text_delta on each line
                if (firstLine) {
                    const partial: AssistantMessage = {
                        role: "assistant",
                        content: [{ type: "text", text: "" }],
                        api: model.api,
                        provider: "qoder-stdio",
                        model: model.id,
                        usage: zeroUsage(model),
                        stopReason: "stop",
                        timestamp: Date.now(),
                    };
                    stream.push({ type: "start", partial });
                    stream.push({
                        type: "text_start",
                        contentIndex: 0,
                        partial,
                    });
                    firstLine = false;
                }
                stream.push({
                    type: "text_delta",
                    contentIndex: 0,
                    delta: text,
                    partial: {
                        role: "assistant",
                        content: [{ type: "text", text: "" }],
                        api: model.api,
                        provider: "qoder-stdio",
                        model: model.id,
                        usage: zeroUsage(model),
                        stopReason: "stop",
                        timestamp: Date.now(),
                    },
                });
            }
        }
    });

    // Collect stderr for diagnostics
    child.stderr!.on("data", (data: Buffer) => {
        stderrBuf += data.toString();
    });

    // Handle exit
    child.on("exit", (code, signal) => {
        if (aborted) return;

        if (code !== 0 || signal) {
            const detail = signal
                ? `killed by signal ${signal}`
                : `exited with code ${code}`;
            const errDetail = stderrBuf.trim()
                ? `\nstderr: ${stderrBuf.trim()}`
                : "";
            const msg = makeErrorMessage(
                model,
                `qodercli ${detail}${errDetail}`,
            );
            stream.push({ type: "start", partial: msg });
            stream.push({ type: "error", reason: "error", error: msg });
            stream.push({ type: "done", reason: "error", message: msg });
            stream.end();
            return;
        }

        if (hasTools) {
            const fullText = textBuffer.join("");
            const result = detectToolCalls(fullText, context.tools ?? []);

            // Validation errors: emit error response
            if (result.errors.length > 0) {
                const errMsg = result.errors.join("\n");
                const msg = makeErrorMessage(model, errMsg);
                stream.push({ type: "start", partial: msg });
                stream.push({ type: "error", reason: "error", error: msg });
                stream.push({ type: "done", reason: "error", message: msg });
                stream.end();
                return;
            }

            if (result.toolCalls.length > 0) {
                // Build content: optional text block + tool call blocks
                const content: (TextContent | ToolCall)[] = [];
                let contentIndex = 0;

                if (result.text) {
                    content.push({ type: "text", text: result.text });
                    contentIndex = 1;
                }

                const toolCallBlocks: ToolCall[] = result.toolCalls.map(
                    (tc, i) => ({
                        type: "toolCall" as const,
                        id: makeToolCallId(i),
                        name: tc.name,
                        arguments: tc.arguments,
                    }),
                );
                content.push(...toolCallBlocks);

                const partial: AssistantMessage = {
                    role: "assistant",
                    content,
                    api: model.api,
                    provider: "qoder-stdio",
                    model: model.id,
                    usage: zeroUsage(model),
                    stopReason: "toolUse",
                    timestamp: Date.now(),
                };

                stream.push({ type: "start", partial });

                // Emit text events if there is explanatory text
                if (result.text) {
                    stream.push({
                        type: "text_start",
                        contentIndex: 0,
                        partial,
                    });
                    stream.push({
                        type: "text_delta",
                        contentIndex: 0,
                        delta: result.text,
                        partial,
                    });
                    stream.push({
                        type: "text_end",
                        contentIndex: 0,
                        content: result.text,
                        partial,
                    });
                }

                // Emit toolcall events for each tool call
                for (let i = 0; i < toolCallBlocks.length; i++) {
                    const idx = contentIndex + i;
                    stream.push({
                        type: "toolcall_start",
                        contentIndex: idx,
                        partial,
                    });
                    stream.push({
                        type: "toolcall_delta",
                        contentIndex: idx,
                        delta: JSON.stringify(toolCallBlocks[i]),
                        partial,
                    });
                    stream.push({
                        type: "toolcall_end",
                        contentIndex: idx,
                        toolCall: toolCallBlocks[i],
                        partial,
                    });
                }

                stream.push({
                    type: "done",
                    reason: "toolUse",
                    message: partial,
                });
                stream.end();
            } else {
                // No valid tool calls, no errors: emit as text
                const text = result.text || "No tool calls requested.";
                const partial: AssistantMessage = {
                    role: "assistant",
                    content: [{ type: "text", text }],
                    api: model.api,
                    provider: "qoder-stdio",
                    model: model.id,
                    usage: zeroUsage(model),
                    stopReason: "stop",
                    timestamp: Date.now(),
                };
                stream.push({ type: "start", partial });
                stream.push({ type: "text_start", contentIndex: 0, partial });
                stream.push({
                    type: "text_delta",
                    contentIndex: 0,
                    delta: text,
                    partial,
                });
                stream.push({
                    type: "text_end",
                    contentIndex: 0,
                    content: text,
                    partial,
                });
                stream.push({ type: "done", reason: "stop", message: partial });
                stream.end();
            }
        } else {
            // No tools: already streamed text_delta per line; now push text_end + done
            const fullText = textBuffer.join("");
            const partial: AssistantMessage = {
                role: "assistant",
                content: [{ type: "text", text: fullText }],
                api: model.api,
                provider: "qoder-stdio",
                model: model.id,
                usage: zeroUsage(model),
                stopReason: "stop",
                timestamp: Date.now(),
            };
            stream.push({
                type: "text_end",
                contentIndex: 0,
                content: fullText,
                partial,
            });
            stream.push({ type: "done", reason: "stop", message: partial });
            stream.end();
        }
    });

    child.on("error", (err) => {
        if (aborted) return;
        const msg = makeErrorMessage(
            model,
            `qodercli process error: ${err.message}`,
        );
        stream.push({ type: "start", partial: msg });
        stream.push({ type: "error", reason: "error", error: msg });
        stream.push({ type: "done", reason: "error", message: msg });
        stream.end();
    });

    return stream;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeroUsage(_model: Model<string>): Usage {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { ...zero },
    };
}

function makeErrorMessage(
    model: Model<string>,
    errorMessage: string,
): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: errorMessage }],
        api: model.api,
        provider: "qoder-stdio",
        model: model.id,
        usage: zeroUsage(model),
        stopReason: "error",
        errorMessage,
        timestamp: Date.now(),
    };
}

function makeAbortedMessage(model: Model<string>): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: "Request aborted" }],
        api: model.api,
        provider: "qoder-stdio",
        model: model.id,
        usage: zeroUsage(model),
        stopReason: "aborted",
        errorMessage: "Request aborted by user",
        timestamp: Date.now(),
    };
}

// ---------------------------------------------------------------------------
// Extension entrypoint
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
    pi.registerProvider("qoder-stdio", {
        name: "Qoder CLI via stdio",
        api: "qoder-stdio" as any,
        baseUrl: "stdio://qodercli",
        apiKey: "not-used",
        streamSimple: streamQoderCli,
        models: MODEL_DEFS.map((m) => makeModelConfig(m.id, m.name)),
    });
}
