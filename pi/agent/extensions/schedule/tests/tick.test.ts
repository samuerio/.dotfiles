// tick.ts: the scheduler pass and crontab installation.
//
// Every test redirects PI_CODING_AGENT_DIR into a scratch directory and injects
// both the dispatch sink and the log sink, so no real `pi` is spawned and no
// real crontab is touched.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import { activeRun, claimRun, patchMetadata, readMetadata, writeMetadata } from "../run.ts";
import type { RunMetadata } from "../run.ts";
import { addTask, readWatermark, runDir, taskRunsDir, tasksDir, writeWatermark } from "../store.ts";
import {
    CRON_BLOCK_BEGIN,
    CRON_BLOCK_END,
    TICK_SCHEDULE,
    appendTickLog,
    formatTickResult,
    extractCronBlock,
    installCron,
    renderCronBlock,
    runTick,
    stampOf,
    stripCronBlock,
    uninstallCron,
} from "../tick.ts";
import type { CommandRunner } from "../tick.ts";

let scratch: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    scratch = mkdtempSync(join(tmpdir(), "schedule-tick-"));
    process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
    mkdirSync(tasksDir(), { recursive: true });
});

afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(scratch, { recursive: true, force: true });
});

interface TickHarness {
    dispatches: Array<{ taskId: string; stamp: string }>;
    logs: string[];
}

function tickAt(now: Date, harness: TickHarness) {
    return runTick({
        now,
        dispatch: (taskId, stamp) => harness.dispatches.push({ taskId, stamp }),
        log: (line) => harness.logs.push(line),
    });
}

function newHarness(): TickHarness {
    return { dispatches: [], logs: [] };
}

/** Local-time instant (cron fields are local, so tests must build local dates). */
function at(day: number, hour: number, minute: number, second = 0): Date {
    return new Date(2026, 10, day, hour, minute, second);
}

function makeTask(options: { cron?: string; once?: boolean; createdAt?: Date; enabled?: boolean } = {}) {
    const task = addTask(
        {
            name: "task",
            cron: options.cron ?? "* * * * *",
            cwd: tmpdir(),
            prompt: "hello",
            once: options.once ?? false,
        },
        { now: () => options.createdAt ?? new Date() },
    );
    if (options.enabled === false) {
        writeFileSync(
            join(tasksDir(), `${task.id}.json`),
            JSON.stringify({ ...task, enabled: false }, null, 2),
        );
    }
    return task;
}

/** A metadata document that claims an active run without any real process. */
function writeFakeRunningRun(taskId: string, stamp: string, patch: Partial<RunMetadata> = {}): string {
    const dir = claimRun(taskId, stamp, { cwd: tmpdir() });
    const metadata: RunMetadata = {
        version: 1,
        taskId,
        trigger: "manual",
        state: "running",
        // Own pid: alive and with a matching starttime once filled in below.
        pid: process.pid,
        pgid: process.pid,
        helperPid: process.pid,
        startedAt: new Date().toISOString(),
        sessionFile: join(dir, "session.jsonl"),
        cwd: tmpdir(),
        launchArgs: ["-p"],
        ...patch,
    };
    writeMetadata(dir, metadata);
    return dir;
}

