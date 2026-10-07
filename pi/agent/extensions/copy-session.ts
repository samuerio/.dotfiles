import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "./lib/clipboard.ts";

/**
 * /copy-session: copy the current session id to the clipboard.
 *
 * Single-purpose user convenience command (continue.ts precedent: one
 * command, one small file). No picker: the id comes straight from the live
 * session manager. The bare id is what the read_session tool trio and
 * `pi --session <path|id>` accept (resolved by lib/session-common.ts's
 * resolveSessionRef), so the paste target stays the caller's choice.
 *
 * Clipboard-unavailable fallback: warn-notify the id itself for manual
 * copy (same degradation as background-task's status action).
 */
export default function (pi: ExtensionAPI): void {
	pi.registerCommand("copy-session", {
		description: "Copy the current session id to the clipboard",
		handler: async (_args, ctx) => {
			const id = ctx.sessionManager.getSessionId();
			const copied = await copyToClipboard(pi, id);
			if (copied) ctx.ui.notify(`Copied session id ${id}`, "info");
			else ctx.ui.notify(`Clipboard unavailable. Session id: ${id}`, "warning");
		},
	});
}
