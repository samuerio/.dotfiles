/**
 * Markdown Preview Extension
 *
 * Renders a markdown file for the user in a scrollable overlay viewer.
 *
 * - Tool `show_markdown(path)`: for the agent to present a markdown file it
 *   just wrote (plans, reports, docs). Non-blocking: the tool returns
 *   immediately and the overlay stays open until the user presses Esc.
 * - Command `/preview [path]`: manually preview a markdown file. With no
 *   argument, reopens the most recently previewed file in this session
 *   (tracked in a session entry, so it survives restarts and is per branch).
 *
 * Only one preview overlay is open at a time; a new preview closes the
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
import { Type } from "@sinclair/typebox";
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

type PreviewDetails = { path: string; error?: string };

/** Handle of the currently open preview overlay (single instance). */
let activePreviewHandle: OverlayHandle | null = null;

// --- Last-preview state (same pattern as inline.ts) ---

const PREVIEW_STATE_KEY = "preview-state";

interface PreviewState {
    path: string;
}

/** In-memory cache of the most recently previewed file (per current branch). */
let lastPreviewPath: string | null = null;

function persistPreviewPath(pi: ExtensionAPI, filePath: string): void {
    lastPreviewPath = filePath;
    pi.appendEntry(PREVIEW_STATE_KEY, { path: filePath } satisfies PreviewState);
}

function loadPreviewPathFromBranch(branch: SessionEntry[]): string | null {
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (
            entry.type === "custom" &&
            entry.customType === PREVIEW_STATE_KEY &&
            entry.data &&
            typeof (entry.data as PreviewState).path === "string"
        ) {
            return (entry.data as PreviewState).path;
        }
    }
    return null;
}

function reconstructPreviewState(ctx: ExtensionContext): void {
    lastPreviewPath = loadPreviewPathFromBranch(ctx.sessionManager.getBranch());
}

function getLastPreviewPath(ctx: ExtensionContext): string | null {
    if (lastPreviewPath === null) {
        reconstructPreviewState(ctx);
    }
    return lastPreviewPath;
}

function expandHome(filePath: string): string {
    if (filePath === "~") return os.homedir();
    if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
    return filePath;
}

function resolvePreviewPath(cwd: string, filePath: string): string {
    return path.resolve(cwd, expandHome(filePath.trim()));
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

class MarkdownPreviewOverlayComponent {
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

async function openPreview(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    filePath: string,
    content: string,
): Promise<void> {
    // Record as the session's most recent preview, then close any previously
    // open preview (single instance).
    persistPreviewPath(pi, filePath);
    if (activePreviewHandle) {
        const handle = activePreviewHandle;
        activePreviewHandle = null;
        handle.hide();
    }

    const runtime: { handle: OverlayHandle | null; closed: boolean } = {
        handle: null,
        closed: false,
    };

    await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) => {
            return new MarkdownPreviewOverlayComponent(
                tui,
                theme,
                keybindings,
                filePath,
                content,
                () => {
                    runtime.closed = true;
                    if (activePreviewHandle === runtime.handle) {
                        activePreviewHandle = null;
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
                activePreviewHandle = handle;
             },
         },
    ).catch((error) => {
        if (activePreviewHandle === runtime.handle) {
            activePreviewHandle = null;
         }
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    });
}

export default function previewExtension(pi: ExtensionAPI) {
    // Rebuild the last-preview cache on session load / tree navigation so a
    // no-argument /preview follows the current branch.
    pi.on("session_start", async (_event, ctx) => {
        reconstructPreviewState(ctx);
    });
    pi.on("session_tree", async (_event, ctx) => {
        reconstructPreviewState(ctx);
    });

    pi.registerTool({
        name: "show_markdown",
        label: "Show Markdown",
        description:
            "Render a markdown file for the user in a scrollable preview overlay. " +
            "Call this after writing or updating a markdown file (plans, reports, docs) " +
            "so the user can read the rendered result. Non-blocking: returns immediately; " +
            "the user closes the preview with Esc.",
        parameters: Type.Object({
            path: Type.String({
                description: "Path to the markdown file (absolute or relative to cwd)",
             }),
         }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const filePath = resolvePreviewPath(ctx.cwd, params.path);
            const result = await readMarkdownFile(filePath);
            if ("error" in result) {
                return {
                    content: [{ type: "text", text: `Error: ${result.error}` }],
                    details: { path: filePath, error: result.error },
                 };
             }

            if (!ctx.hasUI) {
                persistPreviewPath(pi, filePath);
                const text = `Preview not available (headless mode). File: ${filePath}`;
                return {
                    content: [{ type: "text", text }],
                    details: { path: filePath },
                 };
             }

            // Fire-and-forget: do not await; the tool returns immediately and the
            // user closes the overlay with Esc. done() handles cleanup.
            void openPreview(pi, ctx, filePath, result.content);

            return {
                content: [{ type: "text", text: `Opened preview: ${filePath}` }],
                details: { path: filePath },
             };
         },

        renderCall(args, theme) {
            const filePath = typeof args.path === "string" ? args.path : "";
            const text =
                theme.fg("toolTitle", theme.bold("show_markdown ")) +
                theme.fg("accent", filePath);
            return new Text(text, 0, 0);
         },

        renderResult(result, { isPartial }, theme) {
            if (isPartial) {
                return new Text(theme.fg("warning", "Processing..."), 0, 0);
             }
            const details = result.details as PreviewDetails | undefined;
            if (details?.error) {
                return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
             }
            const filePath = details?.path ?? "";
            return new Text(
                theme.fg("success", "✓ ") +
                    theme.fg("muted", "Opened preview ") +
                    theme.fg("accent", filePath),
                0,
                0,
            );
         },
    });

    pi.registerCommand("preview", {
        description:
            "Preview a markdown file in an overlay viewer. With no argument, " +
            "reopens the most recently previewed file in this session.",
        handler: async (args, ctx) => {
            let target = (args ?? "").trim();
            if (!target) {
                const last = getLastPreviewPath(ctx);
                if (!last) {
                    ctx.ui.notify(
                        "No markdown previewed yet in this session. Usage: /preview <path-to-markdown>",
                        "warning",
                    );
                    return;
                }
                target = last;
            }
            if (!ctx.hasUI) {
                console.log(`Preview not available (headless mode). File: ${resolvePreviewPath(ctx.cwd, target)}`);
                 return;
             }

            const filePath = resolvePreviewPath(ctx.cwd, target);
            const result = await readMarkdownFile(filePath);
            if ("error" in result) {
                ctx.ui.notify(result.error, "error");
                 return;
             }
            await openPreview(pi, ctx, filePath, result.content);
         },
    });
}