describe("tick: catch-up", () => {
    test("a slot inside the catch-up window fires once and consumes the watermark", () => {
        const task = makeTask({ createdAt: at(6, 8, 0, 30) });
        const harness = newHarness();
        const result = tickAt(at(6, 8, 3, 10), harness);

        assert.equal(result.dispatched.length, 1);
        assert.equal(result.missed, 0);
        assert.equal(harness.dispatches[0].taskId, task.id);
        // The *current* slot wins, not the oldest due slot, and the watermark
        // records the accounted instant (the tick's now), not the slot.
        assert.equal(Date.parse(String(readWatermark(task.id).accountedThrough)), at(6, 8, 3, 10).getTime());
    });

    test("a long downtime with a slot still in the window fires once and counts no miss", () => {
        const task = makeTask({ createdAt: at(6, 7, 52, 30) });
        const harness = newHarness();
        const result = tickAt(at(6, 8, 3, 10), harness);

        // 07:53..08:03 are all due, but 08:03 is inside the window → the
        // backlog is coalesced into one dispatch, not one missed per slot.
        assert.equal(result.dispatched.length, 1);
        assert.equal(result.missed, 0);
        assert.equal(Date.parse(String(readWatermark(task.id).accountedThrough)), at(6, 8, 3, 10).getTime());
        assert.ok(!harness.logs.some((line) => line.includes("behind since")));
    });

    test("a backlog entirely outside the window counts one missed and dispatches nothing", () => {
        const task = makeTask({ cron: "0 * * * *", createdAt: at(6, 7, 0) });
        const harness = newHarness();
        const result = tickAt(at(6, 8, 20), harness);

        // 08:00 is owed but >10 minutes old, and the next slot is 09:00.
        assert.equal(result.dispatched.length, 0);
        assert.equal(result.missed, 1);
        assert.equal(Date.parse(String(readWatermark(task.id).accountedThrough)), at(6, 8, 20).getTime());
        assert.ok(harness.logs.some((line) => line.includes("behind since")));
    });

    test("regression: a stale watermark with a slot still in the window is due, not missed", () => {
        // The plan's counter-example: */5, anchor 12:00, now 12:40, cutoff 12:30.
        // first = 12:05 is out of the window, but nextCron(12:30) = 12:35 is not.
        const task = makeTask({ cron: "*/5 * * * *", createdAt: at(6, 11, 0) });
        writeWatermark(task.id, at(6, 12, 0).toISOString());
        const harness = newHarness();
        const result = tickAt(at(6, 12, 40), harness);

        assert.equal(result.dispatched.length, 1, "dispatches exactly once");
        assert.equal(result.missed, 0);
        assert.equal(Date.parse(String(readWatermark(task.id).accountedThrough)), at(6, 12, 40).getTime());
    });

    test("a pending slot writes no watermark", () => {
        const task = makeTask({ cron: "0 9 * * *", createdAt: at(6, 8, 0) });
        const harness = newHarness();
        tickAt(at(6, 8, 59), harness);
        assert.equal(readWatermark(task.id).accountedThrough, null);
    });

    test("a long downtime does not wedge the task: the next tick sees a fresh watermark", () => {
        const task = makeTask({ createdAt: at(6, 0, 0) });
        const first = newHarness();
        tickAt(at(6, 8, 3, 10), first);
        assert.equal(first.dispatches.length, 1);

        // Same minute, immediately after: nothing is due any more.
        const second = newHarness();
        const result = tickAt(at(6, 8, 3, 40), second);
        assert.equal(second.dispatches.length, 0);
        assert.equal(result.missed, 0);

        // Next minute fires again, i.e. the schedule kept its shape.
        const third = newHarness();
        tickAt(at(6, 8, 4, 10), third);
        assert.equal(third.dispatches.length, 1);
        assert.equal(Date.parse(String(readWatermark(task.id).accountedThrough)), at(6, 8, 4, 10).getTime());
    });

    test("a future slot is not fired early", () => {
        makeTask({ cron: "0 9 * * *", createdAt: at(6, 8, 0) });
        const harness = newHarness();
        const result = tickAt(at(6, 8, 59), harness);
        assert.equal(result.dispatched.length, 0);
        assert.equal(result.missed, 0);
    });
});

