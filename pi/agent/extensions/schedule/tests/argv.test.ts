// cli.ts process-level contract: argv parsing, option validation and exit
// codes. The other test files call the read side directly; this one spawns the
// real CLI the way a shell (or crontab) does, which is the only way to cover
// `parseArgs` and the usage/exit-code surface.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { afterEach, beforeEach, describe } from "node:test";

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));

let scratch: string;
let agentDir: string;

beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "schedule-argv-"));
    agentDir = join(scratch, "agent");
    mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

interface CliResult {
    status: number;
    stdout: string;
    stderr: string;
}

function run(...args: string[]): CliResult {
    try {
        const stdout = execFileSync(process.execPath, [CLI, ...args], {
            encoding: "utf8",
            env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
            stdio: ["ignore", "pipe", "pipe"],
        });
        return { status: 0, stdout, stderr: "" };
    } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        return {
            status: typeof failure.status === "number" ? failure.status : 1,
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? "",
        };
    }
}

/** `add` a valid task and return its id (parsed from `added <id> ...`). */
function addTask(extra: string[] = []): string {
    const result = run(
        "add",
        "--name",
        "argv-task",
        "--cron",
        "0 9 * * *",
        "--cwd",
        scratch,
        "--prompt",
        "hello",
        ...extra,
    );
    assert.equal(result.status, 0, result.stderr);
    const match = /^added ([a-z0-9]{8})\b/m.exec(result.stdout);
    assert.ok(match, `id in: ${result.stdout}`);
    return match[1];
}

describe("argv: end of options", () => {
    test("`--` keeps the remaining tokens as positionals", () => {
        const id = addTask();
        const removed = run("remove", "--", id);
        assert.equal(removed.status, 0, removed.stderr);
        assert.match(removed.stdout, /^removed /);

        const list = run("list", "--json");
        assert.equal(list.status, 0, list.stderr);
        assert.deepEqual(JSON.parse(list.stdout).tasks, []);
    });
});

describe("argv: option validation", () => {
    test("an unknown option is rejected instead of silently ignored", () => {
        // The dangerous case: `--oncee` used to leave a recurring task behind.
        const result = run(
            "add",
            "--name",
            "typo",
            "--cron",
            "0 9 * * *",
            "--cwd",
            scratch,
            "--prompt",
            "hello",
            "--oncee",
        );
        assert.equal(result.status, 1);
        assert.match(result.stderr, /unknown option '--oncee'/);
        assert.deepEqual(JSON.parse(run("list", "--json").stdout).tasks, []);
    });

    test("a boolean option rejects a value", () => {
        const result = run("list", "--json=1");
        assert.equal(result.status, 1);
        assert.match(result.stderr, /option '--json' does not take a value/);
    });

    test("a value option without a value is a usage error", () => {
        const result = run("add", "--name");
        assert.equal(result.status, 1);
        assert.match(result.stderr, /option '--name' requires a value/);
    });

    test("a prompt that starts with a dash is taken verbatim", () => {
        const result = run(
            "add",
            "--name",
            "dash",
            "--cron",
            "0 9 * * *",
            "--cwd",
            scratch,
            "--prompt",
            "-5 minutes, then report",
        );
        assert.equal(result.status, 0, result.stderr);
    });
});

describe("argv: add validation", () => {
    test("a cron with no reachable slot is accepted but flagged", () => {
        const result = run(
            "add",
            "--name",
            "never",
            "--cron",
            "0 0 30 2 *",
            "--cwd",
            scratch,
            "--prompt",
            "hello",
        );
        // Valid syntax, no slot inside the search window: `NEXT` says so and
        // `add` warns instead of silently arming a task that never fires.
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /next: invalid/);
        assert.match(result.stdout, /no fire time in the next 366 days/);

        const rows = JSON.parse(run("list", "--json").stdout).tasks as Array<{ next: string }>;
        assert.equal(rows[0].next, "invalid");
    });

    test("a valid task prints its next fire, its route, and lists as one row", () => {
        const id = addTask();
        const list = run("list", "--json");
        const tasks = JSON.parse(list.stdout).tasks as Array<{ id: string; next: string }>;
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0].id, id);
        assert.notEqual(tasks[0].next, "invalid");
    });
});
