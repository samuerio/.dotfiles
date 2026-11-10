// cron.ts tests: parsing, next-fire computation, DST behavior, and semantic
// parity with the cron core already living in `extensions/loop/cron.ts`.
//
// TZ is pinned to a DST-observing zone before any Date is constructed so the
// spring-forward / fall-back cases are deterministic. `process.env.TZ` is the
// only knob node honors here (V8 resets its timezone cache on assignment).
process.env.TZ = "America/New_York";

import assert from "node:assert/strict";
import test from "node:test";

import { CronParseError, cronToHuman, isValidCron, nextCron, parseCron } from "../cron.ts";
import {
    computeNextCronRun,
    cronToHuman as loopCronToHuman,
    parseCronDetailed,
} from "../../loop/cron.ts";

/** True when the TZ assignment above actually took effect. */
const TZ_EFFECTIVE = new Date("2026-07-01T12:00:00Z").getHours() === 8;

function loopNext(expr: string, after: Date): Date | null {
    const parsed = parseCronDetailed(expr);
    if (!("fields" in parsed)) return null;
    return computeNextCronRun(parsed.fields, after);
}

function expectFieldError(expr: string, field?: string): void {
    assert.throws(
        () => parseCron(expr),
        (error: unknown) => {
            assert.ok(error instanceof CronParseError, `expected CronParseError, got ${String(error)}`);
            assert.equal(error.field, field);
            return true;
        },
    );
}

// ─── parsing ──────────────────────────────────────────────────────

test("parseCron expands every field", () => {
    const fields = parseCron("* * * * *");
    assert.equal(fields.minute.length, 60);
    assert.equal(fields.hour.length, 24);
    assert.equal(fields.dayOfMonth.length, 31);
    assert.equal(fields.month.length, 12);
    assert.equal(fields.dayOfWeek.length, 7);
    assert.deepEqual(fields.minute.slice(0, 3), [0, 1, 2]);
    assert.deepEqual(fields.month.slice(0, 2), [1, 2]);
    assert.deepEqual(fields.dayOfMonth.slice(-1), [31]);
});

test("parseCron handles numbers, lists, ranges and steps", () => {
    assert.deepEqual(parseCron("7 9 * * *").minute, [7]);
    assert.deepEqual(parseCron("7 9 * * *").hour, [9]);
    assert.deepEqual(parseCron("15,45 8-10 * * *").minute, [15, 45]);
    assert.deepEqual(parseCron("15,45 8-10 * * *").hour, [8, 9, 10]);
    assert.deepEqual(parseCron("*/15 * * * *").minute, [0, 15, 30, 45]);
    assert.deepEqual(parseCron("0 0-23/6 * * *").hour, [0, 6, 12, 18]);
    assert.deepEqual(parseCron("0 0 * * 1-5").dayOfWeek, [1, 2, 3, 4, 5]);
    assert.deepEqual(parseCron("0 0 1 */3 *").month, [1, 4, 7, 10]);
});

test("parseCron treats 7 as a Sunday alias for day-of-week", () => {
    assert.deepEqual(parseCron("0 0 * * 7").dayOfWeek, [0]);
    assert.deepEqual(parseCron("0 0 * * 5-7").dayOfWeek, [0, 5, 6]);
    assert.deepEqual(parseCron("0 0 * * 0,7").dayOfWeek, [0]);
});

test("parseCron expands cron macros, case-insensitively", () => {
    assert.deepEqual(parseCron("@hourly"), parseCron("0 * * * *"));
    assert.deepEqual(parseCron("@daily"), parseCron("0 0 * * *"));
    assert.deepEqual(parseCron("@midnight"), parseCron("0 0 * * *"));
    assert.deepEqual(parseCron("@weekly"), parseCron("0 0 * * 0"));
    assert.deepEqual(parseCron("@monthly"), parseCron("0 0 1 * *"));
    assert.deepEqual(parseCron("@yearly"), parseCron("0 0 1 1 *"));
    assert.deepEqual(parseCron("@annually"), parseCron("0 0 1 1 *"));
    assert.deepEqual(parseCron("@DAILY"), parseCron("0 0 * * *"));
});

