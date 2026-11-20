/**
 * `/archive`: cold/hot separation for pi session files.
 *
 * The command MOVES sessions out of the hot session root
 * (`~/.pi/agent/sessions/<project>/`) into `~/.pi/agent/archive/sessions/
 * <project>/` and indexes the searchable projection into
 * `~/.pi/agent/archive/archive.db` (see store.ts).
 *
 * Archive is a `rename`, never a rewrite: the historical JSONL keeps its exact
 * bytes, so `read_session <path>`, `pi --session <path>` and format migrations
 * behave exactly as before. That also means the 90% of the current corpus that
 * is inert subagent registry payload stays on disk; the archive is about the
 * hot root's size (which is what makes `SessionManager.list` and the live scan
 * slow), not about reclaiming bytes.
 *
 * Subcommands:
 *
 *   /archive                        status: hot dir, archive, index, staleness
 *   /archive run [flags]            plan (dry run) or move+index with --apply
 *   /archive rebuild [--apply]      re-ingest every archived file from JSONL
 *   /archive restore <id|path>      move a session back and drop its rows
 *
 * `run` defaults to a dry run on purpose: moving session files is destructive
 * to the hot view (`/resume` stops listing them), so the plan is printed first
 * and `--apply` is required. Candidates are filtered by mtime (default 30d) and
 * anything touched in the last hour is skipped even when a shorter
 * `--older-than` is asked for: another pi process may be appending to it, and a
 * move does not stop an in-flight write from landing in the archive.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
    getAgentDir,
    type ExtensionAPI,
    type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
    PROJECTION_VERSION,
    SCHEMA_VERSION,
    archiveDbPath,
    archiveLockPath,
    archiveRoot,
    archiveSessionsDir,
    archiveDiskUsage,
    archiveStats,
    deleteSessionRows,
    ingestSessionFile,
    openArchiveDb,
    restoreArchivedSession,
    stampVersions,
} from "./store.ts";
import { NGRAM_VERSION } from "./ngram.ts";

/** Grace window for files another pi process may still be appending to. */
const IN_FLIGHT_MS = 60 * 60 * 1000;
const DEFAULT_OLDER_THAN_MS = 30 * 24 * 60 * 60 * 1000;

function sessionsRoot(): string {
    return path.join(getAgentDir(), "sessions");
}

