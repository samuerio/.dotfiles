/**
 * schedule/cron.ts — 5-field cron parsing + next-fire computation.
 *
 * pi-free by design: node built-ins only. `cli.ts` runs under plain `node`
 * (crontab, or a bare shell), which cannot resolve `@earendil-works/*` bare
 * imports — those only resolve through pi's own extension loader.
 *
 * Semantics deliberately mirror the cron core that already lives in
 * `extensions/loop/cron.ts` (see its "Cron core" block and the DST block in
 * `computeNextCronRun`), so the session scheduler and the OS scheduler can
 * never disagree about when a task fires:
 *
 * - 5 fields, local time: minute hour day-of-month month day-of-week
 * - grammar: `*`, `n`, `a-b`, `*<slash>n`, `a-b/n`, comma lists
 * - macros: @yearly @annually @monthly @weekly @daily @midnight @hourly
 * - day-of-month and day-of-week both constrained → OR (Vixie semantics)
 * - DST: a slot inside the spring-forward gap is skipped, a slot in the
 *   fall-back overlap fires once
 * - next-fire search is bounded at 366 days (sparse crons must not hang)
 *
 * Documented divergences from `loop/cron.ts`:
 * - `nextCron` throws instead of returning null (no nullable return in the
 *   callers: tick treats "no match" as a config error, `list` as "—").
 *   A `CronParseError` carries the offending `field` name for `add`.
 */

export interface CronFields {
    minute: number[];
    hour: number[];
    dayOfMonth: number[];
    month: number[];
    dayOfWeek: number[];
}

export type CronFieldName = "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

export class CronParseError extends Error {
    field: CronFieldName | undefined;

    constructor(message: string, field?: CronFieldName) {
        super(message);
        this.name = "CronParseError";
        this.field = field;
    }
}

const FIELD_NAMES: readonly CronFieldName[] = [
    "minute",
    "hour",
    "dayOfMonth",
    "month",
    "dayOfWeek",
];

const FIELD_RANGES = [
    { min: 0, max: 59 }, // minute
    { min: 0, max: 23 }, // hour
    { min: 1, max: 31 }, // dayOfMonth
    { min: 1, max: 12 }, // month
    { min: 0, max: 6 }, // dayOfWeek (0=Sunday; 7 accepted as Sunday alias)
] as const;

/** Macro → the 5-field expression it stands for (Vixie / systemd set). */
const CRON_MACROS: Readonly<Record<string, string>> = {
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *",
};

/** Expand a macro, or return the trimmed 5-field expression unchanged. */
function normalizeExpression(expr: string): string {
    const trimmed = expr.trim();
    return CRON_MACROS[trimmed.toLowerCase()] ?? trimmed;
}

type ExpandResult = { values: number[] } | { error: string };

/**
 * Parse one cron field. Same grammar and same rejections as
 * `loop/cron.ts#expandField` (a step larger than the field span is an error
 * rather than silently collapsing to the field minimum).
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
                return { error: `step ${step} exceeds the range span (${lo}-${hi})` };
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

        return { error: "unsupported syntax (no L/W/?/names)" };
    }

    if (out.size === 0) return { error: "field matches no values" };
    return { values: Array.from(out).sort((a, b) => a - b) };
}

/** Parse a 5-field expression (or macro). Throws `CronParseError`. */
export function parseCron(expr: string): CronFields {
    const expandedExpr = normalizeExpression(expr);
    const parts = expandedExpr.length === 0 ? [] : expandedExpr.split(/\s+/);
    if (parts.length !== 5) {
        throw new CronParseError(
            `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
        );
    }

    const expanded: number[][] = [];
    for (let i = 0; i < 5; i += 1) {
        const result = expandField(parts[i], i);
        if ("error" in result) {
            throw new CronParseError(
                `field ${i + 1} '${parts[i]}': ${result.error}`,
                FIELD_NAMES[i],
            );
        }
        expanded.push(result.values);
    }

    return {
        minute: expanded[0],
        hour: expanded[1],
        dayOfMonth: expanded[2],
        month: expanded[3],
        dayOfWeek: expanded[4],
    };
}

/** Non-throwing form of `parseCron`. */
export function isValidCron(expr: string): boolean {
    try {
        parseCron(expr);
        return true;
    } catch {
        return false;
    }
}

/**
 * Next local-time match strictly after `after`, minute-by-minute, bounded at
 * 366 days of wall clock. DoM/DoW constrained simultaneously → OR.
 *
 * DST (same behavior as `loop/cron.ts#computeNextCronRun`, which this is a
 * port of): fixed-hour crons targeting a spring-forward gap skip the
 * transition day, wildcard-hour crons fire at the first valid minute after
 * the gap, fall-back repeats fire once.
 */
function computeNextCronRun(fields: CronFields, after: Date): Date | null {
    const minuteSet = new Set(fields.minute);
    const hourSet = new Set(fields.hour);
    const domSet = new Set(fields.dayOfMonth);
    const monthSet = new Set(fields.month);
    const dowSet = new Set(fields.dayOfWeek);

    const domWild = fields.dayOfMonth.length === 31;
    const dowWild = fields.dayOfWeek.length === 7;

    const t = new Date(after.getTime());
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() + 1);

    // Hard wall-clock cap: month/day skips consume few iterations, so a
    // sparse DoM/DoW (leap-day) cron must be bounded by TIME, not by loop
    // count.
    const deadline = after.getTime() + 366 * 24 * 60 * 60 * 1000;
    const maxIter = 366 * 24 * 60;
    for (let i = 0; i < maxIter; i += 1) {
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

/**
 * Next fire time strictly after `after`. `after` itself is never returned —
 * a tick that re-evaluated the same instant would otherwise fire forever.
 *
 * Throws `CronParseError` on an invalid expression or when no match exists
 * within 366 days (e.g. `0 0 30 2 *`).
 */
export function nextCron(expr: string | CronFields, after: Date): Date {
    if (Number.isNaN(after.getTime())) {
        throw new CronParseError("invalid 'after' date");
    }
    const fields = typeof expr === "string" ? parseCron(expr) : expr;
    const next = computeNextCronRun(fields, after);
    if (next === null) {
        throw new CronParseError("no matching fire time within 366 days");
    }
    return next;
}

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
    // January 1 — no DST gap anywhere; a "today"-based Date would roll
    // 2am→3am on the one spring-forward day per year.
    const d = new Date(2000, 0, 1, hour, minute);
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * Human-readable schedule for common shapes; anything else falls back to the
 * raw input (`@monthly` stays `@monthly`). Wording matches
 * `loop/cron.ts#cronToHuman` so `schedule list` and `loop_list` read the same.
 */
export function cronToHuman(expr: string): string {
    const raw = expr.trim();
    const expandedExpr = normalizeExpression(raw);
    const parts = expandedExpr.length === 0 ? [] : expandedExpr.split(/\s+/);
    if (parts.length !== 5) return raw;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
        string,
        string,
        string,
        string,
        string,
    ];

    // Intentional divergence from loop/cron.ts: a bare `* * * * *` reads as
    // "Every minute" instead of being echoed back verbatim (loop/cron.ts only
    // recognizes the `*/1` spelling).
    if (parts.every((part) => part === "*")) return "Every minute";

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

    if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return raw;
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
    return raw;
}
