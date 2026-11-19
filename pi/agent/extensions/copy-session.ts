import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "./lib/clipboard.ts";

/**
 * /copy-session: copy the current session id (default) or session file path
 * to the clipboard.
 *
 * Two targets, one flag each: `--id` (also the no-argument default, keeping
 * the pre-flag muscle memory) and `--path` (the JSONL file the session is
 * persisted to, i.e. what `pi --session <path>` and the read_session tool
 * trio resolve from lib/session-common.ts's resolveSessionRef). Flags rather
 * than bare words so the argument syntax matches pi's own CLI (`--session`,
 * `--no-session`) and leaves room for a later `--both` without reshaping the
 * grammar.
 *
 * Argument parsing is deliberately strict: bare `id`/`path`, short forms, or
 * two flags at once are rejected with usage guidance instead of guessing, so
 * a mistyped command never silently copies the wrong thing. Absent or empty
 * args keep the original id behavior.
 *
 * Clipboard-unavailable fallback: warn-notify the text itself for manual
 * copy (same degradation as worktree-task's status action).
 */
const USAGE = "Usage: /copy-session [--id | --path]";

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("copy-session", {
		description: "Copy the current session id (default) or session file path to the clipboard",
		getArgumentCompletions: (prefix: string) => {
			const items = ["--id", "--path"]
				.filter((flag) => flag.startsWith(prefix) && flag !== prefix)
				.map((flag) => ({ value: flag, label: flag }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			let label: "id" | "path" = "id";
			let text: string;

			if (!arg || arg === "--id") {
				text = ctx.sessionManager.getSessionId();
			} else if (arg === "--path") {
				const file = ctx.sessionManager.getSessionFile();
				if (!file) {
					ctx.ui.notify("This session has no file on disk yet; nothing to copy.", "warning");
					return;
				}
				label = "path";
				text = file;
			} else {
				ctx.ui.notify(`Unsupported argument "${arg}". ${USAGE}`, "warning");
				return;
			}

			const copied = await copyToClipboard(pi, text);
			if (copied) ctx.ui.notify(`Copied session ${label} ${text}`, "info");
			else ctx.ui.notify(`Clipboard unavailable. Session ${label}: ${text}`, "warning");
		},
	});
}