describe("tick: cross-second dedupe and mutual exclusion", () => {
    test("two ticks in adjacent seconds cannot double-dispatch the same slot", () => {
        makeTask({ createdAt: at(6, 8, 0, 30) });
        const harness = newHarness();
        tickAt(new Date(at(6, 8, 3).getTime() + 500), harness);
        tickAt(new Date(at(6, 8, 3, 1).getTime() + 500), harness);
        assert.equal(harness.dispatches.length, 1);
    });

    test("an active run of any trigger blocks the scheduler", () => {
        const task = makeTask({ createdAt: at(6, 8, 0, 30) });
        writeFakeRunningRun(task.id, "20261106-080200");
        const harness = newHarness();
        const result = tickAt(at(6, 8, 4, 10), harness);

        assert.equal(harness.dispatches.length, 0);
        assert.deepEqual(result.skipped, [task.id]);
        assert.ok(activeRun(task.id), "the fake run still holds the task");
        // A skipped slot is not a missed slot: the watermark must not move.
        assert.equal(readWatermark(task.id).accountedThrough, null);
    });

    test("a terminal run does not block the scheduler", () => {
        const task = makeTask({ createdAt: at(6, 8, 0, 30) });
        const dir = writeFakeRunningRun(task.id, "20261106-080200", { state: "exited", exitCode: 0 });
        patchMetadata(dir, { finishedAt: new Date().toISOString() });
        const harness = newHarness();
        tickAt(at(6, 8, 4, 10), harness);
        assert.equal(harness.dispatches.length, 1);
    });

    test("disabled tasks are never dispatched", () => {
        makeTask({ createdAt: at(6, 8, 0, 30), enabled: false });
        const harness = newHarness();
        tickAt(at(6, 8, 4, 10), harness);
        assert.equal(harness.dispatches.length, 0);
    });
});

describe("tick: once", () => {
    test("a once task fires for its first due slot only", () => {
        const task = makeTask({
            cron: "0 9 * * *",
            once: true,
            createdAt: at(6, 8, 0),
        });
        const first = newHarness();
        tickAt(at(6, 9, 0, 10), first);
        assert.equal(first.dispatches.length, 1);

        const second = newHarness();
        tickAt(at(7, 9, 0, 10), second);
        assert.equal(second.dispatches.length, 0);
        assert.equal(Date.parse(String(readWatermark(task.id).accountedThrough)), at(6, 9, 0, 10).getTime());
    });

    test("the consumed guard runs before the verdict for a high-frequency once task", () => {
        const task = makeTask({
            cron: "* * * * *",
            once: true,
            createdAt: at(6, 8, 0),
        });
        const first = newHarness();
        tickAt(at(6, 8, 1, 10), first);
        assert.equal(first.dispatches.length, 1);

        // Ten minutes later the slot after the anchor is still in the past
        // (verdict would be `due`); only the watermark stops a second fire.
        const second = newHarness();
        tickAt(at(6, 8, 11, 10), second);
        assert.equal(second.dispatches.length, 0);
        assert.ok(second.logs.some((line) => line.includes("already consumed")));
        assert.equal(Date.parse(String(readWatermark(task.id).accountedThrough)), at(6, 8, 1, 10).getTime());
    });

    test("a once task consumed by a missed slot never fires and logs the reason", () => {
        const task = makeTask({
            cron: "0 9 * * *",
            once: true,
            createdAt: at(6, 8, 0),
        });
        const harness = newHarness();
        const result = tickAt(at(6, 12, 0), harness);

        assert.equal(harness.dispatches.length, 0);
        assert.equal(result.missed, 1);
        assert.equal(Date.parse(String(readWatermark(task.id).accountedThrough)), at(6, 12, 0).getTime());
        assert.ok(harness.logs.some((line) => line.includes("consumed by a missed slot")));
    });
});

