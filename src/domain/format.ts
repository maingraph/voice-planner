import type { DateTime } from "luxon";
import { describeRecurrence } from "./recurrence.js";
import { TYPE_LABELS, type Occurrence } from "./types.js";

const MONTHS_GEN = [
  "", "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];
/** Weekday in accusative ("в пятницу"), index = ISO weekday. */
const WEEKDAYS_ACC = ["", "понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье"];
const WEEKDAYS_GEN = ["", "понедельника", "вторника", "среды", "четверга", "пятницы", "субботы", "воскресенья"];
const WEEKDAYS_NOM = ["", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];

export function plural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}

export function hhmm(dt: DateTime): string {
  return dt.toFormat("HH:mm");
}

export function dateWords(dt: DateTime, now: DateTime): string {
  const base = `${dt.day} ${MONTHS_GEN[dt.month]}`;
  return dt.year === now.year ? base : `${base} ${dt.year}`;
}

export function weekdayName(dt: DateTime): string {
  return WEEKDAYS_NOM[dt.weekday];
}

/**
 * Human phrase for a day relative to now, suitable after a preposition-less slot:
 * "сегодня", "завтра", "в пятницу, 7 ноября", "28 октября".
 */
export function dayPhrase(dt: DateTime, now: DateTime): string {
  const diff = Math.round(dt.startOf("day").diff(now.startOf("day"), "days").days);
  if (diff === 0) return "сегодня";
  if (diff === 1) return "завтра";
  if (diff === 2) return "послезавтра";
  if (diff === -1) return "вчера";
  if (diff === -2) return "позавчера";
  if (diff > 0 && diff < 7) {
    const prep = dt.weekday === 2 ? "во" : "в";
    return `${prep} ${WEEKDAYS_ACC[dt.weekday]}, ${dateWords(dt, now)}`;
  }
  return dateWords(dt, now);
}

/** Due-date phrase: "до конца дня", "до завтра", "до пятницы, 6 ноября". */
export function deadlinePhrase(dt: DateTime, now: DateTime): string {
  const diff = Math.round(dt.startOf("day").diff(now.startOf("day"), "days").days);
  if (diff === 0) return "до конца дня";
  if (diff === 1) return "до завтра";
  if (diff > 1 && diff < 7) return `до ${WEEKDAYS_GEN[dt.weekday]}, ${dateWords(dt, now)}`;
  return `до ${dateWords(dt, now)}`;
}

/** "завтра в 10:00", "в пятницу, 7 ноября", "сегодня с 15:00 до 16:00". */
export function whenPhrase(start: DateTime | null, end: DateTime | null, allDay: boolean, now: DateTime): string {
  if (!start) return "без срока";
  const day = dayPhrase(start, now);
  if (allDay) return day;
  if (end && end > start && end.hasSame(start, "day")) return `${day} с ${hhmm(start)} до ${hhmm(end)}`;
  return `${day} в ${hhmm(start)}`;
}

export function describeOccurrence(occ: Occurrence, now: DateTime): string {
  const { item } = occ;
  const when = whenPhrase(occ.start, occ.end, item.allDay, now);
  const repeat = item.recurrence ? `, ${describeRecurrence(item.recurrence)}` : "";
  const done = item.status === "done" ? " (выполнено)" : "";
  return `${TYPE_LABELS[item.type].one} «${item.title}» — ${when}${repeat}${done}`;
}

/** Compact line for lists inside a single day: "в 15:00 — встреча «…»". */
export function describeInDay(occ: Occurrence): string {
  const { item } = occ;
  const label = TYPE_LABELS[item.type].one;
  const done = item.status === "done" ? " (выполнено)" : "";
  if (!occ.start || item.allDay) return `${label} «${item.title}»${done}`;
  const time = occ.end && occ.end > occ.start ? `с ${hhmm(occ.start)} до ${hhmm(occ.end)}` : `в ${hhmm(occ.start)}`;
  return `${time} — ${label} «${item.title}»${done}`;
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Serializable view of an occurrence for the UI and for LLM tool results. */
export function occurrenceView(occ: Occurrence, now: DateTime) {
  const { item } = occ;
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    notes: item.notes,
    status: item.status,
    allDay: item.allDay,
    start: occ.start ? (item.allDay ? occ.start.toISODate() : occ.start.toISO({ suppressMilliseconds: true, includeOffset: false })) : null,
    end: occ.end ? occ.end.toISO({ suppressMilliseconds: true, includeOffset: false }) : null,
    when: whenPhrase(occ.start, occ.end, item.allDay, now),
    recurrence: item.recurrence ? describeRecurrence(item.recurrence) : null,
    createdAt: item.createdAt,
  };
}
export type OccurrenceView = ReturnType<typeof occurrenceView>;
