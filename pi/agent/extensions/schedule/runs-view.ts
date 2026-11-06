/**
 * Presentation of a task's run history for the `/schedule` picker.
 *
 * pi-free and side-effect free on purpose: `index.ts` (the only file allowed to
 * import pi packages) cannot be imported by tests, so the label logic and the
 * label→run mapping live here where `node --test` can reach it.
 */

import { isActive, type ActiveRun } from "./run.ts";

/** How much of a run's `error` string survives in a one-line label. */
const ERROR_LABEL_WIDTH = 48;

export function formatDuration(ms: number): string {
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

export function relativeTime(iso: string | undefined): string {
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
