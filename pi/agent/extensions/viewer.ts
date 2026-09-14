/**
 * Markdown Viewer Extension
 *
 * Renders a markdown file for the user in a scrollable overlay viewer.
 *
 * - Tool `show_markdown(path)`: for the agent to present a markdown file it
 *   just wrote (plans, reports, docs). Non-blocking: the tool returns
 *   immediately and the overlay stays open until the user presses Esc.
 * - Command `/view [path]`: manually view a markdown file. With no
 *   argument, reopens the most recently viewed file in this session
 *   (tracked in a session entry, so it survives restarts and is per branch).
 *
 * Only one viewer overlay is open at a time; a new view closes the
 * previous one. In headless mode (no UI) both paths degrade to printing the
 * absolute file path.
 */
import {
    DynamicBorder,
    getMarkdownTheme,
    type ExtensionAPI,
    type ExtensionContext,
    type SessionEntry,
    type Theme,
    type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";
import os from "node:os";
import { stat, readFile } from "node:fs/promises";
import {
    Key,
    Markdown,
    Text,
    TUI,
    matchesKey,
    truncateToWidth,
    visibleWidth,
} from "@earendil-works/pi-tui";
import type { OverlayHandle } from "@earendil-works/pi-tui";

type ViewerDetails = { path: string; error?: string };

/** Handle of the currently open viewer overlay (single instance). */
let activeViewerHandle: OverlayHandle | null = null;

// --- Last-viewed state (same pattern as inline.ts) ---

const VIEWER_STATE_KEY = "viewer-state";

interface ViewerState {
    path: string;
}

/** In-memory cache of the most recently viewed file (per current branch). */
let lastViewedPath: string | null = null;

function persistViewedPath(pi: ExtensionAPI, filePath: string): void {
    lastViewedPath = filePath;
    pi.appendEntry(VIEWER_STATE_KEY, { path: filePath } satisfies ViewerState);
}

function loadViewedPathFromBranch(branch: SessionEntry[]): string | null {
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (
            entry.type === "custom" &&
            entry.customType === VIEWER_STATE_KEY &&
            entry.data &&
            typeof (entry.data as ViewerState).path === "string"
        ) {
            return (entry.data as ViewerState).path;
        }
    }
    return null;
}

function reconstructViewerState(ctx: ExtensionContext): void {
    lastViewedPath = loadViewedPathFromBranch(ctx.sessionManager.getBranch());
}

function getLastViewedPath(ctx: ExtensionContext): string | null {
    if (lastViewedPath === null) {
        reconstructViewerState(ctx);
    }
    return lastViewedPath;
}

function expandHome(filePath: string): string {
    if (filePath === "~") return os.homedir();
    if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
    return filePath;
}

function resolveViewPath(cwd: string, filePath: string): string {
    return path.resolve(cwd, expandHome(filePath.trim()));
}

/** cwd-relative when possible, otherwise ~-abbreviated (same semantics as the built-in read renderer). */
function shortenPath(filePath: string, cwd: string): string {
    const rel = path.relative(cwd, filePath);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        return rel.split(path.sep).join("/");
    }
    const home = os.homedir();
    if (filePath.startsWith(home)) {
        return `~${filePath.slice(home.length)}`;
    }
    return filePath;
}

async function readMarkdownFile(
    filePath: string,
): Promise<{ content: string; bytes: number } | { error: string }> {
    try {
        const stats = await stat(filePath);
        if (!stats.isFile()) {
            return { error: `Not a file: ${filePath}` };
         }
        const content = await readFile(filePath, "utf8");
        return { content, bytes: stats.size };
    } catch (error: any) {
        if (error?.code === "ENOENT") {
            return { error: `File not found: ${filePath}` };
         }
        return { error: `Failed to read ${filePath}: ${error?.message ?? "unknown error"}` };
    }
}

class MarkdownViewerOverlayComponent {
    private filePath: string;
    private fileName: string;
    private markdown: Markdown;
    private scrollOffset = 0;
    private viewHeight = 0;
    private totalLines = 0;
    private tui: TUI;
    private theme: Theme;
    private keybindings: KeybindingsManager;
    private onClose: () => void;
    private fullscreen = false;

    constructor(
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        filePath: string,
        content: string,
        onClose: () => void,
    ) {
        this.tui = tui;
        this.theme = theme;
        this.keybindings = keybindings;
        this.filePath = filePath;
        this.fileName = path.basename(filePath);
        this.onClose = onClose;
        const body = content.trim() ? content : "_Empty file._";
        this.markdown = new Markdown(body, 1, 0, getMarkdownTheme());
    }

