/**
 * /watch Command - Watch other pi sessions in real-time
 */
import {
    type ExtensionAPI,
    SessionManager,
} from "@mariozechner/pi-coding-agent";
import { watch } from "node:fs";
import process from "node:process";

/**
 * Format date as relative time (matches /resume format)
 */
function formatSessionDate(date: { getTime: () => number }): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "now";
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 7) return `${diffDays}d`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
    return `${Math.floor(diffDays / 365)}y`;
}

/**
 * Shorten home directory path to ~
 */
function shortenPath(path: string): string {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (!path) return path;
    if (path.startsWith(home)) {
        return `~${path.slice(home.length)}`;
    }
    return path;
}

/**
 * 防抖工具函数
 */
function debounce<T extends (...args: any[]) => any>(
    fn: T,
    delay: number,
): (...args: Parameters<T>) => void {
    let timeoutId: NodeJS.Timeout | null = null;
    return (...args: Parameters<T>) => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delay);
    };
}

export default function (pi: ExtensionAPI) {
    let isWatching = false;
    let watcher: ReturnType<typeof watch> | null = null;
    let lastMessageCount = 0;
    let targetSessionPath: string | null = null;

    pi.registerCommand("watch", {
        description: "Watch another pi session in real-time",
        handler: async (args, ctx) => {
            try {
                if (isWatching) {
                    ctx.ui.notify(
                        "Already in watch mode, press Ctrl+Shift+Q to exit first",
                        "warning",
                    );
                    return;
                }

                // 1. 加载当前工作路径的会话列表，和/resume默认显示逻辑一致
                const currentCwd = process.cwd();
                ctx.ui.notify("Loading sessions...", "info");

                // 获取所有会话，过滤出当前工作路径的会话
                const allSessions = await SessionManager.listAll();
                const sessions = allSessions.filter(
                    (s) => s.cwd === currentCwd,
                );
                if (!sessions || sessions.length === 0) {
                    ctx.ui.notify(
                        "No sessions found in current folder",
                        "error",
                    );
                    return;
                }

                // 过滤无效会话
                const validSessions = sessions.filter(
                    (s) => s && s.path && typeof s === "object",
                );
                if (validSessions.length === 0) {
                    ctx.ui.notify("No valid sessions found", "error");
                    return;
                }

                // 2. 生成会话选择列表，和/resume格式完全一样，只保留最近10条
                const choices = validSessions.slice(0, 10).map((s) => {
                    const displayName =
                        s.name || s.firstMessage || "Unnamed session";
                    const normalizedMessage = displayName
                        .replace(/[\x00-\x1f\x7f]/g, " ")
                        .trim()
                        .slice(0, 150);
                    const cwdShort = s.cwd ? shortenPath(s.cwd) : "";
                    const age = s.modified ? formatSessionDate(s.modified) : "";
                    const msgCount = s.messageCount || 0;
                    return `${normalizedMessage} (${cwdShort} ${msgCount} ${age})`;
                });

                // 3. 显示选择框，和/resume完全一样
                const selected = await ctx.ui.select(
                    "Select a session to watch:",
                    choices,
                );

                if (!selected) {
                    ctx.ui.notify("Cancelled", "info");
                    return;
                }

                const selectedIndex = choices.indexOf(selected);
                if (
                    selectedIndex < 0 ||
                    selectedIndex >= validSessions.length
                ) {
                    ctx.ui.notify("Invalid selection", "error");
                    return;
                }

                const targetSession = validSessions[selectedIndex];
                if (!targetSession || !targetSession.path) {
                    ctx.ui.notify("Invalid session", "error");
                    return;
                }

                targetSessionPath = targetSession.path;
                lastMessageCount = targetSession.messageCount || 0;

                // 4. 切换到目标会话
                const result = await ctx.switchSession(targetSessionPath);
                if (result.cancelled) {
                    ctx.ui.notify("Failed to load session", "error");
                    targetSessionPath = null;
                    return;
                }

                // 5. 启动文件监听器，防抖300ms避免频繁刷新
                const debouncedRefresh = debounce(async () => {
                    if (!targetSessionPath || !isWatching) return;

                    try {
                        // 重新读取会话信息
                        const allSessions = await SessionManager.listAll();
                        const latestSession = allSessions.find(
                            (s) => s.path === targetSessionPath,
                        );
                        if (!latestSession) {
                            ctx.ui.notify(
                                "Target session was deleted, exiting watch mode",
                                "error",
                            );
                            watcher?.close();
                            isWatching = false;
                            return;
                        }

                        // 消息数量有变化才刷新
                        const newCount = latestSession.messageCount || 0;
                        if (newCount > lastMessageCount) {
                            const added = newCount - lastMessageCount;
                            // 重新切换到同一会话触发重载
                            await ctx.switchSession(targetSessionPath);
                            lastMessageCount = newCount;
                            ctx.ui.notify(
                                `🔄 Session updated, +${added} new message${added > 1 ? "s" : ""}`,
                                "success",
                            );
                        }
                    } catch (e) {
                        console.error("Refresh error:", e);
                    }
                }, 300);

                // 启动watch
                watcher = watch(targetSessionPath, debouncedRefresh);
                isWatching = true;

                ctx.ui.notify(
                    `👓 Now watching session: ${shortenPath(targetSession.cwd || targetSession.path)} | Switch session/exit pi to quit`,
                    "success",
                );
                ctx.ui.setStatus("watch-mode", "👓 Watching session");
                ctx.ui.setStatus("watch-mode");
            } catch (error) {
                ctx.ui.notify(`Error: ${String(error)}`, "error");
                console.error("Watch command error:", error);
                // 出错清理状态
                isWatching = false;
                watcher?.close();
                targetSessionPath = null;
            }
        },
    });

    // 会话关闭时自动清理监听器
    pi.on("session_shutdown", () => {
        if (watcher) {
            watcher.close();
            watcher = null;
        }
        isWatching = false;
    });
}