describe("tick: robustness", () => {
    test("a corrupt task file does not abort the pass and is reported once", () => {
        const good = makeTask({ createdAt: at(6, 8, 0, 30) });
        writeFileSync(join(tasksDir(), "deadbeef.json"), "{ not json");
        const harness = newHarness();

        const result = tickAt(at(6, 8, 4, 10), harness);
        assert.equal(result.dispatched.length, 1);
        assert.equal(result.dispatched[0], good.id);
        assert.ok(harness.logs.some((line) => line.includes("deadbeef") && line.includes("corrupt")));

        // Reported once: the same corrupt file on the next tick is silent.
        const second = newHarness();
        tickAt(at(6, 8, 4, 40), second);
        assert.ok(!second.logs.some((line) => line.includes("corrupt")));
    });

    test("an unschedulable cron is reported and skipped, not thrown", () => {
        const task = makeTask({ createdAt: at(6, 8, 0) });
        writeFileSync(
            join(tasksDir(), `${task.id}.json`),
            JSON.stringify({ ...task, cron: "0 0 30 2 *" }, null, 2),
        );
        const harness = newHarness();
        const result = tickAt(at(6, 8, 4, 10), harness);
        assert.equal(result.dispatched.length, 0);
        assert.ok(harness.logs.some((line) => line.includes("not schedulable")));
    });

    test("a dispatch that throws is logged and does not abort other tasks", () => {
        const first = makeTask({ createdAt: at(6, 8, 0, 30) });
        const second = makeTask({ createdAt: at(6, 8, 0, 31) });
        const logs: string[] = [];
        const seen: string[] = [];
        runTick({
            now: at(6, 8, 4, 10),
            log: (line) => logs.push(line),
            dispatch: (taskId) => {
                seen.push(taskId);
                if (taskId === first.id) throw new Error("boom");
            },
        });
        assert.deepEqual(seen.sort(), [first.id, second.id].sort());
        assert.ok(logs.some((line) => line.includes("dispatch failed")));
    });

    test("skipped is logged once per active run, not once per tick", () => {
        const task = makeTask({ createdAt: at(6, 8, 0, 30) });
        writeFakeRunningRun(task.id, "20261106-080200");
        const harness = newHarness();

        tickAt(at(6, 8, 4, 10), harness);
        tickAt(at(6, 8, 4, 40), harness);
        tickAt(at(6, 8, 5, 10), harness);

        const skipLines = harness.logs.filter((line) => line.includes("scheduling skipped"));
        assert.equal(skipLines.length, 1);
    });
});

describe("tick: log and helpers", () => {
    test("stampOf formats the local run stamp", () => {
        const stamp = stampOf(new Date(2026, 10, 6, 8, 3, 9));
        assert.equal(stamp, "20261106-080309");
    });

    test("formatTickResult summarises the pass", () => {
        assert.equal(
            formatTickResult({ dispatched: ["a"], skipped: ["b", "c"], missed: 4 }),
            "dispatched 1 / skipped 2 / missed 4",
        );
    });

    test("appendTickLog creates the log next to the schedule dir", () => {
        appendTickLog("hello");
        const path = join(scratch, "agent", "schedule", "tick.log");
        assert.ok(existsSync(path));
        assert.match(readFileSync(path, "utf8"), /hello\n$/);
    });

    test("appendTickLog appends instead of truncating the previous tick's lines", () => {
        appendTickLog("first");
        appendTickLog("second");
        const path = join(scratch, "agent", "schedule", "tick.log");
        const content = readFileSync(path, "utf8").trimEnd().split("\n");
        assert.equal(content.length, 2);
        assert.match(content[0], /first$/);
        assert.match(content[1], /second$/);
    });
});

