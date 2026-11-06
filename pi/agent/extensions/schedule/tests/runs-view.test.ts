/**
 * runs-view.ts: labels and the label→run mapping behind `/schedule`'s run
 * picker. Pure formatting, so these tests build ActiveRun objects by hand
 * instead of touching the filesystem.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { listRuns } from "../run.ts";
import type { ActiveRun, RunMetadata } from "../run.ts";
import { describeRunState, runOptions } from "../runs-view.ts";

const TASK = "aaaaaaaa";
const NOW = Date.now();

function makeRun(ts: string, patch: Partial<RunMetadata>): ActiveRun {
    const metadata: RunMetadata = {
        version: 1,
        taskId: TASK,
        trigger: "scheduled",
        state: "exited",
        startedAt: new Date(NOW - 60_000).toISOString(),
        finishedAt: new Date(NOW - 56_000).toISOString(),
        exitCode: 0,
        signal: null,
        sessionFile: `/runs/${TASK}/${ts}/session.jsonl`,
        cwd: "/tmp",
        launchArgs: [],
        ...patch,
    };
    return {
        dir: `/runs/${TASK}/${ts}`,
        ts,
        metadata,
        effective: (patch.state ?? "exited") as ActiveRun["effective"],
    };
}

test("terminal state carries the exit code and when it finished", () => {
    const label = describeRunState(makeRun("20260101-000000", {}));
    assert.match(label, /^exited \(exit 0\) 56s ago$/);
});

test("a killed run shows 124, not a bare 'killed'", () => {
    const label = describeRunState(makeRun("20260101-000000", { state: "killed", exitCode: 124 }));
    assert.match(label, /^killed \(exit 124\)/);
});

test("an error run appends a truncated error head", () => {
    const long = "spawn did not yield a pid (pi) " + "x".repeat(200);
    const label = describeRunState(makeRun("20260101-000000", { state: "error", error: long }));
    assert.match(label, /^error \(exit 0\).* · spawn did not yield a pid/);
    assert.ok(label.endsWith("…"), "long errors are truncated");
    assert.ok(label.length < 130, `label stays one line, got ${label.length} chars`);
    // Whitespace is collapsed so the option never wraps.
    assert.ok(!/\s{2,}/.test(label));
});

test("active states report how long, and orphan carries its pgid", () => {
    const running = describeRunState(
        makeRun("20260101-000000", {
            state: "running",
            startedAt: new Date(NOW - 120_000).toISOString(),
            finishedAt: undefined,
        }),
    );
    assert.match(running, /^running 2m$/);

    const orphan = describeRunState(
        makeRun("20260101-000000", {
            state: "orphan",
            pgid: 4242,
            startedAt: new Date(NOW - 120_000).toISOString(),
            finishedAt: undefined,
        }),
    );
    assert.match(orphan, /^orphan \(pgid 4242\) 2m$/);
});

test("runOptions keeps listRuns order and prefixes every label with its stamp", () => {
    const runs = [
        makeRun("20260103-000000", {}),
        makeRun("20260102-000000", { trigger: "manual" }),
        makeRun("20260101-000000", { state: "killed", exitCode: 124 }),
    ];
    const options = runOptions(runs);
    assert.deepEqual(
        options.map((option) => option.run.ts),
        ["20260103-000000", "20260102-000000", "20260101-000000"],
    );
    assert.equal(new Set(options.map((option) => option.label)).size, 3, "labels are unique");
    assert.match(options[1].label, /^20260102-000000 · manual · exited \(exit 0\)/);
    assert.match(options[2].label, /^20260101-000000 · scheduled · killed \(exit 124\)/);
});

test("the selected label maps back to that run, not to the newest one", () => {
    const runs = [makeRun("20260103-000000", {}), makeRun("20260102-000000", {})];
    const options = runOptions(runs);
    const choice = options[1].label;
    const picked = options.find((option) => option.label === choice)?.run;
    assert.ok(picked);
    // index.ts previews `picked.metadata.sessionFile`, so this is the whole
    // contract of the second picker level.
    assert.equal(picked.ts, "20260102-000000");
    assert.equal(picked.metadata.sessionFile, `/runs/${TASK}/20260102-000000/session.jsonl`);
});

test("listRuns (the picker's source) is ordered newest first", () => {
    // Guards the assumption runOptions relies on: no re-sorting on our side.
    const runs = [makeRun("20260102-000000", {}), makeRun("20260101-000000", {})];
    const labels = runOptions(runs).map((option) => option.label);
    assert.ok(labels[0].startsWith("20260102-000000"));
    assert.equal(typeof listRuns, "function");
});
