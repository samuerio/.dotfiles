/**
 * schedule/slots.ts — the slot verdict shared by the tick (write side) and
 * `list` (read side).
 *
 * Both sides must answer "is a scheduled slot owed?" with the same window
 * semantics, so this module is the single source of truth:
 *
 *   pending  the next slot is still in the future
 *   due      at least one slot inside the catch-up window can still run
 *   missed   slots are owed, but all of them left the catch-up window
 *
 * pi-free on purpose (node built-ins + ./cron.ts only): `cli.ts` runs under a
 * bare `node` from crontab.
 */
import { nextCron } from "./cron.ts";

/** A slot older than this is accounted for as missed instead of dispatched. */
export const CATCHUP_MS = 10 * 60 * 1000;

export type SlotVerdict =
    | { kind: "pending" }
    | { kind: "due"; at: Date }
    | { kind: "missed"; first: Date };

/**
 * Verdict for `cron` relative to the accounting anchor `anchor` at `now`.
 *
 * `anchor` is "the highest instant already accounted for" (the watermark, or
 * the task's creation time); `first` is the first slot after it.
 */
export function slotVerdict(cron: string, anchor: Date, now: Date): SlotVerdict {
    const nowMs = now.getTime();
    const first = nextCron(cron, anchor);
    if (first.getTime() > nowMs) return { kind: "pending" };

    // `first` alone is not enough: the anchor may be far behind while a slot
    // inside the window is still runnable. Example: an every-5-minutes task
    // (`*` slash `5`) with anchor 12:00, now 12:40 and a 10-minute window —
    // `first` (12:05) is long gone, but `nextCron(12:30)` (12:35) is inside the
    // window, so the verdict is `due` and the whole backlog is coalesced into
    // that one dispatch. Resuming from the newer of anchor/cutoff is what finds
    // it; `nextCron` is strictly after its argument, so a slot exactly on the
    // cutoff is already missed.
    const cutoff = new Date(nowMs - CATCHUP_MS);
    const resumeFrom = anchor.getTime() > cutoff.getTime() ? anchor : cutoff;
    const window = nextCron(cron, resumeFrom);
    if (window.getTime() <= nowMs) return { kind: "due", at: window };

    return { kind: "missed", first };
}
