// cli.ts read side: the `missed` verdict and the rendered `LAST` / `NEXT`
// columns. `buildRows(now)` takes the clock so these assertions do not depend on
// the wall clock; every test redirects PI_CODING_AGENT_DIR into a scratch dir.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import { buildRows, missedSince } from "../cli.ts";
import { claimRun, writeMetadata } from "../run.ts";
import type { RunMetadata } from "../run.ts";
import { addTask, readWatermark, setTaskEnabled, tasksDir, writeWatermark } from "../store.ts";
import type { Task } from "../store.ts";
import { runTick } from "../tick.ts";

let scratch: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    scratch = mkdtempSync(join(tmpdir(), "schedule-cli-"));
    process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
    mkdirSync(tasksDir(), { recursive: true });
});

afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(scratch, { recursive: true, force: true });
});

function at(day: number, hour: number, minute: number, second = 0): Date {
    return new Date(2026, 10, day, hour, minute, second);
}

function makeTask(options: {
    cron?: string;
    once?: boolean;
    createdAt: Date;
    enabled?: boolean;
}): Task {
    const task = addTask(
        {
            name: "task",
            cron: options.cron ?? "0 * * * *",
            cwd: tmpdir(),
            prompt: "hello",
            once: options.once ?? false,
        },
        { now: () => options.createdAt },
    );
    if (options.enabled === false) setTaskEnabled(task.id, false);
    return task;
}

function writeRun(taskId: string, stamp: string, patch: Partial<RunMetadata> = {}): void {
    const dir = claimRun(taskId, stamp, { cwd: tmpdir() });
    writeMetadata(dir, {
        version: 1,
        taskId,
        trigger: "scheduled",
        state: "exited",
        startedAt: new Date().toISOString(),
        sessionFile: join(dir, "session.jsonl"),
        cwd: tmpdir(),
        launchArgs: [],
        exitCode: 0,
        ...patch,
    });
}

function row(taskId: string, now: Date) {
    const found = buildRows(now).find((entry) => entry.id === taskId.slice(0, 8));
    assert.ok(found, `row for ${taskId}`);
    return found;
}

describe("missedSince", () => {
    test("a newest run older than the window yields the first owed slot", () => {
        const task = makeTask({ createdAt: at(6, 10, 0) });
        writeRun(task.id, "20261106-110000", { startedAt: at(6, 11, 0).toISOString() });
        const runs = buildRows(at(6, 12, 20));
        assert.equal(runs.length, 1);
        assert.equal(runs[0].missed, true);
        assert.match(runs[0].last, /^missed · /);
        // The run itself is still reported in `state`; missed only overrides LAST.
        assert.equal(runs[0].state, "exited (code 0)");

        // Without a run the base is createdAt, so the first owed slot is 11:00.
        const first = missedSince(task, undefined, at(6, 12, 20));
        assert.equal(first?.getTime(), at(6, 11, 0).getTime());
    });

    test("a run in flight for more than the window is not missed", () => {
        const task = makeTask({ createdAt: at(6, 10, 0) });
        writeRun(task.id, "20261106-110000", {
            startedAt: at(6, 11, 0).toISOString(),
            state: "running",
            pid: process.pid,
            pgid: null,
            helperPid: process.pid,
        });
        const listRow = row(task.id, at(6, 12, 20));
        assert.equal(listRow.missed, false);
        assert.match(listRow.last, /^running · /);
    });

    test("a disabled task never reports missed", () => {
        const task = makeTask({ createdAt: at(6, 10, 0), enabled: false });
        const listRow = row(task.id, at(6, 12, 20));
        assert.equal(listRow.missed, false);
        assert.equal(listRow.last, "—");
        assert.equal(listRow.enabled, false);
    });

    test("a newest run that failed but is still new shows the failure, not missed", () => {
        const task = makeTask({ createdAt: at(6, 10, 0) });
        writeRun(task.id, "20261106-121500", {
            startedAt: at(6, 12, 15).toISOString(),
            state: "exited",
            exitCode: 1,
        });
        const listRow = row(task.id, at(6, 12, 20));
        assert.equal(listRow.missed, false);
        assert.match(listRow.last, /^exited \(code 1\) · /);
    });

    test("a task that never ran falls back to createdAt", () => {
        const task = makeTask({ createdAt: at(6, 11, 0) });
        const listRow = row(task.id, at(6, 12, 20));
        assert.equal(listRow.missed, true);
        assert.match(listRow.last, /^missed · /);
        assert.equal(listRow.state, "idle");
    });

    test("an unschedulable cron or a bad base never throws, and is not missed", () => {
        const task = makeTask({ cron: "0 0 30 2 *", createdAt: at(6, 11, 0) });
        assert.equal(missedSince(task, undefined, at(6, 12, 20)), undefined);
        assert.equal(missedSince({ ...task, createdAt: "not-a-date" }, undefined, at(6, 12, 20)), undefined);
    });
});

