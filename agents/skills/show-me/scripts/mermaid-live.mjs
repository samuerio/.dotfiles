#!/usr/bin/env node
import { Buffer } from "node:buffer"
import { readFileSync } from "node:fs"

const USAGE =
  "usage: mermaid-live.mjs [file.mmd | -]   (or pipe Mermaid source on stdin)"

const die = (message, code = 2) => {
  process.stderr.write(message + "\n")
  process.exit(code)
}

// mermaid.live reads `mermaid` as a JSON string of config. Keep it locked down
// because the diagram source may come from a model rather than the user.
const CONFIG = JSON.stringify({
  securityLevel: "strict",
  secure: ["secure", "securityLevel", "dompurifyConfig"],
  dompurifyConfig: {
    ALLOWED_TAGS: ["a", "b", "strong", "i", "em", "code", "pre", "span", "p", "br"],
    ALLOWED_ATTR: { a: ["href", "title"] },
    ALLOW_UNKNOWN_PROTOCOLS: false
  }
})

const arg = process.argv[2]

if (arg === "-h" || arg === "--help") {
  process.stdout.write(USAGE + "\n")
  process.exit(0)
}

let source
if (arg && arg !== "-") {
  try {
    source = readFileSync(arg, "utf8")
  } catch {
    die(`cannot read file: ${arg}`)
  }
} else {
  if (process.stdin.isTTY) die(USAGE)
  source = readFileSync(0, "utf8")
}

// Callers often pipe a whole fenced block, so accept one and unwrap it.
const fence = source.match(/```(?:mermaid)?[^\n]*\n([\s\S]*?)```/)
if (fence) source = fence[1]

source = source.replace(/^\uFEFF/, "").replace(/\s+$/, "")
if (!source) die("empty Mermaid input")

const payload = JSON.stringify({ code: source, mermaid: CONFIG })
const url =
  "https://mermaid.live/edit#base64:" +
  Buffer.from(payload, "utf8").toString("base64")

if (url.length > 8192) {
  process.stderr.write(`note: long URL (${url.length} chars)\n`)
}

process.stdout.write(url + "\n")
