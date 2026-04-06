#!/usr/bin/env node

/**
 * twitter.js — Convert a Twitter/X URL to Markdown via fxtwitter API
 *
 * Usage:
 *   node twitter.js <tweet_url> [-o output.md]
 *
 * Examples:
 *   node twitter.js https://x.com/badlogicgames/status/2040164191940550798
 *   node twitter.js https://twitter.com/badlogicgames/status/2040164191940550798 -o tweet.md
 */

import { writeFileSync } from "fs";

// ── helpers ──────────────────────────────────────────────────────────────────

function parseTwitterUrl(url) {
    const m = url.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/);
    if (!m) throw new Error(`Invalid Twitter/X URL: ${url}`);
    return { username: m[1], id: m[2] };
}

function formatDate(isoOrRfc) {
    const d = new Date(isoOrRfc);
    return d.toUTCString().replace(" GMT", " UTC");
}

function renderMedia(media = []) {
    if (!media.length) return "";
    const lines = media.map((m) => {
        if (m.type === "photo") return `![image](${m.url})`;
        if (m.type === "video" || m.type === "gif")
            return `[🎬 video](${m.url ?? m.thumbnail_url})`;
        return `[media](${m.url})`;
    });
    return "\n\n" + lines.join("\n");
}

function renderQuote(quote) {
    if (!quote) return "";

    const media = renderMedia(quote.media?.all ?? quote.media?.photos ?? []);
    const text = (quote.text ?? "").replace(/^/gm, "> ");

    return `
---

**引用推文** — [${quote.author.name}](${quote.author.url}) (@${quote.author.screen_name})

${text}${media}

> 🕐 ${formatDate(quote.created_at)} · 👍 ${quote.likes} · 🔁 ${quote.retweets} · 💬 ${quote.replies} · 🔖 ${quote.bookmarks} · 👁 ${quote.views}
>
> [查看原推](${quote.url})`;
}

function tweetToMarkdown(tweet) {
    const {
        author,
        text,
        created_at,
        likes,
        retweets,
        replies,
        bookmarks,
        views,
        url,
        media,
        quote,
    } = tweet;

    const mediaSection = renderMedia(media?.all ?? media?.photos ?? []);
    const quoteSection = renderQuote(quote ?? null);

    return `# [${author.name}](${author.url}) (@${author.screen_name})

> ${text.replace(/^/gm, "> ").replace(/^> > /, "> ")}${mediaSection}

---
${quoteSection}
---

🕐 ${formatDate(created_at)} · 👍 ${likes} · 🔁 ${retweets} · 💬 ${replies} · 🔖 ${bookmarks} · 👁 ${views}

[查看原推](${url})
`;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);

    if (!args.length || args[0] === "--help" || args[0] === "-h") {
        console.log("Usage: node twitter.js <tweet_url> [-o output.md]");
        process.exit(0);
    }

    const tweetUrl = args[0];
    const oIdx = args.indexOf("-o");
    const outputFile = oIdx !== -1 ? args[oIdx + 1] : null;

    if (oIdx !== -1 && !outputFile) {
        console.error("Error: -o requires a filename");
        process.exit(1);
    }

    let username, id;
    try {
        ({ username, id } = parseTwitterUrl(tweetUrl));
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }

    const apiUrl = `https://api.fxtwitter.com/${username}/status/${id}`;

    let data;
    try {
        const res = await fetch(apiUrl, {
            headers: { "User-Agent": "markit-twitter/1.0" },
        });
        data = await res.json();
    } catch (e) {
        console.error(`Failed to fetch tweet: ${e.message}`);
        process.exit(1);
    }

    if (data.code !== 200 || !data.tweet) {
        console.error(`API error: ${data.message ?? JSON.stringify(data)}`);
        process.exit(1);
    }

    const markdown = tweetToMarkdown(data.tweet);

    if (outputFile) {
        writeFileSync(outputFile, markdown, "utf8");
        console.error(`Saved to ${outputFile}`);
    } else {
        process.stdout.write(markdown);
    }
}

main();