    handleInput(keyData: string): void {
        const kb = this.keybindings;
        if (kb.matches(keyData, "tui.select.cancel")) {
            this.onClose();
             return;
         }
        if (kb.matches(keyData, "tui.select.confirm")) {
            this.onClose();
             return;
         }
        if (kb.matches(keyData, "tui.select.up")) {
             this.scrollBy(-1);
             return;
         }
        if (kb.matches(keyData, "tui.select.down")) {
             this.scrollBy(1);
             return;
         }
        if (matchesKey(keyData, "j")) {
            this.scrollBy(1);
            return;
        }
        if (matchesKey(keyData, "k")) {
            this.scrollBy(-1);
            return;
        }
       if (matchesKey(keyData, Key.ctrl("d"))) {
            this.scrollBy(Math.floor(this.viewHeight / 2) || 1);
            return;
        }
       if (matchesKey(keyData, Key.ctrl("u"))) {
            this.scrollBy(-Math.floor(this.viewHeight / 2) || -1);
            return;
        }
        if (matchesKey(keyData, "f")) {
            this.fullscreen = !this.fullscreen;
            this.tui.requestRender();
            return;
        }
        if (kb.matches(keyData, "tui.select.pageUp") || matchesKey(keyData, Key.left)) {
             this.scrollBy(-this.viewHeight || -1);
             return;
         }
        if (kb.matches(keyData, "tui.select.pageDown") || matchesKey(keyData, Key.right)) {
             this.scrollBy(this.viewHeight || 1);
             return;
         }
    }

    render(width: number): string[] {
        const maxHeight = this.getMaxHeight();
        const headerLines = this.fullscreen ? 0 : 3;
        const footerLines = this.fullscreen ? 0 : 2;
        const borderLines = 2;
        const innerWidth = Math.max(10, width - 2);
        const contentHeight = Math.max(1, maxHeight - headerLines - footerLines - borderLines);

        const markdownLines = this.markdown.render(innerWidth);
        this.totalLines = markdownLines.length;
        this.viewHeight = contentHeight;
        const maxScroll = Math.max(0, this.totalLines - contentHeight);
        this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

        const visibleLines = markdownLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
        const lines: string[] = [];

        if (!this.fullscreen) {
            lines.push(this.buildTitleLine(innerWidth));
            lines.push(this.buildMetaLine(innerWidth));
            lines.push("");
        }

        for (const line of visibleLines) {
            lines.push(truncateToWidth(line, innerWidth));
         }
        while (lines.length < headerLines + contentHeight) {
            lines.push("");
         }

        if (!this.fullscreen) {
            lines.push("");
            lines.push(this.buildActionLine(innerWidth));
        }

        const borderColor = (text: string) => this.theme.fg("borderMuted", text);
        const top = borderColor(`┌${"─".repeat(innerWidth)}┐`);
        const bottom = borderColor(`└${"─".repeat(innerWidth)}┘`);
        const framedLines = lines.map((line) => {
            const truncated = truncateToWidth(line, innerWidth);
            const padding = Math.max(0, innerWidth - visibleWidth(truncated));
            return borderColor("│") + truncated + " ".repeat(padding) + borderColor("│");
         });

        return [top, ...framedLines, bottom].map((line) => truncateToWidth(line, width));
    }

    invalidate(): void {
        // Rebuilding is unnecessary: the markdown text never changes while open.
        // Kept for Component interface compatibility.
    }

    private getMaxHeight(): number {
        const rows = this.tui.terminal.rows || 24;
        if (this.fullscreen) return Math.max(10, Math.floor(rows * 0.88));
        return Math.max(10, Math.floor(rows * 0.88));
    }

    private buildTitleLine(width: number): string {
        const titleText = ` ${this.fileName} `;
        const titleWidth = visibleWidth(titleText);
        if (titleWidth >= width) {
            return truncateToWidth(this.theme.fg("accent", titleText.trim()), width);
         }
        const leftWidth = Math.max(0, Math.floor((width - titleWidth) / 2));
        const rightWidth = Math.max(0, width - titleWidth - leftWidth);
        return (
            this.theme.fg("borderMuted", "─".repeat(leftWidth)) +
            this.theme.fg("accent", titleText) +
            this.theme.fg("borderMuted", "─".repeat(rightWidth))
        );
    }

    private buildMetaLine(width: number): string {
        const line = this.theme.fg("muted", ` ${this.filePath}`);
        return truncateToWidth(line, width);
    }

    private buildActionLine(width: number): string {
        const close = this.theme.fg("accent", "esc") + this.theme.fg("dim", " close");
        const full = this.theme.fg("accent", "f") + this.theme.fg("dim", " fullscreen");
        const nav = this.theme.fg("dim", "j/k: scroll. ctrl+d/u: half page. ←/→: page.");
        let line = [close, full, nav].join(this.theme.fg("muted", " • "));
        if (this.totalLines > this.viewHeight) {
            const start = Math.min(this.totalLines, this.scrollOffset + 1);
            const end = Math.min(this.totalLines, this.scrollOffset + this.viewHeight);
            line += this.theme.fg("dim", ` ${start}-${end}/${this.totalLines}`);
         }
        return truncateToWidth(line, width);
    }

    private scrollBy(delta: number): void {
        const maxScroll = Math.max(0, this.totalLines - this.viewHeight);
        this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, maxScroll));
    }
}

