/**
 * Model routing for scheduled runs.
 *
 * A scheduled run is a one-shot worker call, so it follows the same routing as
 * subagent dispatch: `roles.subagents` of the *currently active* mode in
 * modes.json (project `.pi/modes.json` first, then the global agent
 * modes.json). This mirrors `extensions/lib/worker.ts#loadWorkerModeSpec`
 * semantics exactly; that file cannot be imported here because it pulls in
 * `@earendil-works/*`, which plain `node` cannot resolve from crontab.
 *
 * No pin resolvable → no model flags at all, and the child inherits
 * `settings.json` defaults (the pre-routing behaviour).
 */

import { join } from "node:path";

import { getAgentDir, readJsonFile } from "./store.ts";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: readonly ThinkingLevel[] = [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];

export interface ModelRoute {
    provider: string;
    modelId: string;
    thinkingLevel?: ThinkingLevel;
    /** Which modes.json supplied the pin (for `logs`). */
    source: string;
}

function normalizeThinkingLevel(level: unknown): ThinkingLevel | undefined {
    return THINKING_LEVELS.includes(level as ThinkingLevel)
        ? (level as ThinkingLevel)
        : undefined;
}

function pinToRoute(pin: unknown, source: string): ModelRoute | undefined {
    if (!pin || typeof pin !== "object") return undefined;
    const record = pin as Record<string, unknown>;
    const provider = typeof record.provider === "string" ? record.provider : undefined;
    const modelId = typeof record.modelId === "string" ? record.modelId : undefined;
    if (!provider || !modelId) return undefined;
    return { provider, modelId, thinkingLevel: normalizeThinkingLevel(record.thinkingLevel), source };
}

function routeFromModesFile(path: string): ModelRoute | undefined {
    const parsed = readJsonFile(path);
    if (!parsed || typeof parsed !== "object") return undefined;
    const root = parsed as Record<string, unknown>;
    const currentMode = typeof root.currentMode === "string" ? root.currentMode : undefined;
    const modes = root.modes;
    if (!currentMode || !modes || typeof modes !== "object") return undefined;
    const mode = (modes as Record<string, unknown>)[currentMode];
    if (!mode || typeof mode !== "object") return undefined;
    const roles = (mode as Record<string, unknown>).roles;
    if (!roles || typeof roles !== "object") return undefined;
    return pinToRoute((roles as Record<string, unknown>).subagents, path);
}

/**
 * Resolve the subagent model pin for a run whose cwd is `cwd`.
 *
 * Project modes.json wins over the global one (same precedence as
 * `lib/worker.ts`). Returns undefined when no usable pin exists, which means
 * "let pi use its configured default".
 */
export function resolveSubagentRoute(cwd: string): ModelRoute | undefined {
    const candidates = [join(cwd, ".pi", "modes.json"), join(getAgentDir(), "modes.json")];
    for (const path of candidates) {
        const route = routeFromModesFile(path);
        if (route) return route;
    }
    return undefined;
}

/** `--provider <p> --model <m> [--thinking <level>]`, or nothing when unpinned. */
export function routeFlags(route: ModelRoute | undefined): string[] {
    if (!route) return [];
    const flags = ["--provider", route.provider, "--model", route.modelId];
    if (route.thinkingLevel) flags.push("--thinking", route.thinkingLevel);
    return flags;
}

/** Compact single-line description for `logs` / diagnostics. */
export function describeRoute(route: ModelRoute | undefined): string {
    if (!route) return "agent default (no roles.subagents pin)";
    const thinking = route.thinkingLevel ? `:${route.thinkingLevel}` : "";
    return `${route.provider}/${route.modelId}${thinking} (roles.subagents)`;
}
