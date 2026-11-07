/**
 * schedule store: task definitions, scheduling watermark, run-dir GC.
 *
 * Layout (all paths derived at call time so tests can redirect via
 * PI_CODING_AGENT_DIR, exactly like pi's own getAgentDir()):
 *
 *   <agentDir>/schedule/tasks/<id>.json       task definition, git-tracked
 *   <agentDir>/schedule/runs/<id>/state.json  tick-owned scheduling watermark
 *   <agentDir>/schedule/runs/<id>/<ts>/       one directory per run
 *
 * This module is pi-free on purpose: the `schedule` CLI is executed by plain
 * `node`, which cannot resolve `@earendil-works/*` (pi's loader resolves those
 * against the pi install root). Only node built-ins are allowed here.
 */
import { randomBytes } from "node:crypto";
import {
    type Dirent,
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Runs kept per task regardless of age. */
export const KEEP_RUNS = 10;
/** Runs kept per task regardless of position (14 days). */
export const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

const TASK_ID_PATTERN = /^[a-z0-9]{8}$/;
const RUN_STAMP_PATTERN = /^\d{8}-\d{6}$/;

export interface Task {
    version: 1;
    id: string;
    name: string;
    cron: string;
    enabled: boolean;
    cwd: string;
    prompt?: string;
    promptFile?: string;
    once: boolean;
    createdAt: string;
}

export interface Watermark {
    version: 1;
    taskId: string;
    /** Last slot that was consumed (dispatched or recorded as missed). */
    lastSlotConsumed: string | null;
    updatedAt: string;
}

export interface TaskListEntry {
    id: string;
    task: Task | undefined;
    error?: string;
}

export interface AddTaskInput {
    name: string;
    cron: string;
    cwd: string;
    prompt?: string;
    promptFile?: string;
    once?: boolean;
}

export interface AddTaskOptions {
    /** Injectable id source (tests use it to force collisions). */
    nextId?: () => string;
    /** Injectable clock. */
    now?: () => Date;
}

export function getAgentDir(): string {
    const fromEnv = process.env.PI_CODING_AGENT_DIR;
    if (fromEnv && fromEnv.length > 0) return fromEnv;
    return join(homedir(), ".pi", "agent");
}

export function getScheduleDir(): string {
    return join(getAgentDir(), "schedule");
}

export function tasksDir(): string {
    return join(getScheduleDir(), "tasks");
}

export function runsRoot(): string {
    return join(getScheduleDir(), "runs");
}

export function taskRunsDir(taskId: string): string {
    // Callers must validate the id first; this only keeps the join readable.
    return join(runsRoot(), taskId);
}

export function runDir(taskId: string, stamp: string): string {
    return join(taskRunsDir(taskId), stamp);
}

export function watermarkPath(taskId: string): string {
    return join(taskRunsDir(taskId), "state.json");
}

function taskPath(id: string): string {
    return join(tasksDir(), `${id}.json`);
}

export function ensureDir(path: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 });
}

/**
 * Write JSON atomically: temp file in the same directory, then rename.
 *
 * Ported from pi-subagent's writeMetadata (same rationale): a reader either
 * sees the previous document or the next one, never a half-written file.
 */
export function atomicWriteJson(path: string, value: unknown): void {
    ensureDir(dirname(path));
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const body = `${JSON.stringify(value, null, 2)}\n`;
    try {
        writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
        renameSync(temporary, path);
    } catch (error) {
        try {
            unlinkSync(temporary);
        } catch {
            // best effort
        }
        throw error;
    }
}

/** Read + parse one JSON document; a missing or corrupt file yields undefined. */
export function readJsonFile(path: string): unknown | undefined {
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return undefined;
    }
}

export function validateTaskId(id: string): boolean {
    return typeof id === "string" && TASK_ID_PATTERN.test(id);
}

export function validateRunStamp(stamp: string): boolean {
    return typeof stamp === "string" && RUN_STAMP_PATTERN.test(stamp);
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}

