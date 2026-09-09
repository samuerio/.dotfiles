import {
	SessionManager,
	SessionSelectorComponent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";

/** Lazy session loader (SessionListProgress-compatible). */
export type SessionLoader = (
	onProgress?: (loaded: number, total: number) => void,
) => Promise<SessionInfo[]>;

export interface PickSessionOptions {
	/** Loader for the Current Folder scope (Tab). */
	current: SessionLoader;
	/** Loader for the All scope (Tab). */
	all: SessionLoader;
	/** Session file to mark as "current" in the list (optional). */
	currentSessionFile?: string;
}

/**
 * Open the built-in /resume picker (Tab toggles Current Folder / All, plus its
 * filter / sort / rename / delete) and return the picked session, or null on
 * esc/quit. The component's onSelect only reports the path, so both loaders
 * fill a path → SessionInfo map; a path missing from the map (mutation race)
 * yields null rather than a stale fallback.
 */
export async function pickSession(
	ctx: ExtensionCommandContext,
	options: PickSessionOptions,
): Promise<SessionInfo | null> {
	const infoByPath = new Map<string, SessionInfo>();
	const track = (sessions: SessionInfo[]): SessionInfo[] => {
		for (const info of sessions) infoByPath.set(info.path, info);
		return sessions;
	};

	return ctx.ui.custom<SessionInfo | null>((tui, _theme, keybindings, done) => {
		const selector = new SessionSelectorComponent(
			(onProgress) => options.current(onProgress).then(track),
			(onProgress) => options.all(onProgress).then(track),
			(sessionPath) => done(infoByPath.get(sessionPath) ?? null),
			() => done(null),
			// Quit (ctrl+c): close the picker, never shut down the host session.
			() => done(null),
			() => tui.requestRender(),
			{
				// Same rename behavior as the built-in resume flow.
				renameSession: async (sessionFilePath, nextName) => {
					const name = (nextName ?? "").trim();
					if (!name) return;
					SessionManager.open(sessionFilePath).appendSessionInfo(name);
				},
				showRenameHint: true,
				keybindings,
			},
			options.currentSessionFile,
		);
		return selector;
	});
}

/** Mention appended to the editor: "read session <session-id>". */
function mention(id: string): string {
	return `read session ${id}`;
}

/**
 * /pick-session: pick a session with the built-in /resume picker and append
 * "read session <session-id>" to the editor.
 *
 * Only the default session dir is listed, so the id form resolves: the
 * read_session tool's id lookup covers ~/.pi/agent/sessions/<project>/ only.
 */
export default function (pi: ExtensionAPI): void {
	pi.registerCommand("pick-session", {
		description: "Pick a session and append \"read session <session-id>\" to the prompt",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("pick-session requires interactive mode", "error");
				return;
			}

			const sessionDir = ctx.sessionManager.getSessionDir();
			const info = await pickSession(ctx, {
				// Current Folder: explicit dir bypasses cwd filtering for
				// non-default --session-dir setups.
				current: (onProgress) => SessionManager.list(ctx.cwd, sessionDir, onProgress),
				all: (onProgress) => SessionManager.listAll(sessionDir, onProgress),
				currentSessionFile: ctx.sessionManager.getSessionFile(),
			});
			if (!info) return;

			// Append to the editor like background-task's addSessionToPrompt
			// (space-separated), then confirm with a notify.
			const current = ctx.ui.getEditorText();
			const separator = current && !current.endsWith(" ") ? " " : "";
			const text = `${current}${separator}${mention(info.id)}`;
			ctx.ui.setEditorText(text);
			ctx.ui.notify(`Added ${mention(info.id)} to prompt`, "info");
		},
	});
}
