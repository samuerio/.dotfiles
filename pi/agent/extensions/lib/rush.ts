/**
 * Shared "rush" mode resolution.
 *
 * Reads provider/model/thinking-level bindings from modes.json
 * (project `.pi/modes.json` first, then global agent `modes.json`).
 * Consumed by extensions that run one-shot LLM requests with the rush
 * model (answer.ts, handoff.ts).
 *
 * This directory intentionally has no index.ts: pi only auto-loads
 * `extensions/*.ts` files and subdirectories with index.ts/package.json.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ModeSpec = {
	provider?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
};

export const RUSH_MODE = "rush";

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

export function loadRushModeSpec(cwd: string): ModeSpec | null {
	const candidates = [getProjectModesPath(cwd), getGlobalModesPath()];
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(p, "utf8"));
		} catch {
			continue;
		}
		const modes =
			parsed && typeof parsed === "object"
				? (parsed as { modes?: unknown }).modes
				: undefined;
		if (!modes || typeof modes !== "object") continue;
		const spec = (modes as Record<string, unknown>)[RUSH_MODE];
		if (!spec || typeof spec !== "object") continue;
		const obj = spec as Record<string, unknown>;
		const provider =
			typeof obj.provider === "string" ? obj.provider : undefined;
		const modelId =
			typeof obj.modelId === "string" ? obj.modelId : undefined;
		const thinkingLevel = THINKING_LEVELS.includes(
			obj.thinkingLevel as ThinkingLevel,
		)
			? (obj.thinkingLevel as ThinkingLevel)
			: undefined;
		if (!provider || !modelId) continue;
		return { provider, modelId, thinkingLevel };
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
