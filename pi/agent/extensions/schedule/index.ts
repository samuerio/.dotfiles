/**
 * schedule extension: cron-scheduled headless pi runs.
 *
 * This is the only file in `extensions/schedule/` that pi auto-loads (pi's
 * loader treats a subdirectory containing `index.ts` as an extension entry).
 * Everything else in the directory is pi-free on purpose: `cli.ts` and
 * `tick.ts` are executed by plain `node` from crontab, where `@earendil-works/*`
 * does not resolve.
 *
 * The extension is a thin observation surface only:
 * - `/schedule` lists tasks, then their runs, and previews the chosen run's
 *   session transcript.
 * - a widget shows runs that are currently active.
 * Task management stays in the CLI (`schedule add/remove/enable/disable/run/logs`).
 */

import { existsSync } from "node:fs";

import {
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Theme, type TUI } from "@earendil-works/pi-tui";

import { previewSessionFile } from "../lib/session-preview.ts";
import { cronToHuman, nextCron } from "./cron.ts";
import { effectiveState, isActive, latestRun, listRuns, type ActiveRun } from "./run.ts";
import { describeRunState, elapsedSince, runOptions } from "./runs-view.ts";
import { errorMessage, listTasks, readWatermark, type Task } from "./store.ts";

const COMMAND_NAME = "schedule";
const WIDGET_KEY = "schedule-running";
const WIDGET_INTERVAL_MS = 1_000;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function humanCron(expr: string): string {
    try {
        return cronToHuman(expr);
    } catch {
        return expr;
    }
}

function nextFireText(task: Task): string {
    const watermark = readWatermark(task.id);
    // Same one meaning as the CLI's NEXT column: `—` is a consumed one-shot.
    if (task.once && watermark.accountedThrough !== null) return "—";
    const base = watermark.accountedThrough
        ? new Date(watermark.accountedThrough)
        : new Date(task.createdAt);
    try {
        return nextCron(task.cron, base).toLocaleString();
    } catch (error) {
        return `unavailable (${errorMessage(error)})`;
    }
}

function widgetLines(): string[] {
    const lines: string[] = [];
    for (const entry of listTasks()) {
        if (!entry.task) continue;
        const run = latestRun(entry.id);
        if (!run || !isActive(run.effective)) continue;
        const mark = run.effective === "orphan" ? "orphan" : run.effective;
        lines.push(
            `schedule: ${entry.task.name} [${run.metadata.trigger}] ${mark} ${elapsedSince(run.metadata.startedAt)}`,
        );
    }
    return lines;
}

function buildWidget(lines: string[]) {
    return (_tui: TUI, _theme: Theme) => {
        const container = new Container();
        for (const line of lines) {
            container.addChild(new Text(line, 1, 0));
        }
        return container;
    };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function scheduleExtension(pi: ExtensionAPI): void {
    // Child guard: runs dispatch `pi -p` with PI_SCHEDULE_RUN_DIR set. A
    // headless child has no TUI and no use for a command or a polling widget.
    if (process.env.PI_SCHEDULE_RUN_DIR) {
        return;
    }

    let liveCtx: ExtensionContext | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let published = "";

    const stopTimer = (): void => {
        if (timer === undefined) return;
        clearInterval(timer);
        timer = undefined;
    };

    const publish = (): void => {
        const ctx = liveCtx;
        if (!ctx || !ctx.hasUI) return;

        const lines = widgetLines();
        if (lines.length === 0) {
            stopTimer();
            if (published !== "") {
                published = "";
                ctx.ui.setWidget(WIDGET_KEY, undefined);
            }
            return;
        }

        const signature = lines.join("\n");
        if (signature !== published) {
            published = signature;
            ctx.ui.setWidget(WIDGET_KEY, buildWidget(lines), {
                placement: "aboveEditor",
            });
        }
        if (timer === undefined) {
            timer = setInterval(publish, WIDGET_INTERVAL_MS);
            timer.unref();
        }
    };

    pi.on("session_start", (_event, ctx) => {
        liveCtx = ctx;
        publish();
    });

    pi.on("turn_end", () => {
        publish();
    });

    pi.on("session_shutdown", (_event, ctx) => {
        stopTimer();
        published = "";
        liveCtx = undefined;
        if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
    });

    pi.registerCommand(COMMAND_NAME, {
        description:
            "List scheduled tasks, pick a run of one, and preview its session transcript",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI) {
                throw new Error(`/${COMMAND_NAME} requires TUI or RPC mode.`);
            }
            await runSchedulePicker(ctx);
        },
    });
}

