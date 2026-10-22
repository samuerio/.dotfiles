/**
 * Compact-worker extension - compaction with the worker model
 *
 * Replaces pi's default compaction model choice: instead of the current
 * session model, compaction (/compact, auto-threshold, overflow recovery)
 * summarizes with the worker model, i.e. the active mode's
 * `roles.subagents` pin in modes.json (shared infra: ./lib/worker.ts).
 * Falls back to the default compaction
 * path (current session model) on any failure - never cancels, because
 * compaction is often on the overflow-recovery critical path.
 *
 * Design (spec: .pi/spec/20261009-172936-compact-rush-model/):
 * - Calls the OFFICIALLY EXPORTED compact() with the worker model, so
 *   summary prompts, failure gates (length/error/toolCall), maxTokens
 *   budgeting, split-turn merge, fileOps tracking and retry wrapping all
 *   stay in sync with the installed pi release. This extension only
 *   supplies what compact() cannot know: worker auth resolution, opencode
 *   session routing headers, and the fileOps chain repair.
 * - fileOps chain repair: pi's prepareCompaction only relays the previous
 *   compaction's file details when that entry was pi-generated
 *   (!fromHook). Once this extension takes over, every previous
 *   compaction is fromHook=true, so the cumulative <read-files>/
 *   <modified-files> tracking would silently reset on every compaction.
 *   We merge the last compaction entry's details back into
 *   preparation.fileOps. pi mutates/prepares nothing in between (the hook
 *   receives the preparation object by reference), so the repair also
 *   benefits the fallback path when it returns undefined.
 * - Auth: ctx.modelRegistry.getApiKeyAndHeaders() is the public facade of
 *   pi's internal auth resolution (apiKey / OAuth refresh / baseUrl
 *   override / env). ResolvedRequestAuth is a discriminated union.
 * - opencode headers: pi-ai's completeSimple never injects the
 *   x-opencode-session routing header (only pi core's agent-loop streamFn
 *   does), so we merge lib/worker.ts sessionHeaders() ourselves, with a
 *   fresh routing session id (one-off request semantics, matching pi
 *   core). Session headers go first so auth headers win on conflict.
 * - Context-window precheck: gate on preparation.tokensBefore vs 90% of
 *   the worker model's context window. Conservative: serialized prompts are
 *   much smaller than the raw context (tool results are truncated), so
 *   this may occasionally fall back when a worker model would have fit - correct
 *   tradeoff, compaction must not fail loudly.
 * - UI: pi injects a no-op UI context when no UI exists (runner.js), so
 *   unguarded ctx.ui.notify/setStatus calls are always safe.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import { loadWorkerModeSpec, sessionHeaders } from "./lib/worker.ts";

type ResolvedRequestAuth = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
type ResolvedAuthOk = Extract<ResolvedRequestAuth, { ok: true }>;

/** Local shape of pi-generated / extension-provided compaction details. */
interface CompactionFiles {
	readFiles?: unknown;
	modifiedFiles?: unknown;
}

/**
 * Identical config/credential-class failures are warned once per session;
 * distinct messages (transient auth vs config) latch separately.
 */
const warnedMessages = new Set<string>();

function warnOnce(ctx: ExtensionContext, message: string): void {
	if (warnedMessages.has(message)) return;
	warnedMessages.add(message);
	ctx.ui.notify(`worker compaction unavailable: ${message}`, "warning");
}

/** merge last compaction entry's details into preparation.fileOps */
function repairFileOpsChain(branchEntries: SessionEntry[], preparation: Parameters<typeof compact>[0]): void {
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i];
		if (entry.type !== "compaction") continue;
		const details = (entry as { details?: CompactionFiles }).details;
		if (Array.isArray(details?.readFiles)) {
			for (const f of details.readFiles) preparation.fileOps.read.add(f);
		}
		if (Array.isArray(details?.modifiedFiles)) {
			for (const f of details.modifiedFiles) preparation.fileOps.edited.add(f);
		}
		break; // only the most recent compaction relays (matches core semantics)
	}
}

