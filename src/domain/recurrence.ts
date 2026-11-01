import { DateTime } from "luxon";
import type { DateRange, Recurrence } from "./types.js";

const MAX_OCCURRENCES = 366;

function untilBound(rule: Recurrence, zone: string): DateTime | null {
  if (!rule.until) return null;
  const d = DateTime.fromISO(rule.until, { zone });
  return d.isValid ? d.endOf("day") : null;
}

/**
 * Yields occurrence starts of a recurring item, beginning at `first`
 * (the stored start), that fall inside `range`.
 */
export function expandOccurrences(first: DateTime, rule: Recurrence, range: DateRange): DateTime[] {
  const out: DateTime[] = [];
  const until = untilBound(rule, first.zoneName ?? "utc");
  const interval = Math.max(1, Math.floor(rule.interval || 1));
  const accept = (dt: DateTime) => {
    if (dt < first) return true; // keep iterating
    if (until && dt > until) return false;
    if (dt >= range.to) return false;
    if (dt >= range.from) out.push(dt);
    return out.length < MAX_OCCURRENCES;
  };

  if (rule.freq === "weekly") {
    const days = (rule.byWeekday?.length ? rule.byWeekday : [first.weekday]).slice().sort();
    // Jump close to the range start to avoid iterating years of history.
    let weekStart = first.startOf("day").minus({ days: first.weekday - 1 });
    const weeksToSkip = Math.max(0, Math.floor(range.from.diff(weekStart, "weeks").weeks / interval) - 1);
    weekStart = weekStart.plus({ weeks: weeksToSkip * interval });
    for (let guard = 0; guard < 1000; guard++) {
      for (const wd of days) {
        const dt = weekStart.plus({ days: wd - 1 }).set({ hour: first.hour, minute: first.minute });
        if (!accept(dt)) return out;
      }
      weekStart = weekStart.plus({ weeks: interval });
    }
    return out;
  }

  const unit = rule.freq === "daily" ? "days" : rule.freq === "monthly" ? "months" : "years";
  let step = 0;
  const span = range.from.diff(first, unit).get(unit);
  if (span > interval) step = Math.floor(span / interval) - 1;
  for (let guard = 0; guard < 5000; guard++, step++) {
    const dt = first.plus({ [unit]: step * interval });
    // Months like "31st" clamp to the end of shorter months in luxon; acceptable for a prototype.
    if (!accept(dt)) return out;
  }
  return out;
}

/** First occurrence strictly after `after`. */
export function nextOccurrence(first: DateTime, rule: Recurrence, after: DateTime): DateTime | null {
  const horizon = { from: after.plus({ milliseconds: 1 }), to: after.plus({ years: 2 }) };
  return expandOccurrences(first, rule, horizon)[0] ?? null;
}

const WEEKDAY_SHORT = ["", "пн", "вт", "ср", "чт", "пт", "сб", "вс"];

export function describeRecurrence(rule: Recurrence): string {
  const n = rule.interval > 1 ? rule.interval : 0;
  switch (rule.freq) {
    case "daily":
      return n ? `каждые ${n} дн.` : "каждый день";
    case "weekly": {
      const days = rule.byWeekday ?? [];
      if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return "по будням";
      if (days.length === 2 && days.includes(6) && days.includes(7)) return "по выходным";
      const list = days.length ? ` (${days.map((d) => WEEKDAY_SHORT[d]).join(", ")})` : "";
      return (n ? `каждые ${n} нед.` : "каждую неделю") + list;
    }
    case "monthly":
      return n ? `каждые ${n} мес.` : "каждый месяц";
    case "yearly":
      return "каждый год";
  }
}
