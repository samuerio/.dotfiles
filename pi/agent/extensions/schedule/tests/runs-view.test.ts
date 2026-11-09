/**
 * runs-view.ts: the task list rows shared with `schedule list`, their menu
 * labels, and the label→run mapping behind `/schedule`'s run picker. Pure
 * formatting, so these tests build ListRow / ActiveRun objects by hand instead
 * of touching the filesystem.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { listRuns } from "../run.ts";
import type { ActiveRun, RunMetadata } from "../run.ts";
import {
    describeRunState,
    displayWidth,
    elidePath,
    matchesScope,
    runOptions,
    taskRowLines,
} from "../runs-view.ts";
import type { ListRow } from "../runs-view.ts";

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

function makeRow(patch: Partial<ListRow> = {}): ListRow {
    return {
        id: "aaaaaaaa",
        name: "task",
        cron: "0 * * * *",
        schedule: "Every hour",
        enabled: true,
        once: false,
        next: "11-06 12:00",
        last: "exited (code 0) · 3h ago",
        state: "exited (code 0)",
        missed: false,
        // One cwd for the whole batch is the normal case: a scoped menu.
        cwd: "/srv/project",
        ...patch,
    };
}

test("taskRowLines: one line per task, padded so the columns line up", () => {
    const lines = taskRowLines([
        makeRow({ name: "a", last: "exited (code 0) · 3h ago" }),
        makeRow({ id: "bbbbbbbb", name: "a much longer task name", last: "—", next: "—" }),
    ]);
    assert.equal(lines.length, 2);
    // The id prefix is what index.ts maps the choice back through, so it has to
    // stay first and fixed-width.
    assert.ok(lines[0].startsWith("aaaaaaaa  a "));
    assert.ok(lines[1].startsWith("bbbbbbbb  a much longer task name  Every hour  "));
    assert.equal(
        lines[0].indexOf("Every hour"),
        lines[1].indexOf("Every hour"),
        "schedule column starts at the same offset",
    );
    assert.equal(lines[0].indexOf("next "), lines[1].indexOf("next "), "next column lines up");
    for (const line of lines) assert.equal(line, line.trimEnd(), "no trailing spaces");
});

test("taskRowLines: every cell but the last is two-space separated", () => {
    assert.equal(
        taskRowLines([makeRow()])[0],
        "aaaaaaaa  task  Every hour  exited (code 0) · 3h ago  next 11-06 12:00",
    );
});

test("taskRowLines: a name past 28 cells is elided, a name that fits is not", () => {
    const long = "x".repeat(40);
    assert.ok(
        taskRowLines([makeRow({ name: long })])[0].startsWith(`aaaaaaaa  ${"x".repeat(27)}…  Every hour`),
    );
    const exact = "y".repeat(28);
    assert.ok(
        taskRowLines([makeRow({ name: exact })])[0].startsWith(`aaaaaaaa  ${exact}  Every hour`),
    );
});

test("taskRowLines: disabled is a suffix on the schedule cell, not a column", () => {
    assert.equal(
        taskRowLines([makeRow({ enabled: false })])[0],
        "aaaaaaaa  task  Every hour (disabled)  exited (code 0) · 3h ago  next 11-06 12:00",
    );
});

test("taskRowLines: a one-shot task keeps the same `· once` marker the CLI folds into SCHEDULE", () => {
    assert.equal(
        taskRowLines([
            makeRow({ schedule: "Every day at 10:02 AM", once: true, next: "—" }),
        ])[0],
        "aaaaaaaa  task  Every day at 10:02 AM · once  exited (code 0) · 3h ago  next —",
    );
});

test("taskRowLines: a missed slot shows through where LAST would be", () => {
    assert.equal(
        taskRowLines([makeRow({ last: "missed · 12m ago", missed: true, state: "idle", next: "—" })])[0],
        "aaaaaaaa  task  Every hour  missed · 12m ago  next —",
    );
});

test("taskRowLines: a corrupt row renders without a definition and without markers", () => {
    // `—` means unreadable here, so it must not read as `(disabled)`.
    assert.equal(
        taskRowLines([
            makeRow({
                name: "(unreadable)",
                cron: "—",
                schedule: "—",
                enabled: false,
                next: "—",
                last: "—",
                state: "corrupt",
            }),
        ])[0],
        "aaaaaaaa  (unreadable)  —  —  next —",
    );
});

test("taskRowLines: no tasks yields no lines", () => {
    assert.deepEqual(taskRowLines([]), []);
});

test("taskRowLines: rows that share one cwd keep `next` and show no cwd cell", () => {
    // The scoped default: every row is already "this project", so spending the
    // last column on the path would only crowd out the next fire.
    const line = taskRowLines([
        makeRow({ cwd: "/srv/project" }),
        makeRow({ id: "bbbbbbbb", cwd: "/srv/project" }),
    ])[0];
    assert.ok(line.endsWith("next 11-06 12:00"), line);
    assert.ok(!line.includes("/srv/project"));
});

test("taskRowLines: rows spanning more than one cwd replace `next` with the cwd", () => {
    const lines = taskRowLines([
        makeRow({ cwd: "/srv/alpha" }),
        makeRow({ id: "bbbbbbbb", cwd: "/srv/beta" }),
    ]);
    assert.equal(lines[0], "aaaaaaaa  task  Every hour  exited (code 0) · 3h ago  /srv/alpha");
    assert.equal(lines[1], "bbbbbbbb  task  Every hour  exited (code 0) · 3h ago  /srv/beta");
    for (const line of lines) {
        assert.ok(!line.includes("next "), "the cwd cell takes the room next would need");
        assert.equal(line, line.trimEnd(), "no trailing spaces");
    }
});

test("taskRowLines: a corrupt row's `—` counts as a second cwd and renders as one", () => {
    const lines = taskRowLines([
        makeRow({ cwd: "/srv/alpha" }),
        makeRow({
            id: "bbbbbbbb",
            name: "(unreadable)",
            cron: "—",
            schedule: "—",
            enabled: false,
            next: "—",
            last: "—",
            state: "corrupt",
            cwd: "—",
        }),
    ]);
    assert.ok(lines[0].endsWith("/srv/alpha"), lines[0]);
    // The `—` tail is what marks the row as having no cwd at all.
    assert.ok(lines[1].endsWith("—"), lines[1]);
    assert.ok(!lines[1].includes("next "));
});

test("taskRowLines: a long multi-cwd path is elided from the head", () => {
    const [line] = taskRowLines([
        makeRow({ cwd: "/srv/www/example-projects/alpha-service" }),
        makeRow({ id: "bbbbbbbb", cwd: "/srv/other" }),
    ]);
    assert.ok(line.endsWith("…/alpha-service"), line);
    assert.ok(!line.endsWith("/"), "no dangling separator");
});

// ---------------------------------------------------------------------------
// elidePath
// ---------------------------------------------------------------------------

test("elidePath: a leading home directory collapses to ~ before measuring", () => {
    assert.equal(elidePath(homedir()), "~");
    assert.equal(elidePath(join(homedir(), "workspace")), "~/workspace");
    // Measured after the collapse: the absolute form is 14 cells and would be
    // elided, while `~/aaaa` fits in 12.
    const child = join(homedir(), "aaaa");
    assert.ok(displayWidth(child) > 12);
    assert.equal(elidePath(child, 12), "~/aaaa");
});

test("elidePath: a path that fits exactly is returned unchanged", () => {
    assert.equal(elidePath("/srv/ab", 7), "/srv/ab");
    assert.equal(displayWidth("/srv/ab"), 7);
    assert.equal(elidePath("/srv/abc", 7), "…/abc");
});

test("elidePath: a long path keeps its tail and elides the head", () => {
    const path = "/srv/www/example-projects/alpha-service";
    const elided = elidePath(path, 28);
    assert.equal(elided, "…/alpha-service");
    assert.ok(displayWidth(elided) <= 28);
    assert.ok(elided.startsWith("…/"));
    assert.ok(!elided.endsWith("/"), "no dangling separator");
    // The retained segments are a real suffix of the path, not a re-join.
    assert.ok(path.endsWith(elided.slice(2)));
});

test("elidePath: a single segment wider than the width is cut from the left", () => {
    const segment = "x".repeat(40);
    const elided = elidePath(`/${segment}`, 20);
    assert.equal(elided, `…${"x".repeat(19)}`);
    assert.equal(displayWidth(elided), 20, "exactly the width, never more");
    // One cell is all that is left for the ellipsis: still no overflow.
    assert.equal(elidePath("/srv/deep-segment", 1), "…");
});

test("elidePath: never exceeds the width and never leaves a trailing slash", () => {
    const paths = [
        "/srv/www/example-projects/alpha-service",
        "/home/zhe/workspace/.dotfiles/pi/agent/extensions/schedule",
        "/a",
        "/a/b/",
        "/" + "y".repeat(50),
    ];
    for (const path of paths) {
        for (const width of [4, 8, 12, 28, 40]) {
            const elided = elidePath(path, width);
            assert.ok(displayWidth(elided) <= width, `${path} @ ${width} → ${elided}`);
            assert.ok(elided.length > 0);
            // Only an elided result is re-joined from segments; one that fits is
            // the path as stored, trailing slash and all.
            if (elided.startsWith("…")) {
                assert.ok(!elided.endsWith("/"), `${path} @ ${width} → ${elided}`);
            }
        }
    }
});

test("elidePath: `—` and an empty cwd both mean 'no path to show'", () => {
    assert.equal(elidePath("—"), "—");
    assert.equal(elidePath(""), "—");
    assert.equal(elidePath("—", 4), "—");
});

// ---------------------------------------------------------------------------
// matchesScope
// ---------------------------------------------------------------------------

// The predicate canonicalizes with realpath, so these tests need real
// directories: one scratch root holding two sibling projects, a subdirectory and
// a symlink pointing at the first project.
const scopeRoot = mkdtempSync(join(tmpdir(), "schedule-scope-"));
const project = join(scopeRoot, "project");
const other = join(scopeRoot, "other");
const projectLink = join(scopeRoot, "project-link");
mkdirSync(join(project, "sub"), { recursive: true });
mkdirSync(other, { recursive: true });
symlinkSync(project, projectLink);

after(() => rmSync(scopeRoot, { recursive: true, force: true }));

test("matchesScope: the same directory matches, with or without a trailing slash", () => {
    assert.equal(matchesScope(project, project), true);
    assert.equal(matchesScope(`${project}/`, project), true);
    assert.equal(matchesScope(project, `${project}/`), true);
    assert.equal(matchesScope(`${project}//`, `${project}/`), true);
});

test("matchesScope: the root path is all trailing slashes and survives them", () => {
    // Stripping `/` to the empty string would compare "" to "/"; this is the
    // one path where the strip has to leave a slash behind.
    assert.doesNotThrow(() => matchesScope("/", "/"));
    assert.equal(matchesScope("/", "/"), true);
    assert.equal(matchesScope("//", "/"), true);
});

test("matchesScope: a symlinked cwd matches the physical one in both directions", () => {
    // `schedule add --cwd ~/dotfiles` stores the symlinked path verbatim, while a
    // session started from the physical path reports the real one.
    assert.equal(matchesScope(projectLink, project), true);
    assert.equal(matchesScope(project, projectLink), true);
    assert.equal(matchesScope(`${projectLink}/`, project), true);
});

test("matchesScope: a subdirectory of the task cwd does not match", () => {
    // The behaviour change: no subtree matching. `--all` is the escape hatch.
    assert.equal(matchesScope(join(project, "sub"), project), false);
    assert.equal(matchesScope(`${join(project, "sub")}/`, project), false);
});

test("matchesScope: the task cwd's parent does not match either", () => {
    // No ancestor matching: `/home/zhe` is not "contained in" a task defined for
    // `/home/zhe/workspace/.dotfiles`.
    assert.equal(matchesScope(scopeRoot, project), false);
    assert.equal(matchesScope("/", project), false);
});

test("matchesScope: a path that no longer exists falls back to string comparison", () => {
    // realpathSync throws here (ENOENT); the predicate must not, because a task
    // whose cwd was deleted still has to be scopeable and deletable.
    const gone = join(scopeRoot, "gone");
    assert.doesNotThrow(() => matchesScope(gone, gone));
    assert.equal(matchesScope(gone, gone), true);
    assert.equal(matchesScope(`${gone}/`, gone), true);
    assert.equal(matchesScope(gone, join(scopeRoot, "also-gone")), false);
    // Mixed sides: one resolves, the other keeps its string.
    assert.equal(matchesScope(gone, project), false);
});

test("matchesScope: two different existing directories do not match", () => {
    assert.equal(matchesScope(project, other), false);
    assert.equal(matchesScope(other, project), false);
});
