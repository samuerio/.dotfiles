// ngram.ts tests: the cold-side tokenizer only. Every case is pure
// text in / text out, so no session files or pi packages are needed.

import assert from "node:assert/strict";
import test from "node:test";

import {
    ftsMatch,
    ngramPhrase,
    ngramTokens,
    segmentRuns,
} from "../ngram.ts";

const tokens = (text: string): string[] => ngramTokens(text).split(" ").filter(Boolean);

/** Index of `needle` as a contiguous run inside `haystack`, or -1. */
function contiguousAt(haystack: string[], needle: string[]): number {
    if (needle.length === 0) return -1;
    for (let start = 0; start + needle.length <= haystack.length; start++) {
        let ok = true;
        for (let i = 0; i < needle.length; i++) {
            if (haystack[start + i] !== needle[i]) {
                ok = false;
                break;
            }
        }
        if (ok) return start;
    }
    return -1;
}

test("splits runs by script class and lowercases", () => {
    assert.deepEqual(segmentRuns("BDV 变压器 loadConfig"), [
        { cls: "ascii", text: "bdv" },
        { cls: "other", text: " " },
        { cls: "cjk", text: "变压器" },
        { cls: "other", text: " " },
        { cls: "ascii", text: "loadconfig" },
    ]);
});

test("expands CJK to 2-grams and ASCII to 3-grams, separators produce nothing", () => {
    assert.equal(
        ngramTokens("BDV 变压器 loadConfig"),
        "bdv 变压 压器 loa oad adc dco con onf nfi fig",
    );
    assert.equal(ngramTokens("冷热分离方案"), "冷热 热分 分离 离方 方案");
    assert.equal(ngramTokens("冷热 分离"), "冷热 分离");
});

test("no n-gram spans a separator, so a tighter query cannot match a looser text", () => {
    // Query "冷热分离" needs 热分, which "冷热 分离" never produces.
    assert.equal(
        contiguousAt(tokens("冷热 分离"), tokens(ngramPhrase("冷热分离")!)),
        -1,
    );
    // Query "冷热 分离" needs 冷热 followed by 分离, which "冷热分离" does not.
    assert.equal(
        contiguousAt(tokens("冷热分离"), tokens(ngramPhrase("冷热 分离")!)),
        -1,
    );
    // Exact text still matches itself in both shapes.
    assert.equal(
        contiguousAt(tokens("冷热分离"), tokens(ngramPhrase("冷热分离")!)),
        0,
    );
    assert.equal(
        contiguousAt(tokens("冷热 分离"), tokens(ngramPhrase("冷热 分离")!)),
        0,
    );
});

test("two-character CJK and word-internal ASCII both resolve to a phrase", () => {
    assert.equal(ngramPhrase("变压"), "变压");
    assert.equal(ngramPhrase("config"), "con onf nfi fig");
    assert.equal(
        contiguousAt(tokens("loadConfig"), tokens(ngramPhrase("Config")!)),
        4,
    );
});

test("run shorter than its gram size falls back to a scan", () => {
    assert.equal(ngramPhrase("pi"), null); // ascii run of 2
    assert.equal(ngramPhrase("冷"), null); // cjk run of 1
    assert.equal(ngramPhrase("冷热 pi"), null); // one unusable run poisons it
    assert.equal(ngramPhrase("   "), null); // separators only
    assert.equal(ngramPhrase("---"), null);
});

test("astral CJK is one run member, not two surrogates", () => {
    assert.deepEqual(segmentRuns("𠀀𠀁𠀂"), [{ cls: "cjk", text: "𠀀𠀁𠀂" }]);
    assert.equal(ngramTokens("𠀀𠀁𠀂"), "𠀀𠀁 𠀁𠀂");
});

test("column-scoped match expression", () => {
    assert.equal(ftsMatch("变压 压器", "ng_text"), 'ng_text : "变压 压器"');
});

// The prefilter contract: when `ngramPhrase` returns a phrase for a query that
// IS a substring of the source, the source's token stream must contain that
// phrase contiguously. A miss here is a silent false negative in production.
const CORPUS = [
    "冷热分离方案",
    "冷热 分离",
    "BDV 变压器 loadConfig",
    "loadConfig 在 src/pickerConfig.ts 里",
    "pi 的 search_sessions 工具",
    "select count(*) from entries_fts where rowid = 42",
    "Transformer-220kV/110kV 保护定值",
    "缓存命中率 cache hit rate 95%",
    "a",
    "ab1cd",
    "com.公司.产品.v2",
];

test("soundness: every expressible substring query hits its source tokens", () => {
    let checked = 0;
    for (const source of CORPUS) {
        const haystack = tokens(source);
        const chars = Array.from(source);
        for (let start = 0; start < chars.length; start++) {
            for (let len = 1; len <= 8 && start + len <= chars.length; len++) {
                const query = chars.slice(start, start + len).join("");
                const phrase = ngramPhrase(query);
                if (phrase === null) continue;
                checked++;
                assert.notEqual(
                    contiguousAt(haystack, tokens(phrase)),
                    -1,
                    `query ${JSON.stringify(query)} missed in ${JSON.stringify(source)}`,
                );
            }
        }
    }
    assert.ok(checked > 200, `expected a broad sweep, checked ${checked}`);
});
