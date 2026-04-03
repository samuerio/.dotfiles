#!/usr/bin/env node

import {readFile, writeFile} from 'node:fs/promises';

const {transcriptFile, outputFile} = parseArgs(process.argv.slice(2));

if (!transcriptFile || !outputFile) {
    console.error('Usage: render-share-html.js <transcript-file> <output-html>');
    process.exit(1);
}

try {
    const transcript = await readFile(transcriptFile, 'utf8');
    const title = 'Continuous Chinese Transcript';
    const html = buildHtml(title, transcript);

    await writeFile(outputFile, html, 'utf8');
} catch (error) {
    console.error('Error rendering share HTML:', error.message);
    process.exit(1);
}

function parseArgs(args) {
    return {
        transcriptFile: args[0],
        outputFile: args[1],
    };
}

function buildHtml(title, content) {
    const escapedTitle = escapeHtml(title);
    const escapedContent = escapeHtml(content.trim());

    return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapedTitle}</title>
    <style>
      :root {
        color-scheme: light;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: system-ui, sans-serif;
        background: #fff;
        color: #111;
      }

      main {
        max-width: 900px;
        margin: 0 auto;
        padding: 40px 20px 80px;
      }

      h1 {
        font-size: 28px;
        line-height: 1.2;
        margin: 0 0 24px;
      }

      article {
        white-space: pre-wrap;
        line-height: 1.75;
        font-size: 16px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapedTitle}</h1>
      <article>${escapedContent}</article>
    </main>
  </body>
</html>
`;
}

function escapeHtml(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