describe("NEXT", () => {
    test("a consumed one-shot task renders `—` and keeps showing missed", () => {
        const task = makeTask({ cron: "0 9 * * *", once: true, createdAt: at(6, 8, 0) });
        // The missed tick advanced the watermark to its own `now`.
        writeWatermark(task.id, at(6, 12, 0).toISOString());
        const listRow = row(task.id, at(6, 12, 20));
        assert.equal(listRow.next, "—");
        assert.equal(listRow.once, true);
        // The read side does not trust the watermark: there is still no run.
        assert.equal(listRow.missed, true);
    });

    test("an unschedulable cron renders `invalid`", () => {
        const task = makeTask({ cron: "0 0 30 2 *", createdAt: at(6, 11, 0) });
        const listRow = row(task.id, at(6, 12, 20));
        assert.equal(listRow.next, "invalid");
        assert.equal(listRow.missed, false);
    });
});

describe("read side after a tick", () => {
    test("a tick that classified the task as missed does not hide it from list", () => {
        const task = makeTask({ createdAt: at(6, 11, 0) });
        const result = runTick({
            now: at(6, 12, 20),
            dispatch: () => undefined,
            log: () => undefined,
        });
        assert.equal(result.missed, 1);
        assert.equal(Date.parse(String(readWatermark(task.id).accountedThrough)), at(6, 12, 20).getTime());

        // The watermark jumped to the tick's now; the read side must not care.
        const listRow = row(task.id, at(6, 12, 21));
        assert.equal(listRow.missed, true);
        assert.match(listRow.last, /^missed · /);
    });

    test("a dispatched slot is not missed once the claim exists", () => {
        // Real clock on both sides: the claim's startedAt is the tick's now, and
        // the claim record is what makes `list` stop blaming the schedule.
        const task = makeTask({ cron: "*/5 * * * *", createdAt: new Date(Date.now() - 20 * 60 * 1000) });
        const harness: string[] = [];
        const result = runTick({
            now: new Date(),
            dispatch: (taskId, stamp) => harness.push(`${taskId}:${stamp}`),
            log: () => undefined,
        });
        assert.deepEqual(result.dispatched, [task.id]);
        assert.equal(result.missed, 0);
        assert.equal(harness.length, 1);

        const listRow = row(task.id, new Date(Date.now() + 1000));
        assert.equal(listRow.missed, false);
        assert.match(listRow.last, /^(starting|running|stale) · /);
    });

    test("a stale claim is reported as stale, not as missed", () => {
        const task = makeTask({ cron: "*/5 * * * *", createdAt: at(6, 10, 0) });
        // What a dispatch failure leaves behind: a claim nobody ever picked up,
        // aged past the stale threshold.
        writeRun(task.id, "20261106-110000", {
            startedAt: at(6, 11, 0).toISOString(),
            state: "starting",
            pid: null,
        });
        const listRow = row(task.id, at(6, 12, 20));
        assert.equal(listRow.state, "stale");
        assert.equal(listRow.missed, false);
        assert.match(listRow.last, /^stale · /);
    });
});

describe("corrupt task definitions", () => {
    test("a legacy promptFile task renders as corrupt instead of failing a run", () => {
        // The prompt used to live in a file path; that field is gone, so such a
        // file must be visible as corrupt rather than dispatch-time broken.
        const body = {
            version: 1,
            id: "aaaaaaaa",
            name: "legacy",
            cron: "@daily",
            enabled: true,
            cwd: tmpdir(),
            promptFile: "/tmp/prompt.md",
            once: false,
            createdAt: new Date().toISOString(),
        };
        writeFileSync(join(tasksDir(), "aaaaaaaa.json"), JSON.stringify(body));
        const rows = buildRows();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, "aaaaaaaa");
        assert.equal(rows[0].state, "corrupt");
        assert.equal(rows[0].name, "(unreadable)");
    });
});
