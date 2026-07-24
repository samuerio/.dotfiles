import {
    completeSimple,
    type AssistantMessage,
    type UserMessage,
} from "@earendil-works/pi-ai/compat";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ExtensionUI = ExtensionCommandContext["ui"];

// Absolute path of this extension's own source file. Its PI!:/PI?: occurrences
// live only inside prompt/description strings (self-referential noise), never
// real markers. Used to filter them out of rg scan output before describing.
const SELF_PATH = fileURLToPath(import.meta.url);

const SYSTEM_PROMPT = `Extract genuine PI!: and PI?: task comments from rg -C3 -n -H output.

A genuine marker must:
- Start the text of a code comment.
- Be immediately followed by a change request, slash command, or question.

For each genuine marker, output exactly:

<pi-task file="RELATIVE_PATH" line="MATCH_LINE">
RAW_RG_BLOCK
</pi-task>

Rules:
- Preserve the complete rg block exactly, including path and line prefixes.
- Use the matched line's path and scan-time line number.
- Emit one element per marker, in rg order; do not group by file.
- Do not add a type attribute, Markdown, summaries, commentary, or other fields.
- Do not XML-escape or otherwise rewrite the block.

If no genuine markers remain, output exactly:
NO_GENUINE_MARKERS`;

const FRAMING_HEADER = `The following PI!: and PI?: markers are tasks from one file. Complete every <pi-task> in order.

For PI!: tasks, modify the file as needed.
For PI?: tasks, do not modify the marker's file except to remove that marker's entire comment block.

After completing each task, remove its entire marker comment block. For /* ... */ comments or consecutive // comment lines, remove the whole block rather than only the marker line.

Only remove the markers listed below; leave markers from other files untouched.`;

const NO_GENUINE_MARKERS = "NO_GENUINE_MARKERS";

const INLINE_STATE_KEY = "inline-state";

