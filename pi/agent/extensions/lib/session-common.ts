/**
 * Shared session-file plumbing for the session viewer extensions
 * (read-session.ts, find-session.ts).
 *
 * This module intentionally holds only the pieces both consumers need:
 *
 *   - expandHome          — tilde expansion shared by path handling
 *   - resolveSessionRef   — pi `--session <path|id>` semantics
 *   - loadSessionEntries  — read + parse + migrate a session JSONL file
 *   - textOf              — text-part concatenation over message content
 *
 * Each of these carries a contract (id resolution order, migration order,
 * role/content projection) that must NOT fork across consumers when the pi
 * upstream changes the session format, which is why they live in one module
 * instead of being duplicated per extension.
 *
 * All functions here are strictly read-only: `SessionManager.open()` is never
 * used (it is a live read/write object whose migration may rewrite the file);
 * the only SessionManager surface is the static read-only metadata lookup
 * `list`/`listAll` inside `resolveSessionRef`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	migrateSessionEntries,
	parseSessionEntries,
	SessionManager,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";

/** Expand a leading `~` to the home directory. */
export function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * Resolve a `session` argument — path or session id — to a session JSONL
 * path. Semantics mirror the pi CLI's `--session <path|id>`
 * (resolveSessionPath):
 *
 *   - Path form (contains "/" or "\", or ends ".jsonl"): tilde-expanded and
 *     resolved against the process cwd.
 *   - Id form: exact match first, then prefix match, against the current
 *     project's session dir (`SessionManager.list(cwd)`) and then all
 *     projects (`SessionManager.listAll()`). Both lists sort by modified time
 *     descending, so a prefix match resolves to the most recently modified
 *     hit (first match) — same as the CLI.
 *
 * The id search only covers the default sessions root's first level
 * (`~/.pi/agent/sessions/<project>/*.jsonl`), exactly like the CLI. Sessions
 * nested deeper (subagent sessions live at
 * `sessions/<tool>/<runId>/*.jsonl`) are out of scope by design: the caller
 * passes their path (a subagent envelope reports it as `session=`).
 */
export async function resolveSessionRef(ref: string): Promise<string> {
	if (ref.includes("/") || ref.includes("\\") || ref.endsWith(".jsonl")) {
		return path.resolve(expandHome(ref));
	}

	const matchId = (sessions: readonly { id: string; path: string }[]) =>
		sessions.find((s) => s.id === ref) ?? sessions.find((s) => s.id.startsWith(ref));

	const localMatch = matchId(await SessionManager.list(process.cwd()));
	if (localMatch) return localMatch.path;
	const globalMatch = matchId(await SessionManager.listAll());
	if (globalMatch) return globalMatch.path;

	throw new Error(
		`no session found for "${ref}". Id lookup resolves pi session ids (exact match first, then prefix, most ` +
			"recently modified wins) and only covers sessions under ~/.pi/agent/sessions/<project>/; for sessions " +
			"outside that layout (e.g. subagent sessions), pass the .jsonl path instead.",
	);
}

/**
 * Read a session JSONL file, parse, migrate to the current version, and split
 * the header from the entry array. Shared by every session-viewer tool. Throws
 * when the file is unreadable.
 */
export function loadSessionEntries(
	rawPath: string,
): { filePath: string; header: SessionHeader | undefined; entries: SessionEntry[] } {
	const filePath = expandHome(rawPath);

	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		throw new Error(`cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const parsed = parseSessionEntries(content);
	// Migrate the FULL entry array first: migrateToCurrentVersion reads the
	// header's version. Migrating a headerless array would assume version 1 and
	// regenerate every entry id (destroying branch structure and
	// firstKeptEntryId references). Then mirror
	// SessionManager.buildContextEntries(): build functions receive entries
	// only, the header is handled separately.
	migrateSessionEntries(parsed);
	const header = parsed.find((entry): entry is SessionHeader => entry.type === "session");
	const entries = parsed.filter((entry): entry is SessionEntry => entry.type !== "session");
	return { filePath, header, entries };
}

/** Concatenate the text parts of a message content (string or parts array). */
export function textOf(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}