/** Shape check for a parsed task document; anything off ⇒ undefined. */
function parseTask(id: string, raw: string): Task | undefined {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (typeof value !== "object" || value === null) return undefined;
    const task = value as Partial<Task>;
    if (task.version !== 1) return undefined;
    if (task.id !== id || !validateTaskId(id)) return undefined;
    if (!isString(task.name) || task.name.length === 0) return undefined;
    if (!isString(task.cron) || task.cron.length === 0) return undefined;
    if (typeof task.enabled !== "boolean") return undefined;
    if (!isString(task.cwd) || task.cwd.length === 0) return undefined;
    if (typeof task.once !== "boolean") return undefined;
    if (!isString(task.createdAt)) return undefined;
    if (task.prompt !== undefined && !isString(task.prompt)) return undefined;
    if (task.promptFile !== undefined && !isString(task.promptFile)) return undefined;
    const parsed: Task = {
        version: 1,
        id,
        name: task.name,
        cron: task.cron,
        enabled: task.enabled,
        cwd: task.cwd,
        once: task.once,
        createdAt: task.createdAt,
    };
    if (task.prompt !== undefined) parsed.prompt = task.prompt;
    if (task.promptFile !== undefined) parsed.promptFile = task.promptFile;
    return parsed;
}

export function readTask(id: string): Task | undefined {
    if (!validateTaskId(id)) return undefined;
    let raw: string;
    try {
        raw = readFileSync(taskPath(id), "utf8");
    } catch {
        return undefined;
    }
    return parseTask(id, raw);
}

/**
 * Every task file on disk. Corrupt files are reported (not dropped) so `list`
 * can show them; a missing tasks directory is simply an empty list.
 */