test("parseCron rejects malformed expressions with the offending field", () => {
    expectFieldError("");
    expectFieldError("* * * *");
    expectFieldError("* * * * * *");
    expectFieldError("60 * * * *", "minute");
    expectFieldError("0 24 * * *", "hour");
    expectFieldError("0 0 0 * *", "dayOfMonth");
    expectFieldError("0 0 32 * *", "dayOfMonth");
    expectFieldError("0 0 * 0 *", "month");
    expectFieldError("0 0 * 13 *", "month");
    expectFieldError("0 0 * * 8", "dayOfWeek");
    expectFieldError("*/90 * * * *", "minute");
    expectFieldError("5-3 * * * *", "minute");
    expectFieldError("0 0 1W * *", "dayOfMonth");
    expectFieldError("0 0 ? * *", "dayOfMonth");
    expectFieldError("0 0 * JAN *", "month");
    expectFieldError("@fortnightly");
});

test("isValidCron mirrors parseCron", () => {
    assert.equal(isValidCron("*/5 * * * *"), true);
    assert.equal(isValidCron("@daily"), true);
    assert.equal(isValidCron("61 * * * *"), false);
    assert.equal(isValidCron("nonsense"), false);
    assert.equal(isValidCron(""), false);
});

// ─── nextCron ─────────────────────────────────────────────────────

test("nextCron is strictly after `after` and truncates seconds", () => {
    const onBoundary = new Date(2026, 10, 6, 9, 0, 0, 0);
    const fromBoundary = nextCron("*/5 * * * *", onBoundary);
    assert.equal(fromBoundary.getTime(), new Date(2026, 10, 6, 9, 5, 0).getTime());

    const insideMinute = nextCron("*/5 * * * *", new Date(2026, 10, 6, 9, 3, 42));
    assert.equal(insideMinute.getTime(), new Date(2026, 10, 6, 9, 5, 0).getTime());

    const everyMinute = nextCron("* * * * *", onBoundary);
    assert.equal(everyMinute.getTime(), new Date(2026, 10, 6, 9, 1, 0).getTime());
});

test("nextCron accepts pre-parsed fields", () => {
    const fields = parseCron("7 9 * * 1-5");
    const next = nextCron(fields, new Date(2026, 10, 6, 0, 0));
    assert.deepEqual(next, nextCron("7 9 * * 1-5", new Date(2026, 10, 6, 0, 0)));
    assert.equal(next.getHours(), 9);
    assert.equal(next.getMinutes(), 7);
});

test("nextCron crosses months and years", () => {
    const monthEnd = nextCron("0 0 1 * *", new Date(2026, 10, 15, 12, 0));
    assert.equal(monthEnd.getTime(), new Date(2026, 11, 1, 0, 0).getTime());

    const yearEnd = nextCron("0 0 1 1 *", new Date(2026, 5, 1, 0, 0));
    assert.equal(yearEnd.getTime(), new Date(2027, 0, 1, 0, 0).getTime());

    const newYearMidnight = nextCron("59 23 31 12 *", new Date(2026, 0, 1, 0, 0));
    assert.equal(newYearMidnight.getTime(), new Date(2026, 11, 31, 23, 59).getTime());
});

test("nextCron finds leap days but gives up beyond 366 days", () => {
    const leap = nextCron("0 0 29 2 *", new Date(2028, 0, 1, 0, 0));
    assert.equal(leap.getMonth(), 1);
    assert.equal(leap.getDate(), 29);
    assert.equal(leap.getFullYear(), 2028);

    // Next Feb 29 (2032) is more than 366 days out → bounded search fails.
    assert.throws(
        () => nextCron("0 0 29 2 *", new Date(2028, 2, 1, 0, 0)),
        (error: unknown) => error instanceof CronParseError && /366 days/.test(error.message),
    );
    assert.throws(
        () => nextCron("0 0 30 2 *", new Date(2026, 0, 1)),
        () => true,
    );
});

test("nextCron rejects an invalid `after` date and invalid expressions", () => {
    assert.throws(() => nextCron("* * * * *", new Date(Number.NaN)), CronParseError);
    assert.throws(() => nextCron("61 * * * *", new Date()), CronParseError);
});

