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
 * - `/schedule` is a three-level navigator: tasks (this project's by default,
 *   every task with `--all`) → runs of one task → what to do with that run
 *   (preview its transcript, or put its result / session into the editor).
 *   Esc walks one level back, so several runs can be inspected in one visit.
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
import {
    effectiveState,
    isActive,
    latestRun,
    listRuns,
    readLatestAssistant,
    type ActiveRun,
} from "./run.ts";
import {
    RUN_ACTION_LABELS,
    buildRows,
    elapsedSince,
    elidePath,
    isSettledState,
    matchesScope,
    resultPromptText,
    runActions,
    runOptions,
    sessionPromptText,
    taskRowLines,
} from "./runs-view.ts";
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
            "List scheduled tasks, pick a run of one, and preview it or add its result/session to the prompt",
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

    // Esc at the task list is the only way out of this loop: every deeper Esc
    // comes back here, so one invocation can inspect several tasks. The menu is
    // rebuilt on every pass rather than once — it stays on screen while the user
    // drills into runs, and `last`, `missed` and `next` must not freeze at the
    // moment the command started.
    while (true) {
        const menu = buildTaskMenu(scope.all);
        if (!menu) {
            ctx.ui.notify(
                "No scheduled tasks. Add one with `schedule add …` from a shell.",
                "info",
            );
            return;
        }

        const choice = await ctx.ui.select(menu.title, menu.labels);
        if (!choice) return;

        // A corrupt file renders a row but has no definition behind it; a task
        // removed while the menu was open lands in the same branch. Exiting is
        // the honest end here: the fix is a CLI command, not another menu.
        const taskId = menu.idByLabel.get(choice);
        const task = taskId ? readTask(taskId) : undefined;
        if (!task) {
            ctx.ui.notify(
                "This task file is corrupt. Re-create it with `schedule add`.",
                "error",
            );
            return;
        }

        // Only a written editor ends the command; every other outcome means
        // "there is still a list above this", so the task menu comes back.
        if ((await runTaskFlow(ctx, task)) === "done") return;
    }
}

/** One frame of the task list: what to show, and what selects each row. */
type TaskMenu = {
    title: string;
    labels: string[];
    idByLabel: Map<string, string>;
};

/**
 * Build the task list: the rows `schedule list` prints, narrowed to this project
 * unless `all` is set.
 *
 * Rebuilt on every pass of the picker loop, which can stay open for as long as
 * the user keeps drilling into runs. `undefined` means there is nothing left to
 * select — at startup, or after the last task was removed.
 */
