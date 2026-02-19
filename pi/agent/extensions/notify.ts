/**
 * Notification Extension
 *
 * In tmux: sends a status-line notification via `tmux display-message` when the agent
 * finishes, but only if the current active pane is different from the pane running pi.
 *
 * Outside tmux: falls back to OSC 777 desktop notifications.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@mariozechner/pi-tui";

const inTmux = (): boolean => Boolean(process.env.TMUX);

const getNotifyPaneId = (): string | null => {
	const paneId = process.env.TMUX_PANE?.trim();
	return paneId || null;
};

const getActiveClientPaneIds = async (pi: ExtensionAPI): Promise<string[]> => {
	const { stdout, code } = await pi.exec("tmux", ["list-clients", "-F", "#{pane_id}"]);
	if (code !== 0) return [];

	const ids = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	return [...new Set(ids)];
};

const shouldNotifyInTmux = async (pi: ExtensionAPI): Promise<boolean> => {
	const notifyPaneId = getNotifyPaneId();
	if (!notifyPaneId) {
		// If we cannot resolve the source pane, default to notifying.
		return true;
	}

	const activePaneIds = await getActiveClientPaneIds(pi);
	if (activePaneIds.length === 0) {
		// No active client info; notify by default.
		return true;
	}

	// Silent when any active client is currently focused on the same pane.
	return !activePaneIds.includes(notifyPaneId);
};

const sendTmuxMessage = async (pi: ExtensionAPI, message: string): Promise<boolean> => {
	const text = message.trim();
	if (!text) return false;

	const { code } = await pi.exec("tmux", ["display-message", text]);
	return code === 0;
};

const notifyDesktop = (title: string, body: string): void => {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
};

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
	Boolean(part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part);

const extractLastAssistantText = (messages: Array<{ role?: string; content?: unknown }>): string | null => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") {
			continue;
		}

		const content = message.content;
		if (typeof content === "string") {
			return content.trim() || null;
		}

		if (Array.isArray(content)) {
			const text = content
				.filter(isTextPart)
				.map((part) => part.text)
				.join("\n")
				.trim();
			return text || null;
		}

		return null;
	}

	return null;
};

const plainMarkdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: () => "",
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: () => "",
	quote: (text) => text,
	quoteBorder: () => "",
	hr: () => "",
	listBullet: () => "",
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

const simpleMarkdown = (text: string, width = 80): string => {
	const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);
	return markdown.render(width).join("\n");
};

const formatNotification = (text: string | null): { title: string; body: string } => {
	const simplified = text ? simpleMarkdown(text) : "";
	const normalized = simplified.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return { title: "Ready for input", body: "" };
	}

	const maxBody = 200;
	const body = normalized.length > maxBody ? `${normalized.slice(0, maxBody - 1)}…` : normalized;
	return { title: "π", body };
};

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event) => {
		const lastText = extractLastAssistantText(event.messages ?? []);
		const { title, body } = formatNotification(lastText);
		const message = body ? `${title}: ${body}` : title;

		if (inTmux()) {
			if (!(await shouldNotifyInTmux(pi))) {
				return;
			}

			await sendTmuxMessage(pi, message);
			return;
		}

		notifyDesktop(title, body);
	});
}
