import {
	SessionManager,
	SessionSelectorComponent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionInfo,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { previewSessionFile, sessionDisplayLabel } from "./lib/session-preview.ts";

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
	/**
	 * When set, ctrl+o in the picker previews the highlighted session in an
	 * overlay while the picker stays open (ctrl+o → esc → move → ctrl+o
	 * browsing loop). Absent: ctrl+o is left to the built-in selector.
	 */
	onPreview?: (sessionFile: string, label: string) => void | Promise<void>;
}

/**
 * SessionSelectorComponent subclass adding a ctrl+o session-preview shortcut.
 *
 * Key choice: ctrl+o, not a bare letter. The built-in list forwards every
 * unrecognized key to the search filter, so an unconditional bare letter would
 * make that letter untypable in search, and a query-empty guard would fire on
 * the first letter of any search starting with that letter. ctrl+o is not
 * consumed by the selector (ctrl+p/s/r/d are), so it can be intercepted
 * unconditionally.
 *
 * ctrl+o opens the preview as an overlay on top of the picker (pi-tui stacks
 * overlays): the picker keeps the editor-container slot, keeps its filter /
 * cursor state, and regains focus when the overlay closes. Known edge (accepted,
 * no extra mechanism): ctrl+o followed by immediately closing the picker lets
 * the still-loading preview pop up over the plain editor; esc dismisses it.
 */
class PreviewableSessionSelector extends SessionSelectorComponent {
	/** Preview runner; undefined disables the shortcut entirely. */
	private readonly preview?: (sessionPath: string) => void | Promise<void>;
	/** Captured from the custom-UI factory for the hint line. */
	private readonly previewTheme: Theme;
	/** Guards against stacking overlays on rapid repeated ctrl+o. */
	private previewInFlight = false;

	constructor(
		preview: ((sessionPath: string) => void | Promise<void>) | undefined,
		theme: Theme,
		...args: ConstructorParameters<typeof SessionSelectorComponent>
	) {
		super(...args);
		this.preview = preview;
		this.previewTheme = theme;
	}

	override handleInput(data: string): void {
		if (this.preview && !this.previewInFlight && matchesKey(data, "ctrl+o") && this.isQuiet()) {
			// handleInput is sync; the async preview is fired and forgotten.
			// No selection yet (loading / empty list) is a silent no-op.
			const sessionPath = this.getSessionList().getSelectedSessionPath();
			if (sessionPath) {
				this.previewInFlight = true;
				void Promise.resolve(this.preview(sessionPath))
					.catch(() => {
						// Errors surface as notifications inside previewSessionFile.
					})
					.finally(() => {
						this.previewInFlight = false;
					});
			}
			return;
		}
		super.handleInput(data);
	}

	override render(width: number): string[] {
		return [...super.render(width), this.buildHintLine(width)];
	}

	/**
	 * Quiet state: not in rename mode and not in delete confirmation, the two
	 * private built-in states that swallow input with no public signal. Shape
	 * probe only: a field renamed upstream reads as "not quiet", so the
	 * shortcut silently stops working instead of misfiring.
	 */
	private isQuiet(): boolean {
		const self = this as unknown as { mode?: unknown };
		const list = this.getSessionList() as unknown as { confirmingDeletePath?: unknown };
		return self.mode === "list" && list.confirmingDeletePath === null;
	}

	private buildHintLine(width: number): string {
		return truncateToWidth(this.previewTheme.fg("dim", " ctrl+o: preview"), width);
	}
}

/**
 * Open the built-in /resume picker (Tab toggles Current Folder / All, plus its
 * filter / sort / rename / delete) and return the picked session, or null on
 * esc/quit. The component's onSelect only reports the path, so both loaders
 * fill a path → SessionInfo map; a path missing from the map (mutation race)
 * yields null rather than a stale fallback. With options.onPreview set,
 * ctrl+o previews the highlighted session while the picker stays open.
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

	// label from the tracked map; path fallback for the mutation race.
	const preview = options.onPreview
		? (sessionPath: string) => {
				const info = infoByPath.get(sessionPath);
				return options.onPreview?.(sessionPath, info ? sessionDisplayLabel(info) : sessionPath);
			}
		: undefined;

	return ctx.ui.custom<SessionInfo | null>((tui, theme, keybindings, done) => {
		const selector = new PreviewableSessionSelector(
			preview,
			theme,
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
 * "read session <session-id>" to the prompt. ctrl+o previews the highlighted
 * session in an overlay while the picker stays open.
 *
 * Only the default session dir is listed, so the id form resolves: the
 * read_session tool's id lookup covers ~/.pi/agent/sessions/<project>/ only.
 */
export default function (pi: ExtensionAPI): void {
	pi.registerCommand("pick-session", {
		description: "Pick a session and append \"read session <session-id>\" to the prompt (ctrl+o: preview)",
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
				onPreview: (sessionFile, label) => previewSessionFile(ctx, label, sessionFile),
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
