# Fork notes

Local fork of [`counterposition/pi` → `packages/pi-memory`](https://github.com/counterposition/pi/tree/main/packages/pi-memory).

- Upstream version: `0.3.0`
- Upstream commit: `790e0ff10592a5b12ed3ee38f5e1f52b688af657` (2026-10-27, "Sync with Pi 1.4.0")
- Loaded automatically: this directory sits at `~/.pi/agent/extensions/pi-memory/` and
  `package.json` declares `pi.extensions: ["extensions/memory.ts"]`, which is the pi
  discovery rule for extension subdirectories. No `settings.json` entry needed.
- Upstream is GPL-3.0-only, see `LICENSE.md`.

## Layout

```text
extensions/memory.ts   entry: registers tools/commands/hooks
src/storage.ts         memory root resolution, atomic writes
src/identity.ts        project-id derivation from git common dir
src/parser.ts          entry parser (## heading + metadata block)
src/search.ts          lexical ranking, no index   [modified]
src/write-path.ts      managed write/move, size limits, path guards
src/commands.ts        /memory /remember /forget
src/prompt.ts          injected memory contract + orientation summary
docs/v1-design.md      upstream frozen design rationale
```

## Local changes

### 1. CJK and CJK-adjacent matching (`src/search.ts`)

Upstream built word regexes as `(?<![\p{L}\p{N}])word(?![\p{L}\p{N}])`. Chinese has no
inter-word spaces, so a term glued to its neighbours never matched: `集成测试` missed
`集成测试开始前…`, and `redis` missed `安装redis`. Now:

- a query token containing Han/Hiragana/Katakana/Hangul is matched by substring
  (case-insensitive, no boundary assertions), which is how you would find it by hand;
- ASCII tokens keep word boundaries, but the boundary class is
  `[[\p{L}\p{N}]&&[^<CJK scripts>]]` (`v` flag), so CJK characters do not block a match
  and ASCII-adjacent lookalikes (`xredisx`) still do not match.

`buildExcerpt` inherits the same regex, so excerpts now centre on the real first hit
instead of falling back to offset 0.

### 2. Partial-match fallback (`src/search.ts`, `src/types.ts`, `extensions/memory.ts`)

Upstream gated on `if (totalMatches !== queryWords.length) continue`, so any query with
one word the entry lacks returned nothing, even when the rest matched. Entries matching
every word are still preferred; only when that set is empty does search fall back to
partial coverage, ranked by the same comparator (heading matches dominate, recency breaks
ties). `MemorySearchResponse.partial` reports which mode produced the results, and
`formatSearchResultsText` prefixes partial output with a warning line so the model does
not treat weak hits as full matches.

Deliberately not changed: exact word matching (no stemming), so `testing` still does not
match `tests`. The fallback absorbs most of that pain, and stemming would be permanent
drift against upstream.

### 3. Tooling to make the vendored tests runnable

- `tsconfig.base.json` added, `tsconfig.json` extends `./tsconfig.base.json`. Upstream
  extends `../../tsconfig.base.json`, which lives at the monorepo root and is absent in a
  vendored copy; without it every test file failed to transform.
- `pnpm-lock.yaml` committed so dev dependencies stay pinned.

## Test status (pi 1.3.0, 2026-11-05)

`pnpm install && pnpm exec vitest run` → 75 tests, 12 files, all passing (4 tests added
for the changes above).

`pnpm exec tsc --noEmit` reports 7 errors, all in `extensions/memory.ts` and all
pre-existing: `devDependencies` declare `@earendil-works/*` as `^1.4.0`, pnpm resolved
1.5.0, and 1.5.0 tightened `StringEnum`/`JsonValue` typing. Runtime is unaffected because
pi supplies those modules. Do not chase these without first pinning the dev dependencies
to the pi version actually in use.

End-to-end verified under interactive pi with an isolated `PI_CODING_AGENT_DIR`:

- `/memory`, `/remember`, `/forget`, `memory_write` (project + global scope),
  `memory_move` (project → global), cross-session recall, relative-age labels
- `memory_search "集成测试"` now hits a Chinese entry (was: no result)
- `memory_search "redis 环境准备"` returns partial matches with the warning line
- a query sharing no token with any entry still returns nothing, as it must (lexical
  matching, no semantic expansion)

## Retracted finding

An earlier note here claimed `memory_move` left an empty topic file that inflated the
topic count. That is wrong. `write-path.ts` unlinks the source file when the moved entry
was the only parsed entry, verified by probe: single-entry move leaves no file behind, and
`getMemoryStatusSummary` reports only the surviving topic. The original claim came from
misreading `cat` output for a deleted file as an empty file, and from miscounting three
real topics as two.

Separate edge case that is real but not fixed: the unlink decision uses the pre-removal
parser count, so a topic file containing two `##` sections that share one entry ID (only
producible by hand editing; the parser warns and keeps the last one) gets its whole file
deleted when the surviving entry moves out, silently dropping the other section. Fixing it
means deciding emptiness from the post-removal source instead. Not worth it until a
hand-edited duplicate ID actually shows up.

## Deferred, with triggers

- **CJK bigram matching.** Trigger: repeated misses where the query phrase is longer than
  the stored span (`集成测试环境` vs stored `集成测试`). Substring matching covers daily
  shapes; bigrams would force a threshold rule and break `buildExcerpt` anchoring.
- **Content-aware topic enumeration.** Trigger: a header-only topic file appearing from a
  non-managed source.
- **Always-coverage ranking (no AND-first).** Trigger: repeatedly seeing a
  plausible-but-wrong full-coverage hit while a better partial hit exists.
- **Bash write interception.** Deliberate upstream boundary, not a defect: regex-matching
  shell strings is defeated by heredocs, indirection, and scripting-language one-liners,
  and the prompt contract plus the `write`/`edit` hook cover the realistic paths.
- **Stopwords / stemming.** Do not add; the partial fallback already absorbs most of it.