describe("install-cron", () => {
    interface FakeCron {
        runner: CommandRunner;
        calls: Array<{ command: string; args: string[]; input?: string }>;
        crontab: () => string;
    }

    function fakeCron(initial: string, options: { cronDaemon?: boolean } = {}): FakeCron {
        let current = initial;
        const calls: FakeCron["calls"] = [];
        const runner: CommandRunner = (command, args, runOptions) => {
            calls.push({ command, args, input: runOptions?.input });
            if (command === "crontab" && args[0] === "-l") {
                return current.length > 0
                    ? { status: 0, stdout: current, stderr: "" }
                    : { status: 1, stdout: "", stderr: "no crontab for user" };
            }
            if (command === "crontab" && args[0] === "-") {
                current = runOptions?.input ?? "";
                return { status: 0, stdout: "", stderr: "" };
            }
            if (command === "which") return { status: 0, stdout: "/opt/pi/bin/pi\n", stderr: "" };
            if (command === "pgrep") {
                return options.cronDaemon === false
                    ? { status: 1, stdout: "", stderr: "" }
                    : { status: 0, stdout: "123\n", stderr: "" };
            }
            if (command === "env") return { status: 0, stdout: "No scheduled tasks.\n", stderr: "" };
            return { status: 1, stdout: "", stderr: `unexpected command ${command}` };
        };
        return { runner, calls, crontab: () => current };
    }

    const scheduleBin = () => join(scratch, "agent", "bin", "schedule");

    test("renderCronBlock puts PATH before the entry", () => {
        const block = renderCronBlock({
            piDir: "/opt/pi/bin",
            nodeBin: "/usr/bin/node",
            scheduleBin: "/usr/local/bin/schedule",
            logPath: "/home/zhe/.pi/agent/schedule/tick.log",
        });
        const lines = block.split("\n");
        assert.equal(lines[0], CRON_BLOCK_BEGIN);
        assert.equal(lines[1], "PATH=/opt/pi/bin:/usr/local/bin:/usr/bin:/bin");
        assert.equal(
            lines[2],
            `${TICK_SCHEDULE} /usr/bin/node /usr/local/bin/schedule tick >> /home/zhe/.pi/agent/schedule/tick.log 2>&1`,
        );
        assert.equal(lines[3], CRON_BLOCK_END);
    });

    test("stripCronBlock removes only our block", () => {
        const body = [
            "MAILTO=me@example.com",
            "0 1 * * * /bin/backup.sh",
            CRON_BLOCK_BEGIN,
            "PATH=/x",
            "* * * * * /x tick",
            CRON_BLOCK_END,
            "30 2 * * * /bin/other.sh",
            "",
        ].join("\n");
        const stripped = stripCronBlock(body);
        assert.ok(!stripped.includes(CRON_BLOCK_BEGIN));
        assert.ok(stripped.includes("/bin/backup.sh"));
        assert.ok(stripped.includes("/bin/other.sh"));
        assert.equal(stripped, "MAILTO=me@example.com\n0 1 * * * /bin/backup.sh\n30 2 * * * /bin/other.sh");
    });

    test("preserves the user's entries and is idempotent", () => {
        mkdirSync(join(scratch, "agent", "bin"), { recursive: true });
        writeFileSync(scheduleBin(), "#!/usr/bin/env node\n");
        const fake = fakeCron("0 1 * * * /bin/backup.sh\n");
        const options = { runner: fake.runner, scheduleBin: scheduleBin(), nodeBin: "/usr/bin/node" };

        const first = installCron(options);
        const once = fake.crontab();
        installCron(options);
        const twice = fake.crontab();

        assert.equal(once, twice, "install-cron must be idempotent");
        assert.ok(twice.startsWith("0 1 * * * /bin/backup.sh\n"));
        assert.equal(twice.split(CRON_BLOCK_BEGIN).length - 1, 1, "exactly one managed block");
        assert.equal(first.crontab, twice);
    });

    test("backs up the previous crontab and honours a custom pi dir", () => {
        mkdirSync(join(scratch, "agent", "bin"), { recursive: true });
        writeFileSync(scheduleBin(), "#!/usr/bin/env node\n");
        const fake = fakeCron("0 1 * * * /bin/backup.sh\n");
        installCron({
            runner: fake.runner,
            scheduleBin: scheduleBin(),
            nodeBin: "/usr/bin/node",
            piDir: "/custom/bin",
        });
        const backup = readFileSync(join(scratch, "agent", "schedule", "crontab.bak"), "utf8");
        assert.equal(backup, "0 1 * * * /bin/backup.sh\n");
        assert.ok(fake.crontab().includes("PATH=/custom/bin:"));
    });

    test("warns when the cron daemon is missing and when the entry point is absent", () => {
        const fake = fakeCron("", { cronDaemon: false });
        const result = installCron({
            runner: fake.runner,
            scheduleBin: scheduleBin(),
            nodeBin: "/usr/bin/node",
        });
        assert.ok(result.warnings.some((line) => line.includes("no cron daemon")));
        assert.ok(result.warnings.some((line) => line.includes("schedule entry point not found")));
        assert.ok(result.warnings.some((line) => line.includes("install.sh")));
    });

    test("smoke-tests the tick under a cron-like env and reports failures", () => {
        mkdirSync(join(scratch, "agent", "bin"), { recursive: true });
        writeFileSync(scheduleBin(), "#!/usr/bin/env node\n");
        const fake = fakeCron("");
        const result = installCron({
            runner: fake.runner,
            scheduleBin: scheduleBin(),
            nodeBin: "/usr/bin/node",
        });
        const smoke = fake.calls.find((call) => call.command === "env");
        assert.ok(smoke);
        assert.equal(smoke.args[0], "-i");
        assert.ok(smoke.args.some((arg) => arg.startsWith("PATH=")));
        assert.ok(smoke.args.includes(scheduleBin()));
        assert.equal(result.smoke.status, 0);
    });

    test("a failed crontab write surfaces as an error", () => {
        const runner: CommandRunner = (command, args) => {
            if (command === "crontab" && args[0] === "-") {
                return { status: 1, stdout: "", stderr: "crontab: permission denied" };
            }
            // A genuinely empty crontab: the one non-zero read that is not a failure.
            if (command === "crontab") return { status: 1, stdout: "", stderr: "no crontab for zhe" };
            return { status: 0, stdout: "", stderr: "" };
        };
        assert.throws(
            () => installCron({ runner, scheduleBin: scheduleBin(), nodeBin: "/usr/bin/node" }),
            /permission denied/,
        );
    });

    test("a failed crontab read aborts instead of rewriting from an empty base", () => {
        let wrote = false;
        const runner: CommandRunner = (command, args) => {
            if (command === "crontab" && args[0] === "-l") {
                return { status: 1, stdout: "", stderr: "crontab: cannot open spool" };
            }
            if (command === "crontab") {
                wrote = true;
                return { status: 0, stdout: "", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
        };
        assert.throws(
            () => installCron({ runner, scheduleBin: scheduleBin(), nodeBin: "/usr/bin/node" }),
            /cannot open spool/,
        );
        // Nothing may be written, and no backup may be claimed, from a base we
        // never actually read.
        assert.equal(wrote, false);
        assert.equal(existsSync(join(scratch, "agent", "schedule", "crontab.bak")), false);
    });

    test("uninstall-cron removes only our block and keeps the user's entries", () => {
        const original = [
            "MAILTO=me@example.com",
            "0 1 * * * /bin/backup.sh",
            CRON_BLOCK_BEGIN,
            "PATH=/opt/pi/bin:/usr/bin:/bin",
            "* * * * * /usr/bin/node /x/schedule tick >> /x/tick.log 2>&1",
            CRON_BLOCK_END,
            "30 2 * * * /bin/other.sh",
            "",
        ].join("\n");
        const fake = fakeCron(original);
        const result = uninstallCron({ runner: fake.runner });

        assert.equal(result.removed, true);
        assert.equal(
            fake.crontab(),
            "MAILTO=me@example.com\n0 1 * * * /bin/backup.sh\n30 2 * * * /bin/other.sh\n",
        );
        assert.ok(!fake.crontab().includes(CRON_BLOCK_BEGIN));
        assert.ok(result.removedBlock.startsWith(CRON_BLOCK_BEGIN));
        assert.ok(result.removedBlock.endsWith(CRON_BLOCK_END));
        const backup = readFileSync(join(scratch, "agent", "schedule", "crontab.bak"), "utf8");
        assert.equal(backup, original);
    });

    test("uninstall-cron is an idempotent no-op when no block is present", () => {
        const fake = fakeCron("0 1 * * * /bin/backup.sh\n");
        const result = uninstallCron({ runner: fake.runner });

        assert.equal(result.removed, false);
        assert.equal(result.removedBlock, "");
        assert.equal(fake.crontab(), "0 1 * * * /bin/backup.sh\n");
        const writes = fake.calls.filter((call) => call.command === "crontab" && call.args[0] === "-");
        assert.equal(writes.length, 0, "a no-op must not rewrite the crontab");
    });

    test("uninstall-cron strips an unterminated block too", () => {
        const fake = fakeCron(`0 1 * * * /bin/backup.sh\n${CRON_BLOCK_BEGIN}\nPATH=/x\n`);
        const result = uninstallCron({ runner: fake.runner });
        assert.equal(result.removed, true);
        assert.equal(fake.crontab(), "0 1 * * * /bin/backup.sh\n");
    });

    test("uninstall-cron clears the crontab when the block was the only entry", () => {
        const block = renderCronBlock({
            piDir: "/opt/pi/bin",
            nodeBin: "/usr/bin/node",
            scheduleBin: "/x/schedule",
            logPath: "/x/tick.log",
        });
        const fake = fakeCron(`${block}\n`);
        const result = uninstallCron({ runner: fake.runner });
        assert.equal(result.removed, true);
        assert.equal(fake.crontab(), "");
    });

    test("extractCronBlock returns undefined without markers", () => {
        assert.equal(extractCronBlock("0 1 * * * /bin/x.sh\n"), undefined);
        assert.equal(
            extractCronBlock(`${CRON_BLOCK_BEGIN}\nPATH=/x\n${CRON_BLOCK_END}\n`),
            `${CRON_BLOCK_BEGIN}\nPATH=/x\n${CRON_BLOCK_END}`,
        );
    });

    test("a failed crontab write during uninstall surfaces as an error", () => {
        let read = false;
        const runner: CommandRunner = (command, args) => {
            if (command !== "crontab") return { status: 0, stdout: "", stderr: "" };
            if (args[0] === "-l") {
                read = true;
                return { status: 0, stdout: `${CRON_BLOCK_BEGIN}\nPATH=/x\n${CRON_BLOCK_END}\n`, stderr: "" };
            }
            return { status: 1, stdout: "", stderr: "crontab: permission denied" };
        };
        assert.throws(() => uninstallCron({ runner }), /permission denied/);
        assert.equal(read, true);
    });
});

describe("tick: run integration", () => {
    test("a dispatched slot leaves a visible `starting` claim behind", () => {
        const task = makeTask({ createdAt: at(6, 8, 0, 30) });
        const harness = newHarness();
        tickAt(at(6, 8, 4, 10), harness);
        const stamps = readdirSync(taskRunsDir(task.id)).filter((entry) => entry.includes("-"));
        assert.equal(stamps.length, 1);
        assert.equal(stamps[0], harness.dispatches[0].stamp);
        // Stage 0: the claim itself is a run record, so a dispatch that never
        // reaches the helper shows up as stale instead of being mistaken for a
        // missed slot.
        const metadata = readMetadata(runDir(task.id, stamps[0]));
        if (!metadata) throw new Error("claim metadata exists");
        assert.equal(metadata.state, "starting");
        assert.equal(metadata.trigger, "scheduled");
        assert.equal(metadata.cwd, tmpdir());
        assert.equal(metadata.pid, null);
        assert.ok(Number.isFinite(Date.parse(metadata.startedAt)));
    });
});
