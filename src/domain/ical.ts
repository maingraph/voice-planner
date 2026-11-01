import { DateTime } from "luxon";
import { DEFAULT_MEETING_MIN } from "./planner-service.js";
import { fromIso } from "./time.js";
import type { Item, Recurrence } from "./types.js";

const WD = ["", "MO", "TU", "WE", "TH", "FR", "SA", "SU"];

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function utc(dt: DateTime): string {
  return dt.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
}

function rrule(r: Recurrence): string {
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.byWeekday?.length) parts.push(`BYDAY=${r.byWeekday.map((d) => WD[d]).join(",")}`);
  if (r.until) parts.push(`UNTIL=${r.until.replace(/-/g, "")}T235959Z`);
  return `RRULE:${parts.join(";")}`;
}

/** RFC 5545 feed of a user's dated items — subscribable from Google/Apple/Outlook calendars. */
export function toICalendar(items: Item[]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//voice-planner//RU", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Голосовой ежедневник"];
  for (const item of items) {
    if (!item.startAt) continue;
    const start = fromIso(item.startAt, item.timezone);
    const prefix = item.type === "task" ? "✓ " : item.type === "reminder" ? "⏰ " : "";
    lines.push("BEGIN:VEVENT", `UID:${item.id}@voice-planner`, `DTSTAMP:${utc(DateTime.fromISO(item.updatedAt))}`);
    if (item.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${start.toFormat("yyyyMMdd")}`, `DTEND;VALUE=DATE:${start.plus({ days: 1 }).toFormat("yyyyMMdd")}`);
    } else {
      const end = item.endAt ? fromIso(item.endAt, item.timezone) : start.plus({ minutes: item.type === "meeting" ? DEFAULT_MEETING_MIN : 15 });
      lines.push(`DTSTART:${utc(start)}`, `DTEND:${utc(end)}`);
    }
    lines.push(`SUMMARY:${esc(prefix + item.title)}`);
    if (item.notes) lines.push(`DESCRIPTION:${esc(item.notes)}`);
    if (item.recurrence) lines.push(rrule(item.recurrence));
    if (item.status === "done") lines.push("STATUS:CANCELLED");
    if (item.type === "reminder") lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(item.title)}`, "TRIGGER:PT0M", "END:VALARM");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
