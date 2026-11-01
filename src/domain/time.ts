import { DateTime, IANAZone } from "luxon";
import type { DateRange, Item } from "./types.js";

export const DEFAULT_ZONE = "Europe/Moscow";

export function safeZone(zone: string | undefined | null): string {
  return zone && IANAZone.isValidZone(zone) ? zone : DEFAULT_ZONE;
}

export function toUtcIso(dt: DateTime): string {
  return dt.toUTC().toISO({ suppressMilliseconds: true })!;
}

export function fromIso(iso: string, zone: string): DateTime {
  return DateTime.fromISO(iso, { zone: "utc" }).setZone(zone);
}

/** Item start in the viewer's zone. All-day items keep their calendar date in any zone. */
export function itemStart(item: Item, zone: string): DateTime | null {
  if (!item.startAt) return null;
  if (item.allDay) {
    const local = fromIso(item.startAt, item.timezone);
    return DateTime.fromObject({ year: local.year, month: local.month, day: local.day }, { zone });
  }
  return fromIso(item.startAt, zone);
}

export function itemEnd(item: Item, zone: string): DateTime | null {
  return item.endAt ? fromIso(item.endAt, zone) : null;
}

export function dayRange(day: DateTime): DateRange {
  const from = day.startOf("day");
  return { from, to: from.plus({ days: 1 }) };
}

/** Monday-based week containing `day`. */
export function weekRange(day: DateTime): DateRange {
  const from = day.startOf("day").minus({ days: day.weekday - 1 });
  return { from, to: from.plus({ days: 7 }) };
}

export function monthRange(day: DateTime): DateRange {
  const from = day.startOf("month");
  return { from, to: from.plus({ months: 1 }) };
}

export function inRange(dt: DateTime, range: DateRange): boolean {
  return dt >= range.from && dt < range.to;
}

/** Parses "YYYY-MM-DD" (+ optional "HH:MM") in the given zone; null on bad input. */
export function parseLocal(date: string, time: string | null | undefined, zone: string): DateTime | null {
  const d = DateTime.fromISO(date, { zone });
  if (!d.isValid) return null;
  if (!time) return d.startOf("day");
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return d.set({ hour, minute, second: 0, millisecond: 0 });
}
