import {
    SessionManager,
    SessionSelectorComponent,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type SessionInfo,
} from "@earendil-works/pi-coding-agent";

/**
 * /pick-session: pick a session with the built-in /resume picker (Tab toggles
 * Current Folder / All) and append "read session <session-id>" to the editor.
 *
 * Only the default session dir is listed, so the id form resolves: the
 * read_session tool's id lookup covers ~/.pi/agent/sessions/<project>/ only.
 */
export default function (pi: ExtensionAPI): void {
    pi.registerCommand("pick-session", {
        description:
            'Pick a session and append "read session <session-id>" to the prompt',
        handler: async (_args, ctx) => {
            if (!ctx.hasUI) {
                ctx.ui.notify(
                    "pick-session requires interactive mode",
                    "error",
                );
                return;
            }

            const id = await pickSessionId(ctx);
            if (!id) return;

            // Append to the editor like background-task's addSessionToPrompt
            // (space-separated), but silent: the mention is already visible.
            const current = ctx.ui.getEditorText();
            const separator = current && !current.endsWith(" ") ? " " : "";
            ctx.ui.setEditorText(`${current}${separator}${mention(id)}`);
            ctx.ui.notify(`Added ${mention(id)} to prompt`, "info");
        },
    });
}

/** Mention appended to the editor: "read session <session-id>". */
function mention(id: string): string {
    return `read session ${id}`;
}

/**
 * Show the built-in /resume picker and return the picked session's id (null on
 * esc/quit). onSelect only reports the path, so both loaders fill a path → id
 * map; a path missing from the map (mutation race) yields null, not a fallback
 * to path — appending a path would silently break the "read session <id>"
 * contract.
 */
async function pickSessionId(
    ctx: ExtensionCommandContext,
): Promise<string | null> {
    const sessionDir = ctx.sessionManager.getSessionDir();
    const idByPath = new Map<string, string>();
    const track = (sessions: SessionInfo[]): SessionInfo[] => {
        for (const info of sessions) idByPath.set(info.path, info.id);
        return sessions;
    };

    return ctx.ui.custom<string | null>((tui, _theme, keybindings, done) => {
        const selector = new SessionSelectorComponent(
            // Current Folder: sessions for ctx.cwd (explicit dir bypasses cwd
            // filtering for non-default --session-dir setups).
            (onProgress) =>
                SessionManager.list(ctx.cwd, sessionDir, onProgress).then(
                    track,
                ),
            // All: same dir override semantics as the built-in resume flow.
            (onProgress) =>
                SessionManager.listAll(sessionDir, onProgress).then(track),
            (sessionPath) => done(idByPath.get(sessionPath) ?? null),
            () => done(null),
            // Quit (ctrl+c): close the picker, never shut down the host session.
            () => done(null),
            () => tui.requestRender(),
            {
                // Same rename behavior as the built-in resume flow.
                renameSession: async (sessionFilePath, nextName) => {
                    const name = (nextName ?? "").trim();
                    if (!name) return;
                    SessionManager.open(sessionFilePath).appendSessionInfo(
                        name,
                    );
                },
                showRenameHint: true,
                keybindings,
            },
            ctx.sessionManager.getSessionFile(),
        );
        return selector;
    });
}