async function openViewer(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    filePath: string,
    content: string,
): Promise<void> {
    // Record as the session's most recently viewed file, then close any
    // previously open viewer (single instance).
    persistViewedPath(pi, filePath);
    if (activeViewerHandle) {
        const handle = activeViewerHandle;
        activeViewerHandle = null;
        handle.hide();
    }

    const runtime: { handle: OverlayHandle | null; closed: boolean } = {
        handle: null,
        closed: false,
    };

    await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) => {
            return new MarkdownViewerOverlayComponent(
                tui,
                theme,
                keybindings,
                filePath,
                content,
                () => {
                    runtime.closed = true;
                    if (activeViewerHandle === runtime.handle) {
                        activeViewerHandle = null;
                     }
                    done();
                 },
            );
         },
        {
            overlay: true,
            overlayOptions: { width: "80%", anchor: "center" },
            onHandle: (handle) => {
                runtime.handle = handle;
                if (runtime.closed) {
                    handle.hide();
                     return;
                 }
                activeViewerHandle = handle;
             },
         },
    ).catch((error) => {
        if (activeViewerHandle === runtime.handle) {
            activeViewerHandle = null;
         }
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    });
}

/** Reopen the most recently viewed file, or warn when nothing was viewed yet. */
async function viewLastFile(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    const last = getLastViewedPath(ctx);
    if (!last) {
        ctx.ui.notify(
            "No markdown viewed yet in this session. Usage: /view <path-to-markdown>",
            "warning",
        );
        return;
    }
    if (!ctx.hasUI) {
        console.log(`Viewer not available (headless mode). File: ${resolveViewPath(ctx.cwd, last)}`);
        return;
    }
    const filePath = resolveViewPath(ctx.cwd, last);
    const result = await readMarkdownFile(filePath);
    if ("error" in result) {
        ctx.ui.notify(result.error, "error");
        return;
    }
    await openViewer(pi, ctx, filePath, result.content);
}

export default function viewerExtension(pi: ExtensionAPI) {
    // Rebuild the last-viewed cache on session load / tree navigation so a
    // no-argument /view follows the current branch.
    pi.on("session_start", async (_event, ctx) => {
        reconstructViewerState(ctx);
    });
    pi.on("session_tree", async (_event, ctx) => {
        reconstructViewerState(ctx);
    });

    pi.registerTool({
        name: "show_markdown",
        label: "Show Markdown",
        description:
            "Render a markdown file for the user in a scrollable viewer overlay. " +
            "Call this after writing or updating a markdown file (plans, reports, docs) " +
            "so the user can read the rendered result. Non-blocking: returns immediately; " +
            "the user closes the viewer with Esc.",
        parameters: Type.Object({
            path: Type.String({
                description: "Path to the markdown file (absolute or relative to cwd)",
             }),
         }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const filePath = resolveViewPath(ctx.cwd, params.path);
            const result = await readMarkdownFile(filePath);
            if ("error" in result) {
                return {
                    content: [{ type: "text", text: `Error: ${result.error}` }],
                    details: { path: filePath, error: result.error },
                 };
             }

            if (!ctx.hasUI) {
                persistViewedPath(pi, filePath);
                const text = `Viewer not available (headless mode). File: ${filePath}`;
                return {
                    content: [{ type: "text", text }],
                    details: { path: filePath },
                 };
             }

            // Fire-and-forget: do not await; the tool returns immediately and the
            // user closes the overlay with Esc. done() handles cleanup.
            void openViewer(pi, ctx, filePath, result.content);

            return {
                content: [{ type: "text", text: `Opened viewer: ${filePath}` }],
                details: { path: filePath },
             };
         },

        renderCall(args, theme, context) {
            const rawPath = typeof args.path === "string" ? args.path : "";
            const filePath = rawPath ? shortenPath(resolveViewPath(context.cwd, rawPath), context.cwd) : "";
            const text =
                theme.fg("toolTitle", theme.bold("show_markdown ")) +
                theme.fg("accent", filePath);
            return new Text(text, 0, 0);
         },

        renderResult(result, { isPartial }, theme) {
            if (isPartial) {
                return new Text(theme.fg("warning", "Processing..."), 0, 0);
             }
            const details = result.details as ViewerDetails | undefined;
            if (details?.error) {
                return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
             }
            return new Text("", 0, 0);
         },
    });

    pi.registerCommand("view", {
        description:
            "View a markdown file in an overlay viewer. With no argument, " +
            "reopens the most recently viewed file in this session.",
        handler: async (args, ctx) => {
            let target = (args ?? "").trim();
            if (!target) {
                await viewLastFile(pi, ctx);
                return;
            }
            if (!ctx.hasUI) {
                console.log(`Viewer not available (headless mode). File: ${resolveViewPath(ctx.cwd, target)}`);
                 return;
             }

            const filePath = resolveViewPath(ctx.cwd, target);
            const result = await readMarkdownFile(filePath);
            if ("error" in result) {
                ctx.ui.notify(result.error, "error");
                 return;
             }
            await openViewer(pi, ctx, filePath, result.content);
         },
    });

    // shift+alt+v: reopen the most recently viewed file, same as no-arg /view.
    pi.registerShortcut(Key.shiftAlt("v"), {
        description: "Reopen the last markdown viewer (/view)",
        handler: (ctx) => viewLastFile(pi, ctx),
    });
}
