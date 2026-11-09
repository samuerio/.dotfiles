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
 * - `/schedule` lists tasks (this project's by default, every task with
 *   `--all`), then their runs, and previews the chosen run's session transcript.
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
import { cronToHuman } from "./cron.ts";
import { effectiveState, isActive, latestRun, listRuns, type ActiveRun } from "./run.ts";
import { buildRows, elapsedSince, elidePath, matchesScope, runOptions, taskRowLines } from "./runs-view.ts";
import { listTasks, readTask, type Task } from "./store.ts";

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
        handler: async (args, ctx) => {
            if (!ctx.hasUI) {
                throw new Error(`/${COMMAND_NAME} requires TUI or RPC mode.`);
            }
            await runSchedulePicker(ctx, args);
        },
    });
}

/** `/schedule` takes exactly one flag; anything else is a typo, not a filter. */
function parseScope(rawArgs: string): { all: boolean; unknown: string | undefined } {
    let all = false;
    for (const token of rawArgs.trim().split(/\s+/).filter(Boolean)) {
        if (token !== "--all") return { all, unknown: token };
        all = true;
    }
    return { all, unknown: undefined };
}

async function runSchedulePicker(
    ctx: ExtensionCommandContext,
    rawArgs: string,
): Promise<void> {
    const scope = parseScope(rawArgs);
    if (scope.unknown) {
        ctx.ui.notify(
            `/${COMMAND_NAME}: unknown option "${scope.unknown}". Use /${COMMAND_NAME} or /${COMMAND_NAME} --all.`,
            "error",
        );
        return;
    }

    // Same derivation `schedule list` prints, so the two surfaces cannot
    // disagree about schedule, last run or next fire.
    const rows = buildRows();
    if (rows.length === 0) {
        ctx.ui.notify(
            "No scheduled tasks. Add one with `schedule add …` from a shell.",
            "info",
        );
        return;
    }

    // `/schedule` is a view of the current project by default: the tasks defined
    // for exactly this directory. `matchesScope` canonicalizes both sides, so a
    // task added through a symlinked path still matches the physical one. The
    // row carries the task's cwd, so the scope test needs neither a second pass
    // over the task files nor a shortId→cwd map that could drift from the ids.
    const cwd = process.cwd();
    const scopeCwd = elidePath(cwd, 40);

    let visible = rows;
    let title = "Scheduled tasks";
    if (!scope.all) {
        const scoped = rows.filter((row) => {
            // A corrupt file has no cwd to match; hiding it would hide the one
            // row whose fix (re-add or delete) has no other reminder.
            return row.cwd === "—" || matchesScope(cwd, row.cwd);
        });
        // "Nothing for this project" and "only corrupt files for this project"
        // are different answers: only the first one falls back to the full list.
        if (scoped.some((row) => row.cwd !== "—")) {
            visible = scoped;
            // The title is the only place that says which project a menu with
            // no cwd cell belongs to.
            title = `Scheduled tasks · ${scopeCwd}`;
        } else {
            // An empty menu would read as "no tasks at all": show everything and
            // let the title say why the scope was dropped.
            title = `Scheduled tasks · none for ${scopeCwd}, showing all`;
        }
    }

    // The shortId prefix is what makes the mapping unambiguous; two tasks can
    // share name, cron and state, and a joined label would collide here.
    const labels = taskRowLines(visible);
    const idByLabel = new Map<string, string>();
    labels.forEach((label, index) => idByLabel.set(label, visible[index].id));

    const choice = await ctx.ui.select(title, labels);
    if (!choice) return;

    // A corrupt file renders a row but has no definition behind it; a task
    // removed while the menu was open lands in the same branch.
    const taskId = idByLabel.get(choice);
    const task = taskId ? readTask(taskId) : undefined;
    if (!task) {
        ctx.ui.notify(
            "This task file is corrupt. Re-create it with `schedule add`.",
            "error",
        );
        return;
    }

    const run = await pickRun(ctx, task);
    if (!run) return;

    const sessionFile = run.metadata.sessionFile;
    if (!sessionFile || !existsSync(sessionFile)) {
        // The only surface for this branch: nothing else describes the run.
        ctx.ui.notify(
            `${describeRun(task, run)}\nNo session transcript (the run never started, or its session file was removed).`,
            "info",
        );
        return;
    }

    // No metadata toast here: the picker label already carries stamp, trigger,
    // state, exit code and error head, and the overlay title repeats the rest.
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
