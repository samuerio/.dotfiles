// store.ts: task definitions, scheduling watermark, run-dir GC.
// Everything is redirected into a scratch PI_CODING_AGENT_DIR per test, so the
// real ~/.pi/agent/schedule is never touched.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import {
    KEEP_MS,
    KEEP_RUNS,
    addTask,
    atomicWriteJson,
    gcRuns,
    listRunStamps,
    listTasks,
    nextFireAnchor,
    readTask,
    readWatermark,
    removeTask,
    resolvePromptText,
    runDir,
    runsRoot,
    setTaskEnabled,
    setTaskPrompt,
    taskRunsDir,
    tasksDir,
    validateTaskId,
    watermarkPath,
    writeWatermark,
    type Task,
} from "../store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

let scratch: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    scratch = mkdtempSync(join(tmpdir(), "schedule-store-"));
    process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
    mkdirSync(tasksDir(), { recursive: true });
});

afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(scratch, { recursive: true, force: true });
});

function writeTaskFile(id: string, body: unknown): void {
    writeFileSync(join(tasksDir(), `${id}.json`), typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

function makeDir(path: string): void {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "metadata.json"), "{}\n");
}

function ageDir(path: string, ageMs: number): void {
    const seconds = (Date.now() - ageMs) / 1000;
    utimesSync(path, seconds, seconds);
}

describe("atomicWriteJson", () => {
    test("writes pretty JSON and leaves no temp files behind", () => {
        const target = join(scratch, "out", "doc.json");
        atomicWriteJson(target, { version: 1, hello: "world" });
        assert.equal(readFileSync(target, "utf8"), `{\n  "version": 1,\n  "hello": "world"\n}\n`);
        assert.deepEqual(readdirSync(join(scratch, "out")), ["doc.json"]);
    });

    test("overwrites atomically: readers never see a partial document", () => {
        const target = join(scratch, "doc.json");
        atomicWriteJson(target, { n: 1 });
        for (let i = 2; i < 20; i++) {
            atomicWriteJson(target, { n: i });
            assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { n: i });
        }
        assert.deepEqual(readdirSync(scratch), ["agent", "doc.json"].filter((name) => existsSync(join(scratch, name))));
    });

    test("a failing write does not leave the temp file behind", () => {
        const target = join(scratch, "doc.json");
        atomicWriteJson(target, { ok: true });
        chmodSync(scratch, 0o500);
        try {
            assert.throws(() => atomicWriteJson(join(scratch, "sub", "doc.json"), { ok: false }));
        } finally {
            chmodSync(scratch, 0o700);
        }
        const leftovers = readdirSync(scratch).filter((name) => name.endsWith(".tmp"));
        assert.deepEqual(leftovers, []);
    });
});

describe("validateTaskId", () => {
    test("accepts 8 lowercase hex", () => {
        for (const id of ["a1b2c3d4", "00000000", "deadbeef"]) assert.equal(validateTaskId(id), true, id);
    });

    test("rejects anything that could escape the task directory", () => {
        for (const id of ["../../etc", "a/b", "a1b2c3d4/..", "ABCDEF12", "abc", "123456789", "", "..", "a1b2c3d"]) {
            assert.equal(validateTaskId(id), false, id);
        }
    });
});

