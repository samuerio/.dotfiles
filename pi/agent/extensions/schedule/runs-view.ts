/**
 * Presentation for `/schedule`: the task list rows (the same derivation
 * `schedule list` prints), their one-line menu labels, the run labels behind
 * the second picker level, and the action menu (gating plus the editor text)
 * behind the third.
 *
 * pi-free and side-effect free on purpose: `index.ts` (the only file allowed to
 * import pi packages) cannot be imported by tests, so the derivation, the
 * labels, the action gating and the editor text live here where `node --test`
 * can reach them. One `buildRows()` for both surfaces is what keeps the CLI
 * table and the TUI menu from drifting.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";

import { cronToHuman, nextCron } from "./cron.ts";
import {
    isActive,
    listRuns,
    type ActiveRun,
    type EffectiveState,
    type RunMetadata,
} from "./run.ts";
import { slotVerdict } from "./slots.ts";
import { listTasks, nextFireAnchor, readWatermark, type Task } from "./store.ts";

/** How much of a run's `error` string survives in a one-line label. */
const ERROR_LABEL_WIDTH = 48;

function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 1_000) return "0s";
    const seconds = Math.round(ms / 1_000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        const rest = seconds % 60;
        return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 48) {
        const rest = minutes % 60;
        return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
    }
    return `${Math.floor(hours / 24)}d`;
}

/** Time since `iso`, or `?` when it is missing/unparseable. */
export function elapsedSince(iso: string | undefined): string {
    if (!iso) return "?";
    const startedAt = Date.parse(iso);
    if (!Number.isFinite(startedAt)) return "?";
    return formatDuration(Date.now() - startedAt);
}

function relativeTime(iso: string | undefined): string {
    if (!iso) return "never";
    const timestamp = Date.parse(iso);
    if (!Number.isFinite(timestamp)) return "unknown";
    const delta = Date.now() - timestamp;
    const label = formatDuration(Math.abs(delta));
    return delta >= 0 ? `${label} ago` : `in ${label}`;
}

function truncate(text: string, width: number): string {
    const single = text.replace(/\s+/g, " ").trim();
    return single.length <= width ? single : `${single.slice(0, width - 1)}…`;
}

/**
 * One-line effective state, used both by the task list and by the run list.
 *
 * Active runs report how long they have been that way (`running 3m`,
 * `orphan 5m`) because that is the only thing worth acting on; terminal runs
 * report the exit code and when they finished, plus the error head that makes
 * `killed`/`error` distinguishable without opening the transcript.
 */
export function describeRunState(run: ActiveRun): string {
    const { metadata, effective } = run;
    if (isActive(effective)) {
        const mark =
            effective === "orphan" && metadata.pgid ? `orphan (pgid ${metadata.pgid})` : effective;
        return `${mark} ${elapsedSince(metadata.startedAt)}`;
    }
    const exit = metadata.exitCode === null || metadata.exitCode === undefined
        ? "-"
        : String(metadata.exitCode);
    const when = relativeTime(metadata.finishedAt ?? metadata.startedAt);
    const head = `${effective} (exit ${exit}) ${when}`;
    return metadata.error ? `${head} · ${truncate(metadata.error, ERROR_LABEL_WIDTH)}` : head;
}

export interface RunOption {
    label: string;
    run: ActiveRun;
}

/**
 * Labels for the run picker, in the order given (newest first from
 * `listRuns`). The run stamp prefixes every label, which is what keeps them
 * unique: two runs of one task can never share a stamp.
 */
export function runOptions(runs: ActiveRun[]): RunOption[] {
    return runs.map((run) => ({
        label: `${run.ts} · ${run.metadata.trigger} · ${describeRunState(run)}`,
        run,
    }));
}

// ---------------------------------------------------------------------------
// run actions (third picker level)
// ---------------------------------------------------------------------------

/**
 * What the action menu can do with one run. Ids rather than labels: `index.ts`
 * maps them through `RUN_ACTION_LABELS` and switches over them, so a new action
 * cannot be offered without a branch that knows what to do with it.
 */
