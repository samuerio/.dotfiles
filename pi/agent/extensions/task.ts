/**
 * Inline subagent extension (single file): the general-purpose `task` tool.
 *
 * Registers one native pi tool:
 *   - `task` : inline, general-purpose subagent; config read per-call
 *              from `~/.pi/agent/subagent.json`. Because the specialized
 *              subagents (finder.ts, oracle.ts, librarian.ts) are also
 *              tools, an inline subagent can whitelist them and call them
 *              from inside its child context (grandchild pi process).
 *
 * The spawn/parse/envelope/render machinery + the standard execute body live
 * in `lib/subagent.ts` (see its header for the full consumer list and the
 * Architecture Invariant); this file holds the inline persona, the
 * subagent.json config loader, and the tool registration.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Subagent, SubagentParams, type SubagentSpec } from "./lib/subagent.ts";

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

For any coding task that involves thoroughly searching or understanding the codebase, use the finder tool to intelligently locate relevant code, functions, or patterns. This helps in understanding existing implementations, locating dependencies, or finding similar code before making changes.`;

/**
 * Default configuration for inline subagent runs, read from
 * `~/.pi/agent/subagent.json`. `skills` is required (the explicit skill
 * allowlist); other fields are optional and fall back to the child pi
 * process's own defaults.
 */
interface InlineConfig {
	model?: string;
	thinking?: string;
	tools?: string[];
	skills: string[];
}

/**
 * Load inline defaults from `~/.pi/agent/subagent.json`. Returns an empty config
 * (all defaults) when the file is missing or unreadable. JSON parse errors are
 * surfaced to the caller.
 */
function loadInlineConfig(): { config: InlineConfig; error?: string } {
	const configPath = path.join(getAgentDir(), "subagent.json");
	if (!fs.existsSync(configPath)) return { config: { skills: [] } };

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	} catch (error) {
		return {
			config: { skills: [] },
			error: `Invalid JSON in inline config: ${configPath} (${error instanceof Error ? error.message : String(error)})`,
		};
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { config: { skills: [] }, error: `Inline config must be a JSON object: ${configPath}` };
	}

	const raw = parsed as Record<string, unknown>;
	const config: InlineConfig = { skills: [] };

	if (typeof raw.model === "string" && raw.model.trim()) config.model = raw.model.trim();
	if (typeof raw.thinking === "string" && raw.thinking.trim()) config.thinking = raw.thinking.trim();
	if (Array.isArray(raw.tools)) {
		const tools = raw.tools.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim());
		if (tools.length > 0) config.tools = tools;
	}
	// `skills` is the single user-facing knob for the child's skills: the
	// explicit allowlist handed to the child as `--skill <path>` entries.
	// Missing or malformed key is a config error so execute throws instead of
	// silently changing which skills the child sees.
	if (!Array.isArray(raw.skills)) {
		return {
			config: { skills: [] },
			error: `${configPath}: missing required field "skills" — set [] to disable all skills, or list skill file/dir paths to enable`,
		};
	}
	// Keep non-empty string entries; expand a leading `~` to the home dir —
	// spawn uses `shell: false`, so no shell expands `~` for us. Paths are
	// passed through as-is (no existence check).
	const home = os.homedir();
	config.skills = raw.skills
		.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
		.map((s) => {
			const trimmed = s.trim();
			return trimmed === "~" || trimmed.startsWith("~/") ? path.join(home, trimmed.slice(1)) : trimmed;
		});

	return { config };
}

export default function (pi: ExtensionAPI) {
	// Inline `task` tool: config is read per call from subagent.json, so a
	// fresh Subagent is constructed each invocation with a runtime-resolved
	// spec. Rendering depends only on result.details (not runtime config), so
	// a shared default instance backs renderCall/renderResult.
	const defaultTaskInstance = new Subagent({
		name: "task",
		systemPrompt: "",
		skills: [],
	});
	const { config: taskInlineConfig } = loadInlineConfig();
	pi.registerTool({
		name: "task",
		label: "Task",
		description: `Perform a task (a sub-task of the user's overall task) using a sub-agent that has access to the following tools: ${taskInlineConfig.tools && taskInlineConfig.tools.length > 0 ? taskInlineConfig.tools.join(", ") : ""}`,
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { config: inlineConfig, error: configError } = loadInlineConfig();
			if (configError) {
				throw new Error(configError);
			}
			const inlineSpec: SubagentSpec = {
				name: "task",
				systemPrompt: INLINE_BASE_SYSTEM_PROMPT,
				model: inlineConfig.model,
				thinking: inlineConfig.thinking,
				tools: inlineConfig.tools,
				skills: inlineConfig.skills,
			};
			const instance = new Subagent(inlineSpec);
			return instance.execute(_toolCallId, params, signal, onUpdate, ctx);
		},

		renderCall: (args, theme) => defaultTaskInstance.renderCall(args, theme),
		renderResult: (result, opts, theme, context) => defaultTaskInstance.renderResult(result, opts, theme, context),
	});
}