describe("addTask", () => {
    test("creates an enabled, non-recurring task with a generated id", () => {
        const task = addTask({ name: "daily-report", cron: "7 9 * * 1-5", cwd: tmpdir(), prompt: "do it" });
        assert.equal(task.version, 1);
        assert.match(task.id, /^[a-z0-9]{8}$/);
        assert.equal(task.enabled, true);
        assert.equal(task.once, false);
        assert.equal(task.cwd, tmpdir());
        assert.equal(task.prompt, "do it");
        assert.ok(existsSync(join(tasksDir(), `${task.id}.json`)));
        assert.deepEqual(readTask(task.id), task);
    });

    test("honours once and snapshots a prompt file into the definition", () => {
        const promptPath = join(scratch, "prompt.md");
        writeFileSync(promptPath, "from file\n");
        const task = addTask({ name: "one-shot", cron: "@daily", cwd: tmpdir(), promptFile: promptPath, once: true });
        assert.equal(task.once, true);
        assert.equal(task.prompt, "from file\n");
        // The path is an input, not part of the persisted definition.
        assert.equal(readFileSync(join(tasksDir(), `${task.id}.json`), "utf8").includes("promptFile"), false);
        // Deleting the source afterwards cannot change what the task runs.
        rmSync(promptPath);
        assert.equal(readTask(task.id)?.prompt, "from file\n");
    });

    test("retries on an id collision", () => {
        const taken = addTask({ name: "a", cron: "@daily", cwd: tmpdir(), prompt: "x" }, { nextId: () => "aaaaaaaa" });
        const ids = ["aaaaaaaa", "aaaaaaaa", "bbbbbbbb"];
        const created = addTask(
            { name: "b", cron: "@daily", cwd: tmpdir(), prompt: "y" },
            { nextId: () => ids.shift() ?? "cccccccc" },
        );
        assert.equal(created.id, "bbbbbbbb");
        assert.notEqual(created.id, taken.id);
        assert.equal(listTasks().length, 2);
    });

    test("gives up after repeated collisions", () => {
        addTask({ name: "a", cron: "@daily", cwd: tmpdir(), prompt: "x" }, { nextId: () => "aaaaaaaa" });
        assert.throws(
            () => addTask({ name: "b", cron: "@daily", cwd: tmpdir(), prompt: "y" }, { nextId: () => "aaaaaaaa" }),
            /unique task id/,
        );
    });

    test("rejects invalid input", () => {
        const notADirectory = join(scratch, "prompt.md");
        writeFileSync(notADirectory, "x");
        const base = { name: "n", cron: "@daily", cwd: tmpdir(), prompt: "p" };
        assert.throws(() => addTask({ ...base, name: " " }), /--name/);
        assert.throws(() => addTask({ ...base, cron: "" }), /--cron/);
        assert.throws(() => addTask({ ...base, cwd: "relative/path" }), /absolute/);
        assert.throws(() => addTask({ ...base, cwd: join(scratch, "nope") }), /does not exist/);
        assert.throws(() => addTask({ ...base, cwd: notADirectory }), /not a directory/);
        const promptFile = join(scratch, "p.md");
        writeFileSync(promptFile, "x");
        assert.throws(() => addTask({ ...base, promptFile }), /mutually exclusive/);
        assert.throws(() => addTask({ name: "n", cron: "@daily", cwd: tmpdir() }), /one of --prompt/);
        assert.throws(() => addTask({ ...base, prompt: undefined, promptFile: join(scratch, "missing.md") }), /cannot read/);
        assert.throws(() => addTask({ ...base, prompt: "  \n" }), /prompt is empty/);
        const emptyFile = join(scratch, "empty.md");
        writeFileSync(emptyFile, "");
        assert.throws(() => addTask({ ...base, prompt: undefined, promptFile: emptyFile }), /prompt is empty/);
    });
});

