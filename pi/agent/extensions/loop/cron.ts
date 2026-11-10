/**
 * Cron core for the loop extension: parse, next-fire, human labels,
 * jitter, missed-task detection. Pure functions only — no fs, no
 * module state, no pi runtime handles (see ../index.ts for those).
 */

import type { StoredTask } from "./types.ts";

// ─── Jitter knobs (claude DEFAULT_CRON_JITTER_CONFIG) ─────────────

const JITTER = {
    recurringFrac: 0.1,
    recurringCapMs: 15 * 60 * 1000,
    oneShotMaxMs: 90 * 1000,
    oneShotFloorMs: 0,
    oneShotMinuteMod: 30,
} as const;

// ─── Cron core (ported from claude src/utils/cron.ts) ─────────────

export type CronFields = {
    minute: number[];
    hour: number[];
    dayOfMonth: number[];
    month: number[];
    dayOfWeek: number[];
};

const FIELD_RANGES = [
    { min: 0, max: 59 }, // minute
    { min: 0, max: 23 }, // hour
    { min: 1, max: 31 }, // dayOfMonth
    { min: 1, max: 12 }, // month
    { min: 0, max: 6 }, // dayOfWeek (0=Sunday; 7 accepted as Sunday alias)
] as const;

type ExpandResult = { values: number[] } | { error: string };

/**
 * Parse a single cron field. Supports wildcard, N, star-slash-N, N-M,
 * N-M/S and comma-lists. [v5] A step larger than the field span is
 * rejected (instead of silently collapsing to the field minimum): cron
 * would collapse a star-step of 40 over the day-of-month field to a
 * monthly schedule, and a star-step of 90 over minutes to hourly.
 */
function expandField(field: string, index: number): ExpandResult {
    const { min, max } = FIELD_RANGES[index];
    const out = new Set<number>();

    for (const part of field.split(",")) {
        const stepMatch = /^\*(?:\/(\d+))?$/.exec(part);
        if (stepMatch) {
            const step = stepMatch[1] ? Number.parseInt(stepMatch[1], 10) : 1;
            if (!(step >= 1)) return { error: "step must be >= 1" };
            if (step > max - min + 1) {
                return {
                    error: `step ${step} exceeds the field span (${min}-${max}); smallest usable value is ${min}`,
                };
            }
            for (let i = min; i <= max; i += step) out.add(i);
            continue;
        }

        const rangeMatch = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part);
        if (rangeMatch) {
            const lo = Number.parseInt(rangeMatch[1], 10);
            const hi = Number.parseInt(rangeMatch[2], 10);
            const step = rangeMatch[3] ? Number.parseInt(rangeMatch[3], 10) : 1;
            // dayOfWeek: accept 7 as Sunday alias in ranges (5-7 → [5,6,0]).
            const isDow = min === 0 && max === 6;
            const effMax = isDow ? 7 : max;
            if (lo > hi || step < 1 || lo < min || hi > effMax) {
                return { error: `value out of range (${min}-${max})` };
            }
            if (step > hi - lo + 1) {
                return {
                    error: `step ${step} exceeds the range span (${lo}-${hi})`,
                };
            }
            for (let i = lo; i <= hi; i += step) {
                out.add(isDow && i === 7 ? 0 : i);
            }
            continue;
        }

        if (/^\d+$/.test(part)) {
            let n = Number.parseInt(part, 10);
            if (min === 0 && max === 6 && n === 7) n = 0;
            if (n < min || n > max) {
                return { error: `value out of range (${min}-${max})` };
            }
            out.add(n);
            continue;
        }

        return { error: `unsupported syntax (no L/W/?/names)` };
    }

    if (out.size === 0) return { error: "field matches no values" };
    return { values: Array.from(out).sort((a, b) => a - b) };
}

/**
 * Parse a 5-field cron expression. Returns an error message on invalid or
 * unsupported syntax (including [v5] out-of-span steps), otherwise the
 * expanded fields.
 */