export function listTasks(): TaskListEntry[] {
    const dir = tasksDir();
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }
    const out: TaskListEntry[] = [];
    for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const id = entry.slice(0, -".json".length);
        if (!validateTaskId(id)) {
            out.push({ id, task: undefined, error: `invalid task file name: ${entry}` });
            continue;
        }
        let raw: string;
        try {
            raw = readFileSync(join(dir, entry), "utf8");
        } catch (error) {
            out.push({ id, task: undefined, error: `unreadable: ${errorMessage(error)}` });
            continue;
        }
        const task = parseTask(id, raw);
        if (task) out.push({ id, task });
        else out.push({ id, task: undefined, error: "corrupt task definition" });
    }
    out.sort((left, right) => {
        const leftAt = left.task?.createdAt ?? "";
        const rightAt = right.task?.createdAt ?? "";
        if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
    return out;
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function defaultNextId(): string {
    return randomBytes(4).toString("hex");
}

export function addTask(input: AddTaskInput, options: AddTaskOptions = {}): Task {
    const name = input.name?.trim();
    if (!name) throw new Error("add: --name is required");
    const cron = input.cron?.trim();
    if (!cron) throw new Error("add: --cron is required");
    const cwd = input.cwd?.trim();
    if (!cwd) throw new Error("add: --cwd is required");
    if (!cwd.startsWith("/")) throw new Error(`add: --cwd must be an absolute path: ${cwd}`);
    let cwdStat;
    try {
        cwdStat = statSync(cwd);
    } catch {
        throw new Error(`add: --cwd does not exist: ${cwd}`);
    }
    if (!cwdStat.isDirectory()) throw new Error(`add: --cwd is not a directory: ${cwd}`);
    if (input.prompt !== undefined && input.promptFile !== undefined) {
        throw new Error("add: --prompt and --prompt-file are mutually exclusive");
    }
    if (input.prompt === undefined && input.promptFile === undefined) {
        throw new Error("add: one of --prompt or --prompt-file is required");
    }
    if (input.promptFile !== undefined) {
        const promptFile = input.promptFile.trim();
        if (!promptFile) throw new Error("add: --prompt-file is empty");
        if (!existsSync(promptFile)) throw new Error(`add: --prompt-file does not exist: ${promptFile}`);
    }

    const now = (options.now ?? (() => new Date()))();
    const nextId = options.nextId ?? defaultNextId;
    ensureDir(tasksDir());
    for (let attempt = 0; attempt < 100; attempt++) {
        const id = nextId();
        if (!validateTaskId(id)) throw new Error(`add: generated invalid task id: ${id}`);
        const path = taskPath(id);
        if (existsSync(path)) continue;
        const task: Task = {
            version: 1,
            id,
            name,
            cron,
            enabled: true,
            cwd,
            once: input.once === true,
            createdAt: now.toISOString(),
        };
        if (input.prompt !== undefined) task.prompt = input.prompt;
        if (input.promptFile !== undefined) task.promptFile = input.promptFile.trim();
        atomicWriteJson(path, task);
        try {
            chmodSync(path, 0o600);
        } catch {
            // mode is advisory
        }
        return task;
    }
    throw new Error("add: could not allocate a unique task id");
}

export function removeTask(id: string): boolean {
    if (!validateTaskId(id)) return false;
    const path = taskPath(id);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
}

export function setTaskEnabled(id: string, enabled: boolean): Task | undefined {
    const task = readTask(id);
    if (!task) return undefined;
    const next: Task = { ...task, enabled };
    atomicWriteJson(taskPath(id), next);
    return next;
}

/**
 * Prompt text of a task. `prompt` and `promptFile` are mutually exclusive; a
 * task that has both or neither is a configuration error, not a silent default.
 */
export function promptTextOf(task: Task): string {
    const hasInline = task.prompt !== undefined;
    const hasFile = task.promptFile !== undefined;
    if (hasInline === hasFile) {
        throw new Error(`task ${task.id}: exactly one of prompt / promptFile must be set`);
    }
    if (hasInline) return task.prompt as string;
    const path = task.promptFile as string;
    try {
        return readFileSync(path, "utf8");
    } catch (error) {
        throw new Error(`task ${task.id}: cannot read promptFile ${path}: ${errorMessage(error)}`);
    }
}

export function readWatermark(taskId: string): Watermark {
    const synthetic: Watermark = {
        version: 1,
        taskId,
        lastSlotConsumed: null,
        updatedAt: "",
    };
    if (!validateTaskId(taskId)) return synthetic;
    // A torn/corrupt watermark must never wedge scheduling: treat it as
    // "never consumed" and let the next tick rewrite it.
    const value = readJsonFile(watermarkPath(taskId));
    if (!value || typeof value !== "object") return synthetic;
    const parsed = value as Partial<Watermark>;
    const slot = parsed.lastSlotConsumed;
    if (parsed.version !== 1) return synthetic;
    if (slot !== null && !isString(slot)) return synthetic;
    return {
        version: 1,
        taskId,
        lastSlotConsumed: slot ?? null,
        updatedAt: isString(parsed.updatedAt) ? parsed.updatedAt : "",
    };
}

export function writeWatermark(taskId: string, lastSlotConsumed: string | null): void {
    if (!validateTaskId(taskId)) throw new Error(`invalid task id: ${taskId}`);
    const watermark: Watermark = {
        version: 1,
        taskId,
        lastSlotConsumed,
        updatedAt: new Date().toISOString(),
    };
    atomicWriteJson(watermarkPath(taskId), watermark);
}

/** Run stamps (`YYYYMMDD-HHmmss`) of one task, newest first. */
export function listRunStamps(taskId: string): string[] {
    if (!validateTaskId(taskId)) return [];
    let entries: Dirent[];
    try {
        entries = readdirSync(taskRunsDir(taskId), { withFileTypes: true });
    } catch {
        return [];
    }
    const stamps: string[] = [];
    for (const entry of entries) {
        if (validateRunStamp(entry.name) && entry.isDirectory()) stamps.push(entry.name);
    }
    stamps.sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
    return stamps;
}

/**
 * Collect old run directories.
 *
 * Walks run directories (not task files) so runs left behind by a removed task
 * are collected too. Retention is OR: keep the newest KEEP_RUNS runs *or*
 * anything younger than KEEP_MS. The newest run of every task and the
 * watermark (`state.json`, a sibling of the stamp dirs) are never removed.
 */
export function gcRuns(now: Date = new Date()): { removed: string[] } {
    const removed: string[] = [];
    const root = runsRoot();
    let taskDirs: Dirent[];
    try {
        taskDirs = readdirSync(root, { withFileTypes: true });
    } catch {
        return { removed };
    }
    const nowMs = now.getTime();
    for (const entry of taskDirs) {
        if (!entry.isDirectory()) continue;
        const taskId = entry.name;
        const taskDir = join(root, taskId);
        const stamps = listRunStamps(taskId);
        stamps.forEach((stamp, index) => {
            if (index === 0) return; // newest run always survives
            if (index < KEEP_RUNS) return;
            const full = join(taskDir, stamp);
            let ageMs: number;
            try {
                ageMs = nowMs - statSync(full).mtimeMs;
            } catch {
                return;
            }
            if (ageMs < KEEP_MS) return;
            try {
                rmSync(full, { recursive: true, force: true });
                removed.push(full);
            } catch {
                // leave it for the next tick
            }
        });
    }
    return { removed };
}
