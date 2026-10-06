/**
 * Inline subagent extension (single file): the general-purpose `task` tool.
 *
 * Registers one native pi tool:
 *   - `task` : inline, general-purpose subagent. Config (model, thinking,
 *              tools, skills) is loaded once at registration time from
 *              `~/.pi/agent/subagent.json`; edits take effect on extension
 *              reload, not per call. Tools and skills are explicit opt-in:
 *              omitted or empty = the child runs with no tools / no skills
 *              (fail-closed, no silent inheritance of the child's defaults).
 *              A missing or broken config aborts the extension load (pi
 *              reports it and continues without the tool) instead of
 *              surfacing the error only when the model calls the tool.
 *              Because the specialized subagents (finder.ts, oracle.ts,
 *              librarian.ts) are also tools, an inline subagent can whitelist
 *              them in `tools` and call them from inside its child context
 *              (grandchild pi process).
 *
 * The spawn/parse/envelope/render machinery + the standard tool wiring live
 * in `lib/subagent.ts`; this file holds the inline persona, the
 * subagent.json config loader, and the spec construction.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Subagent, type SubagentSpec } from "./lib/subagent.ts";

/**
 * Base system prompt for the inline `task` tool (no specialized persona).
 * Replaces the verbose default coding-assistant prompt so the child gets a lean,
 * focused persona. The caller's instructions go into the `prompt`. Mentions
 * `finder` because finder is now a native tool the inline child may whitelist.
 */
export const INLINE_BASE_SYSTEM_PROMPT = `You are pi, a powerful AI coding agent.

When invoking the Read tool, ALWAYS use absolute paths.
When reading a file, read the complete file, not specific line ranges.
If you've already used the Read tool to read an entire file, do NOT invoke Read on that file again.

If AGENTS.md exists, treat it as ground truth for commands, style, structure. If you discover a recurring command that's missing, ask to append it there.

For any coding task that involves thoroughly searching or understanding the codebase, use the finder tool to intelligently locate relevant code, functions, or patterns. This helps in understanding existing implementations, locating dependencies, and finding similar code before making changes.`;

/**
 * Inline defaults from `~/.pi/agent/subagent.json`, read once at registration
 * time. All fields optional; omitted or empty `tools`/`skills` mean the child
 * runs without them (the spec turns that into `--no-tools`/`--no-skills`).
 */
interface InlineConfig {
	model?: string;
	thinking?: string;
	tools?: string[];
	skills?: string[];
}

/**
 * Load inline defaults from `~/.pi/agent/subagent.json`. The file is required:
 * a missing file is an error rather than a silent all-defaults fallback, so
 * new machines fail the extension load instead of quietly registering a
 * no-tool/no-skill subagent. Unknown keys are rejected (typo guard). Returns
 * the parsed config plus an error message on failure.
 */
function loadInlineConfig(): { config: InlineConfig; error?: string } {
	const configPath = path.join(getAgentDir(), "subagent.json");
	if (!fs.existsSync(configPath)) {
		return { config: {}, error: `Inline config file not found: ${configPath}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	} catch (error) {
		return {
			config: {},
			error: `Invalid JSON in inline config: ${configPath} (${error instanceof Error ? error.message : String(error)})`,
		};
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { config: {}, error: `Inline config must be a JSON object: ${configPath}` };
	}

	const raw = parsed as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (key !== "model" && key !== "thinking" && key !== "tools" && key !== "skills") {
			return {
				config: {},
				error: `${configPath}: unknown key "${key}" (valid keys: model, thinking, tools, skills)`,
			};
		}
	}

	const config: InlineConfig = {};

	if (typeof raw.model === "string" && raw.model.trim()) config.model = raw.model.trim();
	if (typeof raw.thinking === "string" && raw.thinking.trim()) config.thinking = raw.thinking.trim();
	if (raw.tools !== undefined) {
		if (!Array.isArray(raw.tools)) {
			return { config: {}, error: `${configPath}: "tools" must be an array of tool names` };
		}
		const tools = raw.tools
			.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
			.map((t) => t.trim());
		if (tools.length > 0) config.tools = tools;
	}
	if (raw.skills !== undefined) {
		if (!Array.isArray(raw.skills)) {
			return {
				config: {},
				error: `${configPath}: "skills" must be an array of skill file/dir paths`,
			};
		}
		// Keep non-empty string entries; expand a leading `~` to the home dir
		// (spawn uses `shell: false`, so no shell expands `~` for us). Paths
		// are passed through as-is (no existence check).
		const home = os.homedir();
		const skills = raw.skills
			.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
			.map((s) => {
				const trimmed = s.trim();
				return trimmed === "~" || trimmed.startsWith("~/") ? path.join(home, trimmed.slice(1)) : trimmed;
			});
		if (skills.length > 0) config.skills = skills;
	}

	return { config };
}

export default function (pi: ExtensionAPI) {
	const { config: inlineConfig, error: configError } = loadInlineConfig();
	if (configError) throw new Error(configError);

	// Declare the child's tool surface to the parent model: the explicit
	// allowlist, or an honest "none" instead of a misleading empty tail.
	const toolsDesc =
		inlineConfig.tools && inlineConfig.tools.length > 0
			? inlineConfig.tools.join(", ")
			: "none (it can only reason from the prompt)";
	const description = `Perform a task (a sub-task of the user's overall task) using a sub-agent that has access to the following tools: ${toolsDesc}`;

	const inlineSpec: SubagentSpec = {
		name: "task",
		systemPrompt: INLINE_BASE_SYSTEM_PROMPT,
		model: inlineConfig.model,
		thinking: inlineConfig.thinking,
		tools: inlineConfig.tools,
		skills: inlineConfig.skills,
	};
	new Subagent(inlineSpec).registerTool(pi, description);
}
