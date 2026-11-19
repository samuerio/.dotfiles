/**
 * session-search extension entry: one capability, two halves.
 *
 * Hot (`./search.ts`): the `search_sessions` tool + `/search-sessions` panel,
 * scanning session JSONL files in realtime.
 * Cold (`./archive.ts` + `./store.ts`): the `/archive` command family, which
 * moves quiescent sessions into `~/.pi/agent/archive/` and indexes their
 * searchable projection so the hot side can fall back to them.
 *
 * They are one extension because the ingest projection and the live scan must
 * agree byte for byte: `./core.ts` holds the single matcher / haystack /
 * snippet / ranking implementation both sides use, and splitting them into two
 * extensions would invite a second copy of it.
 *
 * What stays in the shared layer, and why:
 *
 *   ../lib/session-common.ts   session JSONL parse pipeline + session-ref
 *                              resolution (read-session, copy-session,
 *                              session-preview and transcript-* use it too)
 *   ../lib/session-preview.ts  ctrl+o transcript overlay (worktree-task,
 *                              session-picker and schedule use it too)
 *   ../lib/session-common.ts   session JSONL parsing, id resolution, `textOf`
 *                              (passed into `core.ts` as an extractor)
 *
 * lib must never import from this directory, and nothing needs to travel
 * backwards either: archiving MOVES files out of the sessions root, so the
 * shared layer simply stops resolving their ids, and every hit this extension
 * emits carries the archived path. Keeping the archive self-contained also
 * follows from how pi loads extensions (jiti, `moduleCache: false`): a shared
 * module variable would never be seen by another extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerArchive } from "./archive.ts";
import { registerSearch } from "./search.ts";

export default function (pi: ExtensionAPI): void {
    registerSearch(pi);
    registerArchive(pi);
}
