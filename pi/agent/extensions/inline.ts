import { completeSimple, type UserMessage } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

type ExtensionUI = ExtensionCommandContext["ui"];

const SYSTEM_PROMPT = `You are an inline marker extractor. You receive ripgrep output that scanned a codebase for PI! and PI? comments. Your job has three steps only: filter, construct, and output all. Do NOT implement changes, answer questions, clarify, or interpret what the marker asks for.

Filter:
- Keep a match only when PI! or PI? is immediately followed by task or question content (e.g., a change request, a slash command, a question sentence).
- Skip matches where PI!/PI? is followed by explanatory prose about the convention (e.g., "PI! for change and PI? for questions"), and skip matches inside markdown/SKILL files that merely describe the marker syntax.

Construct:
- For every genuine marker (after filtering), emit one <pi-task> element.
- The element body is the raw rg context (the path:line:content lines surrounding the match, preserved exactly as they appear in the rg output, including the path:line prefix). Do not summarize, rewrite, or trim the snippet.
- Do not include a type attribute. The PI! or PI? in the content itself indicates the nature of the task.
- The file attribute is the relative file path from the rg output. The line attribute is the line number of the match line from the rg output (the scan-time line number).
- Do NOT emit a separate comment field. The matching line in the snippet already carries the comment text.
- Do NOT group by file. Do NOT use Markdown headings.
- Output all <pi-task> elements in the same order they appear in the rg output.
- Do NOT XML-escape the snippet. The output is read as text, not parsed.
- Do NOT output a summary line or any other text.

If, after filtering, there are no genuine markers (rg matched but all matches are documentation about the convention), output exactly the token:

NO_GENUINE_MARKERS

and nothing else.

Output shape (multiple markers, one per genuine match):

<pi-task file="<relative path>" line="<n>">
<path>:<line>: <raw rg context line>
<path>:<line>: <raw rg context line>
</pi-task>

<pi-task file="<relative path>" line="<n>">
<path>:<line>: <raw rg context line>
<path>:<line>: <raw rg context line>
</pi-task>

Use English for any prose. Do NOT output meta commentary, resolution rules, or output format instructions. Output ONLY the <pi-task> elements (or the NO_GENUINE_MARKERS token).`;

const FRAMING_HEADER = `Found inline markers (PI!/PI?) for one file in the codebase.

Both PI! and PI? represent tasks to be executed.

- For a PI? task: do not modify the file that contains this marker, except to remove the marker itself.
- For a PI! task: there is no such restriction; the task may freely modify the file containing the marker.

Complete the tasks. After finishing all tasks in this group, remove the corresponding markers.

Only remove the markers explicitly listed below. Do not touch markers from other files.`;

const NO_GENUINE_MARKERS = "NO_GENUINE_MARKERS";

const INLINE_STATE_KEY = "inline-state";

interface InlineTask {
    line: number;
    content: string; // raw rg context lines inside the <pi-task>
    file: string;
}

interface InlineGroup {
    file: string;
    tasks: InlineTask[];
}

interface InlineBatchState {
    groups: InlineGroup[];
    nextIndex: number;
}

type ModeName = string;

type ModeSpec = {
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
};

type ModesFile = {
    version: 1;
    currentMode: ModeName;
    modes: Record<ModeName, ModeSpec>;
};

const RUSH_MODE = "rush";

function getProjectModesPath(cwd: string): string {
    return join(cwd, ".pi", "modes.json");
}

function getGlobalModesPath(): string {
    return join(getAgentDir(), "modes.json");
}

function loadRushModeSpec(cwd: string): ModeSpec | null {
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
        const thinkingLevel =
            typeof obj.thinkingLevel === "string"
                ? obj.thinkingLevel
                : undefined;
        if (!provider || !modelId) continue;
        return { provider, modelId, thinkingLevel };
    }
    return null;
}

function extractText(response: any): string {
    return response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
}

// --- State management ---

let inlineState: InlineBatchState | null = null;

function persistState(pi: ExtensionAPI, state: InlineBatchState): void {
    pi.appendEntry(INLINE_STATE_KEY, state);
}

function loadStateFromBranch(branch: any[]): InlineBatchState | null {
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (
            entry.type === "custom" &&
            entry.customType === INLINE_STATE_KEY &&
            entry.data
        ) {
            const s = entry.data as InlineBatchState;
            if (s && Array.isArray(s.groups) && typeof s.nextIndex === "number") {
                return s;
            }
        }
    }
    return null;
}

function reconstructState(ctx: any): void {
    const branch = ctx.sessionManager.getBranch();
    inlineState = loadStateFromBranch(branch);
}

function getCurrentState(ctx: any): InlineBatchState | null {
    if (inlineState === null) {
        reconstructState(ctx);
    }
    return inlineState;
}

function setState(newState: InlineBatchState | null, pi: ExtensionAPI, ui?: ExtensionUI): void {
    inlineState = newState;
    if (newState) {
        persistState(pi, newState);
    }
    if (ui) {
        updateInlineStatus(ui);
    }
}