describe("readTask / listTasks", () => {
    test("corrupt and malformed definitions read as undefined but stay listed", () => {
        const good = addTask({ name: "good", cron: "@daily", cwd: tmpdir(), prompt: "x" });
        writeTaskFile("11111111", "{ not json");
        writeTaskFile("22222222", { version: 2, id: "22222222" });
        writeTaskFile("33333333", { version: 1, id: "44444444", name: "mismatch" });
        // Legacy shape: the prompt lived in a file path, which is no longer a task field.
        writeTaskFile("55555555", {
            version: 1,
            id: "55555555",
            name: "legacy",
            cron: "@daily",
            enabled: true,
            cwd: tmpdir(),
            promptFile: "/tmp/prompt.md",
            once: false,
            createdAt: new Date().toISOString(),
        });
        writeFileSync(join(tasksDir(), "notes.txt"), "ignore me");

        assert.equal(readTask("11111111"), undefined);
        assert.equal(readTask("22222222"), undefined);
        assert.equal(readTask("33333333"), undefined);
        assert.equal(readTask("deadbeef"), undefined);
        assert.equal(readTask("../etc/passwd"), undefined);

        const listed = listTasks();
        const ids = listed.map((entry) => entry.id).sort();
        assert.deepEqual(ids, [good.id, "11111111", "22222222", "33333333", "55555555"].sort());
        const corrupt = listed.filter((entry) => entry.task === undefined);
        assert.equal(corrupt.length, 4);
        for (const entry of corrupt) assert.ok(entry.error && entry.error.length > 0);
        assert.equal(listed.find((entry) => entry.id === good.id)?.task?.name, "good");
    });

    test("missing tasks directory lists as empty", () => {
        rmSync(tasksDir(), { recursive: true, force: true });
        assert.deepEqual(listTasks(), []);
    });

    test("removeTask and setTaskEnabled", () => {
        const task = addTask({ name: "t", cron: "@daily", cwd: tmpdir(), prompt: "x" });
        const disabled = setTaskEnabled(task.id, false);
        assert.equal(disabled?.enabled, false);
        assert.equal(readTask(task.id)?.enabled, false);
        assert.equal(setTaskEnabled("deadbeef", false), undefined);
        assert.equal(removeTask(task.id), true);
        assert.equal(removeTask(task.id), false);
        assert.equal(removeTask("../etc/passwd"), false);
        assert.equal(readTask(task.id), undefined);
    });
});

describe("resolvePromptText", () => {
    test("passes inline text through untouched", () => {
        assert.equal(resolvePromptText({ prompt: "  keep\n formatting  " }, "add"), "  keep\n formatting  ");
    });

    test("reads a file once", () => {
        const path = join(scratch, "p.md");
        writeFileSync(path, "file body\n");
        assert.equal(resolvePromptText({ promptFile: path }, "add"), "file body\n");
    });

    test("both or neither is a configuration error", () => {
        assert.throws(() => resolvePromptText({ prompt: "a", promptFile: "/tmp/x" }, "add"), /mutually exclusive/);
        assert.throws(() => resolvePromptText({}, "add"), /one of --prompt/);
    });

    test("an unreadable or empty source is an error, not an empty prompt", () => {
        assert.throws(() => resolvePromptText({ promptFile: join(scratch, "missing.md") }, "add"), /cannot read/);
        const empty = join(scratch, "empty.md");
        writeFileSync(empty, "\n \t\n");
        assert.throws(() => resolvePromptText({ promptFile: empty }, "add"), /prompt is empty/);
    });

    test("the action name is carried into the message", () => {
        assert.throws(() => resolvePromptText({}, "set-prompt"), /^Error: set-prompt: one of/);
    });
});

describe("setTaskPrompt", () => {
    test("replaces only the prompt and leaves the schedule alone", () => {
        const task = addTask({ name: "t", cron: "@daily", cwd: tmpdir(), prompt: "old" }, { nextId: () => "aaaaaaaa" });
        const next = setTaskPrompt(task.id, { prompt: "new" });
        assert.equal(next?.prompt, "new");
        assert.equal(next?.cron, task.cron);
        assert.equal(next?.cwd, task.cwd);
        assert.equal(next?.createdAt, task.createdAt);
        assert.equal(readTask(task.id)?.prompt, "new");
    });

    test("a file source is snapshot, not referenced", () => {
        const task = addTask({ name: "t", cron: "@daily", cwd: tmpdir(), prompt: "old" }, { nextId: () => "aaaaaaaa" });
        const path = join(scratch, "p.md");
        writeFileSync(path, "from file\n");
        setTaskPrompt(task.id, { promptFile: path });
        writeFileSync(path, "edited later\n");
        assert.equal(readTask(task.id)?.prompt, "from file\n");
    });

    test("unknown task or bad input writes nothing", () => {
        assert.equal(setTaskPrompt("deadbeef", { prompt: "x" }), undefined);
        const task = addTask({ name: "t", cron: "@daily", cwd: tmpdir(), prompt: "old" }, { nextId: () => "aaaaaaaa" });
        assert.throws(() => setTaskPrompt(task.id, {}), /one of --prompt/);
        assert.equal(readTask(task.id)?.prompt, "old");
    });
});

