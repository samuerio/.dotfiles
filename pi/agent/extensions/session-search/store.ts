/**
 * Global archive store: SQLite schema, session ingestion, and the cold-side
 * query used by `search.ts`.
 *
 * Layout (see .pi/spec/*-session-cold-hot-archive/plan.md):
 *
 *   ~/.pi/agent/archive/
 *   ├── archive.db            # WAL
 *   ├── .lock                 # archiver serialization (owned by archive.ts)
 *   └── sessions/<project>/   # moved session files, bytes untouched
 *
 * Three design constraints shape this module:
 *
 *   1. The DB is a derived projection, never a copy of the transcript. No
 *      `raw_json` column: the archived JSONL stays the source of truth, and a
 *      stray multi-gigabyte payload (subagent registry snapshots are 90% of
 *      the current corpus) must never be duplicated into the index.
 *   2. Only the ACTIVE branch is indexed, computed with the same
 *      `buildContextEntries` + `sessionEntryToContextMessages` projection the
 *      live scan uses, and only for roles `core.ts` considers
 *      searchable. Tool results are stored nowhere.
 *   3. FTS is a prefilter, not a judge. `entries.text`/`entries.tool_calls`
 *      hold exactly `messageBodyText`/`toolCallHaystack`, so every candidate
 *      is re-judged with the live matcher and the snippet/rank rules are the
 *      ones in `core.ts`.
 *
 * Archived sessions are immutable by construction (they were moved out of the
 * session root), which is why ingest is one-shot and keyed by session id.
 * A resumed or migrated archive file shows up as `stale` (size/mtime mismatch)
 * instead of silently serving a dead entry id.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import {
    buildContextEntries,
    getAgentDir,
    migrateSessionEntries,
    sessionEntryToContextMessages,
    type FileEntry,
    type SessionEntry,
    type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { textOf } from "../lib/session-common.ts";
import { NGRAM_VERSION, ftsMatch, ngramPhrase, ngramTokens } from "./ngram.ts";
import {
    MAX_HAYSTACK_CHARS,
    SELF_EXCLUDED_CUSTOM_TYPES,
    type HitRank,
    type SearchHit,
    betterRank,
    buildSnippet,
    compareRank,
    messageBodyText,
    messageTimestampMs,
    normalizeForTier,
    roleWeightForRole,
    toolCallHaystack,
} from "./core.ts";

export const SCHEMA_VERSION = 1;
/**
 * Bump whenever the ingestion projection changes (which roles are stored, how
 * the haystack is split, which branch resolution rule applies). Stored rows
 * are then unusable and the archive has to be rebuilt from the JSONL files.
 */
