# Improve watch.ts Session Listing

## 背景

当前 `watch.ts` 扩展手动遍历文件系统来列出会话列表，而 pi 已经提供了 `SessionManager.listAll()` 接口。这个接口是 `/resume` 命令使用的标准方式。

## 问题

### 手动实现的局限性

当前 `listAllSessions()` 函数：
- 手动构造 `~/.pi/agent/sessions/--<path>--/` 路径
- 手动读取每个 `.jsonl` 文件并解析第一行
- 只返回基本信息：`{ file, cwd, timestamp, mtime }`
- 不支持会话名称
- 不支持父会话信息（forked sessions）
- 不支持消息数量
- 不支持搜索功能
- 不支持进度回调

### 已有接口的优势

`SessionManager.listAll()` 提供：
- 完整的 `SessionInfo` 接口：
  - `path`: 完整文件路径
  - `id`: Session UUID
  - `cwd`: 工作目录
  - `name`: 用户定义的显示名称
  - `parentSessionPath`: 父会话路径（forked sessions）
  - `created`: 创建时间（Date 对象）
  - `modified`: 修改时间（Date 对象）
  - `messageCount`: 消息数量
  - `firstMessage`: 第一条消息
  - `allMessagesText`: 所有消息文本（用于搜索）
- 进度回调支持
- 内置错误处理
- 统一的时间格式（Date 对象）

## 目标

重构 `watch.ts` 使用 `SessionManager.listAll()` 替代手动实现，获得更完整的会话信息和更好的用户体验。

## 实施计划

### 1. 更新导入

```typescript
import { SessionManager } from "@mariozechner/pi-coding-agent";
```

### 2. 更新 SessionInfo 接口

```typescript
interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}
```

### 3. 简化 listAllSessions 函数

```typescript
async function listAllSessions(): Promise<SessionInfo[]> {
  return await SessionManager.listAll();
}
```

### 4. 更新 watchSession 调用处

当前代码：
```typescript
const selectedPath = selected.split(" (")[0];
const session = sessions.find((s) => s.cwd === selectedPath);
```

改为：
```typescript
const selectedPath = selected.split(" (")[0];
const session = sessions.find((s) => s.path === selectedPath);
```

### 5. 更新显示格式（可选）

当前显示格式使用 `cwd` 和 `timestamp`，可以改进为：

```typescript
const choices = sessions.map((s) => {
  const name = s.name ? `${s.name} - ` : "";
  const date = formatSessionDate(s.modified);  // 复用 pi 内部的格式化
  return `${name}${s.cwd} (${date})`;
});
```

### 6. 移除不再需要的代码

删除以下导入：
```typescript
import { readdir, readFile, stat } from "node:fs/promises";
```

### 7. 测试

- 验证会话列表正确加载
- 验证会话选择功能正常
- 验证文件监控功能正常
- 测试无会话时的错误处理
- 测试有命名会话的显示

## 影响

- **代码简化**: 移除约 30 行手动遍历代码
- **功能增强**: 获得会话名称、父会话信息等
- **维护性**: 使用标准接口，跟随 pi 更新
- **兼容性**: 需要调整字段名称（`file` → `path`, `mtime` → `modified`）

## 参考资料

- `SessionManager.listAll()` 实现：`packages/coding-agent/src/core/session-manager.ts`
- `/resume` 命令实现：`packages/coding-agent/src/cli/session-picker.ts`
- SessionSelectorComponent：`packages/coding-agent/src/modes/interactive/components/session-selector.ts`
- 扩展文档：`docs/extensions.md`
