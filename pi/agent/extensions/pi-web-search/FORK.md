# Fork notes

Local fork of [`counterposition/pi` → `packages/pi-web-search`](https://github.com/counterposition/pi/tree/main/packages/pi-web-search).

- Upstream version: `0.10.0`
- Upstream commit: `790e0ff10592a5b12ed3ee38f5e1f52b688af657` (2026-10-27, "Sync with Pi 1.4.0")
- Loaded automatically: this directory sits at `~/.pi/agent/extensions/pi-web-search/` and
  `package.json` declares `pi.extensions: ["extensions/web-search.ts"]`, which is the pi
  discovery rule for extension subdirectories. No `settings.json` entry needed.
- No local changes yet. Upstream is GPL-3.0-only, see `LICENSE.md`.
- No runtime `dependencies`. Only `peerDependencies` (`@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent`, `typebox`), resolved from the running pi install via
  the `~/.pi/node_modules` symlinks. No install step required.
- npm overlap: `settings.json` `packages` is currently empty, so only this fork loads. If
  `npm:@counterposition/pi-web-search` were added back, both copies would load and their
  `web_search` / `web_fetch` tool names would conflict. The local fork wins that conflict
  because a user-scope auto-discovered extension ranks 3 in `resourcePrecedenceRank` while a
  user-scope package ranks 4, and the first owner of a tool name keeps it.

## Layout

```text
extensions/web-search.ts   entry: registers web_search / web_fetch, injects untrusted-content prompt section
src/config.ts              settings + env key loading, domain normalization, provider ranking and resolution
src/format.ts              search/fetch text formatting, 8k character pagination windows
src/page-cache.ts          LRU page cache (20 entries, 5 min TTL) keyed by URL
src/provider-utils.ts      shared HTTP helpers, timeouts, byte caps, transient-error classification, dedupe
src/types.ts               provider interfaces, settings, result and pagination types
src/url-safety.ts          fetch URL validation, blocks localhost and cloud metadata hosts
src/providers/index.ts     builds the provider set from whichever API keys are configured
src/providers/brave.ts     Brave adapter (search, freshness)
src/providers/tavily.ts    Tavily adapter (content, semantic, freshness, domain filter, dates)
src/providers/exa.ts       Exa adapter (content, semantic, freshness, domain filter, dates)
src/providers/parallel.ts  Parallel adapter, free MCP endpoint when keyless, always ranked last
src/providers/jina.ts      Jina Reader page fetch adapter
tests/                     vitest suites, not loaded by pi
docs/, concerns/           upstream design overview, ADR, maintenance plans
```

API keys come from `webSearch.apiKeys` in the global `~/.pi/agent/settings.json` or from
`BRAVE_API_KEY` / `TAVILY_API_KEY` / `EXA_API_KEY` / `PARALLEL_API_KEY` / `JINA_API_KEY`.
No key is required: Parallel's free tier serves keyless searches.
