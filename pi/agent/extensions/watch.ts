/**
 * /watch Command - Watch other pi sessions in real-time
 */

import {
  type ExtensionAPI,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { watch, readFileSync, existsSync } from "node:fs";
import process from "node:process";

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

/**
 * Format message for display
 */
function formatMessage(entry: any): string | null {
  if (entry.type !== "message") return null;

  const msg = entry.message;
  const role = msg.role;

  switch (role) {
    case "user":
      return `👤 ${formatContent(msg.content)}`;

    case "assistant":
      return `🤖 ${formatContent(msg.content)}`;

    case "toolResult":
      return `🔧 [${msg.toolName}] ${formatContent(msg.content)}`;

    case "bashExecution":
      return `💻 $ ${msg.command}`;

    default:
      return `❓ [${role}] ${JSON.stringify(msg.content)}`;
  }
}

/**
 * Extract text from content blocks
 */
function formatContent(content: any): string {
  if (typeof content === "string") {
    return content.slice(0, 200);
  }

  if (Array.isArray(content)) {
    const texts = content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join(" ");
    return texts.slice(0, 200);
  }

  return "";
}

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
 * List sessions in current directory
 */
async function listSessions(cwd: string): Promise<SessionInfo[]> {
  return await SessionManager.list(cwd);
}

/**
 * Watch a session and display new messages
 */
function watchSession(sessionPath: string, ctx: any) {
  let lastProcessedLineCount = 0;

  // Count initial lines
  if (existsSync(sessionPath)) {
    try {
      const data = readFileSync(sessionPath, "utf8");
      lastProcessedLineCount = data.split("\n").filter((l) => l.trim()).length;
    } catch (e) {
      // File might be empty or unreadable
    }
  }

  const watcher = watch(sessionPath, { persistent: false }, (eventType) => {
    if (eventType !== "change") return;

    try {
      const data = readFileSync(sessionPath, "utf8");
      const lines = data.split("\n").filter((l) => l.trim());

      const newLines = lines.slice(lastProcessedLineCount);

      for (const line of newLines) {
        try {
          const entry = JSON.parse(line);
          const formatted = formatMessage(entry);
          if (formatted) {
            ctx.ui.notify(formatted, "info");
          }
        } catch (e) {
          // Skip malformed lines
        }
      }

      lastProcessedLineCount = lines.length;
    } catch (e) {
      // Skip errors during read
    }
  });

  // Return cleanup function
  return () => {
    watcher.close();
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("watch", {
    description: "Watch another pi session in real-time",
    handler: async (args, ctx) => {
      // Get current working directory
      const currentCwd = process.cwd();
      let sessions: SessionInfo[] = [];
      try {
        sessions = await listSessions(currentCwd);
      } catch (error) {
        ctx.ui.notify(`Failed to load sessions: ${error}`, "error");
        return;
      }

      if (!sessions || sessions.length === 0) {
        ctx.ui.notify("No sessions found in current folder", "error");
        return;
      }

      // Filter out invalid sessions
      sessions = sessions.filter((s) => s && s.path && typeof s === "object");

      if (sessions.length === 0) {
        ctx.ui.notify("No valid sessions found", "error");
        return;
      }

      // Format sessions for selection as strings (matches /resume format)
      const choices: string[] = [];
      for (const s of sessions) {
        try {
          if (!s) continue;
          
          const displayName = s.name || "";
          const firstMsg = s.firstMessage || "";
          const finalName = displayName || firstMsg;

          const normalizedMessage = finalName
            .replace(/[\x00-\x1f\x7f]/g, " ")
            .trim()
            .slice(0, 200);
          const cwdShort = s.cwd ? shortenPath(s.cwd) : "";
          const age = s.modified ? formatSessionDate(s.modified) : "";
          const msgCount = s.messageCount || 0;
          choices.push(`${normalizedMessage} (${cwdShort} ${msgCount} ${age})`);
        } catch (e) {
          console.error("Error processing session:", e, s);
        }
      }

      if (choices.length === 0) {
        ctx.ui.notify("No valid sessions to display", "error");
        return;
      }

      const selected = await ctx.ui.select(
        "Select a session to watch (Ctrl+C to stop):",
        choices,
      );

      if (!selected) return;

      const selectedIndex = choices.indexOf(selected);
      if (
        selectedIndex === -1 ||
        selectedIndex < 0 ||
        selectedIndex >= sessions.length
      ) {
        ctx.ui.notify("Failed to find selected session", "error");
        return;
      }
      const session = sessions[selectedIndex];

      if (!session) {
        ctx.ui.notify("Selected session is undefined", "error");
        return;
      }

      if (!session.path) {
        ctx.ui.notify("Session has no path", "error");
        return;
      }

      const sessionCwd = session && session.cwd ? session.cwd : session && session.path ? session.path : "unknown";
      ctx.ui.notify(`Watching: ${sessionCwd}`, "info");
      ctx.ui.notify("Press Ctrl+C in this terminal to stop watching", "info");

      // Start watching
      const cleanup = watchSession(session.path, ctx);

      // Register cleanup on session shutdown
      pi.on("session_shutdown", () => {
        cleanup();
      });
    },
  });
}