function buildTaskMenu(all: boolean): TaskMenu | undefined {
    // Same derivation `schedule list` prints, so the two surfaces cannot
    // disagree about schedule, last run or next fire.
    const rows = buildRows();
    if (rows.length === 0) return undefined;

    // `/schedule` is a view of the current project by default: the tasks defined
    // for exactly this directory. `matchesScope` canonicalizes both sides, so a
    // task added through a symlinked path still matches the physical one. The
    // row carries the task's cwd, so the scope test needs neither a second pass
    // over the task files nor a shortId→cwd map that could drift from the ids.
    const cwd = process.cwd();
    const scopeCwd = elidePath(cwd, 40);

    let visible = rows;
    let title = "Scheduled tasks";
    if (!all) {
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
    // share name, cron and state, and a joined label would collide here. The map
    // is built from the same frame as the labels it keys.
    const labels = taskRowLines(visible);
    const idByLabel = new Map<string, string>();
    labels.forEach((label, index) => idByLabel.set(label, visible[index].id));

    return { title, labels, idByLabel };
}

/** How the run-level loop ends: back to the task list, or done with the command. */
type FlowEnd = "back" | "done";

/**
 * Levels two and three: the run list and the action menu, looped.
 *
 * `back` is every "the level above still has something to show" exit — Esc at
 * the run list, a task without runs, a run whose transcript is gone. `done`
 * means the editor was written: the user is about to type, so there is nothing
 * left to select.
 */
async function runTaskFlow(
    ctx: ExtensionCommandContext,
    task: Task,
): Promise<FlowEnd> {
    while (true) {
        const run = await pickRun(ctx, task);
        // Undefined covers Esc and "no runs yet" alike; both belong to the task
        // list, which is where the other tasks are.
        if (!run) return "back";

        const sessionFile = run.metadata.sessionFile;
        if (!sessionFile || !existsSync(sessionFile)) {
            // The only surface for this branch: nothing else describes the run.
            // Stay in the run list — the task's other runs are still readable.
            ctx.ui.notify(
                `${describeRun(task, run)}\nNo session transcript (the run never started, or its session file was removed).`,
                "info",
            );
            continue;
        }

        // Read the answer once, for both the gate and the pasted text. Settled
        // states only: a live run's transcript can be megabytes and cannot hold
        // a final answer yet (a pre-created `session.jsonl` proves nothing).
        const resultText = isSettledState(run.effective)
            ? readLatestAssistant(sessionFile)
            : undefined;
        // `hasSession: true` is the branch above asserted: the transcript file
        // exists, which is all preview and the session mention need, so the menu
        // always has at least those two entries.
        const actions = runActions(run.effective, {
            hasSession: true,
            hasResult: Boolean(resultText),
        });

        // Same words as the preview title: stamp and state are what distinguish
        // one run of a task from the others.
        const title = `${task.name} · ${run.ts} · ${run.effective}`;
        const choice = await ctx.ui.select(
            title,
            actions.map((action) => RUN_ACTION_LABELS[action]),
        );
        // Esc at the action menu walks one level up, and `pickRun` lists the
        // runs again on the way — a run may have finished meanwhile.
        if (!choice) continue;

        const action = actions.find(
            (candidate) => RUN_ACTION_LABELS[candidate] === choice,
        );
        if (!action) continue;

        switch (action) {
            case "preview":
                // No metadata toast here: the menu title already carries task,
                // stamp and state, and the overlay title repeats the rest.
                await previewSessionFile(ctx, title, sessionFile);
                // Overlay closed → back to the run list, fresh.
                continue;
            case "result":
                // runActions only offers this for a settled run whose last
                // assistant text is non-empty; the guard is that boundary
                // asserted, not a second decision.
                if (!resultText) continue;
                writeEditor(ctx, resultPromptText(task.name, run.ts, resultText));
                ctx.ui.notify(
                    `Added result of ${task.name} run ${run.ts} to prompt`,
                    "info",
                );
                return "done";
            case "session":
                writeEditor(ctx, sessionPromptText(sessionFile));
                ctx.ui.notify(
                    `Added session of ${task.name} run ${run.ts} to prompt`,
                    "info",
                );
                return "done";
            default: {
                // Compile-time proof that every action id has a branch: adding
                // one to `RunAction` without handling it fails the type check
                // here instead of silently showing an inert menu entry.
                const _exhaustive: never = action;
                continue;
            }
        }
    }
}

/**
 * Append text to the editor, `worktree-task.ts`'s `addSessionToPrompt` shape:
 * one space separates it from whatever is already typed, never a leading one,
 * and the user's draft is preserved around it.
 */
function writeEditor(ctx: ExtensionCommandContext, text: string): void {
    const current = ctx.ui.getEditorText();
    const separator = current && !current.endsWith(" ") ? " " : "";
    ctx.ui.setEditorText(`${current}${separator}${text}`);
}

/**
 * Second level of `/schedule`: choose which run of the task to inspect.
 *
 * Always shown, even for a task with exactly one run: the action menu behind it
 * is the reason to drill in, and skipping the level would make "add this run's
 * result without previewing it first" impossible. `undefined` means the user
 * backed out — or the task has no runs yet — and leads back to the task list.
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

    const options = runOptions(runs);
    const count = runs.length === 1 ? "1 run" : `${runs.length} runs`;
    const choice = await ctx.ui.select(
        `${task.name} · ${count}`,
        options.map((option) => option.label),
    );
    if (!choice) return undefined;
    return options.find((option) => option.label === choice)?.run;
}

function describeRun(task: Task, run: ActiveRun): string {
    const { metadata } = run;
    // effectiveState is derived from live pids; recompute so a run that ended
    // between latestRun() and now is not reported as active. A synthesized
    // `unreadable` record carries `state: "error"` on its face, so the
    // recompute would relabel it and lose the one thing this branch exists to
    // say; keep the already-derived verdict for that state.
    const effective = run.effective === "unreadable" ? run.effective : effectiveState(metadata);
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
