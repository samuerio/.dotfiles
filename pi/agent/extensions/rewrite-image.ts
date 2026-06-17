import {
    complete,
    type ImageContent,
    type UserMessage,
} from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";

const SYSTEM_PROMPT = `Convert this image into text so it can replace the image in a user's question for a pure text reasoning model.

The downstream model has NO image access. Describe only what is visible in the image.

Rules:
- Describe ALL important visible content in detail: text, UI elements, code, errors, diagrams, charts, layout, colors, annotations, screenshots context, etc.
- If the image contains text, transcribe the visible text as faithfully as possible.
- Do not answer any implied question. Do not solve the problem. Only describe the image content.
- Output ONLY the image description. No meta commentary, no markdown wrappers.`;

const IMG_RE = /(?:"([^"]+\.(?:png|jpe?g|webp|gif))"|(\S+\.(?:png|jpe?g|webp|gif)))/gi;

const MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
};

type ConfigResult =
    | { ok: true; provider: string; model: string }
    | { ok: false; error: string };

type TextSegment = {
    type: "text";
    text: string;
};

type ImageSegment = {
    type: "image";
    index: number;
    image: ImageContent;
};

type Segment = TextSegment | ImageSegment;

function loadConfig(): ConfigResult {
    const path = join(getAgentDir(), "rewrite-image.json");
    if (!existsSync(path)) {
        return { ok: false, error: `Config not found: ${path}` };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch (err) {
        return {
            ok: false,
            error: `Invalid JSON in ${path}: ${(err as Error).message}`,
        };
    }
    if (!parsed || typeof parsed !== "object") {
        return { ok: false, error: `Config in ${path} must be a JSON object` };
    }
    const { provider, model } = parsed as Record<string, unknown>;
    if (typeof provider !== "string" || typeof model !== "string") {
        return {
            ok: false,
            error: `Config in ${path} missing string fields 'provider' and 'model'`,
        };
    }
    return { ok: true, provider, model };
}

async function parseSegments(args: string, cwd: string): Promise<Segment[]> {
    const segments: Segment[] = [];
    let last = 0;
    let imageIndex = 1;

    let m: RegExpExecArray | null;
    IMG_RE.lastIndex = 0;
    while ((m = IMG_RE.exec(args)) !== null) {
        const rawPath = m[1] ?? m[2];
        const abs = isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);
        if (!existsSync(abs)) {
            continue;
        }

        const ext = extname(abs).toLowerCase();
        const mime = MIME[ext];
        if (!mime) {
            continue;
        }

        if (m.index > last) {
            segments.push({ type: "text", text: args.slice(last, m.index) });
        }

        const buf = await readFile(abs);
        segments.push({
            type: "image",
            index: imageIndex++,
            image: {
                type: "image",
                data: buf.toString("base64"),
                mimeType: mime,
            },
        });
        last = m.index + m[0].length;
    }

    if (last < args.length) {
        segments.push({ type: "text", text: args.slice(last) });
    }

    return segments;
}

function getImageSegments(segments: Segment[]): ImageSegment[] {
    return segments.filter((s): s is ImageSegment => s.type === "image");
}

function extractText(response: Awaited<ReturnType<typeof complete>>): string {
    return response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
}

export default function (pi: ExtensionAPI) {
    const handler = async (
        args: string,
        ctx: ExtensionCommandContext,
    ) => {
        const fail = (message: string): void => {
            if (ctx.hasUI) {
                ctx.ui.notify(message, "error");
                return;
            }
            throw new Error(message);
        };

        if (!args.trim()) {
            return fail("Usage: /rewrite-image <path.png> <question>");
        }

        const segments = await parseSegments(args, ctx.cwd);
        const imageSegments = getImageSegments(segments);

        if (imageSegments.length === 0) {
            return fail(
                "No image found in args. Provide at least one image path.",
            );
        }

        const cfg = loadConfig();
        if (!cfg.ok) {
            return fail(cfg.error);
        }

        const model = ctx.modelRegistry.find(cfg.provider, cfg.model);
        if (!model) {
            return fail(`Model ${cfg.provider}/${cfg.model} not found`);
        }

        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
            return fail(`Auth failed: ${auth.error}`);
        }

        const describeImages = async (
            signal?: AbortSignal,
        ): Promise<string | null> => {
            const describeImage = async (
                segment: ImageSegment,
            ): Promise<[number, string] | null> => {
                const userMessage: UserMessage = {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Describe this image for a pure text reasoning model.",
                        },
                        segment.image,
                    ],
                    timestamp: Date.now(),
                };

                const response = await complete(
                    model,
                    {
                        systemPrompt: SYSTEM_PROMPT,
                        messages: [userMessage],
                    },
                    {
                        apiKey: auth.apiKey,
                        headers: auth.headers,
                        signal,
                    },
                );

                if (response.stopReason === "aborted") {
                    return null;
                }

                const text = extractText(response);
                if (!text) {
                    throw new Error(`Empty image ${segment.index} description`);
                }

                return [segment.index, text];
            };

            const results = await Promise.all(
                imageSegments.map((segment) => describeImage(segment)),
            );
            if (results.some((result) => result === null)) {
                return null;
            }

            const descriptions = new Map<number, string>();
            for (const result of results) {
                if (result) {
                    descriptions.set(result[0], result[1]);
                }
            }

            const rewrittenText = segments
                .map((segment) => {
                    if (segment.type === "text") {
                        return segment.text;
                    }
                    const description = descriptions.get(segment.index);
                    if (!description) {
                        throw new Error(
                            `Missing image ${segment.index} description`,
                        );
                    }
                    return `\n\n<image id="${segment.index}">\n${description}\n</image>\n\n`;
                })
                .join("")
                .trim();

            return rewrittenText || null;
        };

        if (!ctx.hasUI) {
            const rewritten = await describeImages();
            if (!rewritten) {
                throw new Error("Empty rewrite result");
            }
            process.stdout.write(`${rewritten}\n`);
            return;
        }

        const rewritten = await ctx.ui.custom<string | null>(
            (tui, theme, _kb, done) => {
                const imageLabel =
                    imageSegments.length === 1 ? "image" : "images";
                const loader = new BorderedLoader(
                    tui,
                    theme,
                    `Describing ${imageSegments.length} ${imageLabel}...`,
                );
                loader.onAbort = () => done(null);

                describeImages(loader.signal)
                    .then(done)
                    .catch((err) => {
                        ctx.ui.notify(
                            `Rewrite failed: ${err.message}`,
                            "error",
                        );
                        done(null);
                    });

                return loader;
            },
        );

        if (rewritten === null) {
            ctx.ui.notify("Cancelled", "info");
            return;
        }

        if (!rewritten) {
            ctx.ui.notify("Empty rewrite result", "error");
            return;
        }

        pi.sendMessage(
            {
                customType: "rewrite-image",
                content: rewritten,
                display: true,
            },
            { triggerTurn: true },
        );
    };

    pi.registerCommand("rewrite-image", {
        description:
            "Replace image paths in a question with text descriptions",
        handler: (args, ctx) => handler(args, ctx),
    });
}
