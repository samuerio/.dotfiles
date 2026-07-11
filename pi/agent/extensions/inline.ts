import {
    completeSimple,
    type ThinkingLevel,
    type UserMessage,
} from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SYSTEM_PROMPT = `You are an inline marker extractor. You receive ripgrep output that scanned a codebase for PI! and PI? comments. Your job has three steps only: filter, select, and construct. Do NOT implement changes, answer questions, clarify, or interpret what the marker asks for.

Filter:
- Skip matches that are clearly documentation about the PI!/PI? convention itself (e.g., SKILL files explaining the markers, README sections, code-block examples showing the syntax). Only genuine inline markers that represent actual tasks or questions count.

Select:
- From the remaining genuine markers, take the FIRST one in ripgrep (rg) output order. Output only that single marker.

Construct:
- Emit one <pi-task> element for the selected marker. The element body is the raw rg context (the path:line:content lines surrounding the match, preserved exactly as they appear in the rg output, including the path:line prefix). Do not summarize, rewrite, or trim the snippet.
- Use type="change" for PI! and type="question" for PI?.
- The file attribute is the relative file path from the rg output. The line attribute is the line number of the match line from the rg output (the scan-time line number).
- Do NOT emit a separate comment field. The matching line in the snippet already carries the comment text.
- Do NOT group by file. Do NOT use Markdown headings. Output exactly one <pi-task> element.
- Do NOT XML-escape the snippet. The output is read as text, not parsed.
- Do NOT output a summary line.

If, after filtering, there are no genuine markers (rg matched but all matches are documentation about the convention), output exactly the token:

NO_GENUINE_MARKERS

and nothing else.

Output shape (single marker):

<pi-task type="change" file="<relative path>" line="<n>">
<path>:<line>: <raw rg context line>
<path>:<line>: <raw rg context line>
</pi-task>

Use English for any prose. Do NOT output meta commentary, resolution rules, or output format instructions. Output ONLY the <pi-task> element (or the NO_GENUINE_MARKERS token).`;

const FRAMING_HEADER = `Found an inline marker (PI!/PI?) in the codebase.

For this marker:
- Extract the task content from the comment.
- If the task needs clarification, ask the user and wait (the comment stays in place).
- When starting the actual task, remove the comment from the file.
- PI! (modification): implement the code changes.
  PI? (explanatory): investigate and answer directly; do not make code or doc changes.`;

const NO_GENUINE_MARKERS = "NO_GENUINE_MARKERS";

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

function extractText(response: Awaited<ReturnType<typeof complete>>): string {
    return response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
}

export default function (pi: ExtensionAPI) {
    const handler = async (_args: string, ctx: ExtensionCommandContext) => {
        const fail = (message: string): void => {
            if (ctx.hasUI) {
                ctx.ui.notify(message, "error");
                return;
            }
            throw new Error(message);
        };

        // 1. Scan for inline markers. Exclude this extension file so its own
        //    marker-pattern strings are not treated as user markers.
        const extensionRelPath = relative(
            ctx.cwd,
            fileURLToPath(import.meta.url),
        ).replace(/\\/g, "/");
        const rgArgs = ["PI!|PI\\?", "-C", "3", "-n", "-H"];
        if (!extensionRelPath.startsWith("..")) {
            rgArgs.push("-g", `!${extensionRelPath}`);
        }

        const rg = await pi.exec("rg", rgArgs, { cwd: ctx.cwd });

        // ripgrep exit code 1 means no matches, which is not an error here.
        if (rg.code !== 0 && rg.code !== 1) {
            return fail(`rg failed (code ${rg.code}): ${rg.stderr.trim()}`);
        }

        const scanOutput = rg.stdout.trim();
        if (!scanOutput) {
            if (ctx.hasUI) {
                ctx.ui.notify("No PI!/PI? markers found", "info");
            }
            return;
        }

        // 2. Resolve the rush mode model and auth.
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

        const thinkingLevels: readonly ThinkingLevel[] = [
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
        ];
        const reasoning: ThinkingLevel | undefined =
            rushSpec.thinkingLevel &&
            thinkingLevels.includes(rushSpec.thinkingLevel as ThinkingLevel)
                ? (rushSpec.thinkingLevel as ThinkingLevel)
                : undefined;

        // 3. Format markers with an independent LLM call.
        const describe = async (signal?: AbortSignal): Promise<string | null> => {
            const userMessage: UserMessage = {
                role: "user",
                content: [{ type: "text", text: scanOutput }],
                timestamp: Date.now(),
            };

            const response = await completeSimple(
                model,
                {
                    systemPrompt: SYSTEM_PROMPT,
                    messages: [userMessage],
                },
                {
                    apiKey,
                    headers,
                    signal,
                    ...(reasoning ? { reasoning } : {}),
                },
            );

            if (response.stopReason === "aborted") {
                return null;
            }

            const text = extractText(response);
            if (!text) {
                throw new Error("Empty inline result");
            }

            return text;
        };

        // 4. Run formatting and deliver results.
        if (!ctx.hasUI) {
            const formatted = await describe();
            if (!formatted) {
                throw new Error("Empty inline result");
            }
            if (formatted === NO_GENUINE_MARKERS) {
                process.stdout.write("No genuine markers (all matches are docs)\n");
                return;
            }
            process.stdout.write(`${formatted}\n`);
            return;
        }

        const formatted = await ctx.ui.custom<string | null>(
            (tui, theme, _kb, done) => {
                const loader = new BorderedLoader(
                    tui,
                    theme,
                    "Scanning and describing inline markers...",
                );
                loader.onAbort = () => done(null);

                describe(loader.signal)
                    .then(done)
                    .catch((err) => {
                        ctx.ui.notify(
                            `Inline failed: ${err.message}`,
                            "error",
                        );
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
            return;
        }

        const content = `${FRAMING_HEADER}\n\n${formatted}`;
        pi.sendMessage(
            { customType: "inline", content, display: true },
            { triggerTurn: true },
        );
    };

    pi.registerCommand("inline", {
        description:
            "Scan inline PI! and PI? markers and generate a structured task list",
        handler: (args, ctx) => handler(args, ctx),
    });
}
