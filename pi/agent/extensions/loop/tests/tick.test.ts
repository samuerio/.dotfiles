// Tick-ordering regression tests: drive the real extension with a fake pi
// runtime and observe fire cadence, one-shot inject-then-delete ordering,
// and the retry-after-failed-injection path.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Harness = {
    root: string;
    handlers: Map<string, Function>;
    fires: string[];
    idle: { value: boolean };
    failFirstSends: { remaining: number };
    cleanup: () => void;
};

async function startHarness(sessionId: string): Promise<Harness> {
    const root = mkdtempSync(join(tmpdir(), "loop-tick-"));
    mkdirSync(join(root, ".pi"), { recursive: true });
    const handlers = new Map<string, Function>();
    const fires: string[] = [];
    const idle = { value: true };
    const failFirstSends = { remaining: 0 };

    const pi: any = {
        on(event: string, handler: Function) {
            handlers.set(event, handler);
        },
        registerTool() {},
        registerEntryRenderer() {},
        registerCommand() {},
        sendMessage(message: any, options: any) {
            if (failFirstSends.remaining > 0) {
                failFirstSends.remaining--;
                throw new Error("simulated send failure");
            }
            fires.push(`${message.content}|${JSON.stringify(options)}`);
        },
        appendEntry() {},
        exec: async () => ({ code: 1, stdout: "", stderr: "" }),
        sendUserMessage() {},
    };
    const ctx: any = {
        mode: "tui",
        isIdle: () => idle.value,
        cwd: root,
        sessionManager: { getSessionId: () => sessionId },
        ui: { notify: () => {} },
    };

    const mod = await import("../../loop.ts");
    mod.__testReset({ repoRoot: root, sessionId });
    mod.default(pi);
    await handlers.get("session_start")!({ type: "session_start" }, ctx);

    return {
        root,
        handlers,
        fires,
        idle,
        failFirstSends,
        cleanup: () => {
            handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
            rmSync(root, { recursive: true, force: true });
            mod.__testReset();
        },
    };
}

test("recurring session task fires once, not once per turn", async () => {
    const h = await startHarness("tick-s1");
    try {
        const { __testAddSessionTask } = await import("../../loop.ts");
        __testAddSessionTask({
            id: "aabbccdd",
            cron: "* * * * *",
            prompt: "tick probe",
            createdAt: Date.now() - 120_000,
            recurring: true,
        });

        await sleep(3500); // first fire on an idle session
        assert.equal(h.fires.length, 1, `expected exactly 1 fire, got ${h.fires.length}`);

        // Simulate a turn: busy 2s, then settle + idle again.
        h.idle.value = false;
        await sleep(2000);
        h.idle.value = true;
        h.handlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, h);
        await sleep(3000);

        assert.equal(h.fires.length, 1, "must not re-fire after the turn settles");
    } finally {
        h.cleanup();
    }
});

test("durable one-shot: injected first, then removed from disk", async () => {
    const h = await startHarness("tick-s2");
    try {
        // Due on the current minute. The session just started, so the
        // missed-task surface has already run — this exercises the tick path.
        const now = new Date();
        const cron = `${now.getMinutes()} * * * *`;
        const file = join(h.root, ".pi", "loop-tasks.json");
        writeFileSync(
            file,
            `${JSON.stringify({
                version: 2,
                tasks: [{ id: "bbccddee", cron, prompt: "one-shot probe", createdAt: Date.now() - 90_000 }],
            })}\n`,
        );

        await sleep(3000);

        assert.equal(h.fires.length, 1, `expected exactly 1 fire, got ${h.fires.length}`);
        assert.ok(h.fires[0].includes("one-shot probe"));
        assert.ok(
            JSON.parse(h.fires[0].split("|")[1]).triggerTurn === true,
            "fire must trigger a turn",
        );
        const after = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { tasks: [] };
        assert.equal(after.tasks.length, 0, "fired one-shot must be deleted from disk");
    } finally {
        h.cleanup();
    }
});

test("durable one-shot with failed injection stays on disk and retries", async () => {
    // Needs ~5s inside the current minute; skip if we're too close to the
    // boundary (a retry past the minute would correctly schedule tomorrow).
    if (Date.now() % 60_000 > 54_000) return;
    const h = await startHarness("tick-s3");
    try {
        const now = new Date();
        const cron = `${now.getMinutes()} * * * *`;
        const file = join(h.root, ".pi", "loop-tasks.json");
        writeFileSync(
            file,
            `${JSON.stringify({
                version: 2,
                tasks: [{ id: "cceeff00", cron, prompt: "retry probe", createdAt: Date.now() - 90_000 }],
            })}\n`,
        );
        h.failFirstSends.remaining = 1;

        await sleep(4000);

        assert.equal(h.fires.length, 1, "the retry must deliver exactly one injection");
        assert.ok(h.fires[0].includes("retry probe"));
        const after = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { tasks: [] };
        assert.equal(after.tasks.length, 0, "delivered one-shot is deleted after the retry");
    } finally {
        h.cleanup();
    }
});
