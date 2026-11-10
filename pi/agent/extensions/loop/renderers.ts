/** Transcript renderers for the loop tools (pure, testable). */

import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import {
    stripTerminalSequences,
    Text,
    truncateToWidth,
    visibleWidth,
    type Component,
} from "@earendil-works/pi-tui";

import { cronToHuman, parseCronExpression } from "./cron.ts";

// ─── Renderer formatters (pure, testable) ─────────────────────────
//
// How the three tools draw in the interactive transcript (and HTML
// exports). Same shape as the built-in tools: format* returns a
// styled string, thin render* closures reuse the last component.
//
// Rules (mirroring read/bash renderers):
// - never throw: a renderer exception is silently swallowed by the
//   TUI and falls back to the raw JSON args line;
// - no fs, no module state, no relative times ("in 3m"): rows are
//   snapshots re-rendered on every repaint, session reloads, and
//   HTML exports (which also render at fixed width 100);
// - read everything from the tool call's args (typed, may be partial
//   while streaming) and the structured `details` set by execute() —
//   details ride along with the result through session storage but
//   are never sent to the model.

export interface LoopCreateDetails {
    id: string;
    cron: string;
    recurring: boolean;
    durable: boolean;
    /** Jittered first fire (epoch ms); null when the cron matches nothing. */
    nextFireAt: number | null;
}

export interface LoopListJob {
    id: string;
    cron: string;
    recurring: boolean;
    durable: boolean;
    prompt: string;
    createdAt: number;
}

export interface LoopListDetails {
    jobs: LoopListJob[];
}

interface LoopDeleteDetails {
    id: string;
    scope: "session" | "durable";
}

type RenderArgs = {
    cron?: unknown;
    prompt?: unknown;
    recurring?: unknown;
    durable?: unknown;
    id?: unknown;
};

type RenderContent = { type?: unknown; text?: unknown };

interface RenderResult {
    content: RenderContent[];
    details?: unknown;
}

interface RenderChecks {
    args?: RenderArgs;
    argsComplete: boolean;
    isError: boolean;
    lastComponent?: Component;
}

/** Neutralize a model-controlled string (cron, id) for row output: any
 *  terminal-control sequences the model emits must not reach the UI. */
function cleanToken(text: unknown): string {
    return typeof text === "string" ? stripTerminalSequences(text) : "";
}

function asArgs(args: RenderArgs | undefined | null): RenderArgs {
    return typeof args === "object" && args !== null ? args : {};
}

function resultTextOf(result: RenderResult): string {
    return Array.isArray(result?.content)
        ? result.content
              .filter((block) => block.type === "text" && typeof block.text === "string")
              .map((block) => block.text as string)
              .join("\n")
        : "";
}

/** Reuse the previously returned component (built-in renderer pattern). */
function reuseText(last: Component | undefined): Text {
    return last instanceof Text ? last : new Text("", 0, 0);
}

/** One safe display line: sequences stripped, whitespace folded, width-capped. */
function oneLine(text: string, maxWidth: number): string {
    const clean = stripTerminalSequences(typeof text === "string" ? text : "").replace(/\s+/g, " ").trim();
    return truncateToWidth(clean, Math.max(1, maxWidth), "…");
}

/** Truncate to width then pad to width (counting display cells, CJK-safe). */
function padTo(text: string, width: number): string {
    const capped = truncateToWidth(text, width);
    return capped + " ".repeat(Math.max(0, width - visibleWidth(capped)));
}

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Absolute wall-clock label for an epoch stamp, never a relative
 * "in 3m" (which would be wrong the next time the row repaints).
 */
