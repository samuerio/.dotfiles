// slots.ts: the single slot verdict shared by tick (write side) and list.
//
// Dates are local because cron fields are local; the numbers below are chosen
// so that a wrong "only look at `first`" implementation flips due into missed.
import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { CATCHUP_MS, slotVerdict } from "../slots.ts";

function at(day: number, hour: number, minute: number, second = 0): Date {
    return new Date(2026, 10, day, hour, minute, second);
}

describe("slotVerdict", () => {
    test("a fresh anchor with a reachable slot is due", () => {
        const verdict = slotVerdict("* * * * *", at(6, 8, 0, 30), at(6, 8, 3, 10));
        assert.equal(verdict.kind, "due");
        if (verdict.kind === "due") assert.equal(verdict.at.getTime(), at(6, 8, 1).getTime());
    });

    test("a stale anchor with a slot inside the window is still due", () => {
        // The regression this whole helper exists for: */5, anchor 12:00,
        // now 12:40, cutoff 12:30. first = 12:05 is long gone, but
        // nextCron(12:30) = 12:35 is inside the window.
        const verdict = slotVerdict("*/5 * * * *", at(6, 12, 0), at(6, 12, 40));
        assert.equal(verdict.kind, "due");
        if (verdict.kind === "due") assert.equal(verdict.at.getTime(), at(6, 12, 35).getTime());
    });

    test("a backlog entirely outside the window is missed at its first slot", () => {
        // Hourly task, anchor 11:50, now 12:20, cutoff 12:10: the 12:00 slot is
        // owed, and the next one (13:00) is outside the window.
        const verdict = slotVerdict("0 * * * *", at(6, 11, 50), at(6, 12, 20));
        assert.equal(verdict.kind, "missed");
        if (verdict.kind === "missed") assert.equal(verdict.first.getTime(), at(6, 12, 0).getTime());
    });

    test("a slot exactly on the cutoff is not runnable any more", () => {
        // now 12:10 → cutoff 12:00; the 12:00 slot is the first owed slot and
        // nextCron(12:00) is 13:00, so the verdict is missed with first=12:00.
        const verdict = slotVerdict("0 * * * *", at(6, 11, 50), at(6, 12, 10));
        assert.equal(verdict.kind, "missed");
        if (verdict.kind === "missed") assert.equal(verdict.first.getTime(), at(6, 12, 0).getTime());
    });

    test("a future slot is pending", () => {
        const verdict = slotVerdict("0 * * * *", at(6, 12, 30), at(6, 12, 40));
        assert.equal(verdict.kind, "pending");
    });

    test("uses the shared 10-minute catch-up window", () => {
        assert.equal(CATCHUP_MS, 10 * 60 * 1000);
    });

    test("an unschedulable cron throws instead of guessing", () => {
        assert.throws(() => slotVerdict("0 0 30 2 *", at(6, 12, 0), at(6, 12, 40)), /366 days/);
    });
});