export type RunAction = "preview" | "result" | "session";

/** Menu labels, verbatim the strings `worktree-task.ts` uses for the same actions. */
export const RUN_ACTION_LABELS: Record<RunAction, string> = {
    preview: "Preview",
    result: "Add result to prompt",
    session: "Add session to prompt",
};

/**
 * States in which a run is over and its last assistant message is final.
 *
 * `stale` and `unreadable` count as over: a claim nobody picked up has no live
 * process and never will, and an unreadable metadata.json cannot hide a live
 * process either (occupancy is decided from readable records).
 * `starting`/`running`/`orphan` do not — their `session.jsonl`
 * already exists (the file is created before pi starts), so `existsSync` alone
 * would offer a half-written answer as if it were the result.
 */
const SETTLED_STATES = new Set<string>(["exited", "killed", "error", "stale", "unreadable"]);

export function isSettledState(state: string): boolean {
    return SETTLED_STATES.has(state);
}

/**
 * The actions the action menu offers for one run, in menu order.
 *
 * Gated by facts, exactly like `worktree-task.ts`'s `taskActionItems`: nothing
 * is offered that the run cannot support. Preview and the session mention need
 * only the transcript file; the result additionally needs a settled state with
 * assistant text in it. `hasSession: false` yields no actions at all — the
 * caller has already reported the missing transcript, and a menu with no
 * entries is not an answer.
 */
export function runActions(
    state: string,
    facts: { hasSession: boolean; hasResult: boolean },
): RunAction[] {
    if (!facts.hasSession) return [];
    const actions: RunAction[] = ["preview"];
    if (isSettledState(state) && facts.hasResult) actions.push("result");
    actions.push("session");
    return actions;
}

/**
 * Editor text for "Add result to prompt".
 *
 * The header names the task and the run stamp — a task can have many runs, and
 * `schedule task … run <stamp>` is what makes the pasted answer traceable back
 * to its transcript. The text itself goes in verbatim: no truncation and no
 * `Error:` suffix, because a partial answer reads like a complete one.
 */
export function resultPromptText(taskName: string, ts: string, text: string): string {
    return `schedule task "${taskName}" run ${ts} result:\n\n${text}`;
}

/**
 * Editor text for "Add session to prompt".
 *
 * The `@` is a literal mention convention — it is inlined only for CLI `@file`
 * arguments — so pointing at a 3 MB session transcript costs one line of
 * editor text, not a copy of the file.
 */
export function sessionPromptText(sessionFile: string): string {
    return `read session @${sessionFile}`;
}

// ---------------------------------------------------------------------------
// Column formatting
// ---------------------------------------------------------------------------

/** Rough display width: CJK and full-width forms take two cells. */
export function displayWidth(text: string): number {
    let width = 0;
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        width +=
            (code >= 0x1100 && code <= 0x115f) ||
            (code >= 0x2e80 && code <= 0xa4cf) ||
            (code >= 0xac00 && code <= 0xd7a3) ||
            (code >= 0xf900 && code <= 0xfaff) ||
            (code >= 0xfe30 && code <= 0xfe6f) ||
            (code >= 0xff00 && code <= 0xff60) ||
            (code >= 0xffe0 && code <= 0xffe6)
                ? 2
                : 1;
    }
    return width;
}

export function pad(text: string, width: number): string {
    const fill = width - displayWidth(text);
    return fill > 0 ? text + " ".repeat(fill) : text;
}

/** How much of one path segment survives when even it alone is too wide. */
function tailByWidth(text: string, width: number): string {
    const chars = [...text];
    let kept = "";
    let used = 0;
    // Walk from the right: the end of a segment is the part that still names it.
    for (let index = chars.length - 1; index >= 0; index -= 1) {
        const charWidth = displayWidth(chars[index]);
        if (used + charWidth > width) break;
        kept = chars[index] + kept;
        used += charWidth;
    }
    return kept;
}