export function parseCronDetailed(
    expr: string,
): { fields: CronFields } | { error: string } {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) {
        return { error: "expected 5 fields: M H DoM Mon DoW" };
    }
    const expanded: number[][] = [];
    for (let i = 0; i < 5; i++) {
        const result = expandField(parts[i], i);
        if ("error" in result) {
            return { error: `field ${i + 1} '${parts[i]}': ${result.error}` };
        }
        expanded.push(result.values);
    }
    return {
        fields: {
            minute: expanded[0],
            hour: expanded[1],
            dayOfMonth: expanded[2],
            month: expanded[3],
            dayOfWeek: expanded[4],
        },
    };
}

export function parseCronExpression(expr: string): CronFields | null {
    const parsed = parseCronDetailed(expr);
    return "fields" in parsed ? parsed.fields : null;
}

/**
 * Next local-time match strictly after `from`, minute-by-minute, bounded
 * at 366 days. DoM/DoW constrained simultaneously → OR semantics.
 *
 * DST: fixed-hour crons targeting a spring-forward gap skip the transition
 * day; wildcard-hour crons fire at the first valid minute after the gap;
 * fall-back repeats fire once. Matches vixie-cron / claude behavior.
 */
export function computeNextCronRun(fields: CronFields, from: Date): Date | null {
    const minuteSet = new Set(fields.minute);
    const hourSet = new Set(fields.hour);
    const domSet = new Set(fields.dayOfMonth);
    const monthSet = new Set(fields.month);
    const dowSet = new Set(fields.dayOfWeek);

    const domWild = fields.dayOfMonth.length === 31;
    const dowWild = fields.dayOfWeek.length === 7;

    const t = new Date(from.getTime());
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() + 1);

    // Hard wall-clock cap: month/day skips consume few iterations, so a
    // sparse DoM/DoW (leap-day) cron must be bounded by TIME, not by loop
    // count. Matches claude's "no match within a year" semantics.
    const deadline = from.getTime() + 366 * 24 * 60 * 60 * 1000;
    const maxIter = 366 * 24 * 60;
    for (let i = 0; i < maxIter; i++) {
        if (t.getTime() > deadline) return null;
        const month = t.getMonth() + 1;
        if (!monthSet.has(month)) {
            t.setMonth(t.getMonth() + 1, 1);
            t.setHours(0, 0, 0, 0);
            continue;
        }

        const dom = t.getDate();
        const dow = t.getDay();
        const dayMatches =
            domWild && dowWild
                ? true
                : domWild
                  ? dowSet.has(dow)
                  : dowWild
                    ? domSet.has(dom)
                    : domSet.has(dom) || dowSet.has(dow);
        if (!dayMatches) {
            t.setDate(t.getDate() + 1);
            t.setHours(0, 0, 0, 0);
            continue;
        }

        if (!hourSet.has(t.getHours())) {
            t.setHours(t.getHours() + 1, 0, 0, 0);
            continue;
        }
        if (!minuteSet.has(t.getMinutes())) {
            t.setMinutes(t.getMinutes() + 1);
            continue;
        }
        return t;
    }
    return null;
}

/** Next fire in epoch ms strictly after fromMs, or null. */
export function nextCronRunMs(cron: string, fromMs: number): number | null {
    const fields = parseCronExpression(cron);
    if (!fields) return null;
    const next = computeNextCronRun(fields, new Date(fromMs));
    return next ? next.getTime() : null;
}

// ─── cronToHuman (claude parity, local time) ──────────────────────

const DAY_NAMES = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

