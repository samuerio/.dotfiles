# Iterate Report

Started: 2026-06-26T08:34:07.747Z

## Iteration 1

- Actor: 文件已创建并通过 bun 编译验证（无错误）。以下是实现摘要：

**创建的文件：** `pi/agent/extensions/qoder-stdio-provider.ts`

**核心组件：**

1. **Provider 注册** — 通过 `pi.registerProvider("qoder-stdio", ...)` 注册，包含自定义 `streamSimple` 处理器和三个模型（`auto`、`ultimate`、`performance`），均设置 `contextWindow: 128000`、`maxTokens: 4096`、`cost: 0`。

2. **Prompt 构建** (`buildPrompt`) — 将 context 组装为单一字符串：
   - 可选的 system prompt
   - 工具定义（含名称、描述、JSON schema），并指示模型使用 `{"tool_call":{"name":"...","arguments":{...}}}` 格式
   - 最近 20 条消息，按角色格式化（`User:`、`Assistant:`、`Tool result:`）

3. **qodercli 调用** — 使用 `child_process.spawn` 执行 `qodercli`，参数包括：
   - `-p <prompt>`、`--output-format stream-json`、`-w <cwd>`
   - 可选的 `--model`（非 auto 时）
   - `--disallowed-tools=Read,Write,Bash,Grep`（可通过 `QODERCLI_DISALLOWED_TOOLS` 环境变量配置，设为 `"0"` 可禁用）
   - 环境变量：`NO_BROWSER=1`、`CI=1`
   - 通过 `options.signal` 支持 abort，发送 `SIGTERM`

4. **输出解析** — 使用 `readline` 逐行读取 stdout，每行解析 JSON，依次尝试 `data.message.content`（字符串或数组）、`data.result`、`data.text`、`data.output`，非 JSON 行则作为纯文本处理。

5. **工具调用检测** — 当 `context.tools` 存在时，缓冲所有文本；qodercli 退出后，在缓冲文本中搜索 `{"tool_call":...}`（优先匹配围栏代码块，其次匹配最后一个包含 `"tool_call"` 的 `{}`）。若检测到则触发 `toolcall_start/delta/end` 事件并设置 `stopReason: "toolUse"`，否则作为普通文本响应输出。

6. **错误处理** — 处理非零退出码、信号终止、spawn 失败、进程错误和 abort。始终调用 `stream.end()`。
- Critic score: 75
- Critic summary: 实现基本覆盖了所有功能点：provider 注册、三个模型、prompt 构建、qodercli 调用、abort 支持、输出解析、tool call 检测、错误处理。但无工具模式下的流式事件推送存在两个严重 bug，导致该路径不可用。
- Result: accepted
- Commit: 447ebf6d8e1009d38f96aec9f6ca327a33f376c1

Suggestions:
- Bug 1 (严重): 无工具模式下每行 JSONL 都触发独立的 start/text_start/text_delta/text_end 事件序列，语义错误。应只在首行前推一次 start 事件，后续只推 text_delta，最后推 text_end + done。
- Bug 2 (严重): 无工具模式下 textBuffer 未被填充，导致 exit 回调中 done 事件的 message.content[0].text 为空字符串。应累积文本或在 exit 时使用已推送的文本构造 done 消息。
- Bug 3 (轻微): stream.end(msg) 传入了 AssistantMessage 参数，但规范中 stream.end() 无参数。应确认 API 签名并修正为 stream.end()。
- Bug 4 (轻微): 错误路径（spawn 失败、非零退出）只推了 error 事件但未推 done 事件。虽然 error 事件本身表示终止，但缺少 done 可能导致消费者状态机卡住。建议在 error 事件后也推一个 done 事件。