/**
 * A task's cwd as a table/menu cell: `~` for the home directory, and the head
 * of a too-long path elided instead of the tail.
 *
 * Later segments are what distinguish one project from another (`…/dotfiles`
 * says more than `/home/zhe/workspa…`), so the cut happens at a segment
 * boundary from the left and `…/` marks that the path continues upwards.
 */
export function elidePath(cwd: string, width = 28): string {
    if (!cwd || cwd === "—") return "—";
    const home = homedir();
    const display =
        home && home !== "/" && (cwd === home || cwd.startsWith(`${home}/`))
            ? `~${cwd.slice(home.length)}`
            : cwd;
    if (displayWidth(display) <= width) return display;
    // Longest fitting tail first, down to the last segment alone. Empty segments
    // are dropped so the ellipsis never ends up as a bare `…/`.
    const segments = display.split("/").filter((segment) => segment.length > 0);
    for (let start = 0; start < segments.length; start += 1) {
        const candidate = `…/${segments.slice(start).join("/")}`;
        if (displayWidth(candidate) <= width) return candidate;
    }
    // Not even the last segment fits: keep its tail under a cell for the ellipsis.
    const last = segments[segments.length - 1] ?? display;
    return `…${tailByWidth(last, width - 1)}`;
}

// ---------------------------------------------------------------------------
// default scope of /schedule
// ---------------------------------------------------------------------------

/**
 * A cwd reduced to the form two paths can be compared in: no trailing slashes
 * (a lone `/` is all that is left of the root) and symlinks resolved.
 *
 * `realpathSync` throws on a path that is gone (deleted task cwd, EACCES on a
 * component, a broken symlink), and a menu is the wrong place to fail: the
 * stripped string is still the best answer available, and it is exactly what
 * the path was written as.
 */
function normalizeCwd(path: string): string {
    const stripped = path.replace(/\/+$/, "") || "/";
    try {
        return realpathSync(stripped);
    } catch {
        return stripped;
    }
}

/**
 * Whether a task belongs to the project a session was started in: the same
 * directory, compared on real paths.
 *
 * Exact match, not "the session sits inside the task's cwd": a task is a job
 * about one directory, and a session started in a subdirectory is looking at
 * that subdirectory (`/schedule --all` is the escape hatch).
 *
 * The realpath step is what makes exact matching usable at all. `addTask`
 * stores `--cwd` verbatim (it only checks that the path exists), so a task
 * added through a symlinked path (`~/dotfiles`) would silently stop matching a
 * session started at the physical path (`~/workspace/.dotfiles`) — and nothing
 * about that mismatch would be visible. Canonicalizing both sides here fixes
 * the comparison without rewriting the stored definition, which has to keep
 * meaning "the path the user typed" (it is what runs are launched in, and
 * `schedule list --json` prints it).
 */
export function matchesScope(sessionCwd: string, taskCwd: string): boolean {
    return normalizeCwd(sessionCwd) === normalizeCwd(taskCwd);
}

// ---------------------------------------------------------------------------
// task list rows (shared with `schedule list`)
// ---------------------------------------------------------------------------

function shortId(id: string): string {
    return id.slice(0, 8);
}

/**
 * Age of `iso` as the `LAST` column words it; `—` means there is nothing.
 *
 * Deliberately not `relativeTime` above: run labels say `never`/`unknown` and
 * round through `formatDuration`, while the table has always printed a bare
 * `<n>s|m|h|d ago`. `schedule list` output is a contract, so its wording stays.
 */
function agoText(iso: string | undefined): string {
    if (!iso) return "—";
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return "—";
    const delta = Date.now() - at;
    const past = delta >= 0;
    const seconds = Math.abs(delta) / 1000;
    const unit =
        seconds < 60
            ? `${Math.round(seconds)}s`
            : seconds < 3600
              ? `${Math.round(seconds / 60)}m`
              : seconds < 86400
                ? `${Math.round(seconds / 3600)}h`
                : `${Math.round(seconds / 86400)}d`;
    return past ? `${unit} ago` : `in ${unit}`;
}

