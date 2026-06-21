# JSON Mode Event Reference

Full event schema, message types, and jq recipes for `pi --mode json`. SKILL.md only needs to know which `type` to filter on — this file gives the complete field definitions, to be consulted as needed.

## Top-Level Event Types

Event definitions come from `AgentSessionEvent` (pi-mono `packages/coding-agent/src/core/agent-session.ts`), which extends the base `AgentEvent` with a few coding-agent-specific events:

```ts
type AgentSessionEvent =
  | AgentEvent
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };
```

- `queue_update`: re-emits the full pending steering/follow-up queues whenever they change. Rarely fires in single-turn Print/JSON mode (there's no way to interject mid-run); mostly relevant in RPC mode.
- `compaction_start`/`compaction_end`: start and end of context compaction, manual or automatic. `reason` distinguishes manual trigger, threshold trigger, and overflow trigger.
- `auto_retry_start`/`auto_retry_end`: automatic retry after a failed API call — useful for telling "it's retrying" apart from "it's actually stuck."

Base events come from `AgentEvent` (pi-mono `packages/agent/src/types.ts`):

```ts
type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

## Message Types

Base messages (pi-mono `packages/ai/src/types.ts`):
- `UserMessage`
- `AssistantMessage`
- `ToolResultMessage`

Coding-agent extended messages (pi-mono `packages/coding-agent/src/core/messages.ts`):
- `BashExecutionMessage` — produced by `!command`/`!!command` shell execution in interactive mode
- `CustomMessage` — custom messages injected by extensions
- `BranchSummaryMessage` — produced when `/tree` summarizes an abandoned branch
- `CompactionSummaryMessage` — the summary message inserted after context compaction

## Output Format

Typical single-turn sequence (no tool calls):

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","delta":"Hello",...}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...]}
```

If tool calls happen mid-turn, you'll see `tool_execution_start` → (possibly several) `tool_execution_update` → `tool_execution_end` inserted, and the agent may continue into another `turn_start` until there are no more tool calls and the model produces its final reply.

## jq Recipe Collection

```bash
# Print streaming tokens in real time (like the interactive mode's live typing)
pi --mode json "..." 2>/dev/null \
  | jq -rj 'select(.type=="message_update" and .assistantMessageEvent.type=="text_delta")
             | .assistantMessageEvent.delta'

# List every tool call and its arguments
pi --mode json "..." 2>/dev/null \
  | jq -c 'select(.type=="tool_execution_start") | {tool: .toolName, args}'

# Only failed tool calls
pi --mode json "..." 2>/dev/null \
  | jq -c 'select(.type=="tool_execution_end" and .isError==true)'

# Count how many turns this task took
pi --mode json "..." 2>/dev/null | jq -s '[.[] | select(.type=="turn_start")] | length'

# Grab the session id (to resume later with --session)
pi --mode json "..." 2>/dev/null | jq -r 'select(.type=="session") | .id' | head -1
```

## Debugging Tips

- Save the full output to a `.jsonl` file first (`pi --mode json "..." > out.jsonl 2>err.log`), then iterate on `jq` filters against the file — much faster than re-running pi every time.
- `assistantMessageEvent.type` can also be `thinking_delta` (incremental reasoning/thinking output) and tool-call-related delta types, in addition to `text_delta`. If `--thinking` is set to a higher level, make sure to filter `thinking_delta` separately rather than concatenating it together with the final-answer text.
