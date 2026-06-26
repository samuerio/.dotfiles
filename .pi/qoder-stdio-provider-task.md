# Task: Create qoder-stdio-provider Pi Extension

## Goal

Create a Pi coding agent custom provider extension at `pi/agent/extensions/qoder-stdio-provider.ts` that registers a `qoder-stdio` provider. It spawns `qodercli` as a child process per request, reads `stream-json` output, and converts it into Pi's `AssistantMessageEventStream`.

## Architecture

```
Pi Agent model provider request
  -> qoder-stdio-provider extension (streamSimple)
    -> child_process.spawn("qodercli", ["-p", prompt, "--output-format", "stream-json", "-w", cwd])
      -> stdout JSONL lines
    -> parse into AssistantMessage events (text_start/delta/end, toolcall_start/delta/end, done)
  -> Pi tool loop continues
```

Critical: Pi controls the tool loop. qodercli should NOT directly operate on files. Disable qodercli's own tools by default via `--disallowed-tools=Read,Write,Bash,Grep` (configurable via `QODERCLI_DISALLOWED_TOOLS` env var).

## SDK Types Reference

### Provider Registration

```typescript
// ExtensionAPI
pi.registerProvider("qoder-stdio", {
  name: "Qoder CLI via stdio",
  api: "qoder-stdio" as any,
  baseUrl: "stdio://qodercli",
  apiKey: "not-used",
  streamSimple: streamQoderCli,
  models: [/* ProviderModelConfig[] */],
});
```

### streamSimple Signature

```typescript
function streamQoderCli(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream
```

- `context.systemPrompt`: optional string
- `context.messages`: Message[] (UserMessage | AssistantMessage | ToolResultMessage)
- `context.tools`: Tool[] optional (name, description, parameters)
- `options.signal`: AbortSignal optional

### Key Types from @earendil-works/pi-ai

```typescript
interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api; provider: Provider; model: string;
  usage: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

interface TextContent { type: "text"; text: string; }
interface ToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, any>; }

// Events to push to stream:
{ type: "start"; partial: AssistantMessage }
{ type: "text_start"; contentIndex: number; partial: AssistantMessage }
{ type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
{ type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
{ type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
{ type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
{ type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
{ type: "done"; reason: "stop"|"length"|"toolUse"; message: AssistantMessage }
{ type: "error"; reason: "aborted"|"error"; error: AssistantMessage }
```

### Imports

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
```

## Models to Register

Three model IDs that map to qodercli's model selection:
- `auto` - Qoder CLI Auto (default, no --model flag)
- `ultimate` - Qoder CLI Ultimate (--model ultimate)
- `performance` - Qoder CLI Performance (--model performance)

All with: reasoning: false, input: ["text"], cost: all zeros, contextWindow: 128000, maxTokens: 4096.

## Prompt Building

Build a single prompt string from context:
1. System prompt section (if present)
2. Tool instructions (if context.tools exists): list each tool with name, description, and JSON schema for parameters. Instruct the model to respond with `{"tool_call":{"name":"...","arguments":{}}}` when a tool is needed, or plain text otherwise.
3. Last 20 messages from context.messages, formatted by role:
   - user: `User:\n<content>`
   - assistant: `Assistant:\n<content>` (convert toolCall blocks to `Tool call: name args`)
   - toolResult: `Tool result:\n<content>`

## qodercli Invocation

```typescript
const qoderBin = process.env.QODERCLI_BIN ?? "qodercli";
const args = ["-p", prompt, "--output-format", "stream-json", "-w", process.cwd()];
if (model.id && model.id !== "auto") args.push("--model", model.id);

const disallowed = process.env.QODERCLI_DISALLOWED_TOOLS ?? "Read,Write,Bash,Grep";
if (disallowed && disallowed !== "0") args.push(`--disallowed-tools=${disallowed}`);

const child = spawn(qoderBin, args, {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NO_BROWSER: "1", CI: "1" },
  windowsHide: true,
});
```

Support abort via `options.signal`:
```typescript
options?.signal?.addEventListener("abort", () => child?.kill("SIGTERM"), { once: true });
```

## Output Parsing

Read stdout line by line with readline. Each line is JSON from qodercli's stream-json format.

Extract text from each line by trying:
1. `data.message.content` (string or array of parts with .text/.value)
2. `data.result` (string)
3. `data.text` (string)
4. `data.output` (string)
5. If not valid JSON and not starting with `{`, use the raw line as text.

## Tool Call Detection

When context.tools exists, buffer all text output. After qodercli exits, check if the buffered text contains a tool call JSON:
- Look for `{"tool_call":{"name":"...","arguments":{...}}}`
- Try fenced JSON blocks first, then search for the last `{` containing `"tool_call"`
- If found: push toolcall_start/delta/end events, set stopReason to "toolUse"
- If not found: push the buffered text as a normal text response

When context.tools is absent, stream text directly as it arrives.

## Error Handling

- If qodercli exits with non-zero code: set stopReason to "error", push error event
- If signal is aborted: set stopReason to "aborted", push error event
- If spawn fails: catch and push error event
- Always call `stream.end()` after pushing done or error event

## File Location

Create the extension at: `pi/agent/extensions/qoder-stdio-provider.ts`

This path is auto-discovered by pi as a global extension.
