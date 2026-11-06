/**
 * run.ts tests: launch line, metadata state machine, timeout + signal
 * escalation, effective-state derivation, /proc parsing, session JSONL reading.
 *
 * The fake `pi` binary is a shell script selected through PI_SCHEDULE_PI_BIN, so
 * no real agent is ever started. Timeouts are shrunk through
 * PI_SCHEDULE_TEST_TIMEOUT_MS / PI_SCHEDULE_TEST_GRACE_MS.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    activeRun,
    buildLaunchArgs,
    claimRun,
    effectiveState,
    executeRun,
    listRuns,
    parseProcStatStartTime,
    processAlive,
    readLatestAssistant,
    readMetadata,
    readPidStartTime,
    readRunSummary,
    sessionPath,
    writeMetadata,
} from "../run.ts";
import type { RunMetadata } from "../run.ts";

const TASK = "aaaaaaaa";
const STAMP_A = "20260101-000000";
const STAMP_B = "20260101-000001";

function makeScratch(): string {
    const root = mkdtempSync(join(tmpdir(), "schedule-run-test-"));
    process.env.PI_CODING_AGENT_DIR = root;
    return root;
}

function cleanupScratch(root: string): void {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(root, { recursive: true, force: true });
}

function applyEnv(patch: Record<string, string | undefined>): () => void {
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(patch)) {
        saved[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    return () => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
}

function writeFakePi(root: string, body: string): void {
    const path = join(root, "fake-pi");
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { encoding: "utf8", mode: 0o755 });
    chmodSync(path, 0o755);
}

const DUMP_BODY = `
{
    for a in "$@"; do printf 'ARG:%s\\n' "$a"; done
    printf 'CWD:%s\\n' "$(pwd)"
    printf 'SESSION:%s\\n' "$([ -f "$PI_SCHEDULE_RUN_DIR/session.jsonl" ] && echo yes || echo no)"
    printf 'PROMPT_BYTES:%s\\n' "$(wc -c < "$PI_SCHEDULE_RUN_DIR/prompt.md" | tr -d ' ')"
} > "$FAKE_PI_DUMP"
exit 0
`;

function dumpLines(path: string): string[] {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
}

function expectedArgLines(taskId: string, runDir: string): string[] {
    return buildLaunchArgs({ taskId, runDir }).map((arg) => `ARG:${arg}`);
}

test("launch: foreground and detached share argv/cwd, differing only in spawn options", async () => {
    const root = makeScratch();
    const restore = applyEnv({
        PI_SCHEDULE_PI_BIN: undefined,
        FAKE_PI_DUMP: undefined,
        PI_SCHEDULE_TEST_TIMEOUT_MS: "20000",
        PI_SCHEDULE_TEST_GRACE_MS: "500",
    });
    try {
        writeFakePi(root, DUMP_BODY);
        process.env.PI_SCHEDULE_PI_BIN = join(root, "fake-pi");

        const dumpDetached = join(root, "dump-detached.txt");
        const dumpForeground = join(root, "dump-foreground.txt");

        process.env.FAKE_PI_DUMP = dumpDetached;
        const dirDetached = claimRun(TASK, STAMP_A);
        const codeDetached = await executeRun({
            taskId: TASK,
            stamp: STAMP_A,
            trigger: "scheduled",
            foreground: false,
            cwd: root,
            promptText: "detached prompt",
        });

        process.env.FAKE_PI_DUMP = dumpForeground;
        const dirForeground = claimRun(TASK, STAMP_B);
        const codeForeground = await executeRun({
            taskId: TASK,
            stamp: STAMP_B,
            trigger: "manual",
            foreground: true,
            cwd: root,
            promptText: "detached prompt",
        });

        assert.equal(codeDetached, 0);
        assert.equal(codeForeground, 0);
        assert.equal(dirDetached, join(root, "schedule", "runs", TASK, STAMP_A));
        assert.equal(dirForeground, join(root, "schedule", "runs", TASK, STAMP_B));

        const detachedLines = dumpLines(dumpDetached);
        const foregroundLines = dumpLines(dumpForeground);
        // Same argv, same cwd, same prompt bytes, session pre-created.
        assert.deepEqual(
            detachedLines.filter((line) => !line.startsWith("SESSION:")),
            [
                ...expectedArgLines(TASK, dirDetached),
                `CWD:${root}`,
                "PROMPT_BYTES:15",
            ],
        );
        assert.deepEqual(
            foregroundLines.filter((line) => !line.startsWith("SESSION:")),
            [...expectedArgLines(TASK, dirForeground), `CWD:${root}`, "PROMPT_BYTES:15"],
        );
        assert.ok(detachedLines.includes("SESSION:yes"));
        assert.ok(foregroundLines.includes("SESSION:yes"));

        const detachedMeta = readMetadata(dirDetached);
        const foregroundMeta = readMetadata(dirForeground);
        assert.ok(detachedMeta && foregroundMeta);
        // Only the process-group supervision differs.
        assert.equal(detachedMeta.pgid, detachedMeta.pid);
        assert.equal(detachedMeta.helperPid, process.pid);
        assert.equal(foregroundMeta.pgid, null);
        // A foreground run is supervised in-process, so the helper *is* this
        // process: if it dies while pi survives, `effectiveState` must say
        // `orphan` rather than a forever-`running` ghost.
        assert.equal(foregroundMeta.helperPid, process.pid);
        assert.equal(detachedMeta.state, "exited");
        assert.equal(foregroundMeta.state, "exited");
        assert.equal(detachedMeta.exitCode, 0);
        assert.equal(detachedMeta.launchArgs.length, 8);
        assert.deepEqual(detachedMeta.launchArgs, buildLaunchArgs({ taskId: TASK, runDir: dirDetached }));
    } finally {
        restore();
        cleanupScratch(root);
    }
});

test("launch line: prompt goes after `--` as an @file, session path is explicit", () => {
    const args = buildLaunchArgs({ taskId: TASK, runDir: "/tmp/run" });
    assert.deepEqual(args, [
        "-p",
        "--approve",
        "--name",
        "schedule:aaaaaaaa",
        "--session",
        "/tmp/run/session.jsonl",
        "--",
        "@/tmp/run/prompt.md",
    ]);
    // The path must never be reachable as a flag: `--` comes first, `@` marks a file.
    assert.ok(args.indexOf("--") < args.indexOf("@/tmp/run/prompt.md"));
    assert.ok(args.every((arg) => arg !== "--no-extensions"));
});

test("launch line: a resolved route pin goes before the session flags", () => {
    const route = {
        provider: "engy",
        modelId: "deepseek-v4.1-flash",
        thinkingLevel: "high" as const,
        source: "/x/modes.json",
    };
    const args = buildLaunchArgs({ taskId: TASK, runDir: "/tmp/run", route });
    assert.deepEqual(args, [
        "-p",
        "--approve",
        "--provider",
        "engy",
        "--model",
        "deepseek-v4.1-flash",
        "--thinking",
        "high",
        "--name",
        "schedule:aaaaaaaa",
        "--session",
        "/tmp/run/session.jsonl",
        "--",
        "@/tmp/run/prompt.md",
    ]);
    // The prompt must stay after `--` even with the pin in front.
    assert.ok(args.indexOf("--") < args.indexOf("@/tmp/run/prompt.md"));
});

test("executeRun records the route in metadata", async () => {
    const root = makeScratch();
    const restore = applyEnv({
        PI_SCHEDULE_PI_BIN: join(root, "fake-pi"),
        FAKE_PI_DUMP: join(root, "dump.txt"),
        PI_SCHEDULE_TEST_TIMEOUT_MS: "20000",
        PI_SCHEDULE_TEST_GRACE_MS: "500",
    });
    try {
        writeFakePi(root, DUMP_BODY);
        claimRun(TASK, STAMP_A);
        const route = {
            provider: "engy",
            modelId: "deepseek-v4.1-flash",
            thinkingLevel: "high" as const,
            source: "/x/modes.json",
        };
        const code = await executeRun({
            taskId: TASK,
            stamp: STAMP_A,
            trigger: "scheduled",
            foreground: false,
            cwd: root,
            promptText: "hello",
            route,
        });
        assert.equal(code, 0);
        const metadata = readMetadata(join(root, "schedule", "runs", TASK, STAMP_A));
        assert.deepEqual(metadata?.modelRoute, route);
        assert.ok(metadata?.launchArgs.includes("--provider"));
    } finally {
        restore();
        cleanupScratch(root);
    }
});

test("prompt over MAX_ARG_STRLEN is delivered through the file, not argv", async () => {
    const root = makeScratch();
    const restore = applyEnv({
        PI_SCHEDULE_PI_BIN: join(root, "fake-pi"),
        FAKE_PI_DUMP: join(root, "dump.txt"),
        PI_SCHEDULE_TEST_TIMEOUT_MS: "20000",
        PI_SCHEDULE_TEST_GRACE_MS: "500",
    });
    try {
        writeFakePi(root, DUMP_BODY);
        const prompt = `HEAD${"y".repeat(200_000)}TAIL`;
        claimRun(TASK, STAMP_A);
        const code = await executeRun({
            taskId: TASK,
            stamp: STAMP_A,
            trigger: "manual",
            foreground: false,
            cwd: root,
            promptText: prompt,
        });
        assert.equal(code, 0);
        const lines = dumpLines(join(root, "dump.txt"));
        assert.ok(lines.includes(`PROMPT_BYTES:${Buffer.byteLength(prompt)}`));
        // No argv element carries the prompt body.
        assert.ok(lines.every((line) => !line.includes("yyyy")));
        const dir = join(root, "schedule", "runs", TASK, STAMP_A);
        assert.equal(readMetadata(dir)?.sessionFile, sessionPath(dir));
    } finally {
        restore();
        cleanupScratch(root);
    }
});

test("timeout: state becomes killed before the signal, and killed is terminal", async () => {
    const root = makeScratch();
    const restore = applyEnv({
        PI_SCHEDULE_PI_BIN: join(root, "fake-pi"),
        PI_SCHEDULE_TEST_TIMEOUT_MS: "300",
        PI_SCHEDULE_TEST_GRACE_MS: "5000",
    });
    try {
        // On SIGTERM the fake pi exits 0: the run must stay `killed`, and the
        // observed exit code is recorded underneath that terminal state.
        writeFakePi(root, `trap 'exit 0' TERM\nsleep 60`);
        const dir = claimRun(TASK, STAMP_A);
        const code = await executeRun({
            taskId: TASK,
            stamp: STAMP_A,
            trigger: "scheduled",
            foreground: false,
            cwd: root,
            promptText: "slow",
        });
        const metadata = readMetadata(dir);
        assert.ok(metadata);
        assert.equal(code, 124);
        assert.equal(metadata.state, "killed");
        assert.ok(metadata.killedAt);
        assert.ok(metadata.finishedAt);
        assert.notEqual(metadata.state, "exited");
        assert.equal(effectiveState(metadata), "killed");
    } finally {
        restore();
        cleanupScratch(root);
    }
});

test("timeout: escalates to SIGKILL after the grace period", async () => {
    const root = makeScratch();
    const restore = applyEnv({
        PI_SCHEDULE_PI_BIN: join(root, "fake-pi"),
        PI_SCHEDULE_TEST_TIMEOUT_MS: "200",
        PI_SCHEDULE_TEST_GRACE_MS: "300",
    });
    try {
        writeFakePi(root, `trap '' TERM\nsleep 60`);
        const dir = claimRun(TASK, STAMP_A);
        const startedAt = Date.now();
        const code = await executeRun({
            taskId: TASK,
            stamp: STAMP_A,
            trigger: "scheduled",
            foreground: false,
            cwd: root,
            promptText: "stubborn",
        });
        const elapsed = Date.now() - startedAt;
        assert.equal(code, 124);
        assert.ok(elapsed >= 450, `expected timeout+grace before returning, took ${elapsed}ms`);
        assert.equal(readMetadata(dir)?.state, "killed");
    } finally {
        restore();
        cleanupScratch(root);
    }
});

test("foreground timeout kills the pid only, never the caller's process group", async () => {
    const root = makeScratch();
    const restore = applyEnv({
        PI_SCHEDULE_PI_BIN: join(root, "fake-pi"),
        PI_SCHEDULE_TEST_TIMEOUT_MS: "200",
        PI_SCHEDULE_TEST_GRACE_MS: "200",
    });
    // Sentinel shares the test process's group: a group kill would take it down.
    const sentinel = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
        writeFakePi(root, `exec sleep 60`);
        const dir = claimRun(TASK, STAMP_A);
        const code = await executeRun({
            taskId: TASK,
            stamp: STAMP_A,
            trigger: "manual",
            foreground: true,
            cwd: root,
            promptText: "foreground",
        });
        assert.equal(code, 124);
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(readMetadata(dir)?.state, "killed");
        assert.ok(
            typeof sentinel.pid === "number" && processAlive(sentinel.pid),
            "sentinel in the caller's process group must survive a foreground timeout",
        );
    } finally {
        if (typeof sentinel.pid === "number") {
            try {
                sentinel.kill("SIGKILL");
            } catch {
                // already gone
            }
        }
        restore();
        cleanupScratch(root);
    }
});

test("containment: a tool child that starts its own session escapes the group kill", { skip: !existsSync("/usr/bin/setsid") }, async () => {
    const root = makeScratch();
    const grandchildFile = join(root, "grandchild.pid");
    const restore = applyEnv({
        PI_SCHEDULE_PI_BIN: join(root, "fake-pi"),
        PI_SCHEDULE_TEST_TIMEOUT_MS: "200",
        PI_SCHEDULE_TEST_GRACE_MS: "200",
        FAKE_PI_GRANDCHILD: grandchildFile,
    });
    try {
        // Mirrors reality: pi's bash tool spawns commands with detached: true,
        // so tool grandchildren are NOT in pi's process group. What reaps them is
        // pi's own SIGTERM handler, not our group kill — this test pins the
        // limitation instead of pretending otherwise.
        writeFakePi(root, `setsid sleep 30 &\necho $! > "$FAKE_PI_GRANDCHILD"\nsleep 60`);
        claimRun(TASK, STAMP_A);
        const code = await executeRun({
            taskId: TASK,
            stamp: STAMP_A,
            trigger: "scheduled",
            foreground: false,
            cwd: root,
            promptText: "escapes",
        });
        assert.equal(code, 124);
        const grandchild = Number(readFileSync(grandchildFile, "utf8").trim());
        assert.ok(Number.isFinite(grandchild) && grandchild > 0);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.ok(
            processAlive(grandchild),
            "own-session grandchild survives: SIGTERM-to-pi is what reaps tool children",
        );
        try {
            process.kill(grandchild, "SIGKILL");
        } catch {
            // already gone
        }
    } finally {
        restore();
        cleanupScratch(root);
    }
});

test("effectiveState: dead helper with live pi is an orphan, not a running job", async () => {
    const root = makeScratch();
    const pi = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
        const dir = claimRun(TASK, STAMP_A);
        const deadHelper = spawn("sleep", ["30"], { stdio: "ignore" });
        try {
            assert.ok(typeof pi.pid === "number" && typeof deadHelper.pid === "number");
            deadHelper.kill("SIGKILL");
            await new Promise((resolve) => setTimeout(resolve, 50));
            const metadata: RunMetadata = {
                version: 1,
                taskId: TASK,
                trigger: "scheduled",
                state: "running",
                pid: pi.pid as number,
                pgid: pi.pid as number,
                pidStartTime: readPidStartTime(pi.pid as number),
                helperPid: deadHelper.pid as number,
                startedAt: new Date().toISOString(),
                sessionFile: sessionPath(dir),
                cwd: root,
                launchArgs: buildLaunchArgs({ taskId: TASK, runDir: dir }),
            };
            writeMetadata(dir, metadata);
            assert.equal(effectiveState(metadata), "orphan");

            // pid reused ⇒ stale, never "running".
            assert.equal(
                effectiveState({ ...metadata, pidStartTime: (metadata.pidStartTime ?? 0) + 12345 }),
                "stale",
            );
            // Starting records age out so a crash between claim and spawn cannot
            // wedge the task forever.
            assert.equal(
                effectiveState({ ...metadata, state: "starting", startedAt: new Date().toISOString() }),
                "starting",
            );
            assert.equal(
                effectiveState({
                    ...metadata,
                    state: "starting",
                    startedAt: new Date(Date.now() - 120_000).toISOString(),
                }),
                "stale",
            );
            // Terminal states pass through untouched.
            for (const state of ["exited", "killed", "error"] as const) {
                assert.equal(effectiveState({ ...metadata, state }), state);
            }
        } finally {
            try {
                deadHelper.kill("SIGKILL");
            } catch {
                // already gone
            }
        }
    } finally {
        if (typeof pi.pid === "number") {
            try {
                pi.kill("SIGKILL");
            } catch {
                // already gone
            }
        }
        cleanupScratch(root);
    }
});

test("activeRun: any trigger holds the task, terminal runs do not", async () => {
    const root = makeScratch();
    const pi = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
        assert.ok(typeof pi.pid === "number");
        const dirA = claimRun(TASK, STAMP_A);
        const base: RunMetadata = {
            version: 1,
            taskId: TASK,
            trigger: "scheduled",
            state: "exited",
            startedAt: new Date().toISOString(),
            sessionFile: sessionPath(dirA),
            cwd: root,
            launchArgs: buildLaunchArgs({ taskId: TASK, runDir: dirA }),
        };
        writeMetadata(dirA, base);
        assert.equal(activeRun(TASK), undefined);
        assert.equal(listRuns(TASK).length, 1);

        // A live manual run must block the scheduler as well.
        const dirB = claimRun(TASK, STAMP_B);
        writeMetadata(dirB, {
            ...base,
            trigger: "manual",
            state: "running",
            pid: pi.pid as number,
            pgid: null,
            helperPid: null,
            sessionFile: sessionPath(dirB),
            launchArgs: buildLaunchArgs({ taskId: TASK, runDir: dirB }),
        });
        const active = activeRun(TASK);
        assert.ok(active);
        assert.equal(active.ts, STAMP_B);
        assert.equal(active.effective, "running");
        assert.equal(active.metadata.trigger, "manual");
    } finally {
        if (typeof pi.pid === "number") {
            try {
                pi.kill("SIGKILL");
            } catch {
                // already gone
            }
        }
        cleanupScratch(root);
    }
});

test("claimRun: the same second can only be claimed once", () => {
    const root = makeScratch();
    try {
        const dir = claimRun(TASK, STAMP_A);
        assert.ok(existsSync(dir));
        assert.throws(() => claimRun(TASK, STAMP_A), /EEXIST/);
        assert.throws(() => claimRun("../../etc", STAMP_A), /invalid task id/);
        assert.throws(() => claimRun(TASK, "../escape"), /invalid run stamp/);
    } finally {
        cleanupScratch(root);
    }
});

test("parseProcStatStartTime: comm with spaces and parens still yields field 22", () => {
    const filler = Array.from({ length: 18 }, (_unused, index) => String(index + 1));
    const raw = `4242 (a b) c) S ${filler.join(" ")} 987654\n`;
    assert.equal(parseProcStatStartTime(raw), 987654);
    assert.equal(parseProcStatStartTime("garbage"), undefined);
    assert.equal(parseProcStatStartTime("1 (x) S 1 2 3"), undefined);
    const live = readPidStartTime(process.pid);
    assert.ok(typeof live === "number" && live > 0);
    assert.equal(readPidStartTime(process.pid), live);
});

test("readLatestAssistant: active branch only, tolerating a torn tail", () => {
    const root = makeScratch();
    try {
        const sessionFile = join(root, "session.jsonl");
        const lines = [
            { type: "session", version: 3, id: "s0", timestamp: new Date().toISOString(), cwd: root },
            { type: "message", id: "a1", parentId: "s0", message: { role: "user", content: [{ type: "text", text: "go" }] } },
            { type: "message", id: "a2", parentId: "a1", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
            // Abandoned branch: later in the file but not on the active chain.
            { type: "message", id: "b1", parentId: "a1", message: { role: "assistant", content: [{ type: "text", text: "abandoned" }] } },
            { type: "message", id: "a3", parentId: "a2", message: { role: "user", content: [{ type: "text", text: "again" }] } },
            {
                type: "message",
                id: "a4",
                parentId: "a3",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "second " }, { type: "toolCall", name: "bash" }, { type: "text", text: "answer" }],
                },
            },
        ];
        const body = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n{"type":"message","id":"a5","paren`;
        writeFileSync(sessionFile, body, "utf8");
        assert.equal(readLatestAssistant(sessionFile), "second answer");

        // Legacy shape: content as a plain string, no ids at all.
        writeFileSync(
            sessionFile,
            `${JSON.stringify({ type: "message", message: { role: "assistant", content: "plain string" } })}\n`,
            "utf8",
        );
        assert.equal(readLatestAssistant(sessionFile), "plain string");

        // No assistant message at all.
        writeFileSync(
            sessionFile,
            `${JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "hi" }] } })}\n`,
            "utf8",
        );
        assert.equal(readLatestAssistant(sessionFile), undefined);
        assert.equal(readLatestAssistant(join(root, "missing.jsonl")), undefined);
    } finally {
        cleanupScratch(root);
    }
});

test("readLatestAssistant: falls back to the newest assistant when the active branch has none", () => {
    const root = makeScratch();
    try {
        const sessionFile = join(root, "session.jsonl");
        // The active chain ends on a user turn; the only assistant text sits on
        // an abandoned branch (a fork/re-run shape). An empty summary is worse
        // than a real-but-older answer, so the fallback must surface it.
        const lines = [
            { type: "session", version: 3, id: "s0", timestamp: new Date().toISOString(), cwd: root },
            { type: "message", id: "a1", parentId: "s0", message: { role: "user", content: [{ type: "text", text: "go" }] } },
            { type: "message", id: "b1", parentId: "a1", message: { role: "assistant", content: [{ type: "text", text: "orphaned answer" }] } },
            { type: "message", id: "c1", parentId: "a1", message: { role: "user", content: [{ type: "text", text: "retry" }] } },
        ];
        writeFileSync(sessionFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
        assert.equal(readLatestAssistant(sessionFile), "orphaned answer");
    } finally {
        cleanupScratch(root);
    }
});

test("readRunSummary: reports effective state and last assistant text", async () => {
    const root = makeScratch();
    const restore = applyEnv({
        PI_SCHEDULE_PI_BIN: join(root, "fake-pi"),
        PI_SCHEDULE_TEST_TIMEOUT_MS: "20000",
        PI_SCHEDULE_TEST_GRACE_MS: "500",
    });
    try {
        const sessionBody = `${JSON.stringify({
            type: "message",
            id: "m1",
            message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        })}\n`;
        writeFakePi(root, `exit 7`);
        const dir = claimRun(TASK, STAMP_A);
        const code = await executeRun({
            taskId: TASK,
            stamp: STAMP_A,
            trigger: "scheduled",
            foreground: false,
            cwd: root,
            promptText: "summarize me",
        });
        assert.equal(code, 7);
        writeFileSync(sessionPath(dir), sessionBody, "utf8");
        const summary = readRunSummary(dir);
        assert.equal(summary.effective, "exited");
        assert.equal(summary.metadata?.exitCode, 7);
        assert.equal(summary.lastAssistant, "done");
        assert.equal(readRunSummary(join(root, "nope")).metadata, undefined);
    } finally {
        restore();
        cleanupScratch(root);
    }
});

test("executeRun: spawn failure is recorded as error, not thrown", async () => {
    const root = makeScratch();
    const restore = applyEnv({
        PI_SCHEDULE_PI_BIN: join(root, "does-not-exist"),
        PI_SCHEDULE_TEST_TIMEOUT_MS: "5000",
        PI_SCHEDULE_TEST_GRACE_MS: "200",
    });
    try {
        mkdirSync(join(root, "schedule"), { recursive: true });
        const dir = claimRun(TASK, STAMP_A);
        const code = await executeRun({
            taskId: TASK,
            stamp: STAMP_A,
            trigger: "manual",
            foreground: false,
            cwd: root,
            promptText: "boom",
        });
        const metadata = readMetadata(dir);
        assert.ok(metadata);
        assert.equal(code, 1);
        assert.equal(metadata.state, "error");
        assert.match(metadata.error ?? "", /does-not-exist/);
    } finally {
        restore();
        cleanupScratch(root);
    }
});