function formatFireTime(ms: number, nowMs: number): string {
    const at = new Date(ms);
    const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    if (at.toDateString() === new Date(nowMs).toDateString()) return `~${time}`;
    if (nowMs - ms < 6 * 86_400_000) {
        return `~${WEEKDAYS_SHORT[at.getDay()] ?? "?"} ${time}`;
    }
    const pad = (n: number) => String(n).padStart(2, "0");
    return `~${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

function formatCreatedStamp(ms: number): string {
    return new Date(ms).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

/**
 * Human schedule at render time: cronToHuman falls back to the raw
 * expression when it cannot make it friendly — don't echo it twice.
 */
function scheduleLabel(cron: string): string {
    const trimmed = cron.trim();
    const human = cronToHuman(trimmed);
    return human === trimmed ? trimmed : human;
}

/**
 * Error rows: one truncated line collapsed, the full message expanded.
 * No glyph: a rendered result row only ever exists when something
 * failed, and the toolErrorBg/toolError colors already carry that.
 */
function errorBody(text: string, expanded: boolean, theme: Theme): string {
    const clean = stripTerminalSequences(text ?? "").trim() || "failed";
    return theme.fg("error", expanded ? clean : oneLine(clean, 96));
}

/**
 * Rows without usable details (results recorded before this change,
 * aborted calls, anything hook-rewritten): show the content text as-is.
 */
function legacyBody(text: string, expanded: boolean, theme: Theme): string {
    const clean = stripTerminalSequences(text ?? "").trim();
    if (!clean) return theme.fg("dim", "(no output)");
    if (!expanded) return theme.fg("dim", oneLine(clean.split("\n")[0] ?? clean, 96));
    return theme.fg("toolOutput", stripTerminalSequences(clean));
}

function keyRow(label: string, value: string, theme: Theme): string {
    return theme.fg("dim", `   ${label.padEnd(9)}`) + theme.fg("toolOutput", value);
}

function promptLines(prompt: unknown): string[] {
    if (typeof prompt !== "string") return ["(unknown)"];
    const clean = stripTerminalSequences(prompt).trim();
    return clean ? clean.split(/\r?\n/) : ["(empty)"];
}

export function formatCreateCall(
    args: RenderArgs,
    theme: Theme,
    argsComplete: boolean,
): string {
    const safe = asArgs(args);
    const cron = cleanToken(safe.cron).trim();
    const prompt = typeof safe.prompt === "string" ? oneLine(safe.prompt, 44) : "";
    let text = theme.fg("toolTitle", theme.bold("loop_create "));
    if (argsComplete && cron) {
        // Only humanize complete, parseable args; a half-streamed or
        // invalid cron stays raw.
        text += parseCronExpression(cron)
            ? theme.fg("accent", scheduleLabel(cron))
            : theme.fg("dim", cron);
    } else if (cron) {
        text += theme.fg("dim", cron);
    } else {
        text += theme.fg("dim", "…");
    }
    if (prompt) {
        text += " " + theme.fg(argsComplete ? "muted" : "dim", `"${prompt}"`);
    }
    return text;
}

function asCreateDetails(value: unknown): LoopCreateDetails | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const v = value as Record<string, unknown>;
    if (typeof v.id !== "string" || !v.id || typeof v.cron !== "string" || !v.cron) {
        return undefined;
    }
    return {
        id: v.id,
        cron: v.cron,
        recurring: v.recurring !== false,
        durable: v.durable === true,
        nextFireAt: typeof v.nextFireAt === "number" ? v.nextFireAt : null,
    };
}

export function formatCreateResult(
    args: RenderArgs,
    details: LoopCreateDetails | undefined,
    result: RenderResult,
    options: { expanded: boolean },
    theme: Theme,
    isError: boolean,
): string {
    if (isError) return errorBody(resultTextOf(result), options.expanded, theme);
    if (!details) return legacyBody(resultTextOf(result), options.expanded, theme);

    let head =
        theme.fg("toolOutput", details.id) +
        theme.fg(
            "muted",
            ` · ${details.recurring ? "recurring" : "one-shot"} · ${details.durable ? "durable" : "session"}`,
        );
    if (details.nextFireAt !== null && Number.isFinite(details.nextFireAt)) {
        head += theme.fg("muted", ` · first fire ${formatFireTime(details.nextFireAt, Date.now())}`);
    }
    const lines = [head];
    if (options.expanded) {
        lines.push(keyRow("cron", cleanToken(details.cron), theme));
        lines.push(
            keyRow(
                "storage",
                details.durable
                    ? "durable — persisted to .pi/loop-tasks.json"
                    : "session — in memory, dies when this session exits",
                theme,
            ),
        );
        lines.push(
            keyRow(
                "expiry",
                details.recurring ? "auto-expires after 7 days" : "fires once, then auto-deletes",
                theme,
            ),
        );
        promptLines(asArgs(args).prompt).forEach((line, index) => {
            lines.push(index === 0 ? keyRow("prompt", line, theme) : `            ${line}`);
        });
    }
    return lines.join("\n");
}

export function formatDeleteCall(
    args: RenderArgs,
    theme: Theme,
    argsComplete: boolean,
): string {
    const id = cleanToken(asArgs(args).id).trim();
    let text = theme.fg("toolTitle", theme.bold("loop_delete "));
    text += id
        ? theme.fg(argsComplete ? "toolOutput" : "dim", id)
        : theme.fg("dim", "…");
    return text;
}

function asDeleteDetails(value: unknown): LoopDeleteDetails | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const v = value as Record<string, unknown>;
    if (typeof v.id !== "string" || !v.id) return undefined;
    return { id: v.id, scope: v.scope === "durable" ? "durable" : "session" };
}

export function formatDeleteResult(
    details: LoopDeleteDetails | undefined,
    result: RenderResult,
    options: { expanded: boolean },
    theme: Theme,
    isError: boolean,
): string {
    if (isError) return errorBody(resultTextOf(result), options.expanded, theme);
    if (!details) return legacyBody(resultTextOf(result), options.expanded, theme);
    // Success: the call row already says everything (`loop_delete <id>`)
    // and "Cancelled job <id>." adds nothing — hide the result entirely,
    // collapsed and expanded alike (like the write tool).
    return "";
}

/** List schedule text: mirror loop_list's model-facing "invalid cron" wording. */
function listScheduleOf(cron: string): string {
    return parseCronExpression(cron) ? cronToHuman(cron.trim()) : "invalid cron";
}

const LIST_COLUMN = { id: 10, schedule: 21, recurrence: 11, scope: 9 };

function formatListRow(job: LoopListJob, theme: Theme, promptWidth: number): string {
    return (
        theme.fg("toolOutput", padTo(cleanToken(job.id), LIST_COLUMN.id)) +
        theme.fg("accent", padTo(listScheduleOf(cleanToken(job.cron)), LIST_COLUMN.schedule)) +
        theme.fg(
            "muted",
            padTo(job.recurring ? "recurring" : "one-shot", LIST_COLUMN.recurrence) +
                padTo(job.durable ? "durable" : "session", LIST_COLUMN.scope),
        ) +
        theme.fg("dim", `"${oneLine(job.prompt, promptWidth)}"`)
    );
}

function formatListDetailLine(job: LoopListJob, theme: Theme): string {
    const created = Number.isFinite(job.createdAt)
        ? ` · created ${formatCreatedStamp(job.createdAt)}`
        : "";
    const detail = `cron ${cleanToken(job.cron)}${created} · fires while session idle`;
    return theme.fg("dim", "          " + truncateToWidth(detail, 86, "…"));
}

function asListDetails(value: unknown): LoopListDetails | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const v = value as Record<string, unknown>;
    if (!Array.isArray(v.jobs)) return undefined;
    return {
        jobs: v.jobs.flatMap((raw) => {
            // Renderer inputs must be fully shaped: pi re-feeds persisted
            // details from unvalidated session files (HTML export included),
            // so every field the row reads is coerced here.
            if (typeof raw !== "object" || raw === null) return [];
            const job = raw as Record<string, unknown>;
            if (typeof job.id !== "string" || !job.id) return [];
            if (typeof job.cron !== "string" || !job.cron) return [];
            return [
                {
                    id: job.id,
                    cron: job.cron,
                    recurring: job.recurring !== false,
                    durable: job.durable === true,
                    prompt: typeof job.prompt === "string" ? job.prompt : "",
                    createdAt: typeof job.createdAt === "number" ? job.createdAt : NaN,
                } satisfies LoopListJob,
            ];
        }),
    };
}

/** Expansion hint respects user keybindings; falls back if the theme
 *  subsystem is not initialized (renderer must never throw). */
function expandHint(): string {
    try {
        return keyHint("app.tools.expand", "to expand");
    } catch {
        return "ctrl+e to expand";
    }
}

export function formatListResult(
    details: LoopListDetails | undefined,
    result: RenderResult,
    options: { expanded: boolean },
    theme: Theme,
    isError: boolean,
): string {
    if (isError) return errorBody(resultTextOf(result), options.expanded, theme);
    if (!details) return legacyBody(resultTextOf(result), options.expanded, theme);
    const jobs = details.jobs.filter(
        (job) => typeof job.id === "string" && typeof job.cron === "string",
    );
    if (jobs.length === 0) return theme.fg("dim", "no scheduled jobs");

    const durableCount = jobs.filter((job) => job.durable === true).length;
    const lines = [
        theme.fg("toolOutput", `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}`) +
            theme.fg(
                "muted",
                ` · ${durableCount} durable · ${jobs.length - durableCount} session`,
            ),
    ];
    // Fixed columns total 51 cells; quotes add 2. Keep the whole row within
    // the HTML export's fixed 100-column budget in either mode.
    const promptWidth = options.expanded ? 46 : 43;
    if (options.expanded) {
        for (const job of jobs) {
            lines.push(formatListRow(job, theme, promptWidth));
            lines.push(formatListDetailLine(job, theme));
        }
    } else {
        const shown = jobs.slice(0, 5);
        for (const job of shown) lines.push(formatListRow(job, theme, promptWidth));
        if (jobs.length > shown.length) {
            lines.push(
                theme.fg("muted", `… ${jobs.length - shown.length} more jobs · `) +
                    expandHint(),
            );
        }
    }
    return lines.join("\n");
}

export const loopCreateRenderers = {
    renderCall(args: RenderArgs, theme: Theme, context: RenderChecks) {
        const component = reuseText(context.lastComponent);
        component.setText(formatCreateCall(asArgs(args), theme, context.argsComplete));
        return component;
    },
    renderResult(
        result: RenderResult,
        options: { expanded: boolean; isPartial: boolean },
        theme: Theme,
        context: RenderChecks,
    ) {
        const component = reuseText(context.lastComponent);
        component.setText(
            formatCreateResult(
                context.args ?? {},
                asCreateDetails(result.details),
                result,
                options,
                theme,
                context.isError,
            ),
        );
        return component;
    },
};

export const loopDeleteRenderers = {
    renderCall(args: RenderArgs, theme: Theme, context: RenderChecks) {
        const component = reuseText(context.lastComponent);
        component.setText(formatDeleteCall(asArgs(args), theme, context.argsComplete));
        return component;
    },
    renderResult(
        result: RenderResult,
        options: { expanded: boolean; isPartial: boolean },
        theme: Theme,
        context: RenderChecks,
    ) {
        const component = reuseText(context.lastComponent);
        component.setText(
            formatDeleteResult(asDeleteDetails(result.details), result, options, theme, context.isError),
        );
        return component;
    },
};

export const loopListRenderers = {
    renderCall(_args: RenderArgs, theme: Theme, context: RenderChecks) {
        const component = reuseText(context.lastComponent);
        const title = theme.fg("toolTitle", theme.bold("loop_list "));
        component.setText(context.argsComplete ? title : title + theme.fg("dim", "…"));
        return component;
    },
    renderResult(
        result: RenderResult,
        options: { expanded: boolean; isPartial: boolean },
        theme: Theme,
        context: RenderChecks,
    ) {
        const component = reuseText(context.lastComponent);
        component.setText(
            formatListResult(asListDetails(result.details), result, options, theme, context.isError),
        );
        return component;
    },
};