test("day-of-month and day-of-week constrained together use OR semantics", () => {
    const expr = "0 0 13 * 5";
    // 2026-11-06 is a Friday.
    assert.equal(new Date(2026, 10, 6).getDay(), 5);

    const next = nextCron(expr, new Date(2026, 10, 6, 12, 0));
    const matchedByDom = next.getDate() === 13;
    const matchedByDow = next.getDay() === 5;
    assert.ok(matchedByDom || matchedByDow, `unexpected match ${next.toString()}`);
    // The very next midnight-qualifying day must be the OR of both sets:
    // encountering day 13 first (Friday the 13th) is the strongest signal.
    assert.equal(matchedByDom && matchedByDow, true);

    // Pure day-of-month (dow wildcard) must ignore the weekday.
    const domOnly = nextCron("0 0 13 * *", new Date(2026, 10, 6, 12, 0));
    assert.equal(domOnly.getDate(), 13);

    // Pure day-of-week (dom wildcard) must ignore the date.
    const dowOnly = nextCron("0 0 * * 1", new Date(2026, 10, 6, 12, 0));
    assert.equal(dowOnly.getDay(), 1);
    assert.equal(dowOnly.getDate(), 9);
});

// ─── DST ──────────────────────────────────────────────────────────

/** Day-of-month whose local 02:30 does not exist (spring-forward gap). */
function springGapDay(year: number): number | null {
    for (let day = 1; day <= 31; day += 1) {
        const probe = new Date(year, 2, day, 2, 30);
        if (probe.getMonth() === 2 && probe.getDate() === day && probe.getHours() !== 2) {
            return day;
        }
    }
    return null;
}

/** Day-of-month whose 01:30 and 02:30 have different UTC offsets (fall-back). */
function fallBackDay(year: number): number | null {
    for (let day = 1; day <= 31; day += 1) {
        const first = new Date(year, 10, day, 1, 30);
        const later = new Date(year, 10, day, 2, 30);
        if (first.getMonth() === 10 && first.getTimezoneOffset() !== later.getTimezoneOffset()) {
            return day;
        }
    }
    return null;
}

test(
    "DST spring-forward: a slot inside the gap is skipped, not shifted",
    { skip: !TZ_EFFECTIVE },
    () => {
        const gapDay = springGapDay(2026);
        assert.ok(gapDay !== null, "2026 should have a spring-forward gap");

        const from = new Date(2026, 2, gapDay, 0, 0, 0, 0);
        const next = nextCron("30 2 * * *", from);
        assert.equal(next.getDate(), gapDay + 1);
        assert.equal(next.getMonth(), 2);
        assert.equal(next.getHours(), 2);
        assert.equal(next.getMinutes(), 30);
        assert.deepEqual(next, loopNext("30 2 * * *", from));
    },
);

test(
    "DST fall-back: the repeated hour fires once",
    { skip: !TZ_EFFECTIVE },
    () => {
        const backDay = fallBackDay(2026);
        assert.ok(backDay !== null, "2026 should have a fall-back overlap");

        const from = new Date(2026, 10, backDay, 0, 0, 0, 0);
        const first = nextCron("30 1 * * *", from);
        assert.equal(first.getDate(), backDay);
        assert.equal(first.getHours(), 1);
        assert.equal(first.getMinutes(), 30);
        // First occurrence is still on DST (EDT, UTC-4).
        assert.equal(first.getTimezoneOffset(), 240);

        const second = nextCron("30 1 * * *", first);
        assert.equal(second.getDate(), backDay + 1);
        assert.equal(second.getHours(), 1);
        assert.equal(second.getMinutes(), 30);

        assert.deepEqual(first, loopNext("30 1 * * *", from));
        assert.deepEqual(second, loopNext("30 1 * * *", first));
    },
);

// ─── parity with loop/cron.ts ──────────────────────────────────────────