function formatLocalTime(minute: number, hour: number): string {
    // January 1 — no DST gap anywhere; new Date() (today) would roll
    // 2am→3am on the one spring-forward day per year.
    const d = new Date(2000, 0, 1, hour, minute);
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * Human-readable schedule for common shapes; anything else falls back to
 * the raw cron string (loop_list output depends on this fallback).
 */
export function cronToHuman(cron: string): string {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return cron;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
        string,
        string,
        string,
        string,
        string,
    ];

    const everyMinMatch = /^\*\/(\d+)$/.exec(minute);
    if (
        everyMinMatch &&
        hour === "*" &&
        dayOfMonth === "*" &&
        month === "*" &&
        dayOfWeek === "*"
    ) {
        const n = Number.parseInt(everyMinMatch[1], 10);
        return n === 1 ? "Every minute" : `Every ${n} minutes`;
    }

    if (
        /^\d+$/.test(minute) &&
        hour === "*" &&
        dayOfMonth === "*" &&
        month === "*" &&
        dayOfWeek === "*"
    ) {
        const m = Number.parseInt(minute, 10);
        return m === 0 ? "Every hour" : `Every hour at :${m.toString().padStart(2, "0")}`;
    }

    const everyHourMatch = /^\*\/(\d+)$/.exec(hour);
    if (
        /^\d+$/.test(minute) &&
        everyHourMatch &&
        dayOfMonth === "*" &&
        month === "*" &&
        dayOfWeek === "*"
    ) {
        const n = Number.parseInt(everyHourMatch[1], 10);
        const m = Number.parseInt(minute, 10);
        const suffix = m === 0 ? "" : ` at :${m.toString().padStart(2, "0")}`;
        return n === 1 ? `Every hour${suffix}` : `Every ${n} hours${suffix}`;
    }

    if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return cron;
    const m = Number.parseInt(minute, 10);
    const h = Number.parseInt(hour, 10);

    if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
        return `Every day at ${formatLocalTime(m, h)}`;
    }
    if (dayOfMonth === "*" && month === "*" && /^\d$/.test(dayOfWeek)) {
        const dayIndex = Number.parseInt(dayOfWeek, 10) % 7;
        const dayName = DAY_NAMES[dayIndex];
        if (dayName) return `Every ${dayName} at ${formatLocalTime(m, h)}`;
    }
    if (dayOfMonth === "*" && month === "*" && dayOfWeek === "1-5") {
        return `Weekdays at ${formatLocalTime(m, h)}`;
    }
    return cron;
}

// ─── Jitter (ported from claude src/utils/cronTasks.ts) ───────────

/** id is 8-hex (first char a–f); non-hex ids (hand-edited files) → 0. */
function jitterFrac(taskId: string): number {
    const frac = Number.parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000;
    return Number.isFinite(frac) ? frac : 0;
}

/**
 * Recurring: fire at t1 plus a deterministic per-task delay proportional
 * to the gap between fires (10%, cap 15m) — spreads the herd off :00.
 */
export function jitteredNextCronRunMs(
    cron: string,
    fromMs: number,
    taskId: string,
): number | null {
    const t1 = nextCronRunMs(cron, fromMs);
    if (t1 === null) return null;
    const t2 = nextCronRunMs(cron, t1);
    if (t2 === null) return t1;
    const jitter = Math.min(
        jitterFrac(taskId) * JITTER.recurringFrac * (t2 - t1),
        JITTER.recurringCapMs,
    );
    return t1 + jitter;
}

/**
 * One-shot: fire UP TO 90s EARLY when the computed time lands on a
 * :00/:30 local minute (humans round to the half-hour). Anchor is
 * createdAt, and the result is clamped to fromMs so a task created inside
 * its own lead window never fires before it existed.
 */
export function oneShotJitteredNextCronRunMs(
    cron: string,
    fromMs: number,
    taskId: string,
): number | null {
    const t1 = nextCronRunMs(cron, fromMs);
    if (t1 === null) return null;
    if (new Date(t1).getMinutes() % JITTER.oneShotMinuteMod !== 0) return t1;
    const lead =
        JITTER.oneShotFloorMs +
        jitterFrac(taskId) * (JITTER.oneShotMaxMs - JITTER.oneShotFloorMs);
    return Math.max(t1 - lead, fromMs);
}

/** A task is "missed" when its first scheduled run (from createdAt) is past. */
export function findMissedTasks(tasks: StoredTask[], nowMs: number): StoredTask[] {
    return tasks.filter((t) => {
        if (t.recurring) return false;
        const next = nextCronRunMs(t.cron, t.createdAt);
        return next !== null && next < nowMs;
    });
}
