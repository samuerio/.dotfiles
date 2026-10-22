/**
 * Shared worker-model resolution for one-shot LLM calls.
 *
 * Reads the model routing of the *currently active* mode from modes.json
 * (project `.pi/modes.json` first, then global agent `modes.json`):
 * `modes[currentMode].roles.subagents` — a one-shot worker call is
 * semantically a subagent. Consumed by extensions that run one-shot LLM
 * requests (answer.ts, handoff.ts, inline.ts, goal.ts, compact-worker.ts).
 *
 * This directory intentionally has no index.ts: pi only auto-loads
 * `extensions/*.ts` files and subdirectories with index.ts/package.json.
 */

import type {
	Api,
	AssistantMessage,
	Context,
	Model,
} from "@earendil-works/pi-ai";
import { getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ModeSpec = {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
};

const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

function getProjectModesPath(cwd: string): string {
	return join(cwd, ".pi", "modes.json");
}

function getGlobalModesPath(): string {
	return join(getAgentDir(), "modes.json");
}

function normalizeThinkingLevel(level: unknown): ThinkingLevel | undefined {
	return THINKING_LEVELS.includes(level as ThinkingLevel)
		? (level as ThinkingLevel)
		: undefined;
}

/** Extract `{provider, modelId, thinkingLevel}` from a roles pin. */
function pinToSpec(pin: Record<string, unknown>): ModeSpec | null {
	const provider = typeof pin.provider === "string" ? pin.provider : undefined;
	const modelId = typeof pin.modelId === "string" ? pin.modelId : undefined;
	const thinkingLevel = normalizeThinkingLevel(pin.thinkingLevel);
	if (!provider || !modelId) return null;
	return { provider, modelId, thinkingLevel };
}

/**
 * Returns the active mode's subagent routing as a resolved spec with
 * provider/modelId guaranteed non-empty, or null when no binding.
 * Resolution: modes[currentMode].roles.subagents.
 */
export function loadWorkerModeSpec(cwd: string): ModeSpec | null {
	const candidates = [getProjectModesPath(cwd), getGlobalModesPath()];
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(p, "utf8"));
		} catch {
			continue;
		}
		const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
		if (!obj) continue;
		const modes = obj.modes;
		if (!modes || typeof modes !== "object") continue;
		const currentMode =
			typeof obj.currentMode === "string" ? obj.currentMode : undefined;
		if (!currentMode) continue;
		const spec = (modes as Record<string, unknown>)[currentMode];
		if (!spec || typeof spec !== "object") continue;
		const roles = (spec as Record<string, unknown>).roles;
		if (roles && typeof roles === "object") {
			const pin = (roles as Record<string, unknown>).subagents;
			if (pin && typeof pin === "object") {
				const resolved = pinToSpec(pin as Record<string, unknown>);
				if (resolved) return resolved;
			}
		}
	}
	return null;
}

// opencode / opencode-go providers route requests by session; without an
// x-opencode-session header they reject with 400 MissingSessionID. This
// mirrors pi's internal provider-attribution getSessionHeaders().
const OPENCODE_HOST = "opencode.ai";
export function sessionHeaders(
	model: { provider: string; baseUrl: string },
	sessionId: string | undefined,
): Record<string, string> {
	if (!sessionId) return {};
	let hostMatches = false;
	try {
		hostMatches = new URL(model.baseUrl).hostname === OPENCODE_HOST;
	} catch {
		// ignore malformed URLs
	}
	if (
		model.provider !== "opencode" &&
		model.provider !== "opencode-go" &&
		!hostMatches
	) {
		return {};
	}
	return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

export interface WorkerCompleteOptions {
	signal?: AbortSignal;
	/**
	 * API-level reasoning effort passed straight through to
	 * ModelRegistry.complete; the api layer maps it through the model's own
	 * thinkingLevelMap (e.g. unsupported levels drop). Omit for defaults.
	 */
	reasoningEffort?: ThinkingLevel;
}

/**
 * One-shot LLM call via ModelRegistry.complete — the same shape as pi's
 * official example extensions (handoff/summarize/qna): auth resolution
 * (apiKey/OAuth refresh/baseUrl override/env/provider headers) happens
 * internally; callers never assemble credentials manually.
 *
 * The opencode/opencode-go `x-opencode-session` routing header is only
 * injected by pi core's agent-loop streamFn (sdk.js); ModelRegistry.complete
 * and pi-ai itself never add it, so extension-issued calls must supply it via
 * the official transformHeaders hook. Session headers go first so caller
 * headers win on conflict, matching pi core's attribution merge order.
 */
export async function workerComplete(
	model: Model<Api>,
	registry: ModelRegistry,
	sessionId: string | undefined,
	context: Context,
	options?: WorkerCompleteOptions,
): Promise<AssistantMessage> {
	return registry.complete(model, context, {
		signal: options?.signal,
		cacheRetention: "none",
		sessionId,
		reasoningEffort: options?.reasoningEffort,
		transformHeaders: (headers) => ({
			...sessionHeaders(model, sessionId),
			...headers,
		}),
	});
}

// ---------------------------------------------------------------------------
// Shared consumer helpers (worker-model resolution + response text handling)
// ---------------------------------------------------------------------------

export type ResolvedWorkerModel =
	| {
			ok: true;
			model: Model<Api>;
			spec: ModeSpec;
	  }
	| { ok: false; error: string };

/**
 * One-stop worker-model resolution for one-shot callers: modes.json binding,
 * registry lookup, and auth check. Callers keep their own error surface;
 * the returned error strings are already user-ready.
 */
export function resolveWorkerModel(
	cwd: string,
	modelRegistry: ModelRegistry,
): ResolvedWorkerModel {
	const spec = loadWorkerModeSpec(cwd);
	if (!spec) {
		return {
			ok: false,
			error: "No subagent model routing in modes.json (modes[currentMode].roles.subagents)",
		};
	}
	const model = modelRegistry.find(spec.provider, spec.modelId);
	if (!model) {
		return {
			ok: false,
			error: `Active mode references unknown model ${spec.provider}/${spec.modelId}`,
		};
	}
	if (!modelRegistry.hasConfiguredAuth(model)) {
		return {
			ok: false,
			error: `No auth configured for ${spec.provider}/${spec.modelId}`,
		};
	}
	return { ok: true, model, spec };
}

/** Full text of a worker response: text blocks joined with newlines. */
export function extractText(response: {
	content: { type: string; text?: string }[];
}): string {
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/** Tolerant JSON extraction: bare object, string-wrapped, or fenced. */
export function extractJsonObject(text: string): unknown | null {
	let candidate = text.trim();
	const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) candidate = fence[1].trim();
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(candidate.slice(start, end + 1));
	} catch {
		return null;
	}
}
