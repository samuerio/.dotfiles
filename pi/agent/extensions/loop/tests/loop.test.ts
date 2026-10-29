import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    __testReset,
    buildMissedTaskNotification,
    computeNextCronRun,
    cronToHuman,
    findMissedTasks,
    jitteredNextCronRunMs,
    legacyToStored,
    nextCronRunMs,
    oneShotJitteredNextCronRunMs,
    parseCronDetailed,
} from "../../loop.ts";

// loop.ts's file IO uses module state set via __testReset.

async function withScratchRepoAsync(
    body: (root: string) => Promise<void>,
): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "loop-test-"));
    try {
        __testReset({ repoRoot: root, sessionId: "test-session" });
        await body(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
        __testReset();
    }
}

// ─── cron parsing ─────────────────────────────────────────────────

test("parseCronDetailed accepts lists, ranges, steps and the DoW 7 alias", () => {
    const parsed = parseCronDetailed("0,30 9-17 */3 1 5-7");
    assert.ok("fields" in parsed);
    assert.deepEqual(parsed.fields.minute, [0, 30]);
    assert.deepEqual(parsed.fields.hour, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
    // claude sorts numerically after mapping 7→0, so Sunday lands first.
    assert.deepEqual(parsed.fields.dayOfWeek, [0, 5, 6]); // 7 → Sunday
});

test("parseCronDetailed rejects out-of-range values and bad shapes", () => {
    for (const cron of [
        "60 * * * *",
        "* 24 * * *",
        "0 0 L * *",
        "0 0 * * 7-8",
        "0 0 * *",
        "0 0 * * 1,banana",
    ]) {
        const parsed = parseCronDetailed(cron);
        assert.ok("error" in parsed, `expected rejection for ${cron}`);
    }
});

test("parseCronDetailed rejects steps larger than the field span ([v5])", () => {
    // 0 0 */40 * * would collapse to monthly; */90 to hourly; 0 */30 to daily.
    for (const cron of ["0 0 */40 * *", "*/90 * * * *", "0 */30 * * *", "0-10/15 * * * *"]) {
        const parsed = parseCronDetailed(cron);
        assert.ok("error" in parsed, `expected step-span rejection for ${cron}`);
        assert.match((parsed as { error: string }).error, /step/i);
    }
    // At-span steps are accepted.
    assert.ok("fields" in parseCronDetailed("*/59 * * * *"));
    assert.ok("fields" in parseCronDetailed("0-10/10 * * * *"));
});

test("computeNextCronRun walks minute-by-minute and honors OR day semantics", () => {
    // Jan 27 2026 is a Tuesday. dom=27 OR dow=2 → both match that day.
    const fields = parseCronDetailed("30 14 27 1 2");
    assert.ok("fields" in fields);
    const from = new Date(2026, 0, 27, 14, 0, 0).getTime();
    const next = computeNextCronRun(fields.fields, new Date(from));
    assert.ok(next);
    assert.equal(next.getTime(), new Date(2026, 0, 27, 14, 30, 0).getTime());
});

test("nextCronRunMs returns null when no match within a year", () => {
    // Sparse DoM beyond the wall-clock cap: Feb 29 from 2025-03-01 first
    // matches 2028-02-29 — more than a year out, so null (plan §2.2).
    const from = new Date(2025, 2, 1).getTime();
    assert.equal(nextCronRunMs("0 0 29 2 *", from), null);
    // Same shape, first match inside the year: Feb 28 → 2026-02-28.
    const within = nextCronRunMs("0 0 28 2 *", from);
    assert.ok(within !== null);
    assert.equal(new Date(within).getFullYear(), 2026);
});

test("nextCronRunMs is strictly monotonic: next is always after from", () => {
    const from = Date.now();
    const next = nextCronRunMs("* * * * *", from);
    assert.ok(next !== null && next > from);
});

// ─── cronToHuman ──────────────────────────────────────────────────

test("cronToHuman renders common shapes", () => {
    assert.equal(cronToHuman("*/5 * * * *"), "Every 5 minutes");
    assert.equal(cronToHuman("0 * * * *"), "Every hour");
    assert.equal(cronToHuman("7 * * * *"), "Every hour at :07");
    assert.equal(cronToHuman("0 */6 * * *"), "Every 6 hours");
    assert.equal(cronToHuman("57 8 * * *").startsWith("Every day at"), true);
    assert.equal(cronToHuman("57 8 * * 1").startsWith("Every Monday at"), true);
    assert.equal(cronToHuman("57 8 * * 1-5").startsWith("Weekdays at"), true);
});

test("cronToHuman falls back to the raw string for unrecognized shapes", () => {
    const pinned = "30 14 28 2 *";
    assert.equal(cronToHuman(pinned), pinned);
});

// ─── jitter ───────────────────────────────────────────────────────

test("jitteredNextCronRunMs is deterministic per task id and within 10%/15min", () => {
    const from = Date.now();
    const a1 = jitteredNextCronRunMs("0 * * * *", from, "aaaaaaaa");
    const a2 = jitteredNextCronRunMs("0 * * * *", from, "aaaaaaaa");
    assert.equal(a1, a2);
    assert.ok(a1 !== null);
    const t1 = nextCronRunMs("0 * * * *", from)!;
    const t2 = nextCronRunMs("0 * * * *", t1)!;
    const jitter = a1! - t1;
    assert.ok(jitter >= 0 && jitter <= Math.min(0.1 * (t2 - t1), 15 * 60_000));
});

test("one-shot jitter anchors from createdAt and clamps to fromMs", () => {
    // Created inside its own lead window: :00 cron created at HH:59:30 with
    // an id whose lead exceeds 30s, so the clamp (not the jitter) decides.
    const createdAt = new Date(2026, 0, 27, 14, 59, 30).getTime();
    const next = oneShotJitteredNextCronRunMs("0 * * * *", createdAt, "ffffffff");
    assert.ok(next !== null);
    assert.equal(next, createdAt, "clamped to createdAt (never fires before it exists)");
});

test("one-shot jitter only applies on :00/:30 local minutes", () => {
    const from = new Date(2026, 0, 27, 14, 0, 0).getTime(); // next: 14:07
    const next = oneShotJitteredNextCronRunMs("7 * * * *", from, "12345678");
    assert.equal(next, nextCronRunMs("7 * * * *", from));
});

// ─── storage ──────────────────────────────────────────────────────

test("file IO: missing file reads empty, create/delete round-trips, no tmp leftovers", async () => {
    await withScratchRepoAsync(async (root) => {
        const file = join(root, ".pi", "loop-tasks.json");
        assert.ok(!existsSync(file));
        const { mutateTaskFile, readTaskFile } = await import("../../loop.ts");
        await mutateTaskFile((tasks) => {
            tasks.push({ id: "aabbccdd", cron: "*/5 * * * *", prompt: "hi", createdAt: 1, recurring: true });
        });
        assert.ok(existsSync(file));
        const after = await readTaskFile();
        assert.equal(after.valid.length, 1);
        assert.equal(after.valid[0].id, "aabbccdd");
        await mutateTaskFile((tasks) => {
            tasks.splice(0, 1);
        });
        const final = await readTaskFile();
        assert.equal(final.valid.length, 0);
        // Unique temp files are renamed away — no .tmp entries beside the
        // target file (a leftover temp lives in the directory, not inside
        // the JSON payload).
        const dirEntries = readdirSync(join(root, ".pi"));
        assert.equal(dirEntries.filter((name) => name.includes(".tmp")).length, 0);
    });
});

test("owner lock: same live pid under a new session id re-acquires (session replacement)", async () => {
    await withScratchRepoAsync(async (root) => {
        const { __testReset, tryAcquireOwnerLock } = await import("../../loop.ts");
        const lockFile = join(root, ".pi", "loop-tasks.lock");
        // Simulate a /new-style replacement: the previous session released
        // nothing, so the lock names OUR live pid under the OLD session id.
        mkdirSync(join(root, ".pi"), { recursive: true });
        writeFileSync(
            lockFile,
            `${JSON.stringify({ sessionId: "old-session", pid: process.pid, acquiredAt: Date.now() })}\n`,
        );
        __testReset({ repoRoot: root, sessionId: "new-session" });
        assert.equal(await tryAcquireOwnerLock(), true, "same-process pid must re-acquire");
        const lock = JSON.parse(readFileSync(lockFile, "utf8"));
        assert.equal(lock.sessionId, "new-session");
        assert.equal(lock.pid, process.pid);
    });
});

test("owner lock: live foreign pid is never stolen", async () => {
    await withScratchRepoAsync(async (root) => {
        const { __testReset, tryAcquireOwnerLock } = await import("../../loop.ts");
        const { spawn } = await import("node:child_process");
        const child = spawn("sleep", ["10"]);
        try {
            mkdirSync(join(root, ".pi"), { recursive: true });
            writeFileSync(
                join(root, ".pi", "loop-tasks.lock"),
                `${JSON.stringify({ sessionId: "other", pid: child.pid, acquiredAt: Date.now() })}\n`,
            );
            __testReset({ repoRoot: root, sessionId: "mine" });
            assert.equal(await tryAcquireOwnerLock(), false);
            // Untouched: still the other session's lock.
            const lock = JSON.parse(readFileSync(join(root, ".pi", "loop-tasks.lock"), "utf8"));
            assert.equal(lock.sessionId, "other");
        } finally {
            child.kill();
        }
    });
});

test("file IO: corrupt JSON throws (never silently overwritten)", async () => {
    await withScratchRepoAsync(async (root) => {
        const file = join(root, ".pi", "loop-tasks.json");
        mkdirSync(join(root, ".pi"), { recursive: true });
        writeFileSync(file, "{not json");
        const { mutateTaskFile } = await import("../../loop.ts");
        await assert.rejects(() => mutateTaskFile(() => {}));
        assert.equal(readFileSync(file, "utf8"), "{not json");
    });
});

test("file IO: shape-invalid entries are preserved verbatim on write-back", async () => {
    await withScratchRepoAsync(async (root) => {
        const file = join(root, ".pi", "loop-tasks.json");
        mkdirSync(join(root, ".pi"), { recursive: true });
        writeFileSync(
            file,
            JSON.stringify({
                version: 2,
                tasks: [{ id: "ok1", cron: "* * * * *", prompt: "fine", createdAt: 1 }, { garbage: true }],
            }),
        );
        const { mutateTaskFile, readTaskFile } = await import("../../loop.ts");
        await mutateTaskFile((tasks) => {
            tasks.push({ id: "new1", cron: "0 9 * * *", prompt: "x", createdAt: 2, recurring: true });
        });
        const raw = JSON.parse(readFileSync(file, "utf8"));
        assert.equal(raw.version, 2);
        assert.equal(raw.tasks.filter((t: { id?: string }) => t.id === "ok1").length, 1);
        assert.equal(raw.tasks.filter((t: { garbage?: boolean }) => t.garbage === true).length, 1);
        assert.equal(raw.tasks.filter((t: { id?: string }) => t.id === "new1").length, 1);
        const read = await readTaskFile();
        assert.equal(read.valid.length, 2);
    });
});

// ─── migration ────────────────────────────────────────────────────

test("migration: v1 → v2 stamps recurring lastFiredAt (anti-herd) and is idempotent", async () => {
    await withScratchRepoAsync(async (root) => {
        const file = join(root, ".pi", "loop-tasks.json");
        mkdirSync(join(root, ".pi"), { recursive: true });
        const v1 = {
            version: 1,
            tasks: [
                {
                    id: "aabbccdd",
                    cron: "*/5 * * * *",
                    intervalMs: 300_000,
                    prompt: "recurring job",
                    createdAt: Date.now() - 60_000,
                    lastFiredAt: Date.now() - 60_000,
                    recurring: true,
                },
                {
                    id: "11223344",
                    cron: "0 9 * * *",
                    intervalMs: 86_400_000,
                    prompt: "one-shot job",
                    createdAt: Date.now() - 120_000,
                    lastFiredAt: Date.now() - 120_000,
                    recurring: false,
                },
            ],
        };
        writeFileSync(file, JSON.stringify(v1));
        const { migrateTaskFile } = await import("../../loop.ts");
        await migrateTaskFile();

        const migrated = JSON.parse(readFileSync(file, "utf8"));
        assert.equal(migrated.version, 2);
        const recurring = migrated.tasks.find((t: { id: string }) => t.id === "aabbccdd");
        const oneShot = migrated.tasks.find((t: { id: string }) => t.id === "11223344");
        assert.ok(recurring.lastFiredAt > Date.now() - 5000, "recurring lastFiredAt = now (no fire stampede)");
        assert.equal(recurring.intervalMs, undefined, "legacy fields stripped");
        assert.equal(recurring.paused, undefined);
        assert.equal(recurring.failureCount, undefined);
        assert.equal(oneShot.lastFiredAt, undefined, "one-shot keeps createdAt anchor");
        assert.equal(oneShot.recurring, undefined);

        // Second run is a no-op (already v2).
        const before = readFileSync(file, "utf8");
        await migrateTaskFile();
        assert.equal(readFileSync(file, "utf8"), before);
    });
});

test("migration: leaves corrupt files alone (read/mutate fail loudly later)", async () => {
    await withScratchRepoAsync(async (root) => {
        const file = join(root, ".pi", "loop-tasks.json");
        mkdirSync(join(root, ".pi"), { recursive: true });
        writeFileSync(file, "{broken");
        const { migrateTaskFile } = await import("../../loop.ts");
        await migrateTaskFile();
        assert.equal(readFileSync(file, "utf8"), "{broken");
    });
});

// ─── legacy conversion / missed detection ─────────────────────────

test("legacyToStored converts v1 entries; recurring gets lastFiredAt=now", () => {
    const now = Date.now();
    const stored = legacyToStored({
        id: "aabbccdd",
        cron: "*/5 * * * *",
        intervalMs: 300_000,
        prompt: "x",
        createdAt: now - 60_000,
        recurring: true,
        paused: true,
        failureCount: 2,
    });
    assert.ok(stored);
    assert.equal(stored.recurring, true);
    assert.ok((stored.lastFiredAt ?? 0) >= now - 5000);
    assert.equal("paused" in stored, false);
    assert.equal("intervalMs" in stored, false);
    assert.equal(legacyToStored({ id: "x" }), undefined);
});

test("findMissedTasks: past one-shots only", () => {
    const now = Date.now();
    const missed = { id: "aabbccdd", cron: "0 8 * * *", prompt: "p", createdAt: now - 86_400_000 };
    const future = { id: "11bbccdd", cron: "0 8 * * *", prompt: "p", createdAt: now + 60_000 };
    const recurring = { id: "22bbccdd", cron: "0 8 * * *", prompt: "p", createdAt: now - 86_400_000, recurring: true };
    const result = findMissedTasks([missed, future, recurring], now);
    assert.deepEqual(result.map((t) => t.id), ["aabbccdd"]);
});

// ─── missed notification ──────────────────────────────────────────

test("missed notification uses an injection-safe fence and ask-first wording", () => {
    const now = Date.now();
    const text = buildMissedTaskNotification([
        { id: "aabbccdd", cron: "0 8 * * *", prompt: "```\nsneaky\n```", createdAt: now },
    ]);
    assert.match(text, /already been removed/);
    assert.match(text, /ask the user/i);
    // No backtick run inside the prompt can close the fence early.
    const fence = text.split("\n").find((line) => /^`+$/.test(line)) ?? "";
    assert.ok(fence.length > 3);
});
