import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const SYSTEM_PROMPT = `You are an inline marker extractor. You receive ripgrep output that scanned a codebase for PIDO and PIASK comments. Your job is to extract and format them faithfully. Do NOT implement changes, answer questions, or interpret what the marker asks for.

Output rules:
- Read the provided ripgrep output (file paths, line numbers, and -C 3 surrounding context). The surrounding context is only for you to decide whether a match is documentation about the convention itself; do NOT summarize it back to the main agent.
- Group markers by file path.
- For each marker output exactly: marker type (PIDO or PIASK), file:line, and the full original comment text. If the comment spans multiple consecutive lines, use the surrounding context to capture the complete multi-line comment in the Comment field.
- Skip matches that are clearly documentation about the PIDO/PIASK convention itself (e.g., SKILL files explaining the markers, README sections, code-block examples showing the syntax). Only include genuine inline markers that represent actual tasks or questions.
- Do NOT restate or rephrase the task. Only extract.
- Do NOT output a separate "Context" field.
- Do NOT output resolution rules, output format instructions, or any other meta commentary.
- Use English for all prose. Output as Markdown.
- End with a summary line exactly like: "Summary: N PIDO, M PIASK."

Output shape:

## <relative file path>

### PIDO @ <file>:<line>
- Comment: <full comment text>

### PIASK @ <file>:<line>
- Comment: <full comment text>

---

Summary: N PIDO, M PIASK.

Output ONLY the formatted listing above. No markdown wrappers, no explanations.`;

const FRAMING_HEADER = `Found inline markers (PIDO/PIASK) in the codebase. Handle each one per the resolution rules:

PIASK comments (questions):
- Read the question with surrounding context
- Provide a direct answer to the user
- Do not implement feature/code/doc changes just for answering
- Remove the PIASK comment after resolution
- If context is insufficient to answer, keep the comment as-is

PIDO comments (change requests):
- Analyze the feedback or instructions in each comment
- Implement the requested code changes
- Address any issues or concerns raised
- Remove or update PIDO comments once addressed`;

const OUTPUT_FORMAT_FOOTER = `Output format:
- Group by file path
- For each item include:
  - marker type (PIASK / PIDO)
  - line numbers and full context for each marker type comment
  - action taken (answer given, or change implemented)
  - marker action (removed or kept)
- End with a summary of all changes made and any unresolved blockers`;

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
        const rgArgs = ["PIDO:|PIASK:", "-C", "3", "-n", "-H"];
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
                ctx.ui.notify("No PIDO/PIASK markers found", "info");
            }
            return;
        }

        // 2. Resolve model and auth.
        const model = ctx.model;
        if (!model) {
            return fail("No model selected");
        }

        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
            return fail(`Auth failed: ${auth.error}`);
        }
        const { apiKey, headers } = auth;

        // 3. Format markers with an independent LLM call.
        const describe = async (signal?: AbortSignal): Promise<string | null> => {
            const userMessage: UserMessage = {
                role: "user",
                content: [{ type: "text", text: scanOutput }],
                timestamp: Date.now(),
            };

            const response = await complete(
                model,
                {
                    systemPrompt: SYSTEM_PROMPT,
                    messages: [userMessage],
                },
                {
                    apiKey,
                    headers,
                    signal,
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

        const content = `${FRAMING_HEADER}\n\n${formatted}\n\n${OUTPUT_FORMAT_FOOTER}`;
        pi.sendMessage(
            { customType: "inline", content, display: true },
            { triggerTurn: true },
        );
    };

    pi.registerCommand("inline", {
        description:
            "Scan inline PIDO and PIASK markers and generate a structured task list",
        handler: (args, ctx) => handler(args, ctx),
    });
}