export const PROJECTION_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id         TEXT PRIMARY KEY,
  file               TEXT NOT NULL UNIQUE,
  project_dir        TEXT NOT NULL,
  source_dir         TEXT,
  cwd                TEXT,
  created_at         TEXT NOT NULL,
  format_version     INTEGER NOT NULL,
  entry_count        INTEGER NOT NULL,
  message_count      INTEGER NOT NULL,
  file_size          INTEGER NOT NULL,
  mtime_ms           INTEGER NOT NULL,
  first_user_message TEXT,
  first_user_entry_id TEXT,
  session_name       TEXT,
  archived_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  entry_id   TEXT NOT NULL,
  parent_id  TEXT,
  role       TEXT NOT NULL,
  timestamp  TEXT NOT NULL,
  ts_ms      INTEGER,
  text       TEXT,
  tool_calls TEXT,
  UNIQUE(session_id, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_entries_session ON entries(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  ng_text,
  ng_tools,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61'
);
`;

// ---------------------------------------------------------------------------
// Paths and lifecycle
// ---------------------------------------------------------------------------

export function archiveRoot(): string {
    return path.join(getAgentDir(), "archive");
}

export function archiveDbPath(): string {
    return path.join(archiveRoot(), "archive.db");
}

export function archiveSessionsDir(): string {
    return path.join(archiveRoot(), "sessions");
}

export function archiveLockPath(): string {
    return path.join(archiveRoot(), ".lock");
}

/**
 * Record which rules built this index. Every key is written, because a partial
 * stamp is what makes a rebuild look unnecessary: `archiveIncompatibility`
 * treats a missing key as unusable, so stamping three of four versions would
 * leave a mismatch nobody can clear.
 */
export function stampVersions(db: DatabaseSync): void {
    setMeta(db, "schema_version", String(SCHEMA_VERSION));
    setMeta(db, "projection_version", String(PROJECTION_VERSION));
    setMeta(db, "ngram_version", String(NGRAM_VERSION));
}

/**
 * Open (creating if needed) the archive database and stamp schema metadata.
 *
 * The stamp is written ONLY when this call creates the file. Stamping on every
 * open would silently declare an index built by older code as current the first
 * time a version key is added (INSERT OR IGNORE lets the old keys through while
 * the new key gets today's value), and cold queries would then judge old rows
 * with new rules and return false negatives. A missing key now reads as
 * `archive.db has no <key>`, which is the honest answer: rebuild.
 */
export function openArchiveDb(dbPath: string = archiveDbPath()): DatabaseSync {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const fresh = !fs.existsSync(dbPath);
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
    ensureColumn(db, "sessions", "source_dir", "TEXT");
    if (fresh) stampVersions(db);
    return db;
}

/** Add a column to a pre-existing database (SCHEMA is IF NOT EXISTS only). */
function ensureColumn(
    db: DatabaseSync,
    table: string,
    column: string,
    type: string,
): void {
    const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function metaValue(db: DatabaseSync, key: string): string | undefined {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
    return row?.value;
}

/**
 * Reason the stored index cannot answer queries, or undefined when it can.
 * Version mismatches are a rebuild signal, never silently tolerated: a token
 * stream built by an older segmentation would produce false negatives.
 */
export function archiveIncompatibility(db: DatabaseSync): string | undefined {
    const checks: Array<[string, number]> = [
        ["schema_version", SCHEMA_VERSION],
        ["projection_version", PROJECTION_VERSION],
        ["ngram_version", NGRAM_VERSION],
    ];
    for (const [key, current] of checks) {
        const stored = Number(metaValue(db, key));
        if (!Number.isFinite(stored)) return `archive.db has no ${key}`;
        if (stored !== current)
            // Flattened on purpose: this string ends up inside the answer line's
            // `coldUnavailable=1 (…)` note, and nested parens there are noise.
            return `archive.db ${key} is ${stored}, expected ${current}; run /archive rebuild`;
    }
    return undefined;
}

export interface ArchiveHandle {
    db: DatabaseSync;
    /** Set when the DB exists but its index cannot be queried. */
    incompatible?: string;
}

/** Open the archive for read-only use; undefined when no archive exists yet. */
export function openArchiveForQuery(): ArchiveHandle | undefined {
    const dbPath = archiveDbPath();
    if (!fs.existsSync(dbPath)) return undefined;
    const db = openArchiveDb(dbPath);
    return { db, incompatible: archiveIncompatibility(db) };
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
    db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Drop the parts of an entry the projection never reads, keeping the entry and
 * its parent link. Dropping entries outright is NOT an option: the active
 * branch is recovered by walking `parentId` links, so a removed bookkeeping
 * entry truncates the branch and silently loses every message after it.
 */
function slimEntry(entry: FileEntry): FileEntry {
    if (entry.type === "custom") {
        const { data: _data, ...rest } = entry as FileEntry & { data?: unknown };
        return rest as FileEntry;
    }
    if (entry.type === "message") {
        const msg = (entry as { message?: Record<string, unknown> }).message;
        const role = msg?.role;
        if (role === "toolResult" || role === "system") {
            return {
                ...entry,
                message: { ...msg, content: [] },
            } as unknown as FileEntry;
        }
        if (role === "bashExecution") {
            return {
                ...entry,
                message: { ...msg, content: [], command: "", output: "" },
            } as unknown as FileEntry;
        }
    }
    return entry;
}

/**
 * Stream-parse a session file. `readFileSync(..., "utf-8")` cannot be used:
 * the largest current session is 620 MB and V8 caps a string at ~512 M chars.
 * Returns the migrated header + entries, with unsearchable payloads slimmed.
 */
export async function readSessionFileForIngest(
    srcFile: string,
): Promise<{ header: SessionHeader; entries: SessionEntry[] }> {
    const stream = fs.createReadStream(srcFile, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let header: SessionHeader | undefined;
    const raw: FileEntry[] = [];
    try {
        for await (const line of rl) {
            if (!line.trim()) continue;
            let parsed: FileEntry;
            try {
                parsed = JSON.parse(line) as FileEntry;
            } catch {
                continue; // malformed line: same tolerance as parseSessionEntries
            }
            if (!header) {
                if (parsed.type !== "session")
                    throw new Error("not a session file (first line is not a header)");
                header = parsed as SessionHeader;
                continue;
            }
            if (parsed.type === "session") continue; // duplicated header
            raw.push(slimEntry(parsed));
        }
    } finally {
        rl.close();
        stream.destroy();
    }
    if (!header) throw new Error("empty session file (no header)");
    // Migration reads the header's version, so the header must ride along;
    // migrating a headerless array would assume v1 and regenerate every id.
    const all: FileEntry[] = [header, ...raw];
    migrateSessionEntries(all);
    return { header, entries: all.filter((e) => e.type !== "session") as SessionEntry[] };
}

export interface IngestOutcome {
    sessionId: string;
    entryCount: number;
    messageCount: number;
    fileSize: number;
    mtimeMs: number;
    firstUserMessage: string | null;
}

interface ProjectedRow {
    entryId: string;
    parentId: string | null;
    role: string;
    timestamp: string;
    tsMs: number | null;
    text: string;
    tools: string;
}

/**
 * Project the active branch into searchable rows. Split out so the ingest
 * verification can compare row counts against the projection itself.
 */
export function projectSearchableRows(entries: SessionEntry[]): {
    rows: ProjectedRow[];
    firstUserMessage: string | null;
    firstUserEntryId: string | null;
} {
    const rows: ProjectedRow[] = [];
    let firstUserMessage: string | null = null;
    let firstUserEntryId: string | null = null;

    for (const entry of buildContextEntries(entries)) {
        for (const msg of sessionEntryToContextMessages(entry)) {
            // Self-reference guard, same set as the live scan.
            if (
                msg.role === "custom" &&
                SELF_EXCLUDED_CUSTOM_TYPES.has(msg.customType)
            ) {
                continue;
            }
            const body = messageBodyText(msg, textOf);
            const tools =
                msg.role === "assistant" ? toolCallHaystack(msg) : "";
            // First user message of the ACTIVE-BRANCH projection (pi's
            // de-facto title, the tier-1 key). Recorded before the empty-text
            // skip so an empty user message still anchors tier 1, exactly like
            // collectEntryHits does on the hot side.
            if (msg.role === "user" && firstUserEntryId === null) {
                firstUserEntryId = entry.id;
                firstUserMessage = body;
            }
            if (!body && !tools) continue;
            const tsMs = messageTimestampMs(msg) ?? Date.parse(entry.timestamp);
            rows.push({
                entryId: entry.id,
                parentId: (entry as { parentId?: string }).parentId ?? null,
                role: msg.role,
                timestamp: entry.timestamp,
                tsMs: Number.isFinite(tsMs) ? tsMs : null,
                text: body,
                tools,
            });
        }
    }
    return { rows, firstUserMessage, firstUserEntryId };
}

/** SQL string literal quoting ('' doubling); used only for exec-built writes. */
function sqlLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Delete every row belonging to one session (FTS first: it needs the ids).
 *
 * Everything goes through `exec` with literal integers/strings, never through
 * `run()`. Deleting from the `contentless_delete=1` FTS table leaves a garbage
 * `last_insert_rowid` behind in the SQLite handle, and node:sqlite then throws
 * `RangeError: Value is too large to be represented as a JavaScript number`
 * when the next `run()` reports its own rowid. The ids come from the DB itself
 * (integers) and are chunked so no statement grows unbounded; the session id is
 * quoted here because `exec` cannot bind parameters.
 */
export function deleteSessionRows(db: DatabaseSync, sessionId: string): void {
    const ids = (
        db.prepare("SELECT id FROM entries WHERE session_id = ?").all(sessionId) as Array<{
            id: number;
        }>
    ).map((row) => row.id);
    const CHUNK = 500;
    for (let start = 0; start < ids.length; start += CHUNK) {
        const chunk = ids.slice(start, start + CHUNK).join(",");
        db.exec(`DELETE FROM entries_fts WHERE rowid IN (${chunk})`);
        db.exec(`DELETE FROM entries WHERE id IN (${chunk})`);
    }
    db.exec(`DELETE FROM sessions WHERE session_id = ${sqlLiteral(sessionId)}`);
}

export interface IngestOptions {
    /** Archive path the file will live at after the move (stored in `file`). */
    destFile: string;
    projectDir: string;
    /**
     * Directory the file came from. Recorded so `restore` puts it back exactly
     * where it was, including custom `--session-dir` roots that are not under
     * the default sessions root. `null` means "unknown": a rebuild from disk
     * after the index was lost has nothing to read it from, and a guess would be
     * worse than an honest absence (restore falls back to the default root and
     * says so).
     */
    sourceDir: string | null;
    /** Session display name, when the caller already knows it. */
    sessionName?: string | null;
}

/**
 * Ingest one session file in a single transaction. Idempotent: an existing
 * session id has its rows replaced, so a re-ingest after a rebuild or a
 * restore/re-archive cycle never double-counts.
 */
export async function ingestSessionFile(
    db: DatabaseSync,
    srcFile: string,
    options: IngestOptions,
): Promise<IngestOutcome> {
    const stat = fs.statSync(srcFile);
    const { header, entries } = await readSessionFileForIngest(srcFile);
    const { rows, firstUserMessage, firstUserEntryId } = projectSearchableRows(entries);
    const sessionId = header.id;
    if (!sessionId) throw new Error("session header has no id");
    const messageCount = rows.filter(
        (row) => row.role !== "branchSummary" && row.role !== "compactionSummary",
    ).length;

    const insertEntry = db.prepare(
        `INSERT INTO entries
           (session_id, entry_id, parent_id, role, timestamp, ts_ms, text, tool_calls)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = db.prepare(
        "INSERT INTO entries_fts (rowid, ng_text, ng_tools) VALUES (?, ?, ?)",
    );

    db.exec("BEGIN IMMEDIATE");
    try {
        deleteSessionRows(db, sessionId);
        db.prepare(
            `INSERT INTO sessions
               (session_id, file, project_dir, source_dir, cwd, created_at,
                format_version, entry_count, message_count, file_size, mtime_ms,
                first_user_message, first_user_entry_id, session_name, archived_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            sessionId,
            options.destFile,
            options.projectDir,
            options.sourceDir === null ? null : path.resolve(options.sourceDir),
            typeof header.cwd === "string" && header.cwd
                ? path.resolve(header.cwd)
                : null,
            header.timestamp ?? new Date(stat.mtimeMs).toISOString(),
            header.version ?? 1,
            rows.length,
            messageCount,
            stat.size,
            Math.trunc(stat.mtimeMs),
            firstUserMessage,
            firstUserEntryId,
            options.sessionName ?? null,
            new Date().toISOString(),
        );
        for (const row of rows) {
            const result = insertEntry.run(
                sessionId,
                row.entryId,
                row.parentId,
                row.role,
                row.timestamp,
                row.tsMs,
                row.text,
                row.tools,
            );
            insertFts.run(
                result.lastInsertRowid as number,
                ngramTokens(row.text),
                ngramTokens(row.tools),
            );
        }
        const stored = db
            .prepare("SELECT COUNT(*) AS c FROM entries WHERE session_id = ?")
            .get(sessionId) as { c: number };
        if (stored.c !== rows.length)
            throw new Error(
                `ingest verification failed: wrote ${rows.length} rows, found ${stored.c}`,
            );
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw new Error(`ingest ${path.basename(srcFile)}: ${errorMessage(error)}`);
    }

    return {
        sessionId,
        entryCount: rows.length,
        messageCount,
        fileSize: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
        firstUserMessage,
    };
}

// ---------------------------------------------------------------------------
// Cold query
// ---------------------------------------------------------------------------

export interface ColdQueryOptions {
    query: string;
    /** The compiled matcher, shared with the hot scan (never re-derived here). */
    re: RegExp;
    regexQuery: boolean;
    normalizedQuery: string;
    includeToolCalls: boolean;
    sinceMs?: number;
    untilMs?: number;
    scope: "project" | "all";
    /** Project cwd, used for scope=project filtering. */
    cwd: string;
    /** Current project's session-directory name, the scope=all ownership key. */
    currentProjectDir?: string;
    /** Wall-clock budget for the candidate pass. */
    budgetMs: number;
    maxSessions: number;
    signal?: AbortSignal;
}

export interface ColdHit {
    hit: SearchHit;
    rank: HitRank;
    /** scope=all ownership key, so a merge with hot hits keeps one order. */
    isCurrentProject: boolean;
}

export interface ColdQueryResult {
    hits: ColdHit[];
    /** Archived sessions in scope. */
    listed: number;
    /** Candidate rows examined (FTS hits or scanned rows). */
    examined: number;
    /** Candidates that survived the second-pass matcher. */
    verified: number;
    prefilter: "ngram" | "scan";
    truncated?: string;
    /** Sessions whose archived file no longer matches what was ingested. */
    stale: number;
}

interface CandidateRow {
    entry_id: string;
    role: string;
    timestamp: string;
    ts_ms: number | null;
    text: string | null;
    tool_calls: string | null;
    session_id: string;
    file: string;
    file_size: number;
    mtime_ms: number;
    first_user_message: string | null;
    first_user_entry_id: string | null;
    cwd: string | null;
    project_dir: string;
}

const CANDIDATE_COLUMNS = `
    e.entry_id, e.role, e.timestamp, e.ts_ms, e.text, e.tool_calls,
    s.session_id, s.file, s.file_size, s.mtime_ms,
    s.first_user_message, s.first_user_entry_id, s.cwd, s.project_dir`;

/**
 * Query the archived corpus.
 *
 * Two passes, in this order of authority:
 *
 *   1. FTS (or a full scan when the query is a regex or has a run too short to
 *      n-gram) produces CANDIDATES. Its only job is to not miss rows.
 *   2. Each candidate's `text`/`tool_calls` is rejoined exactly like
 *      `haystackFor` does and re-matched with the live regex, then
 *      `buildSnippet` and `compareRank` run unchanged.
 *
 * The second pass is not a safety net, it is the semantics: n-gram phrase
 * matching cannot express whitespace sensitivity or run order, and it never
 * sees a regex. It is also what makes the `contentless` FTS table acceptable,
 * since snippets come from `entries.text` rather than `snippet()`.
 */
export function queryCold(db: DatabaseSync, options: ColdQueryOptions): ColdQueryResult {
    const startedAt = Date.now();
    const phrase = options.regexQuery ? null : ngramPhrase(options.query);
    const prefilter: "ngram" | "scan" = phrase ? "ngram" : "scan";

    const filters: string[] = [];
    const params: Record<string, string | number | null> = {};
    if (options.scope === "project") {
        filters.push("s.cwd = :cwd");
        params.cwd = path.resolve(options.cwd);
    }
    if (options.sinceMs !== undefined) {
        filters.push("e.ts_ms >= :since");
        params.since = options.sinceMs;
    }
    if (options.untilMs !== undefined) {
        filters.push("e.ts_ms <= :until");
        params.until = options.untilMs;
    }
    const where = filters.length ? ` AND ${filters.join(" AND ")}` : "";

    let sql: string;
    if (phrase) {
        params.match = options.includeToolCalls
            ? `(${ftsMatch(phrase, "ng_text")}) OR (${ftsMatch(phrase, "ng_tools")})`
            : ftsMatch(phrase, "ng_text");
        // FTS5 matches on the TABLE name, never an alias.
        sql = `SELECT ${CANDIDATE_COLUMNS}
                 FROM entries_fts
                 JOIN entries e ON e.id = entries_fts.rowid
                 JOIN sessions s ON s.session_id = e.session_id
                WHERE entries_fts MATCH :match${where}`;
    } else {
        sql = `SELECT ${CANDIDATE_COLUMNS}
                 FROM entries e
                 JOIN sessions s ON s.session_id = e.session_id
                WHERE 1 = 1${where}`;
    }

    const listedRow =
        options.scope === "project"
            ? (db
                  .prepare("SELECT COUNT(*) AS c FROM sessions WHERE cwd = ?")
                  .get(path.resolve(options.cwd)) as { c: number })
            : (db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number });

    const groups = new Map<
        string,
        {
            sessionPath: string;
            sessionId: string;
            projectDir: string;
            best: SearchHit;
            rank: HitRank;
            total: number;
            stale: boolean;
        }
    >();
    /** stat per session, computed at most once. */
    const staleCache = new Map<string, boolean>();
    const isStale = (row: CandidateRow): boolean => {
        const cached = staleCache.get(row.file);
        if (cached !== undefined) return cached;
        let stale = true;
        try {
            const st = fs.statSync(row.file);
            stale =
                st.size !== row.file_size || Math.trunc(st.mtimeMs) !== row.mtime_ms;
        } catch {
            stale = true;
        }
        staleCache.set(row.file, stale);
        return stale;
    };

    let examined = 0;
    let verified = 0;
    let truncated: string | undefined;
    const iter = db.prepare(sql).iterate(params);
    for (const raw of iter) {
        const row = raw as unknown as CandidateRow;
        if (options.signal?.aborted) {
            truncated = "aborted";
            break;
        }
        if (Date.now() - startedAt > options.budgetMs) {
            truncated = "time-budget";
            break;
        }
        examined++;

        const body = row.text ?? "";
        const tools = row.tool_calls ?? "";
        // Rejoin exactly like haystackFor: the separator is part of the
        // haystack for an assistant row whenever includeToolCalls is on, even
        // when the tool-call rendering is empty.
        const haystack =
            options.includeToolCalls && row.role === "assistant"
                ? `${body}\n${tools}`
                : body;
        if (!haystack) continue;
        const searched = haystack.slice(0, MAX_HAYSTACK_CHARS);
        const found = searched.match(options.re);
        if (!found) continue;
        verified++;

        const snippet = buildSnippet(searched, found.index ?? 0, {
            fullText: haystack,
            realEnd: body.length,
        });
        const firstUser = row.first_user_message;
        const tier =
            firstUser !== null &&
            row.entry_id === row.first_user_entry_id &&
            options.re.test(firstUser)
                ? 1
                : 2;
        const rank: HitRank = {
            tier,
            exact:
                tier === 1 &&
                !options.regexQuery &&
                normalizeForTier(firstUser ?? "") === options.normalizedQuery,
            ts: row.ts_ms ?? Date.parse(row.timestamp),
            roleWeight: roleWeightForRole(row.role),
        };
        const stale = isStale(row);
        const hit: SearchHit = {
            sessionPath: row.file,
            sessionId: row.session_id,
            entryId: row.entry_id,
            timestamp: row.timestamp,
            role: row.role,
            snippet: snippet.text,
            omittedBeforeLines: snippet.omittedBeforeLines,
            omittedAfterLines: snippet.omittedAfterLines,
            archived: true,
            ...(stale ? { stale: true as const } : {}),
        };

        const group = groups.get(row.file);
        if (group) {
            group.total++;
            if (betterRank(rank, group.rank)) {
                group.best = hit;
                group.rank = rank;
            }
        } else {
            groups.set(row.file, {
                sessionPath: row.file,
                sessionId: row.session_id,
                projectDir: row.project_dir,
                best: hit,
                rank,
                total: 1,
                stale,
            });
        }
    }

    const currentProjectDir = options.currentProjectDir;
    const ordered = [...groups.values()]
        .map((group) => ({
            group,
            isCurrentProject:
                options.scope === "all"
                    ? currentProjectDir !== undefined &&
                      group.projectDir === currentProjectDir
                    : true,
        }))
        .sort((a, b) => {
            if (a.isCurrentProject !== b.isCurrentProject)
                return a.isCurrentProject ? -1 : 1;
            return compareRank(a.group.rank, b.group.rank);
        })
        .slice(0, options.maxSessions)
        .map(({ group, isCurrentProject }) => ({
            hit:
                group.total > 1
                    ? { ...group.best, more: group.total - 1 }
                    : group.best,
            rank: group.rank,
            isCurrentProject,
        }));

    return {
        hits: ordered,
        listed: listedRow.c,
        examined,
        verified,
        prefilter,
        truncated,
        stale: [...staleCache.values()].filter(Boolean).length,
    };
}

// ---------------------------------------------------------------------------
// Lookup, stats, restore
// ---------------------------------------------------------------------------

export interface ArchiveStats {
    sessions: number;
    entries: number;
    projects: number;
    indexBytes: number;
    oldest: string | null;
    newest: string | null;
    staleSessions: number;
    /** Files on disk that the index does not know about (0 when in sync). */
    unindexed: number;
    incompatible?: string;
}

/** What the archive directory holds, counted without touching the index. */
export function archiveDiskUsage(): {
    sessions: number;
    bytes: number;
    files: string[];
} {
    let sessions = 0;
    let bytes = 0;
    const files: string[] = [];
    let projects: string[];
    try {
        projects = fs
            .readdirSync(archiveSessionsDir(), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    } catch {
        return { sessions, bytes, files };
    }
    for (const project of projects) {
        const dir = path.join(archiveSessionsDir(), project);
        let names: string[];
        try {
            names = fs.readdirSync(dir);
        } catch {
            continue;
        }
        for (const name of names) {
            if (!name.endsWith(".jsonl")) continue;
            const file = path.join(dir, name);
            try {
                bytes += fs.statSync(file).size;
            } catch {
                // vanished mid-scan: it is not on disk either way
                continue;
            }
            sessions++;
            files.push(file);
        }
    }
    return { sessions, bytes, files };
}

export function archiveStats(db: DatabaseSync): ArchiveStats {
    const one = <T>(sql: string): T => db.prepare(sql).get() as T;
    const sessions = one<{ c: number }>("SELECT COUNT(*) AS c FROM sessions").c;
    const entries = one<{ c: number }>("SELECT COUNT(*) AS c FROM entries").c;
    const projects = one<{ c: number }>(
        "SELECT COUNT(DISTINCT project_dir) AS c FROM sessions",
    ).c;
    const span = one<{ oldest: string | null; newest: string | null }>(
        "SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM sessions",
    );
    let indexBytes = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
        try {
            indexBytes += fs.statSync(archiveDbPath() + suffix).size;
        } catch {
            // absent suffix: nothing to add
        }
    }
    let staleSessions = 0;
    for (const row of db
        .prepare("SELECT file, file_size, mtime_ms FROM sessions")
        .iterate() as Iterable<{ file: string; file_size: number; mtime_ms: number }>) {
        try {
            const st = fs.statSync(row.file);
            if (st.size !== row.file_size || Math.trunc(st.mtimeMs) !== row.mtime_ms)
                staleSessions++;
        } catch {
            staleSessions++;
        }
    }
    const disk = archiveDiskUsage();
    const known = new Set(
        (
            db.prepare("SELECT file FROM sessions").all() as Array<{
                file: string;
            }>
        ).map((row) => row.file),
    );
    const unindexed = disk.files.filter((file) => !known.has(file)).length;
    return {
        sessions,
        entries,
        projects,
        indexBytes,
        oldest: span.oldest,
        newest: span.newest,
        staleSessions,
        unindexed,
        incompatible: archiveIncompatibility(db),
    };
}

/**
 * Move an archived session back into the hot session root and drop its index
 * rows. Order is deliberate: rows first, then the rename. If the rename fails
 * the file is still safe in the archive and a re-run of `/archive run`
 * re-ingests it; the reverse order would leave cold rows pointing at a file
 * that is no longer archived.
 */
export function restoreArchivedSession(
    db: DatabaseSync,
    sessionId: string,
): { from: string; to: string; originKnown: boolean } {
    const row = db
        .prepare(
            "SELECT file, project_dir, source_dir FROM sessions WHERE session_id = ?",
        )
        .get(sessionId) as
        | { file: string; project_dir: string; source_dir: string | null }
        | undefined;
    if (!row) throw new Error(`no archived session ${sessionId}`);
    // Prefer the recorded origin directory: a custom --session-dir (piw,
    // schedule runs) is not under the default sessions root, and dropping the
    // file into `~/.pi/agent/sessions/<project>/` would hide it from the
    // process that owns it. `originKnown: false` means the index was rebuilt
    // from disk (nothing recorded the origin), so the caller must SAY that the
    // default root is a guess rather than let it look exact.
    const originKnown = row.source_dir !== null;
    const dest = path.join(
        row.source_dir ?? path.join(getAgentDir(), "sessions", row.project_dir),
        path.basename(row.file),
    );
    if (fs.existsSync(dest))
        throw new Error(`refusing to overwrite ${dest}`);
    // Move first, forget the rows second. The other order orphans the file on a
    // failed rename (permissions, EXDEV): the JSONL would sit in the archive
    // root with no row pointing at it, and neither `run` (hot dirs only) nor
    // `rebuild` (existing rows only) would ever pick it up again. This way a
    // failure leaves the index row intact and the session still findable
    // through the cold side, which reports it as stale until a re-run.
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(row.file, dest);
    db.exec("BEGIN IMMEDIATE");
    try {
        deleteSessionRows(db, sessionId);
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
    return { from: row.file, to: dest, originKnown };
}
