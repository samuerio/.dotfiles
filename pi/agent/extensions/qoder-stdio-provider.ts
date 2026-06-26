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
  calculateCost,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
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
      '\nWhen you need to use a tool, respond with a JSON object: {"tool_call":{"name":"<tool_name>","arguments":{...}}}\nOtherwise, respond with plain text.',
    );
  }

  // 3. Last 20 messages
  const messages = context.messages.slice(-20);
  for (const msg of messages) {
    switch (msg.role) {
      case "user": {
        const text = extractText(msg.content);
        parts.push(`User:\n${text}`);
        break;
      }
      case "assistant": {
        const blocks: string[] = [];
        for (const c of msg.content) {
          if (c.type === "text") {
            blocks.push(c.text);
          } else if (c.type === "toolCall") {
            blocks.push(
              `Tool call: ${c.name} ${JSON.stringify(c.arguments)}`,
            );
          }
        }
        parts.push(`Assistant:\n${blocks.join("\n")}`);
        break;
      }
      case "toolResult": {
        const text = extractText(msg.content);
        parts.push(`Tool result:\n${text}`);
        break;
      }
    }
  }

  return parts.join("\n\n");
}

function extractText(
  content: string | { type: string; text?: string }[],
): string {
  if (typeof content === "string") return content;
  return content
    .filter((c): c is { type: string; text: string } => "text" in c && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// JSONL line parsing
// ---------------------------------------------------------------------------

function extractTextFromLine(line: string): string | null {
  try {
    const parsed = JSON.parse(line);
    // Try common stream-json field paths
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
    if (typeof data.result === "string") return data.result;
    if (typeof data.text === "string") return data.text;
    if (typeof data.output === "string") return data.output;
    return null;
  } catch {
    // Not valid JSON
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

function detectToolCall(text: string): DetectedToolCall | null {
  // Try fenced JSON block first
  const fenceMatch = text.match(
    /```(?:json)?\s*(\{[\s\S]*?"tool_call"[\s\S]*?\})\s*```/,
  );
  if (fenceMatch) {
    const result = tryParseToolCall(fenceMatch[1]);
    if (result) return result;
  }

  // Search for the last `{` containing "tool_call"
  const lastBrace = text.lastIndexOf("{");
  if (lastBrace !== -1) {
    const candidate = text.slice(lastBrace);
    const endBrace = candidate.lastIndexOf("}");
    if (endBrace !== -1) {
      const result = tryParseToolCall(candidate.slice(0, endBrace + 1));
      if (result) return result;
    }
  }

  return null;
}

function tryParseToolCall(jsonStr: string): DetectedToolCall | null {
  try {
    const parsed = JSON.parse(jsonStr);
    const tc = parsed.tool_call;
    if (tc && typeof tc.name === "string" && tc.arguments) {
      return { name: tc.name, arguments: tc.arguments };
    }
    return null;
  } catch {
    return null;
  }
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
  const disallowed =
    process.env.QODERCLI_DISALLOWED_TOOLS ?? "Read,Write,Bash,Grep";
  if (disallowed && disallowed !== "0") {
    args.push(`--disallowed-tools=${disallowed}`);
  }

  // Spawn
  try {
    child = spawn(qoderBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_BROWSER: "1", CI: "1" },
      windowsHide: true,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const msg = makeErrorMessage(model, `Failed to spawn qodercli: ${errMsg}`);
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
      const toolCall = detectToolCall(fullText);

      if (toolCall) {
        // Emit tool call events
        const tc: ToolCall = {
          type: "toolCall",
          id: `tc_${Date.now()}`,
          name: toolCall.name,
          arguments: toolCall.arguments,
        };
        const partial: AssistantMessage = {
          role: "assistant",
          content: [tc],
          api: model.api,
          provider: "qoder-stdio",
          model: model.id,
          usage: zeroUsage(model),
          stopReason: "toolUse",
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial });
        stream.push({
          type: "toolcall_start",
          contentIndex: 0,
          partial,
        });
        const delta = JSON.stringify(toolCall);
        stream.push({
          type: "toolcall_delta",
          contentIndex: 0,
          delta,
          partial,
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: tc,
          partial,
        });
        stream.push({
          type: "done",
          reason: "toolUse",
          message: partial,
        });
        stream.end();
      } else {
        // Emit as text
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
        stream.push({ type: "start", partial });
        stream.push({
          type: "text_start",
          contentIndex: 0,
          partial,
        });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: fullText,
          partial,
        });
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: fullText,
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

function zeroUsage(model: Model<string>): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: calculateCost(model, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    }),
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
