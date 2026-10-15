/**
 * Inline subagent extension (single file): the general-purpose `task` tool.
 *
 * Registers one native pi tool:
 *   - `task` : inline, general-purpose subagent. Config (model, thinking,
 *              tools, skills) is hardcoded in `TASK_SPEC` below, matching the
 *              file-is-the-whole-truth style of the specialized subagents
 *              (finder.ts, oracle.ts, librarian.ts); edits take effect on
 *              extension reload, not per call. Tools and skills are explicit
 *              opt-in: empty = the child runs with no tools / no skills
 *              (fail-closed, no silent inheritance of the child's defaults).
 *              Because the specialized subagents are also tools, an inline
 *              subagent can whitelist them in `tools` and call them from
 *              inside its child context (grandchild pi process).
 *
 * The spawn/parse/envelope/render machinery + the standard tool wiring live
 * in `lib/subagent.ts`; this file holds the inline persona and the spec.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
 * Inline `task` config, hardcoded like the specialized subagents' specs
 * (finder.ts, oracle.ts, librarian.ts). Empty `tools`/`skills` mean the child
 * runs without them (`--no-tools`/`--no-skills`).
 */
const TASK_SPEC: SubagentSpec = {
	name: "task",
	systemPrompt: INLINE_BASE_SYSTEM_PROMPT,
	model: "opencode-go/space-bunny",
	thinking: "medium",
	tools: ["write", "edit", "read", "bash", "finder"],
	skills: [],
};

export default function (pi: ExtensionAPI) {
	// Declare the child's tool surface to the parent model: the explicit
	// allowlist, or an honest "none" instead of a misleading empty tail.
	const toolsDesc =
		TASK_SPEC.tools && TASK_SPEC.tools.length > 0
			? TASK_SPEC.tools.join(", ")
			: "none (it can only reason from the prompt)";
	const description = `Perform a task (a sub-task of the user's overall task) using a sub-agent that has access to the following tools: ${toolsDesc}`;

	new Subagent(TASK_SPEC).registerTool(pi, description);
}