function pluralize(count: number, noun: string): string {
    if (count === 1) return `1 ${noun}`;
    return `${count} ${noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : `${noun}s`}`;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Milliseconds → `30d` / `12h` / `90m`, for messages about a threshold. */
function formatDuration(ms: number): string {
    const day = 24 * 60 * 60 * 1000;
    if (ms >= day) return `${Math.round(ms / day)}d`;
    if (ms >= 60 * 60 * 1000) return `${Math.round(ms / (60 * 60 * 1000))}h`;
    return `${Math.round(ms / (60 * 1000))}m`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Widget key for the two destructive passes. `run --apply` and `rebuild --apply`
 * over a real corpus take minutes, and the plan is printed BEFORE the work
 * starts, so without a live progress row a long pass looks like a hang. The row
 * lives in the widget zone above the editor (pi's own status zone, rendered
 * while the main agent is idle), never the footer. Same lifecycle as
 * `compact-worker.ts`/`btw.ts`: set on entry, overwrite per item, clear in
 * `finally` so no path leaves the line behind.
 */
const STATUS_KEY = "archive";

/**
 * In-flight pass progress as a string-array widget (works in both TUI and RPC
 * modes); `undefined` drops the row.
 */
function setPassProgress(
    ctx: ExtensionCommandContext,
    text: string | undefined,
): void {
    ctx.ui.setWidget(STATUS_KEY, text === undefined ? undefined : [text]);
}

/**
 * `<verb> 12/340 · 1.2 GB moved · 2026-01-01T09-00-00.jsonl`.
 *
 * Only the tail of the name is shown: session files are timestamped, and the
 * timestamp is the part that identifies them, while the head is shared by
 * every file in the directory.
 */
function progressLine(
    verb: string,
    done: number,
    total: number,
    file: string | undefined,
    extra?: string,
): string {
    const name = file ? path.basename(file) : "";
    const short = name.length > 40 ? `…${name.slice(-39)}` : name;
    // An empty `file` is how a caller says "this phase has no per-item name";
    // skipping the segment keeps the line from ending in a dangling separator.
    const parts = [`${verb} ${done}/${total}`];
    if (extra) parts.push(extra);
    if (short) parts.push(short);
    return parts.join(" · ");
}

/** `30d` / `12h` / `90m` / `2w` → milliseconds. */
export function parseDuration(raw: string): number {
    const match = raw.trim().match(/^(\d+)\s*([mhdw])$/i);
    if (!match)
        throw new Error(`invalid duration "${raw}" (expected e.g. 30d, 12h, 90m)`);
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const unitMs =
        unit === "m"
            ? 60 * 1000
            : unit === "h"
              ? 60 * 60 * 1000
              : unit === "d"
                ? 24 * 60 * 60 * 1000
                : 7 * 24 * 60 * 60 * 1000;
    return amount * unitMs;
}

interface RunArgs {
    apply: boolean;
    olderThanMs: number;
    limit?: number;
    allProjects: boolean;
}

export function parseRunArgs(args: string): RunArgs {
    const parsed: RunArgs = {
        apply: false,
        olderThanMs: DEFAULT_OLDER_THAN_MS,
        allProjects: false,
    };
    for (const token of args.trim().split(/\s+/).filter(Boolean)) {
        if (!token.startsWith("--")) {
            throw new Error(`unexpected argument "${token}"`);
        }
        const [flag, value] = token.slice(2).split("=", 2);
        switch (flag) {
            case "apply":
                parsed.apply = true;
                break;
            case "all-projects":
                parsed.allProjects = true;
                break;
            case "older-than":
                if (!value) throw new Error("--older-than needs a value, e.g. 30d");
                parsed.olderThanMs = parseDuration(value);
                break;
            case "limit":
                parsed.limit = Number(value);
                if (!Number.isInteger(parsed.limit) || parsed.limit < 1)
                    throw new Error(`invalid --limit ${value}`);
                break;
            default:
                throw new Error(
                    `unknown flag --${flag} (supported: apply, all-projects, older-than, limit)`,
                );
        }
    }
    return parsed;
}

interface Candidate {
    file: string;
    projectDir: string;
    size: number;
    mtimeMs: number;
}

interface HotProject {
    /** Directory name recorded as `project_dir` in the archive. */
    projectDir: string;
    /** Absolute directory holding this project's jsonl files. */
    dir: string;
}

/**
 * The hot project directories in scope for this process.
 *
 * `getSessionDir()` is already the PROJECT directory (`<root>/--<cwd>--`, one
 * level per project), so its parent is the root only when it actually sits in
 * the default sessions root. A custom `--session-dir` (piw, schedule runs,
 * tests) is used verbatim as one project: scanning its parent would walk an
 * unrelated tree (/tmp, a run directory) and record a nonsense project name.
 */
function hotProjects(
    ctx: ExtensionCommandContext,
    allProjects: boolean,
): HotProject[] {
    const sessionDir = ctx.sessionManager.getSessionDir();
    if (!sessionDir) return [];
    const abs = path.resolve(sessionDir);
    const root = path.resolve(sessionsRoot());
    if (path.dirname(abs) !== root || !allProjects) {
        return [{ projectDir: path.basename(abs), dir: abs }];
    }
    let names: string[] = [];
    try {
        names = fs
            .readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    } catch {
        return [];
    }
    // Subagent trees (sessions/<tool>/<runId>/) keep their jsonl one level
    // deeper, so they yield no candidates and need no blocklist.
    return names.map((name) => ({
        projectDir: name,
        dir: path.join(root, name),
    }));
}

/**
 * Select archivable sessions. The live session and anything touched within
 * IN_FLIGHT_MS are excluded unconditionally; `--older-than` then narrows by
 * mtime. Already-archived session ids are filtered out by the caller (it can
 * see the index), not here.
 */
function selectCandidates(
    options: RunArgs & { currentSessionFile?: string; projects: HotProject[] },
): { candidates: Candidate[]; skippedRecent: number; skippedLive: number } {
    const now = Date.now();
    const cutoff = Math.min(
        now - options.olderThanMs,
        now - IN_FLIGHT_MS,
    );
    const liveAbs = options.currentSessionFile
        ? path.resolve(options.currentSessionFile)
        : undefined;
    const dirs = options.projects;
    const candidates: Candidate[] = [];
    let skippedRecent = 0;
    let skippedLive = 0;
    for (const { projectDir, dir } of dirs) {
        let names: string[];
        try {
            names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
        } catch {
            continue;
        }
        for (const name of names) {
            const file = path.join(dir, name);
            if (liveAbs && path.resolve(file) === liveAbs) {
                skippedLive++;
                continue;
            }
            let stat: fs.Stats;
            try {
                stat = fs.statSync(file);
            } catch {
                continue;
            }
            if (stat.mtimeMs > cutoff) {
                skippedRecent++;
                continue;
            }
            candidates.push({
                file,
                projectDir,
                size: stat.size,
                mtimeMs: stat.mtimeMs,
            });
        }
    }
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
    if (options.limit !== undefined) candidates.length = Math.min(candidates.length, options.limit);
    return { candidates, skippedRecent, skippedLive };
}

/** Exclusive lock so two archivers never interleave their ingest/rename pairs. */
function acquireLock(): () => void {
    fs.mkdirSync(archiveRoot(), { recursive: true });
    const lockPath = archiveLockPath();
    let fd: number;
    try {
        fd = fs.openSync(lockPath, "wx");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new Error(
                `another archive run holds ${lockPath} (delete it if that run died)`,
            );
        throw error;
    }
    fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    fs.closeSync(fd);
    return () => {
        try {
            fs.unlinkSync(lockPath);
        } catch {
            // already gone: nothing to release
        }
    };
}

function moveFile(from: string, to: string): void {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
        fs.renameSync(from, to);
    } catch (error) {
        // Cross-device move (custom --session-dir on another filesystem).
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        fs.copyFileSync(from, to);
        fs.unlinkSync(from);
    }
}

/**
 * Hot-side usage across every project in scope. Counts bytes, not entries: the
 * cost this reports on is `SessionManager.list`, which reads every line of
 * every file in the directory it is pointed at.
 */
function hotUsage(ctx: ExtensionCommandContext): {
    count: number;
    bytes: number;
    root: string;
} {
    const projects = hotProjects(ctx, true);
    const sessionDir = ctx.sessionManager.getSessionDir();
    // A custom --session-dir is one project, so its parent is not a sessions
    // root and must not be displayed as one.
    const custom = sessionDir
        ? path.dirname(path.resolve(sessionDir)) !== path.resolve(sessionsRoot())
        : false;
    let count = 0;
    let bytes = 0;
    for (const project of projects) {
        let names: string[];
        try {
            names = fs.readdirSync(project.dir);
        } catch {
            continue;
        }
        for (const name of names) {
            if (!name.endsWith(".jsonl")) continue;
            try {
                bytes += fs.statSync(path.join(project.dir, name)).size;
                count++;
            } catch {
                // vanished mid-scan
            }
        }
    }
    const root = custom && sessionDir ? path.resolve(sessionDir) : sessionsRoot();
    return { count, bytes, root };
}

function statusText(ctx: ExtensionCommandContext): string {
    const hot = hotUsage(ctx);
    const disk = archiveDiskUsage();
    const lines = [
        "Archive",
        `  hot    ${pluralize(hot.count, "session")} / ${formatBytes(hot.bytes)}  (${hot.root})`,
    ];
    if (!fs.existsSync(archiveDbPath())) {
        // The archive directory can hold sessions with no index at all (deleted
        // or never built). Reporting "none" while files sit there is the one
        // status line that could make a user believe cold search is empty.
        lines.push(
            disk.sessions > 0
                ? `  cold   ${pluralize(disk.sessions, "session")} / ${formatBytes(disk.bytes)} on disk  (${archiveSessionsDir()})`
                : `  cold   none  (${archiveSessionsDir()})`,
        );
        lines.push(
            disk.sessions > 0
                ? "  index  none, run /archive rebuild"
                : "  run    /archive run --older-than=30d  (dry run, add --apply to move)",
        );
        return lines.join("\n");
    }
    let db: ReturnType<typeof openArchiveDb>;
    try {
        db = openArchiveDb();
    } catch (error) {
        // A corrupt index must not hide what is on disk: the files are still
        // there and rebuildable, and "cannot open the database" is a next step,
        // not a dead end.
        return [
            ...lines,
            `  cold   ${pluralize(disk.sessions, "session")} / ${formatBytes(disk.bytes)} on disk  (${archiveSessionsDir()})`,
            `  index  unusable (${errorMessage(error)}), run /archive rebuild`,
        ].join("\n");
    }
    try {
        const stats = archiveStats(db);
        lines.push(
            `  cold   ${pluralize(stats.sessions, "session")} / ${pluralize(stats.entries, "entry")} in ${pluralize(stats.projects, "project")}  (${archiveSessionsDir()})`,
        );
        lines.push(
            `  index  ${formatBytes(stats.indexBytes)}  (schema ${SCHEMA_VERSION} · projection ${PROJECTION_VERSION} · ngram ${NGRAM_VERSION})`,
        );
        if (stats.oldest && stats.newest)
            lines.push(`  span   ${stats.oldest} .. ${stats.newest}`);
        lines.push(`  stale  ${pluralize(stats.staleSessions, "session")} changed since ingest`);
        if (stats.unindexed > 0)
            lines.push(
                `  files  ${pluralize(stats.unindexed, "file")} on disk without an index row (/archive rebuild)`,
            );
        if (stats.incompatible) lines.push(`  warn   ${stats.incompatible}`);
    } finally {
        db.close();
    }
    return lines.join("\n");
}

async function runArchive(
    raw: string,
    ctx: ExtensionCommandContext,
): Promise<void> {
    const parsed = parseRunArgs(raw);
    const currentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
    const projects = hotProjects(ctx, parsed.allProjects);
    if (projects.length === 0) {
        ctx.ui.notify(
            "archive: no session directory in this mode (in-memory session); run it from a real session",
            "error",
        );
        return;
    }
    const { candidates, skippedRecent, skippedLive } = selectCandidates({
        ...parsed,
        currentSessionFile,
        projects,
    });

    const planBytes = candidates.reduce((sum, c) => sum + c.size, 0);
    const header = parsed.apply ? "Archiving" : "Plan (dry run)";
    const lines = [
        `${header}: ${pluralize(candidates.length, "session")} / ${formatBytes(planBytes)} older than ${formatDuration(parsed.olderThanMs)}`,
        `  skipped: ${skippedRecent} recent, ${skippedLive} live`,
    ];
    for (const candidate of candidates.slice(0, 12)) {
        lines.push(
            `  ${formatBytes(candidate.size).padStart(8)}  ${candidate.projectDir}/${path.basename(candidate.file)}`,
        );
    }
    if (candidates.length > 12)
        lines.push(`  ... +${candidates.length - 12} more`);
    if (candidates.length === 0) {
        ctx.ui.notify(lines.join("\n"), "info");
        return;
    }
    if (!parsed.apply) {
        lines.push("  (dry run: add --apply to move and index these sessions)");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
    }

    const release = acquireLock();
    // Open INSIDE the try: a corrupt database file, ENOSPC or a read-only agent
    // dir would otherwise leave the lock behind and brick every later run until
    // someone deletes it by hand.
    let db: ReturnType<typeof openArchiveDb> | undefined;
    let moved = 0;
    let movedBytes = 0;
    let indexed = 0;
    const failures: string[] = [];
    try {
        db = openArchiveDb();
        // Set again inside the loop, before the first ingest: the plan above was
        // printed before the lock, so this is what turns a silent minute into a
        // line that moves.
        setPassProgress(
            ctx,
            progressLine(
                "archiving",
                0,
                candidates.length,
                candidates[0].file,
                "starting",
            ),
        );
        for (const [index, candidate] of candidates.entries()) {
            setPassProgress(
                ctx,
                progressLine(
                    "archiving",
                    index + 1,
                    candidates.length,
                    candidate.file,
                    `${formatBytes(movedBytes)} moved`,
                ),
            );
            const dest = path.join(
                archiveSessionsDir(),
                candidate.projectDir,
                path.basename(candidate.file),
            );
            try {
                const outcome = await ingestSessionFile(db, candidate.file, {
                    destFile: dest,
                    projectDir: candidate.projectDir,
                    sourceDir: path.dirname(candidate.file),
                });
                // DB commit first, rename second: a crash in between leaves rows
                // pointing at a file still in the hot root, which the cold query
                // reports as stale instead of returning a wrong hit. A rename
                // that FAILS is different: the file stays hot, so the rows must
                // go or the session would be returned twice (hot + a dead
                // archived=1 path) and stay stale forever.
                try {
                    moveFile(candidate.file, dest);
                } catch (error) {
                    deleteSessionRows(db, outcome.sessionId);
                    throw error;
                }
                moved++;
                movedBytes += candidate.size;
                indexed += outcome.entryCount;
            } catch (error) {
                failures.push(
                    `${path.basename(candidate.file)}: ${errorMessage(error)}`,
                );
            }
            if (ctx.signal?.aborted) break;
        }
    } finally {
        // Before the close: a close that throws must not leave the progress
        // row claiming an archiving pass is still running.
        setPassProgress(ctx, undefined);
        db?.close();
        release();
    }

    const report = [
        `Archived ${pluralize(moved, "session")} / ${formatBytes(movedBytes)}, indexed ${pluralize(indexed, "entry")}`,
        `  failed: ${failures.length}`,
        ...failures.slice(0, 5).map((line) => `  ${line}`),
    ];
    if (failures.length > 5) report.push(`  ... +${failures.length - 5} more`);
    // The loop breaks on abort, so a short count is an interrupted pass, not a
    // finished one; saying so keeps "Archived 3 sessions" from reading like the
    // plan was drained.
    if (ctx.signal?.aborted) report.push("  stopped early (interrupted)");
    ctx.ui.notify(report.join("\n"), failures.length ? "warning" : "info");
}

/**
 * Rebuild the index from what is on disk.
 *
 * The archive directory is authoritative for WHAT EXISTS: files without a row
 * are ingested, rows whose file is gone are dropped. That is what makes this
 * command able to recover from a deleted or corrupt index, which the old
 * row-driven version could not (it read its own work list out of the database).
 *
 * Rows still matter for one thing they alone know: `source_dir`, the directory a
 * session came from. It is joined back by absolute path, and genuinely unknown
 * when there was no row (a rebuild after an index loss), in which case `restore`
 * says so instead of pretending the default root is exact.
 */
async function rebuildArchive(
    raw: string,
    ctx: ExtensionCommandContext,
): Promise<void> {
    const apply = raw.split(/\s+/).includes("--apply");
    const disk = archiveDiskUsage();
    const dbExists = fs.existsSync(archiveDbPath());

    // The lock guards the quarantine rename and the whole ingest pass. Opening
    // happens after it, because a corrupt file used to throw before any
    // try/finally could run.
    const release = acquireLock();
    let db: ReturnType<typeof openArchiveDb> | undefined;
    let quarantined: string | undefined;
    try {
        if (dbExists) {
            try {
                db = openArchiveDb();
            } catch (error) {
                if (!/not a database|malformed|corrupt/i.test(errorMessage(error)))
                    throw error;
                // Never delete: rename aside so the bytes stay inspectable and
                // the decision is reversible.
                const suffix = new Date().toISOString().replace(/[:.]/g, "-");
                for (const ext of ["", "-wal", "-shm"]) {
                    const from = archiveDbPath() + ext;
                    if (!fs.existsSync(from)) continue;
                    fs.renameSync(from, `${archiveDbPath()}.corrupt-${suffix}${ext}`);
                }
                quarantined = `${archiveDbPath()}.corrupt-${suffix}`;
                db = openArchiveDb();
            }
        } else {
            db = openArchiveDb();
        }

        const rows = [
            ...(db
                .prepare(
                    "SELECT session_id, file, project_dir, source_dir FROM sessions",
                )
                .iterate() as Iterable<{
                session_id: string;
                file: string;
                project_dir: string;
                source_dir: string | null;
            }>),
        ];
        const byFile = new Map(rows.map((row) => [row.file, row]));
        const onDisk = new Set(disk.files);
        const missing = rows.filter((row) => !onDisk.has(row.file));
        const known = disk.files.filter((file) => byFile.has(file)).length;

        const header = [
            apply ? "Rebuilding index" : "Rebuild plan (dry run)",
            `  ${pluralize(disk.sessions, "file")} on disk / ${formatBytes(disk.bytes)} · ${pluralize(rows.length, "row")} in index`,
            `  ${pluralize(disk.sessions - known, "file")} to ingest · ${pluralize(missing.length, "row")} to drop · origin known for ${known}`,
            `  projection ${PROJECTION_VERSION} · ngram ${NGRAM_VERSION}`,
            ...(quarantined ? [`  unusable index moved to ${quarantined}`] : []),
        ];
        if (!apply) {
            header.push("  (dry run: add --apply to re-ingest)");
            ctx.ui.notify(header.join("\n"), "info");
            return;
        }

        let done = 0;
        const failures: string[] = [];
        // Same progress-row contract as `run --apply`: the pass is minutes
        // long over a real corpus and prints nothing else until it ends.
        if (disk.files.length > 0)
            setPassProgress(
                ctx,
                progressLine(
                    "reindexing",
                    0,
                    disk.files.length,
                    disk.files[0],
                    "starting",
                ),
            );
        for (const [index, file] of disk.files.entries()) {
            setPassProgress(
                ctx,
                progressLine("reindexing", index + 1, disk.files.length, file),
            );
            const row = byFile.get(file);
            const projectDir = row?.project_dir ?? path.basename(path.dirname(file));
            try {
                await ingestSessionFile(db, file, {
                    destFile: file,
                    projectDir,
                    // Unknown stays unknown: a guessed origin is worse than an
                    // honest absence, because restore would act on the guess.
                    sourceDir: row?.source_dir ?? null,
                });
                done++;
            } catch (error) {
                // Drop the rows of a file we cannot read instead of refusing to
                // stamp forever: one lost JSONL must not keep the whole cold side
                // unusable. The file is still on disk, so `status` shows it as
                // unindexed and a manual look is possible.
                failures.push(`${path.basename(file)}: ${errorMessage(error)}`);
                try {
                    if (row) deleteSessionRows(db, row.session_id);
                } catch {
                    // best effort: the stamp below is what actually matters
                }
            }
        }
        let dropped = 0;
        // No counter here: dropping is one short delete per vanished file, and
        // painting each of them would cost more than the deletes.
        if (missing.length > 0)
            setPassProgress(
                ctx,
                `dropping ${pluralize(missing.length, "index row")}`,
            );
        for (const row of missing) {
            try {
                deleteSessionRows(db, row.session_id);
                dropped++;
            } catch (error) {
                failures.push(`${row.session_id}: ${errorMessage(error)}`);
            }
        }
        // Stamp unconditionally: the invariant is "every row here was produced by
        // this code", which the drops above already establish.
        stampVersions(db);

        const report = [
            `Rebuilt ${pluralize(done, "session")} · dropped ${pluralize(dropped, "row")}`,
            `  failed: ${failures.length}`,
            ...(quarantined ? [`  unusable index moved to ${quarantined}`] : []),
            ...failures.slice(0, 5),
        ];
        ctx.ui.notify(report.join("\n"), failures.length ? "warning" : "info");
    } finally {
        // Before the close: a close that throws must not leave the progress
        // row claiming a rebuild is still running.
        setPassProgress(ctx, undefined);
        db?.close();
        release();
    }
}

function restoreArchive(
    raw: string,
    ctx: ExtensionCommandContext,
): void {
    const ref = raw.trim();
    if (!ref) {
        ctx.ui.notify("usage: /archive restore <session-id|path>", "error");
        return;
    }
    if (!fs.existsSync(archiveDbPath())) {
        ctx.ui.notify("archive: no archive database yet", "error");
        return;
    }
    const db = openArchiveDb();
    try {
        const isPath = ref.includes("/") || ref.endsWith(".jsonl");
        const row = (
            isPath
                ? db
                      .prepare(
                          "SELECT session_id FROM sessions WHERE file = ? LIMIT 1",
                      )
                      .get(path.resolve(ref))
                : (db
                      // ESCAPE so a ref containing % or _ cannot act as a
                      // wildcard and silently restore an unrelated session.
                      .prepare(
                          "SELECT session_id FROM sessions WHERE session_id = ? OR session_id LIKE ? || '%' ESCAPE '\\' ORDER BY archived_at DESC LIMIT 1",
                      )
                      .get(ref, ref.replace(/[\\%_]/g, "\\$&")) ?? undefined)) as
            | { session_id: string }
            | undefined;
        if (!row) {
            ctx.ui.notify(`archive: no archived session matches "${ref}"`, "error");
            return;
        }
        const { from, to, originKnown } = restoreArchivedSession(
            db,
            row.session_id,
        );
        ctx.ui.notify(
            `Restored ${row.session_id}\n  ${from}\n  → ${to}` +
                (originKnown
                    ? ""
                    : "\n  origin not recorded (index rebuilt from disk): the default sessions root is a guess"),
            originKnown ? "info" : "warning",
        );
    } catch (error) {
        ctx.ui.notify(`archive restore: ${errorMessage(error)}`, "error");
    } finally {
        db.close();
    }
}

export function registerArchive(pi: ExtensionAPI): void {
    pi.registerCommand("archive", {
        description:
            "Cold/hot session separation: move old sessions into the global archive and index them " +
            "(/archive run [--older-than=30d] [--apply] | rebuild | restore <id>)",
        handler: async (args, ctx) => {
            const raw = args.trim();
            const [sub] = raw.split(/\s+/);
            const tail = raw.slice(sub.length).trim();
            try {
                if (!sub) {
                    ctx.ui.notify(statusText(ctx), "info");
                    return;
                }
                if (sub === "run") {
                    await runArchive(tail, ctx);
                    return;
                }
                if (sub === "rebuild") {
                    await rebuildArchive(tail, ctx);
                    return;
                }
                if (sub === "restore") {
                    restoreArchive(tail, ctx);
                    return;
                }
                if (sub === "stats" || sub === "status") {
                    ctx.ui.notify(statusText(ctx), "info");
                    return;
                }
                ctx.ui.notify(
                    `archive: unknown subcommand "${sub}" (run, rebuild, restore, status)`,
                    "error",
                );
            } catch (error) {
                ctx.ui.notify(`archive: ${errorMessage(error)}`, "error");
            }
        },
    });
}