function updateInlineStatus(ui: ExtensionUI): void {
    const s = inlineState;
    if (!s || s.groups.length === 0 || s.nextIndex >= s.groups.length) {
        ui.setStatus("inline", undefined);
        return;
    }
    const label = ui.theme.fg("accent", "inline");
    ui.setStatus("inline", `${label} (${s.nextIndex + 1}/${s.groups.length})`);
}

function parsePiTasks(text: string): InlineTask[] {
    const tasks: InlineTask[] = [];
    // Support both with and without type attribute for robustness during transition
    const regex = /<pi-task\s+(?:type="[^"]+"\s+)?file="([^"]+)"\s+line="(\d+)"\s*>([\s\S]*?)<\/pi-task>/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const file = match[1];
        const line = parseInt(match[2], 10);
        const rawContent = match[3].trim();
        if (file && !isNaN(line) && rawContent) {
            tasks.push({ line, content: rawContent, file });
        }
    }
    return tasks;
}

function groupTasks(tasks: InlineTask[]): InlineGroup[] {
    const byFile = new Map<string, InlineTask[]>();
    for (const t of tasks) {
        if (!byFile.has(t.file)) {
            byFile.set(t.file, []);
        }
        byFile.get(t.file)!.push(t);
    }
    // preserve discovery order of first appearance
    const order: string[] = [];
    for (const t of tasks) {
        if (!order.includes(t.file)) order.push(t.file);
    }
    return order.map((file) => ({
        file,
        tasks: byFile.get(file)!,
    }));
}

function formatGroupContent(group: InlineGroup): string {
    const tasksText = group.tasks
        .map((t) => `<pi-task file="${group.file}" line="${t.line}">\n${t.content}\n</pi-task>`)
        .join("\n\n");
    return `${FRAMING_HEADER}\n\n${tasksText}`;
}

export default function (pi: ExtensionAPI) {
    // Reconstruct state on session load / tree navigation
    pi.on("session_start", async (_event, ctx) => {
        reconstructState(ctx);
        if (ctx.hasUI) updateInlineStatus(ctx.ui);
    });
    pi.on("session_tree", async (_event, ctx) => {
        reconstructState(ctx);
        if (ctx.hasUI) updateInlineStatus(ctx.ui);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        if (ctx.hasUI) {
            ctx.ui.setStatus("inline", undefined);
        }
    });

    const handler = async (args: string, ctx: ExtensionCommandContext) => {
        const fail = (message: string): void => {
            if (ctx.hasUI) {
                ctx.ui.notify(message, "error");
                return;
            }
            throw new Error(message);
        };

        const trimmedArgs = (args || "").trim();
        const flags = trimmedArgs.split(/\s+/).filter(Boolean);

        // Handle control commands first
        if (flags.includes("-l") || flags.includes("--list")) {
            if (!ctx.hasUI) {
                process.stdout.write("inline batch list is only supported in TUI mode\n");
                return;
            }
            const state = getCurrentState(ctx);
            if (!state || !state.groups.length || state.nextIndex >= state.groups.length) {
                ctx.ui.notify("当前没有 inline 分组计划", "info");
                return;
            }
            const lines: string[] = [];
            lines.push(`inline 分组计划（共 ${state.groups.length} 组）：`);
            state.groups.forEach((g, i) => {
                const isNext = i === state.nextIndex;
                const prefix = isNext ? "→ [下一个] " : "[后续] ";
                lines.push(`${prefix}${g.file} (${g.tasks.length} markers)`);
                g.tasks.slice(0, 3).forEach((t) => {
                    const firstLine = t.content.split("\n")[0] || "";
                    lines.push(`  - ${t.line}: ${firstLine.slice(0, 60)}`);
                });
                if (g.tasks.length > 3) lines.push("  ...");
            });
            ctx.ui.notify(lines.join("\n"), "info");
            return;
        }

        if (flags.includes("-r") || flags.includes("--reset")) {
            setState({ groups: [], nextIndex: 0 }, pi, ctx.hasUI ? ctx.ui : undefined);
            if (ctx.hasUI) {
                ctx.ui.notify("inline batch 已重置", "info");
            } else {
                process.stdout.write("inline batch reset\n");
            }
            return;
        }

        // plain /inline : smart continue or regenerate
        const state = getCurrentState(ctx);
        if (ctx.hasUI) updateInlineStatus(ctx.ui);

        // Resolve model/auth (needed for describe in regenerate case)
        const rushSpec = loadRushModeSpec(ctx.cwd);
        if (!rushSpec) {
            return fail(`No '${RUSH_MODE}' mode in modes.json`);
        }
        const model = ctx.modelRegistry.find(rushSpec.provider!, rushSpec.modelId!);
        if (!model) {
            return fail(`Mode '${RUSH_MODE}' references unknown model ${rushSpec.provider}/${rushSpec.modelId}`);
        }
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
            return fail(`Auth failed: ${auth.error}`);
        }
        const { apiKey, headers } = auth;

        const describe = async (scan: string, signal?: AbortSignal): Promise<string | null> => {
            const userMessage: UserMessage = {
                role: "user",
                content: [{ type: "text", text: scan }],
                timestamp: Date.now(),
            };
            const response = await completeSimple(
                model,
                { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
                { apiKey, headers, signal, reasoning: "off" },
            );
            if (response.stopReason === "aborted") return null;
            const text = extractText(response);
            if (!text) throw new Error("Empty inline result");
            return text;
        };

        // 1. Check if we can continue from existing state (no scan)
        if (state && state.nextIndex < state.groups.length) {
            const group = state.groups[state.nextIndex];
            const content = formatGroupContent(group);

            if (ctx.hasUI) {
                ctx.ui.notify(
                    `inline: 处理文件组 (${state.nextIndex + 1}/${state.groups.length}) - ${group.file} (${group.tasks.length} markers)`,
                    "info",
                );
                pi.sendMessage({ customType: "inline", content, display: true }, { triggerTurn: true });
            } else {
                // non-TUI: output text, no trigger
                process.stdout.write(`${content}\n`);
            }

            // advance
            const newState: InlineBatchState = { ...state, nextIndex: state.nextIndex + 1 };
            setState(newState, pi, ctx.hasUI ? ctx.ui : undefined);
            return;
        }

        // 2. No remaining or no state -> fresh scan + new plan
        const extensionRelPath = relative(ctx.cwd, fileURLToPath(import.meta.url)).replace(/\\/g, "/");
        const rgArgs = ["PI!|PI\\?", "-C", "3", "-n", "-H"];
        if (!extensionRelPath.startsWith("..")) {
            rgArgs.push("-g", `!${extensionRelPath}`);
        }
        const rg = await pi.exec("rg", rgArgs, { cwd: ctx.cwd });
        if (rg.code !== 0 && rg.code !== 1) {
            return fail(`rg failed (code ${rg.code}): ${rg.stderr.trim()}`);
        }
        const scanOutput = rg.stdout.trim();
        if (!scanOutput) {
            if (ctx.hasUI) ctx.ui.notify("No PI!/PI? markers found", "info");
            setState({ groups: [], nextIndex: 0 }, pi, ctx.hasUI ? ctx.ui : undefined);
            return;
        }

        let formatted: string | null = null;
        if (!ctx.hasUI) {
            formatted = await describe(scanOutput);
        } else {
            formatted = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
                const loader = new BorderedLoader(tui, theme, "Scanning and describing inline markers...");
                loader.onAbort = () => done(null);
                describe(scanOutput, loader.signal).then(done).catch((err) => {
                    ctx.ui.notify(`Inline failed: ${err.message}`, "error");
                    done(null);
                });
                return loader;
            });
        }

        if (formatted === null) {
            if (ctx.hasUI) ctx.ui.notify("Cancelled", "info");
            return;
        }
        if (!formatted) {
            if (ctx.hasUI) ctx.ui.notify("Empty inline result", "error");
            else throw new Error("Empty inline result");
            return;
        }
        if (formatted === NO_GENUINE_MARKERS) {
            if (ctx.hasUI) ctx.ui.notify("No genuine markers (all matches are docs)", "info");
            else process.stdout.write("No genuine markers (all matches are docs)\n");
            setState({ groups: [], nextIndex: 0 }, pi, ctx.hasUI ? ctx.ui : undefined);
            return;
        }

        const tasks = parsePiTasks(formatted);
        if (tasks.length === 0) {
            if (ctx.hasUI) ctx.ui.notify("No genuine markers (all matches are docs)", "info");
            setState({ groups: [], nextIndex: 0 }, pi, ctx.hasUI ? ctx.ui : undefined);
            return;
        }

        const newGroups = groupTasks(tasks);
        const newState: InlineBatchState = { groups: newGroups, nextIndex: 0 };
        setState(newState, pi);  // temp head; status updated after first handoff below

        if (!ctx.hasUI) {
            // non-TUI: just output the first group as before (minimal support)
            const first = newGroups[0];
            const content = formatGroupContent(first);
            process.stdout.write(`${content}\n`);
            // advance for consistency (though non-TUI doesn't persist turns the same way)
            newState.nextIndex = 1;
            setState(newState, pi, undefined);
            return;
        }

        // TUI: notify and send first group
        ctx.ui.notify(`inline: 开始新批次，共 ${newGroups.length} 个文件组`, "info");
        const firstGroup = newGroups[0];
        ctx.ui.notify(
            `inline: 处理文件组 (1/${newGroups.length}) - ${firstGroup.file} (${firstGroup.tasks.length} markers)`,
            "info",
        );

        const content = formatGroupContent(firstGroup);
        pi.sendMessage({ customType: "inline", content, display: true }, { triggerTurn: true });

        // advance
        newState.nextIndex = 1;
        setState(newState, pi, ctx.ui);
    };

    pi.registerCommand("inline", {
        description:
            "Process inline PI!/PI? markers one file group at a time (smart continue or new batch)",
        handler: (args, ctx) => handler(args, ctx),
    });
}
