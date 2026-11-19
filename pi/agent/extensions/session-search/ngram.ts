/**
 * Cold-side n-gram tokenizer for the archive FTS index.
 *
 * `node:sqlite` cannot load a custom FTS5 tokenizer, so the segmentation has
 * to happen on both sides of FTS5: the ingest expands each stored text into a
 * token stream, the query expands the query text into the same stream, and
 * FTS5 (unicode61) only ever sees space-separated tokens. A phrase query over
 * that stream is then an EXACT substring match, not a fuzzy one.
 *
 * Scheme: split into script runs, lowercase, CJK run → all 2-grams, ASCII run
 * → all 3-grams, everything else is a separator that produces no token. Two
 * properties justify those sizes:
 *
 *   - 2-gram CJK makes two-character Chinese queries work (a trigram index
 *     cannot answer those at all), and 3-gram ASCII keeps word-internal
 *     substrings (`loadConfig` matches `Config`); leaving ASCII as whole
 *     tokens would silently lose that recall.
 *   - Separators produce no token but also consume no position, so a phrase
 *     can span whitespace while no n-gram is ever formed across it. That is
 *     what keeps `冷热分离` from matching `冷热 分离`.
 *
 * The prefilter must be SOUND: it may return rows that do not actually match
 * (cross-run adjacency, short runs dropped by the caller's fallback), because
 * the caller re-judges every candidate with `core.ts`'s matcher.
 * It must never miss a row. `ngramPhrase` therefore returns null (fall back to
 * a full scan) whenever a run is shorter than its gram size, rather than
 * silently emitting a looser, expensive phrase.
 *
 * Bump NGRAM_VERSION whenever the segmentation changes: the stored token
 * streams stop matching the new query expansion, and the archive index has to
 * be rebuilt from the archived JSONL files.
 */

export const NGRAM_VERSION = 1;

export type RunClass = "cjk" | "ascii" | "other";

export interface TextRun {
    cls: RunClass;
    text: string;
}

const GRAM_SIZE: Record<"cjk" | "ascii", number> = { cjk: 2, ascii: 3 };

function isCjk(cp: number): boolean {
    return (
        (cp >= 0x3040 && cp <= 0x30ff) || // hiragana + katakana
        (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
        (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
        (cp >= 0xac00 && cp <= 0xd7af) || // hangul syllables
        (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
        (cp >= 0x20000 && cp <= 0x2fa1f) // CJK ext B-F + compatibility supplement
    );
}

function isAsciiWord(cp: number): boolean {
    return (
        (cp >= 0x30 && cp <= 0x39) || // 0-9
        (cp >= 0x41 && cp <= 0x5a) || // A-Z
        (cp >= 0x61 && cp <= 0x7a) // a-z
    );
}

function classOf(ch: string): RunClass {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCjk(cp)) return "cjk";
    if (isAsciiWord(cp)) return "ascii";
    return "other";
}

/**
 * Split lowercased text into maximal same-class runs. Iteration is by code
 * point, so astral CJK (ext B) is one run member, not two surrogates.
 */
export function segmentRuns(text: string): TextRun[] {
    const runs: TextRun[] = [];
    for (const ch of text.toLowerCase()) {
        const cls = classOf(ch);
        const last = runs[runs.length - 1];
        if (last && last.cls === cls) last.text += ch;
        else runs.push({ cls, text: ch });
    }
    return runs;
}

/** Expand stored text into the FTS token stream (space-separated). */
export function ngramTokens(text: string): string {
    const tokens: string[] = [];
    for (const run of segmentRuns(text)) {
        if (run.cls === "other") continue;
        const size = GRAM_SIZE[run.cls];
        const chars = Array.from(run.text);
        for (let i = 0; i + size <= chars.length; i++) {
            tokens.push(chars.slice(i, i + size).join(""));
        }
    }
    return tokens.join(" ");
}

/**
 * Expand a query into the phrase to hand FTS5, or null when the query cannot
 * be expressed soundly (regex is the caller's job; this rejects a run shorter
 * than its gram size, and an empty token stream).
 */
export function ngramPhrase(query: string): string | null {
    const tokens: string[] = [];
    let sawRun = false;
    for (const run of segmentRuns(query)) {
        if (run.cls === "other") continue;
        sawRun = true;
        const size = GRAM_SIZE[run.cls];
        const chars = Array.from(run.text);
        if (chars.length < size) return null;
        for (let i = 0; i + size <= chars.length; i++) {
            tokens.push(chars.slice(i, i + size).join(""));
        }
    }
    if (!sawRun) return null;
    return tokens.join(" ");
}

/**
 * FTS5 match expression for a phrase, optionally restricted to a column.
 * Column filters keep `ng_text` and `ng_tools` separately queryable, so
 * `includeToolCalls` does not have to pollute the body index.
 */
export function ftsMatch(phrase: string, column: "ng_text" | "ng_tools"): string {
    return `${column} : "${phrase}"`;
}