function formatLocal(date: Date): string {
    const pad2 = (value: number): string => String(value).padStart(2, "0");
    return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function describeState(
    effective: EffectiveState,
    metadata: RunMetadata | undefined,
): string {
    if (!metadata) return effective;
    if (effective === "orphan") return `orphan (pgid ${metadata.pgid ?? "?"})`;
    if (effective === "exited") {
        if (metadata.signal) return `exited (${metadata.signal})`;
        if (typeof metadata.exitCode === "number") return `exited (code ${metadata.exitCode})`;
    }
    return effective;
}

export type NextFire =
    | { kind: "at"; date: Date }
    | { kind: "consumed" }
    | { kind: "unschedulable" };

export function nextFireOf(task: Task): NextFire {
    try {
        const watermark = readWatermark(task.id);
        if (task.once && watermark.accountedThrough !== null) return { kind: "consumed" };
        const anchor = nextFireAnchor(watermark.accountedThrough);
        if (!anchor) return { kind: "unschedulable" };
        return { kind: "at", date: nextCron(task.cron, anchor) };
    } catch {
        return { kind: "unschedulable" };
    }
}

/** `NEXT` column: `—` means only one thing — a consumed one-shot task. */
export function nextText(next: NextFire): string {
    switch (next.kind) {
        case "at":
            return formatLocal(next.date);
        case "consumed":
            return "—";
        case "unschedulable":
            return "invalid";
    }
}

export interface ListRow {
    id: string;
    name: string;
    cron: string;
    schedule: string;
    enabled: boolean;
    once: boolean;
    next: string;
    last: string;
    state: string;
    missed: boolean;
    /**
     * Absolute cwd of the task, or `—` for a corrupt file (there is no
     * definition left to read it from). `/schedule` scopes by it, so it has to
     * travel with the row instead of being re-derived from the task files.
     */
    cwd: string;
}

/**
 * States in which the newest run makes `missed` the wrong verdict: still in
 * flight (the catch-up window expires while the task keeps working), a claim
 * nobody picked up, or a record too broken to read. Reporting any of them as
 * `missed` would blame the schedule for a fault that is not its fault.
 */
function suppressesMissed(state: EffectiveState): boolean {
    return isActive(state) || state === "stale" || state === "unreadable";
}

/**
 * First slot the task owed but never ran, or undefined when it is up to date
 * (or currently busy).
 *
 * The read side deliberately does not look at the watermark: a missed tick
 * pushes the watermark to `now`, destroying the evidence within one cycle. The
 * newest run's `startedAt` — and `createdAt` before the first run — is the
 * stable proof of what actually happened.
 */
export function missedSince(
    task: Task,
    newest: ActiveRun | undefined,
    now = new Date(),
): Date | undefined {
    if (!task.enabled) return undefined;
    if (newest && suppressesMissed(newest.effective)) return undefined;
    const base = newest ? Date.parse(newest.metadata.startedAt) : Date.parse(task.createdAt);
    if (!Number.isFinite(base)) return undefined;
    try {
        const verdict = slotVerdict(task.cron, new Date(base), now);
        return verdict.kind === "missed" ? verdict.first : undefined;
    } catch {
        return undefined;
    }
}

/** `LAST` column: a missed slot overrides the newest run, and `—` means none. */
export function lastText(missed: Date | undefined, newest: ActiveRun | undefined): string {
    if (missed) return `missed · ${agoText(missed.toISOString())}`;
    if (!newest) return "—";
    return `${describeState(newest.effective, newest.metadata)} · ${agoText(newest.metadata.startedAt)}`;
}

export function buildRows(now = new Date()): ListRow[] {
    const rows: ListRow[] = [];
    for (const entry of listTasks()) {
        const { task, id } = entry;
        if (!task) {
            rows.push({
                id: shortId(id),
                name: "(unreadable)",
                cron: "—",
                schedule: "—",
                enabled: false,
                once: false,
                next: "—",
                last: "—",
                state: "corrupt",
                missed: false,
                cwd: "—",
            });
            continue;
        }
        const runs = listRuns(id);
        const newest = runs[0];
        const missed = missedSince(task, newest, now);
        const next = nextFireOf(task);
        rows.push({
            id: shortId(id),
            name: task.name,
            cron: task.cron,
            schedule: cronToHuman(task.cron),
            enabled: task.enabled,
            once: Boolean(task.once),
            next: nextText(next),
            last: lastText(missed, newest),
            state: newest ? describeState(newest.effective, newest.metadata) : "idle",
            missed: missed !== undefined,
            cwd: task.cwd,
        });
    }
    return rows;
}

/** Longest task name the menu shows before it is elided. */
const TASK_NAME_WIDTH = 28;

function truncateWidth(text: string, width: number): string {
    if (displayWidth(text) <= width) return text;
    let kept = "";
    let used = 0;
    // One cell is reserved for the ellipsis so the result fits `width` exactly.
    for (const char of text) {
        const charWidth = displayWidth(char);
        if (used + charWidth > width - 1) break;
        kept += char;
        used += charWidth;
    }
    return `${kept}…`;
}

/** How wide the cwd cell of the multi-cwd menu is allowed to get. */
const MENU_CWD_WIDTH = 28;

/**
 * One menu line per row, in `rows` order — `ctx.ui.select` takes a plain string
 * per option and has no column API, so the columns are padded here instead.
 *
 * Every cell comes from the row the CLI prints, so the menu cannot word a task
 * differently from `schedule list`. ENABLED has no column of its own: a
 * disabled task carries `(disabled)` on its schedule cell, the same way `· once`
 * rides along in SCHEDULE.
 *
 * When the visible rows span more than one cwd, the cwd cell replaces `next`: a
 * menu long enough to mix projects has no room for both, and when you are
 * browsing across projects "which project" beats "next fire" — `next` is still
 * there in `schedule list` and again after drilling into a task. The condition
 * is derived from the rows, so no caller has to declare whether it scoped them.
 */
export function taskRowLines(rows: ListRow[]): string[] {
    // `—` (corrupt) counts as a value of its own: a corrupt file next to a real
    // task is still "more than one place", and the cwd cell is what says so.
    const multiCwd = new Set(rows.map((row) => row.cwd)).size > 1;
    const cells = rows.map((row) => {
        // A corrupt row has no definition to speak of: `—` is unreadable, not
        // disabled, and marking it as either would misread as a real setting.
        const marks =
            row.state === "corrupt"
                ? ""
                : `${row.enabled ? "" : " (disabled)"}${row.once ? " · once" : ""}`;
        return {
            id: row.id,
            name: truncateWidth(row.name, TASK_NAME_WIDTH),
            schedule: `${row.schedule}${marks}`,
            last: row.last,
            tail: multiCwd ? elidePath(row.cwd, MENU_CWD_WIDTH) : `next ${row.next}`,
        };
    });
    const widest = (pick: (cell: (typeof cells)[number]) => string): number =>
        Math.max(0, ...cells.map((cell) => displayWidth(pick(cell))));
    const [idWidth, nameWidth, scheduleWidth, lastWidth] = [
        widest((cell) => cell.id),
        widest((cell) => cell.name),
        widest((cell) => cell.schedule),
        widest((cell) => cell.last),
    ];
    // The tail cell (next or cwd) is last, so it needs no padding; trimEnd drops
    // its trailing spaces when the batch is empty.
    return cells.map((cell) =>
        [
            pad(cell.id, idWidth),
            pad(cell.name, nameWidth),
            pad(cell.schedule, scheduleWidth),
            pad(cell.last, lastWidth),
            cell.tail,
        ]
            .join("  ")
            .trimEnd(),
    );
}
