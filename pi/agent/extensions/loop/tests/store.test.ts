// store.test.ts — direct tests for store.ts (task-file persistence).
// Unlike loop.test.ts these need no __testReset hooks: every store
// function takes the repo root explicitly, so each test targets a fresh
// scratch directory.
import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    existsSync,
    writeFileSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    errnoCode,
    isStoredTask,
    legacyToStored,
    mutateTaskFile,
    migrateTaskFile,
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

test("readTaskFile: shape-invalid entries survive in rest; v1 entries convert", async () => {
    const root = scratch();
    try {
        writeFileSync(
            tasksFilePath(root),
            JSON.stringify({
                version: 2,
                tasks: [
                    T("abc1def2"),
                    { garbage: true },
                    { id: "def3abc4", cron: "0 9 * * *", prompt: "legacy", createdAt: 5 },
                ],
            }),
            "utf8",
        );
        const { valid, rest } = await readTaskFile(root);
        assert.equal(valid.length, 2);
        assert.equal(valid[1].id, "def3abc4");
        assert.deepEqual(rest, [{ garbage: true }]);
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

test("migrateTaskFile: missing and already-v2 files are no-ops", async () => {
    const root = scratch();
    try {
        await migrateTaskFile(root); // no file: fine
        assert.equal(existsSync(tasksFilePath(root)), false);
        await mutateTaskFile(root, (tasks) => {
            tasks.push(T("abc1def2"));
        });
        const before = readFileSync(tasksFilePath(root), "utf8");
        await migrateTaskFile(root); // v2 already: byte-identical
        assert.equal(readFileSync(tasksFilePath(root), "utf8"), before);
    } finally {
        cleanup(root);
    }
});

test("migrateTaskFile: v1 file is rewritten as v2 with lastFiredAt stamped", async () => {
    const root = scratch();
    try {
        writeFileSync(
            tasksFilePath(root),
            JSON.stringify({
                version: 1,
                tasks: [
                    {
                        id: "def3abc4",
                        cron: "0 9 * * *",
                        prompt: "legacy",
                        createdAt: 5,
                        recurring: true,
                        intervalMs: 60_000,
                        failureCount: 2,
                    },
                ],
            }),
            "utf8",
        );
        await migrateTaskFile(root);
        const { valid } = await readTaskFile(root);
        assert.equal(valid.length, 1);
        assert.equal(valid[0].recurring, true);
        assert.ok(typeof valid[0].lastFiredAt === "number");
        assert.ok(!("intervalMs" in valid[0]));
        assert.ok(!("failureCount" in valid[0]));
    } finally {
        cleanup(root);
    }
});

test("isStoredTask / legacyToStored: strict shape, defensive conversion", () => {
    assert.equal(isStoredTask(T("abc1def2")), true);
    assert.equal(isStoredTask({ garbage: true }), false);
    assert.equal(isStoredTask({ ...T("abc1def2"), createdAt: "x" }), false);

    const converted = legacyToStored({ ...T("def3abc4"), recurring: true });
    assert.ok(converted);
    // lastFiredAt is stamped to Date.now(); assert only its type so the
    // assertion cannot race a millisecond boundary against itself.
    assert.equal(typeof converted.lastFiredAt, "number");
    const { lastFiredAt: _stampedAt, ...remainder } = converted;
    assert.deepEqual(remainder, {
        id: "def3abc4",
        cron: "*/5 * * * *",
        prompt: "p-def3abc4",
        createdAt: 1_000,
        recurring: true,
    });
    assert.equal(legacyToStored({ id: "x" }), undefined);
    assert.equal(legacyToStored({ ...T("x"), cron: 5 }), undefined);
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
        // Externally edited file: null / numbers are not legacy candidates.
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
