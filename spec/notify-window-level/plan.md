# 改为 Window 级别通知判断

## 背景

当前 `notify.ts` 扩展在 tmux 中判断是否发送通知时，使用的是 pane 级别的判断：只有当当前聚焦的 pane 
与运行 pi 的 pane 不同时才发送通知。

## 问题

Pane 级别的判断存在以下问题：

1. **状态切换频繁**：在同一个 window 里不同 pane 间切换时，通知行为频繁变化
2. **预期不符**：用户通常把相关 pane 放在同一个 window，期望只要在那个 window 就能看到 pi 的输出
3. **过度打扰**：即使 pi 的 pane 就在用户眼前（同一窗口），只要焦点在另一个 pane 就会通知

## 目标

将通知判断从 pane 级别改为 window 级别。

## 实现方案

### 函数重命名

- `getNotifyPaneId()` → `getNotifyWindowId(pi)` (改为 async，返回 window ID)
- `getActiveClientPaneIds()` → `getActiveClientWindowIds()`
- `shouldNotifyInTmux()` 保持不变，但内部逻辑改为 window 级别

### 逻辑变更

1. **获取运行 pi 的 window ID**：
   - 从 `TMUX_PANE` 环境变量获取 pane ID
   - 通过 `tmux display-message -p -t #{pane_id} '#{window_id}'` 获取对应的 window ID
   - 调研结果：tmux 没有 `TMUX_WINDOW_ID` 环境变量，必须通过 pane ID 转换

2. **获取活跃客户端的 window ID**：
   - 从 `tmux list-clients -F "#{window_id}"` 获取所有活跃客户端当前聚焦的 window ID

3. **判断逻辑**：
   - 只有当没有任何活跃客户端聚焦在运行 pi 的同一个 window 时才发送通知

### 移除的函数

- `getNotifyPaneId()` 功能并入 `getNotifyWindowId()`
- `getWindowIdFromPaneId()` 保留，被 `getNotifyWindowId()` 使用

### 保持不变

- `markWindowAsUnread()` 已经是 window 级别的，保持不变
- 其他辅助函数不变

## 测试

在 tmux 环境中测试：
1. 在同一 window 的不同 pane 间切换，应不发送通知
2. 切换到其他 window，应发送通知

---

## 会话恢复指示

在新会话中快速上手，读取以下文件：

```bash
# 计划文件
spec/notify-window-level/plan.md

# 目标文件
pi/agent/extensions/notify.ts
```