test("nextCron matches loop/cron.ts on a broad expression/instant matrix", () => {
    const expressions = [
        "* * * * *",
        "*/5 * * * *",
        "*/7 * * * *",
        "0 * * * *",
        "* 3 * * *",
        "30 2 * * *",
        "0 0 * * 0",
        "0 0 * * 7",
        "0 0 13 * 5",
        "15,45 8-10 * * 1-5",
        "0 12 1 */3 *",
        "59 23 31 12 *",
        "0 0 29 2 *",
        "7 9 * * 1-5",
        "0 0 1 * *",
    ];
    const instants = [
        new Date(2026, 0, 1, 0, 0, 0, 0),
        new Date(2026, 0, 1, 0, 0, 30, 0),
        new Date(2026, 2, 8, 0, 0, 0, 0),
        new Date(2026, 2, 8, 2, 59, 0, 0),
        new Date(2026, 10, 1, 0, 0, 0, 0),
        new Date(2026, 10, 1, 1, 45, 0, 0),
        new Date(2026, 10, 6, 12, 34, 56, 0),
        new Date(2026, 11, 31, 23, 58, 0, 0),
        new Date(2028, 0, 15, 6, 0, 0, 0),
        new Date(2028, 2, 1, 0, 0, 0, 0),
    ];

    for (const expr of expressions) {
        for (const after of instants) {
            const expected = loopNext(expr, after);
            if (expected === null) {
                assert.throws(
                    () => nextCron(expr, after),
                    (error: unknown) => error instanceof CronParseError,
                    `${expr} @ ${after.toString()} should have no match`,
                );
                continue;
            }
            const actual = nextCron(expr, after);
            assert.deepEqual(actual, expected, `${expr} @ ${after.toString()}`);
            assert.ok(actual.getTime() > after.getTime(), `${expr} must be strictly after`);
        }
    }
});

test("parseCron agrees with loop/cron.ts on validity", () => {
    const expressions = [
        "* * * * *",
        "*/15 0-6 * * 1-5",
        "7 9 * * 1-5",
        "0 0 29 2 *",
        "60 * * * *",
        "0 24 * * *",
        "*/90 * * * *",
        "5-3 * * * *",
        "0 0 1W * *",
        "* * * *",
    ];
    for (const expr of expressions) {
        const loopValid = "fields" in parseCronDetailed(expr);
        assert.equal(isValidCron(expr), loopValid, expr);
    }
});

// ─── cronToHuman ──────────────────────────────────────────────────

test("cronToHuman renders common shapes", () => {
    assert.equal(cronToHuman("* * * * *"), "Every minute");
    assert.equal(cronToHuman("*/1 * * * *"), "Every minute");
    assert.equal(cronToHuman("*/15 * * * *"), "Every 15 minutes");
    assert.equal(cronToHuman("0 * * * *"), "Every hour");
    assert.equal(cronToHuman("5 * * * *"), "Every hour at :05");
    assert.equal(cronToHuman("30 */2 * * *"), "Every 2 hours at :30");
    assert.ok(cronToHuman("30 9 * * *").startsWith("Every day at 9:30"));
    assert.ok(cronToHuman("0 9 * * 1").startsWith("Every Monday at 9:00"));
    assert.ok(cronToHuman("0 9 * * 0").startsWith("Every Sunday at 9:00"));
    assert.ok(cronToHuman("0 9 * * 1-5").startsWith("Weekdays at 9:00"));
});

test("cronToHuman formats macros and falls back to the raw input", () => {
    assert.ok(cronToHuman("@hourly").startsWith("Every hour"));
    assert.ok(cronToHuman("@daily").startsWith("Every day at 12:00"));
    assert.ok(cronToHuman("@weekly").startsWith("Every Sunday at 12:00"));
    // No human shape for these → the text the user typed is echoed back.
    assert.equal(cronToHuman("@monthly"), "@monthly");
    assert.equal(cronToHuman("@yearly"), "@yearly");
    assert.equal(cronToHuman("0 0 1 * *"), "0 0 1 * *");
    assert.equal(cronToHuman("0 0 13 * 5"), "0 0 13 * 5");
    assert.equal(cronToHuman("not a cron"), "not a cron");
});

test("cronToHuman wording matches loop/cron.ts for non-macro expressions", () => {
    // `* * * * *` is excluded: we render it as "Every minute" while loop/cron.ts
    // echoes the raw string back. That divergence is intentional and asserted
    // in the previous test.
    const expressions = [
        "*/1 * * * *",
        "*/15 * * * *",
        "0 * * * *",
        "5 * * * *",
        "30 */2 * * *",
        "30 9 * * *",
        "0 9 * * 1",
        "0 9 * * 1-5",
        "0 0 1 * *",
        "0 0 13 * 5",
    ];
    for (const expr of expressions) {
        assert.equal(cronToHuman(expr), loopCronToHuman(expr), expr);
    }
});