async function runSchedulePicker(ctx: ExtensionCommandContext): Promise<void> {
    const entries = listTasks();
    if (entries.length === 0) {
        ctx.ui.notify(
            "No scheduled tasks. Add one with `schedule add …` from a shell.",
            "info",
        );
        return;
    }

    // Display strings carry everything the user needs to choose; the map keeps
    // us from parsing them back (same pattern as worktree-task).
    const labelToTask = new Map<string, Task | undefined>();
    for (const entry of entries) {
        const task = entry.task;
        if (!task) {
            labelToTask.set(`${entry.id} (corrupt task file)`, undefined);
            continue;
        }
        const latest = latestRun(entry.id);
        const label = [
            task.name,
            task.enabled ? humanCron(task.cron) : `${humanCron(task.cron)} (disabled)`,
            latest ? describeRunState(latest) : "no runs yet",
            `next ${nextFireText(task)}`,
        ].join(" · ");
        labelToTask.set(label, task);
    }

    const choice = await ctx.ui.select(
        "Scheduled tasks",
        Array.from(labelToTask.keys()),
    );
    if (!choice) return;

    const task = labelToTask.get(choice);
    if (!task) {
        ctx.ui.notify(
            "This task file is corrupt. Re-create it with `schedule add`.",
            "error",
        );
        return;
    }

    const run = await pickRun(ctx, task);
    if (!run) return;

    const summary = describeRun(task, run);
    const sessionFile = run.metadata.sessionFile;
    if (!sessionFile || !existsSync(sessionFile)) {
        ctx.ui.notify(
            `${summary}\nNo session transcript (the run never started, or its session file was removed).`,
            "info",
        );
        return;
    }

    ctx.ui.notify(summary, "info");
    await previewSessionFile(
        ctx,
        `${task.name} · ${run.ts} · ${run.effective}`,
        sessionFile,
    );
}

/**
 * Second level of `/schedule`: choose which run of the task to inspect.
 *
 * A single run is opened directly — a one-item menu would just be an extra
 * keystroke. `undefined` means the user backed out.
 */
async function pickRun(
    ctx: ExtensionCommandContext,
    task: Task,
): Promise<ActiveRun | undefined> {
    const runs = listRuns(task.id);
    if (runs.length === 0) {
        ctx.ui.notify(`Task "${task.name}" has no runs yet.`, "info");
        return undefined;
    }
    if (runs.length === 1) return runs[0];

    const options = runOptions(runs);
    const choice = await ctx.ui.select(
        `${task.name} · ${runs.length} runs`,
        options.map((option) => option.label),
    );
    if (!choice) return undefined;
    return options.find((option) => option.label === choice)?.run;
}

function describeRun(task: Task, run: ActiveRun): string {
    const { metadata } = run;
    // effectiveState is derived from live pids; recompute so a run that ended
    // between latestRun() and now is not reported as active.
    const effective = effectiveState(metadata);
    const lines = [
        `${task.name} (${task.id})`,
        `cron: ${task.cron} · ${humanCron(task.cron)}${task.once ? " · once" : ""}`,
        `cwd: ${metadata.cwd}`,
        `run: ${run.ts} · ${effective} · trigger ${metadata.trigger}`,
        `started: ${metadata.startedAt}`,
        `finished: ${metadata.finishedAt ?? "-"}`,
        `exit: ${metadata.exitCode ?? "-"} · signal: ${metadata.signal ?? "-"}`,
    ];
    if (metadata.error) lines.push(`error: ${metadata.error}`);
    if (!task.enabled) lines.push("state: disabled");
    return lines.join("\n");
}
