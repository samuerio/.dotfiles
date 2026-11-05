# Fork notes

Local fork of [`counterposition/pi` → `packages/pi-memory`](https://github.com/counterposition/pi/tree/main/packages/pi-memory).

- Upstream version: `0.3.0`
- Upstream commit: `790e0ff10592a5b12ed3ee38f5e1f52b688af657` (2026-10-27, "Sync with Pi 1.4.0")
- Loaded automatically: this directory sits at `~/.pi/agent/extensions/pi-memory/` and
  `package.json` declares `pi.extensions: ["extensions/memory.ts"]`, which is the pi
  discovery rule for extension subdirectories. No `settings.json` entry needed.
- No local changes yet. Upstream is GPL-3.0-only, see `LICENSE.md`.

## Layout

```text
extensions/memory.ts   entry: registers tools/commands/hooks
src/storage.ts         memory root resolution, atomic writes
src/identity.ts        project-id derivation from git common dir
src/parser.ts          entry parser (## heading + metadata block)
src/search.ts          lexical ranking, no index
src/write-path.ts      managed write/move, size limits, path guards
src/commands.ts        /memory /remember /forget
src/prompt.ts          injected memory contract + orientation summary
docs/v1-design.md      upstream frozen design rationale
```

## Test results (pi 1.3.0, 2026-11-05)

Verified working: `/memory`, `/remember`, `/forget`, `memory_write` (project + global
scope), `memory_move` (project → global), cross-session recall, write/edit interception
hook, relative-age labels.

Known defects found, not yet fixed:

1. **CJK search is effectively broken (P0).** `src/search.ts` builds
   `(?<![\p{L}\p{N}])word(?![\p{L}\p{N}])`. Chinese has no spaces between words, so a
   term embedded in a sentence never matches: `memory_search "集成测试"` returns nothing
   even when the body starts with `集成测试开始前…`. Chinese memories can be written but
   never found.
2. **Strict all-words AND kills long queries (P0).** `if (totalMatches !== queryWords.length) continue;`
   with no stemming and no OR fallback. The tool parameter says "Natural-language or
   keyword query", but a query like `"testing integration test setup requirements"`
   returns nothing even though `integration` and `test` hit. Only short/entity queries work.
3. **`memory_move` leaves an empty topic file (P2).** The source topic file keeps its
   `# Topic` header, and both `/memory` and the orientation summary still count it as a
   topic.
4. **Write guard covers only `write`/`edit` (P3).** `tool_call` path matching does not
   intercept bash. Upstream documents this as best-effort.

Fix direction for 1+2: match on coverage rather than all-words equality, and treat CJK
runs as substring-matchable (skip the boundary assertions for non-ASCII, or segment on
CJK script boundaries).