function mergeHeaders(auth: ResolvedAuthOk, routingSessionId: string, model: { provider: string; baseUrl: string }): Record<string, string> {
	const merged = sessionHeaders(model, routingSessionId);
	if (auth.headers) {
		// ProviderHeaders values may be null (= delete); auth headers win on conflict.
		for (const [key, value] of Object.entries(auth.headers)) {
			if (value !== null) merged[key] = value;
		}
	}
	return merged;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, branchEntries, customInstructions, signal } = event;

		// ------------------------------------------------------------------
		// Worker model resolution (config-class failures: warn keyed by message)
		// ------------------------------------------------------------------
		const spec = loadWorkerModeSpec(ctx.cwd);
		if (!spec) {
			warnOnce(
				ctx,
				"no subagent model routing in modes.json, falling back to default compaction",
			);
			return undefined;
		}
		const baseModel = ctx.modelRegistry.find(spec.provider, spec.modelId);
		if (!baseModel) {
			warnOnce(ctx, `unknown model ${spec.provider}/${spec.modelId}, falling back to default compaction`);
			return undefined;
		}

		// ------------------------------------------------------------------
		// Context-window precheck (conservative; fallback is fine to over-trigger).
		// Runs before the auth await; the baseUrl override does not change the
		// window. 128000 mirrors pi core's own fallback for window-less models.
		// ------------------------------------------------------------------
		const contextWindow = baseModel.contextWindow || 128000;
		if (preparation.tokensBefore > contextWindow * 0.9) {
			ctx.ui.notify(
				`worker compaction skipped: serialized context ~${preparation.tokensBefore.toLocaleString()} tok exceeds 90% of ${baseModel.id} window (${contextWindow.toLocaleString()}), falling back`,
				"warning",
			);
			return undefined;
		}

		// ------------------------------------------------------------------
		// Auth (pi's public facade over its internal resolution)
		// ------------------------------------------------------------------
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(baseModel);
		if (!auth.ok) {
			warnOnce(ctx, auth.error);
			return undefined;
		}
		if (!auth.apiKey && !auth.headers) {
			warnOnce(ctx, "no apiKey or headers resolved, falling back to default compaction");
			return undefined;
		}
		const requestModel = auth.baseUrl ? { ...baseModel, baseUrl: auth.baseUrl } : baseModel;

		// ------------------------------------------------------------------
		// fileOps chain repair (must run before compact() consumes preparation)
		// ------------------------------------------------------------------
		repairFileOpsChain(branchEntries, preparation);

		const routingSessionId = uuidv7();
		const headers = mergeHeaders(auth, routingSessionId, requestModel);

		ctx.ui.setStatus("compact-worker", `compacting with ${requestModel.id}`);

		try {
			const result = await compact(
				preparation,
				requestModel,
				auth.apiKey,
				headers,
				customInstructions,
				signal,
				spec.thinkingLevel,
				undefined, // streamFn: use completeSimple (artifact: plan "verified")
				auth.env,
				undefined, // retry: single attempt
				undefined, // callbacks
				undefined, // sessionId: fresh uuidv7 inside completeSummarization
			);

			ctx.ui.notify(
				`Compacted with worker model ${requestModel.id}${result.usage ? ` (${result.usage.totalTokens.toLocaleString()} tok)` : ""}`,
				"info",
			);
			return {
				compaction: {
					summary: result.summary,
					firstKeptEntryId: result.firstKeptEntryId,
					tokensBefore: result.tokensBefore,
					usage: result.usage,
					details: result.details,
				},
			};
		} catch (err) {
			if (signal.aborted) return undefined; // caller re-checks the same signal; no notify spam
			ctx.ui.notify(
				`worker compaction failed: ${err instanceof Error ? err.message : String(err)}, falling back to default compaction`,
				"warning",
			);
			return undefined; // fallback: default compaction (session model)
		} finally {
			ctx.ui.setStatus("compact-worker", undefined);
		}
	});
}