describe("watermark", () => {
    test("missing watermark reads as never accounted for", () => {
        const watermark = readWatermark("a1b2c3d4");
        assert.equal(watermark.accountedThrough, null);
        assert.equal(watermark.taskId, "a1b2c3d4");
    });

    test("round-trips through disk", () => {
        writeWatermark("a1b2c3d4", "2026-11-06T07:28:00.000Z");
        const watermark = readWatermark("a1b2c3d4");
        assert.equal(watermark.accountedThrough, "2026-11-06T07:28:00.000Z");
        assert.ok(watermark.updatedAt.length > 0);
        assert.ok(existsSync(watermarkPath("a1b2c3d4")));
        writeWatermark("a1b2c3d4", null);
        assert.equal(readWatermark("a1b2c3d4").accountedThrough, null);
    });

    test("a corrupt watermark degrades to never accounted for instead of wedging scheduling", () => {
        mkdirSync(taskRunsDir("a1b2c3d4"), { recursive: true });
        writeFileSync(watermarkPath("a1b2c3d4"), "{ half");
        assert.equal(readWatermark("a1b2c3d4").accountedThrough, null);
        writeFileSync(watermarkPath("a1b2c3d4"), JSON.stringify({ version: 1, accountedThrough: 42 }));
        assert.equal(readWatermark("a1b2c3d4").accountedThrough, null);
    });

    test("a missing field and the old key both read as null (no migration)", () => {
        mkdirSync(taskRunsDir("a1b2c3d4"), { recursive: true });
        writeFileSync(watermarkPath("a1b2c3d4"), JSON.stringify({ version: 1, taskId: "a1b2c3d4" }));
        assert.equal(readWatermark("a1b2c3d4").accountedThrough, null);
        writeFileSync(
            watermarkPath("a1b2c3d4"),
            JSON.stringify({ version: 1, lastSlotConsumed: "2026-11-06T07:28:00.000Z" }),
        );
        assert.equal(readWatermark("a1b2c3d4").accountedThrough, null);
    });

    test("writes only the accountedThrough contract", () => {
        writeWatermark("a1b2c3d4", "2026-11-06T07:28:00.000Z");
        const raw = JSON.parse(readFileSync(watermarkPath("a1b2c3d4"), "utf8")) as Record<string, unknown>;
        assert.deepEqual(Object.keys(raw).sort(), ["accountedThrough", "taskId", "updatedAt", "version"]);
        assert.equal(raw.accountedThrough, "2026-11-06T07:28:00.000Z");
    });

    test("invalid ids never touch the filesystem", () => {
        assert.throws(() => writeWatermark("../etc", null), /invalid task id/);
        assert.equal(readWatermark("../etc").accountedThrough, null);
    });
});

describe("listRunStamps", () => {
    test("returns stamp directories newest first and ignores everything else", () => {
        const dir = taskRunsDir("a1b2c3d4");
        for (const stamp of ["20261106-070000", "20261106-090000", "20261105-230000"]) makeDir(join(dir, stamp));
        writeFileSync(watermarkPath("a1b2c3d4"), "{}\n");
        mkdirSync(join(dir, "inbox"), { recursive: true });
        writeFileSync(join(dir, "20261106-100000"), "not a dir\n");
        assert.deepEqual(listRunStamps("a1b2c3d4"), ["20261106-090000", "20261106-070000", "20261105-230000"]);
        assert.deepEqual(listRunStamps("deadbeef"), []);
        assert.deepEqual(listRunStamps("../etc"), []);
    });
});

