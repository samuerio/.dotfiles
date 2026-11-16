// store.test.ts — direct tests for store.ts (task-file persistence).
// Unlike loop.test.ts these need no __testReset hooks: every store
// function takes the repo root explicitly, so each test targets a fresh
// scratch directory.
import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    errnoCode,
    isStoredTask,
    mutateTaskFile,
    readTaskFile,
    tasksFilePath,
} from "../store.ts";

function scratch(): string {
    const root = mkdtempSync(join(tmpdir(), "loop-store-"));
    mkdirSync(join(root, ".pi"), { recursive: true });
    return root;
}

function cleanup(root: string): void {
    rmSync(root, { recursive: true, force: true });
}

const T = (id: string) => ({
    id,
    cron: "*/5 * * * *",
    prompt: `p-${id}`,
    createdAt: 1_000,
});

test("readTaskFile: missing file = no tasks", async () => {
    const root = scratch();
    try {
        const { valid, rest } = await readTaskFile(root);
        assert.deepEqual(valid, []);
        assert.deepEqual(rest, []);
    } finally {
        cleanup(root);
    }
});

test("readTaskFile: corrupt JSON throws (caller must not overwrite)", async () => {
    const root = scratch();
    try {
        writeFileSync(tasksFilePath(root), "{ not json", "utf8");
        await assert.rejects(() => readTaskFile(root), /corrupt JSON/);
    } finally {
        cleanup(root);
    }
});

test("readTaskFile: malformed container throws", async () => {
    const root = scratch();
    try {
        writeFileSync(tasksFilePath(root), '{"version":2,"tasks":"nope"}', "utf8");
        await assert.rejects(() => readTaskFile(root), /'tasks' is not an array/);
    } finally {
        cleanup(root);
    }
});

test("readTaskFile: shape-invalid entries survive in rest", async () => {
    const root = scratch();
    try {
        // Missing cron, so not a StoredTask: it must survive in rest, not vanish.
        const noCron = { id: "def3abc4", prompt: "no cron", createdAt: 5 };
        writeFileSync(
            tasksFilePath(root),
            JSON.stringify({ version: 2, tasks: [T("abc1def2"), noCron, { garbage: true }] }),
            "utf8",
        );
        const { valid, rest } = await readTaskFile(root);
        assert.deepEqual(
            valid.map((t) => t.id),
            ["abc1def2"],
        );
        assert.deepEqual(rest, [noCron, { garbage: true }]);
    } finally {
        cleanup(root);
    }
});

test("mutateTaskFile: write-back preserves rest entries verbatim", async () => {
    const root = scratch();
    try {
        await mutateTaskFile(root, (tasks) => {
            tasks.push(T("abc1def2"));
        });
        await mutateTaskFile(root, (tasks) => {
            tasks.push(T("bcd2efa3"));
        });
        // Inject a shape-invalid entry directly, then mutate: it must survive.
        const raw = JSON.parse(readFileSync(tasksFilePath(root), "utf8"));
        raw.tasks.push({ weird: 1 });
        writeFileSync(tasksFilePath(root), `${JSON.stringify(raw, null, 2)}\n`, "utf8");

        const ok = await mutateTaskFile(root, (tasks) => {
            tasks.splice(0, 1);
        });
        assert.equal(ok, true);
        const { valid, rest } = await readTaskFile(root);
        assert.deepEqual(
            valid.map((t) => t.id),
            ["bcd2efa3"],
        );
        assert.deepEqual(rest, [{ weird: 1 }]);
    } finally {
        cleanup(root);
    }
});

test("mutateTaskFile: mutator throwing does not write; error surfaces", async () => {
    const root = scratch();
    try {
        await mutateTaskFile(root, (tasks) => {
            tasks.push(T("abc1def2"));
        });
        await assert.rejects(() =>
            mutateTaskFile(root, () => {
                throw new Error("boom");
            }),
        );
        const { valid } = await readTaskFile(root);
        assert.equal(valid.length, 1);
    } finally {
        cleanup(root);
    }
});

test("isStoredTask: strict shape", () => {
    assert.equal(isStoredTask(T("abc1def2")), true);
    assert.equal(isStoredTask({ garbage: true }), false);
    assert.equal(isStoredTask({ ...T("abc1def2"), createdAt: "x" }), false);
});

test("errnoCode: errno surfaces from fs errors", async () => {
    const root = scratch();
    try {
        // ENOENT surfaces through the store's tolerant read (no throw), so
        // probe errnoCode directly with a read error instead.
        try {
            await import("node:fs/promises").then((fs) =>
                fs.readFile(join(root, "missing-file"), "utf8"),
            );
            assert.fail("expected ENOENT");
        } catch (error) {
            assert.equal(errnoCode(error), "ENOENT");
        }
    } finally {
        cleanup(root);
    }
});

test("readTaskFile: null and primitive entries land in rest, never throw", async () => {
    const root = scratch();
    try {
        // Externally edited file: nulls and numbers are not StoredTasks.
        writeFileSync(
            tasksFilePath(root),
            JSON.stringify({ version: 2, tasks: [null, 42, T("abc1def2")] }),
            "utf8",
        );
        const { valid, rest } = await readTaskFile(root);
        assert.deepEqual(
            valid.map((t) => t.id),
            ["abc1def2"],
        );
        assert.deepEqual(rest, [null, 42]);
    } finally {
        cleanup(root);
    }
});