interface InlineTask {
    line: number;
    content: string; // raw rg output block (with path:line: / path-line- prefixes) inside the <pi-task>
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

type ModeSpec = {
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
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

function extractText(response: AssistantMessage): string {
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

function loadStateFromBranch(branch: SessionEntry[]): InlineBatchState | null {
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (
            entry.type === "custom" &&
            entry.customType === INLINE_STATE_KEY &&
            entry.data
        ) {
            const s = entry.data as InlineBatchState;
            if (
                s &&
                Array.isArray(s.groups) &&
                typeof s.nextIndex === "number"
            ) {
                return s;
            }
        }
    }
    return null;
}

function reconstructState(ctx: ExtensionContext): void {
    const branch = ctx.sessionManager.getBranch();
    inlineState = loadStateFromBranch(branch);
}

function getCurrentState(ctx: ExtensionContext): InlineBatchState | null {
    if (inlineState === null) {
        reconstructState(ctx);
    }
    return inlineState;
}

function setState(
    newState: InlineBatchState | null,
    pi: ExtensionAPI,
    ui: ExtensionUI,
): void {
    inlineState = newState;
    if (newState) {
        persistState(pi, newState);
    }
    updateInlineStatus(ui);
}

function updateInlineStatus(ui: ExtensionUI): void {
    const s = inlineState;
    // Show status whenever there is a batch with remaining groups.
    // nextIndex = number of groups already handed off (can be 0 right after
    // batch creation). This means (0/N) is possible and acceptable.
    const hasRemaining =
        !!s && s.groups.length > 0 && s.nextIndex < s.groups.length;

    if (!hasRemaining) {
        ui.setStatus("inline", undefined);
        return;
    }
    const label = ui.theme.fg("accent", "inline");
    ui.setStatus("inline", `${label} (${s.nextIndex}/${s.groups.length})`);
}

function parsePiTasks(text: string): InlineTask[] {
    const tasks: InlineTask[] = [];
    // Support both with and without type attribute for robustness during transition
    const regex =
        /<pi-task\s+(?:type="[^"]+"\s+)?file="([^"]+)"\s+line="(\d+)"\s*>([\s\S]*?)<\/pi-task>/g;
    let match: RegExpExecArray | null;
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

function resolveScanPath(inputPath: string, cwd: string): string {
    let p = inputPath;
    if (p === "~") p = homedir();
    else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
    if (!isAbsolute(p)) p = resolve(cwd, p);
    return resolve(p);
}

type ScanPathResult =
    | { ok: true; paths: string[]; display: string[] }
    | { ok: false; error: string };

function resolveScanPaths(raw: string[], cwd: string): ScanPathResult {
    const paths: string[] = [];
    const display: string[] = [];
    for (const token of raw) {
        const abs = resolveScanPath(token, cwd);
        if (!existsSync(abs)) {
            return { ok: false, error: `Path not found: ${token}` };
        }
        paths.push(abs);
        display.push(token);
    }
    return { ok: true, paths, display };
}

function formatGroupContent(group: InlineGroup): string {
    const tasksText = group.tasks
        .map(
            (t) =>
                `<pi-task file="${group.file}" line="${t.line}">\n${t.content}\n</pi-task>`,
        )
        .join("\n\n");
    return `${FRAMING_HEADER}\n\n${tasksText}`;
}

// Path forms this extension's source may take in rg -H output: absolute (when
// scanned via explicit paths) and relative to cwd (default scan).
function selfPathVariants(cwd: string): string[] {
    const variants: string[] = [SELF_PATH];
    const rel = relative(cwd, SELF_PATH);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
        variants.push(rel);
    }
    return variants;
}

// Drop rg -C3 -n -H blocks whose path matches the extension's own source.
// Blocks are separated by a lone "--" line; a block is removed when any of its
// lines carries one of selfVariants as the path prefix.
function filterSelfFromRgScan(scan: string, selfVariants: string[]): string {
    if (!scan || selfVariants.length === 0) return scan;
    const pathRe = /^(.+?)(?::|-)(\d+)(?::|-)/;
    const keptBlocks: string[][] = [];
    let cur: string[] = [];
    let curIsSelf = false;
    const flush = (): void => {
        if (cur.length && !curIsSelf) keptBlocks.push(cur);
        cur = [];
        curIsSelf = false;
    };
    for (const line of scan.split("\n")) {
        if (line === "--") {
            flush();
            continue;
        }
        const m = line.match(pathRe);
        if (m && selfVariants.includes(m[1])) curIsSelf = true;
        cur.push(line);
    }
    flush();
    return keptBlocks.map((b) => b.join("\n")).join("\n--\n");
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
            ctx.ui.notify(message, "error");
        };

        const trimmedArgs = (args || "").trim();
        const tokens = trimmedArgs.split(/\s+/).filter(Boolean);
        const flags = tokens.filter((t) => t.startsWith("-"));
        const positionals = tokens.filter((t) => !t.startsWith("-"));

        if (!ctx.hasUI) {
            throw new Error("/inline is only supported in TUI mode");
        }

        // Handle control commands first
        if (flags.includes("-l") || flags.includes("--list")) {
            const state = getCurrentState(ctx);
            if (
                !state ||
                !state.groups.length ||
                state.nextIndex >= state.groups.length
            ) {
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
            setState({ groups: [], nextIndex: 0 }, pi, ctx.ui);
            ctx.ui.notify("inline batch 已重置", "info");
            return;
        }

        // plain /inline : smart continue or regenerate
        const state = getCurrentState(ctx);
        updateInlineStatus(ctx.ui);

        // Positional paths => force fresh scan over the given scope
        let scanScope: ScanPathResult | null = null;
        if (positionals.length > 0) {
            scanScope = resolveScanPaths(positionals, ctx.cwd);
            if (!scanScope.ok) {
                return fail(scanScope.error);
            }
        }
        const hasScanPaths = scanScope !== null;

        // Resolve model/auth (needed for describe in regenerate case)
        const rushSpec = loadRushModeSpec(ctx.cwd);
        if (!rushSpec) {
            return fail(`No '${RUSH_MODE}' mode in modes.json`);
        }
        const model = ctx.modelRegistry.find(
            rushSpec.provider!,
            rushSpec.modelId!,
        );
        if (!model) {
            return fail(
                `Mode '${RUSH_MODE}' references unknown model ${rushSpec.provider}/${rushSpec.modelId}`,
            );
        }
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
            return fail(`Auth failed: ${auth.error}`);
        }
        const { apiKey, headers } = auth;

        const describe = async (
            scan: string,
            signal?: AbortSignal,
        ): Promise<string | null> => {
            const userMessage: UserMessage = {
                role: "user",
                content: [{ type: "text", text: scan }],
                timestamp: Date.now(),
            };
            const response = await completeSimple(
                model,
                { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
                { apiKey, headers, signal },
            );
            if (response.stopReason === "aborted") return null;
            const text = extractText(response);
            if (!text) throw new Error("Empty inline result");
            return text;
        };

        // 1. Check if we can continue from existing state (no scan path given)
        if (!hasScanPaths && state && state.nextIndex < state.groups.length) {
            const group = state.groups[state.nextIndex];
            const content = formatGroupContent(group);

            ctx.ui.notify(
                `inline: 处理文件组 (${state.nextIndex + 1}/${state.groups.length}) - ${group.file} (${group.tasks.length} markers)`,
                "info",
            );
            pi.sendMessage(
                { customType: "inline", content, display: true },
                { triggerTurn: true },
            );

            // advance
            const newState: InlineBatchState = {
                ...state,
                nextIndex: state.nextIndex + 1,
            };
            setState(newState, pi, ctx.ui);
            return;
        }

        // 2. No remaining or no state (or explicit scan path) -> fresh scan + new plan
        const rgArgs = ["PI!:|PI\\?:", "-C", "3", "-n", "-H"];
        // Explicit paths bypass .gitignore so ignored dirs (e.g. .pi) can be targeted.
        if (scanScope) rgArgs.push("--no-ignore", ...scanScope.paths);
        const rg = await pi.exec("rg", rgArgs, { cwd: ctx.cwd });
        if (rg.code !== 0 && rg.code !== 1) {
            return fail(`rg failed (code ${rg.code}): ${rg.stderr.trim()}`);
        }
        let scanOutput = rg.stdout.trim();
        // Exclude this extension's own source from the scan: its PI!:/PI?:
        // matches are prompt/description strings (self-referential noise), not
        // real markers. Filtering deterministically here saves describe tokens
        // and removes any risk of the model treating them as tasks that edit
        // the extension itself.
        const selfVariants = selfPathVariants(ctx.cwd);
        if (selfVariants.length) {
            scanOutput = filterSelfFromRgScan(scanOutput, selfVariants);
        }
        if (!scanOutput) {
            ctx.ui.notify("No PI!:/PI?: markers found", "info");
            setState({ groups: [], nextIndex: 0 }, pi, ctx.ui);
            return;
        }

        const formatted: string | null = await ctx.ui.custom<string | null>(
            (tui, theme, _kb, done) => {
                const loader = new BorderedLoader(
                    tui,
                    theme,
                    "Scanning and describing inline markers...",
                );
                loader.onAbort = () => done(null);
                describe(scanOutput, loader.signal)
                    .then(done)
                    .catch((err) => {
                        ctx.ui.notify(`Inline failed: ${err.message}`, "error");
                        done(null);
                    });
                return loader;
            },
        );

        if (formatted === null) {
            ctx.ui.notify("Cancelled", "info");
            return;
        }
        if (!formatted) {
            ctx.ui.notify("Empty inline result", "error");
            return;
        }
        if (formatted === NO_GENUINE_MARKERS) {
            ctx.ui.notify("No genuine markers (all matches are docs)", "info");
            setState({ groups: [], nextIndex: 0 }, pi, ctx.ui);
            return;
        }

        const tasks = parsePiTasks(formatted);
        if (tasks.length === 0) {
            ctx.ui.notify("No genuine markers (all matches are docs)", "info");
            setState({ groups: [], nextIndex: 0 }, pi, ctx.ui);
            return;
        }

        const newGroups = groupTasks(tasks);
        const newState: InlineBatchState = { groups: newGroups, nextIndex: 0 };
        setState(newState, pi, ctx.ui);

        // TUI: notify and send first group
        const scopeLabel = scanScope
            ? `（范围 ${scanScope.display.join(" ")}）`
            : "";
        ctx.ui.notify(
            `inline: 开始新批次${scopeLabel}，共 ${newGroups.length} 个文件组`,
            "info",
        );
        const firstGroup = newGroups[0];
        ctx.ui.notify(
            `inline: 处理文件组 (1/${newGroups.length}) - ${firstGroup.file} (${firstGroup.tasks.length} markers)`,
            "info",
        );

        const content = formatGroupContent(firstGroup);
        pi.sendMessage(
            { customType: "inline", content, display: true },
            { triggerTurn: true },
        );

        // advance
        newState.nextIndex = 1;
        setState(newState, pi, ctx.ui);
    };

    pi.registerCommand("inline", {
        description:
            "Process inline PI!:/PI?: markers one file group at a time. Optional positional paths scope a fresh scan; -l/--list, -r/--reset control the batch.",
        handler: (args, ctx) => handler(args, ctx),
    });
}
