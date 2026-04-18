# /watch 命令实现计划

## 需求

实现一个 pi 扩展，提供 `/watch` 命令，用于实时监看其他 pi 会话的输出。

**使用场景**：
- 打开一个可交互的 pi 界面
- 使用 `/watch` 命令选择要监听的会话
- 会话只要有变化则同步呈现出来
- 用于监听后台 pi 任务的进展

## 调研结论

### 可行性分析

**✅ 可行**（降级需求后）

**原始需求**：实时拦截其他 pi 进程的输出流
- ❌ 不可行：pi 架构没有提供跨会话通信 API
- ❌ 不可行：扩展无法访问其他 pi 进程的内部状态

**降级需求**：查看已写入文件内容 + 持续 watch 新消息
- ✅ 可行：使用 `SessionManager.listAll()` 列出会话
- ✅ 可行：使用 `fs.watch()` 监听文件变化
- ✅ 可行：解析 JSONL 格式的会话文件
- ✅ 可行：在 TUI 中显示新增内容

### 技术限制

1. **只能看到已写入的内容**：如果后台进程还没写入文件，监看者看不到
2. **轮询延迟**：文件变化有轻微延迟（依赖 fs.watch）
3. **无交互能力**：只能被动查看，不能干预后台会话

### 可用的 pi API

```typescript
// 会话列表
SessionManager.listAll()  // 列出所有会话
ctx.sessionManager        // 访问当前会话（对跨会话无用）

// 文件操作
fs.watch()              //   监听文件变化
fs.readFile()           // 读取文件内容
fs.stat()               // 获取文件状态

// TUI 组件
ctx.ui.select()         // 选择对话框
ctx.ui.notify()         // 通知消息
ctx.ui.custom()          // 自定义组件
Text, Container         // 可用的 TUI 组件
// ❌ ScrollableText 不存在
```

## 用户决策记录

### 设计选择

1. **版本策略**：先简化版快速测试，确认可行后再完善
2. **滚动实现**：如果 ScrollableText 不存在，用手动滚动
3. **使用方式**：独立在 pi 中使用 `/watch` 命令
4. **会话选择**：手动选择要监听的会话（不自动检测最新）
5. **显示方式**：简化版使用 `notify()` 显示（接受刷屏）
6. **退出机制**：Ctrl+C 够用
7. **错误处理**：显示详细错误信息

## 实现方案（简化版）

### 核心功能

1. **列出会话**
   - 扫描 `~/.pi/agent/sessions/` 目录
   - 读取每个 `.jsonl` 文件的第一行获取 header
   - 解析 `cwd` 和 `timestamp`
   - 按修改时间排序

2. **选择会话**
   - 使用 `ctx.ui.select()` 显示会话列表
   - 格式：`<cwd> (<时间>)`

3. **监听文件**
   - 使用 `fs.watch()` 监听选中的会话文件
   - 记录最后读取的位置（文件大小）
   - 只读取新增的内容

4. **解析和显示**
   - 解析 JSONL 格式的消息
   - 格式化显示：
     - User: 👤
     - Assistant: 🤖
     - Tool Result: 🔧
     - Bash Execution: 💻
   - 使用 `ctx.ui.notify()` 显示

### 代码结构

```typescript
// 主体函数
export default function (pi: ExtensionAPI) {
  pi.registerCommand("watch", { handler: async (args, ctx) => {
    // 1. 列出会话
    // 2. 用户选择
    // 3. 开始监听
  }});
}

// 核心函数
async function watchSession(session, ctx)
function formatMessage(jsonLine)
function extractText(content)
async function listAllSessions()
```

### 使用方法

```bash
# 创建扩展文件
cat > ~/.pi/agent/extensions/watch.ts << 'EOF'
# 代码内容
EOF

# 启动 pi
pi

# 使用命令
/watch

# 选择要监看的会话
```

## 完整版功能（后续）

1. **自定义 TUI 组件**
   - 使用 `ctx.ui.custom()` 创建专用界面
   - 顶部：会话信息
   - 中部：可滚动的消息区域
   - 底部：状态栏和操作提示

2. **手动滚动**
   - ↑/↓ 键滚动查看历史消息
   - 实现缓冲区管理

3. **更好的格式化**
   - 完整的消息内容
   - 彩色输出
   - 工具调用的参数和结果

4. **退出机制**
   - Esc 键退出监看
   - 清理文件监听器

5. **错误恢复**
   - 处理会话文件被删除的情况
   - 重新连接失败的恢复机制

## 替代方案（如果此方案不适用）

### 方案 1：使用 tmux（pi 官方推荐）

```bash
# 在 tmux 中启动后台 pi
tmux new-session -d -s pi-bg "pi '执行任务...'"

# 在另一个终端监听该会话
tmux attach-session -t pi-bg
```

**优点**：
- 真正实时，无延迟
- 完整交互能力
- pi 官方推荐

**缺点**：
- 需要学习 tmux
- 用户体验不如直接在 pi 中使用

### 方案 2：文件重定向 + tail

```bash
# 后台执行并重定向输出
pi '任务' > /tmp/pi-output.log 2>&1 &

# 监听日志文件
tail -f /tmp/pi-output.log
```

**优点**：
- 简单直接
- 不需要扩展

**缺点**：
- 输出格式不是 JSONL
- 无法看到工具调用详情

## 实现步骤

### 阶段 1：简化版实现
- [ ] 创建 `~/.pi/agent/extensions/watch.ts`
- [ ] 实现会话列表功能
- [ ] 实现会话选择
- [ ] 实现 `fs.watch()` 监听
- [ ] 实现 JSONL 解析和格式化
- [ ] 使用 `ctx.ui.notify()` 显示新消息
- [ ] 测试基本功能

### 阶段 2：测试和反馈
- [ ] 在多个终端测试
- [ ] 验证文件监听可靠性
- [ ] 检查错误处理
- [ ] 收集用户体验反馈

### 阶段 3：完整版实现（如果需要）
- [ ] 实现自定义 TUI 组件
- [ ] 实现滚动功能
- [ ] 改进格式化输出
- [ ] 添加清晰退出机制
- [ ] 完善错误恢复

## 相关文档

- Pi Extensions: `/home/zhe/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- Pi Session Format: `/home/zhe/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/session.md`
- Pi TUI: `/home/zhe/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/tui.md`
- Example Extensions: `/home/zhe/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/`

## 新会话快速恢复

**最低要求**（快速恢复上下文）：
```bash
read spec/watch-session-command/plan.md
```

**完整恢复**（包含所有技术细节）：
```bash
# 首先读取计划文件
read spec/watch-session-command/plan.md

# 如果需要深入了解扩展 API
read /home/zhe/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md

# 如果需要了解会话格式
read /home/zhe/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/session.md

# 如果需要 TUI 组件文档
read /home/zhe/.nvm/versions/node/v22.20.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/tui.md
```