describe("gcRuns", () => {
    test("keeps young runs even when there are more than KEEP_RUNS", () => {
        const id = "a1b2c3d4";
        for (let i = 0; i < KEEP_RUNS + 4; i++) {
            makeDir(runDir(id, `2026110${1 + (i % 9)}-0${i % 10}0000-${String(i).padStart(2, "0")}`.slice(0, 15)));
        }
        const stamps = listRunStamps(id);
        assert.equal(stamps.length, KEEP_RUNS + 4);
        assert.deepEqual(gcRuns().removed, []);
        assert.equal(listRunStamps(id).length, KEEP_RUNS + 4);
    });

    test("deletes old runs beyond KEEP_RUNS, keeps the newest N and never the newest", () => {
        const id = "deadbeef";
        const stamps: string[] = [];
        for (let i = 0; i < KEEP_RUNS + 3; i++) {
            const day = String(10 + i).padStart(2, "0");
            const stamp = `202610${day}-120000`;
            stamps.push(stamp);
            makeDir(runDir(id, stamp));
            ageDir(runDir(id, stamp), 30 * DAY_MS);
        }
        const orderedDesc = [...stamps].sort().reverse();
        const { removed } = gcRuns();
        // Newest KEEP_RUNS survive regardless of age; the tail beyond it is old ⇒ removed.
        const removedStamps = removed.map((path) => path.slice(path.lastIndexOf("/") + 1)).sort();
        assert.deepEqual(removedStamps, orderedDesc.slice(KEEP_RUNS).sort());
        assert.deepEqual(listRunStamps(id), orderedDesc.slice(0, KEEP_RUNS));
    });

    test("OR retention: old runs inside the newest KEEP_RUNS survive", () => {
        const id = "aaaaaaaa";
        for (let i = 0; i < 3; i++) {
            const stamp = `2026101${i}-120000`;
            makeDir(runDir(id, stamp));
            ageDir(runDir(id, stamp), 60 * DAY_MS);
        }
        assert.deepEqual(gcRuns().removed, []);
        assert.equal(listRunStamps(id).length, 3);
    });

    test("nothing is removed while the newest run is younger than KEEP_MS", () => {
        const id = "bbbbbbbb";
        for (let i = 0; i < KEEP_RUNS + 5; i++) {
            const stamp = `202610${String(10 + i).padStart(2, "0")}-120000`;
            makeDir(runDir(id, stamp));
        }
        assert.deepEqual(gcRuns().removed, []);
        assert.equal(listRunStamps(id).length, KEEP_RUNS + 5);
    });

    test("collects runs left behind by a removed task", () => {
        const task = addTask({ name: "t", cron: "@daily", cwd: tmpdir(), prompt: "x" });
        for (let i = 0; i < KEEP_RUNS + 1; i++) {
            const stamp = `202610${String(10 + i).padStart(2, "0")}-120000`;
            makeDir(runDir(task.id, stamp));
            ageDir(runDir(task.id, stamp), 90 * DAY_MS);
        }
        removeTask(task.id);
        const { removed } = gcRuns();
        assert.equal(removed.length, 1);
        assert.equal(existsSync(taskRunsDir(task.id)), true);
        assert.equal(listRunStamps(task.id).length, KEEP_RUNS);
    });

    test("never removes the watermark and tolerates a missing runs root", () => {
        writeWatermark("a1b2c3d4", "2026-11-06T00:00:00.000Z");
        assert.deepEqual(gcRuns().removed, []);
        assert.ok(existsSync(watermarkPath("a1b2c3d4")));
        rmSync(runsRoot(), { recursive: true, force: true });
        assert.deepEqual(gcRuns().removed, []);
    });
});

describe("nextFireAnchor", () => {
    const now = new Date("2026-11-09T10:00:00.000Z");

    test("a never-run task anchors on now", () => {
        assert.equal(nextFireAnchor(null, now)?.toISOString(), now.toISOString());
    });

    test("a watermark in the past is clamped to now", () => {
        // Downtime: the old anchor would label today's slot with a stale date.
        assert.equal(nextFireAnchor("2026-11-06T03:00:00.000Z", now)?.toISOString(), now.toISOString());
    });

    test("a watermark in the future is kept", () => {
        assert.equal(nextFireAnchor("2026-11-09T12:00:00.000Z", now)?.toISOString(), "2026-11-09T12:00:00.000Z");
    });

    test("a malformed watermark has no anchor", () => {
        assert.equal(nextFireAnchor("not a timestamp", now), undefined);
    });
});
