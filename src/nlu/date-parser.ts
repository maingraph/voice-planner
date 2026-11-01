import type { DateTime } from "luxon";
import { dayRange, monthRange, weekRange } from "../domain/time.js";
import type { Recurrence } from "../domain/types.js";
import { NUM, ORD, parseNumber } from "./numbers.js";

/**
 * Deterministic parser for Russian date/time expressions:
 * "завтра в 10 утра", "в пятницу", "через два часа", "на следующей неделе",
 * "15 ноября в 15:30", "с 15 до 16", "по понедельникам", "до конца недели" …
 *
 * It works on a copy of the text in which every consumed fragment is blanked out,
 * so rules never fight over the same words and the remainder becomes the item title.
 */

export interface DateRangeLabeled {
  from: DateTime;
  to: DateTime;
  label: string;
}

export interface DateParse {
  /** Resolved start: date + time, date only (allDay) or exact relative moment. */
  start: DateTime | null;
  end: DateTime | null;
  durationMin: number | null;
  allDay: boolean;
  hasDate: boolean;
  hasTime: boolean;
  /** Period the phrase refers to — used by "что у меня …" queries. */
  range: DateRangeLabeled | null;
  /** "до пятницы", "до конца недели" — start is a due date. */
  deadline: boolean;
  recurrence: Recurrence | null;
  /** Time was earlier than now with no date given, so it moved to tomorrow. */
  rolledToTomorrow: boolean;
  /** Character spans of the input that were recognised as date/time. */
  spans: Array<[number, number]>;
  /** Input with recognised spans removed. */
  rest: string;
}

export interface ParseOptions {
  /** Interpret ambiguous days in the past ("когда была встреча в пятницу"). */
  preferPast?: boolean;
}

const L = "(?<![\\p{L}\\d])";
const R = "(?![\\p{L}\\d])";

const WEEKDAY = "(понедельник\\p{L}*|вторник\\p{L}*|сред[ауые]|сред\\p{L}*ам|четверг\\p{L}*|пятниц\\p{L}*|суббот\\p{L}*|воскресень\\p{L}*)";
const MONTH = "(январ\\p{L}*|феврал\\p{L}*|март\\p{L}*|апрел\\p{L}*|ма[йяюе]|июн\\p{L}*|июл\\p{L}*|август\\p{L}*|сентябр\\p{L}*|октябр\\p{L}*|ноябр\\p{L}*|декабр\\p{L}*)";
const DAYPART_SUFFIX = "(утра|дня|вечера|ночи)";

const MONTH_STEMS = ["янв", "фев", "мар", "апр", "ма", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function weekdayIndex(word: string): number {
  const w = word.toLowerCase();
  if (w.startsWith("понед")) return 1;
  if (w.startsWith("втор")) return 2;
  if (w.startsWith("сред")) return 3;
  if (w.startsWith("четв")) return 4;
  if (w.startsWith("пятн")) return 5;
  if (w.startsWith("субб")) return 6;
  return 7;
}

function monthIndex(word: string): number {
  const w = word.toLowerCase();
  if (w.startsWith("мар")) return 3;
  if (/^ма[йяюе]$/.test(w)) return 5;
  return MONTH_STEMS.findIndex((s) => w.startsWith(s)) + 1;
}

type Daypart = "morning" | "noon" | "afternoon" | "evening" | "night";
const DAYPART_DEFAULT: Record<Daypart, number> = { morning: 9, noon: 13, afternoon: 14, evening: 19, night: 23 };

function applyDaypart(hour: number, part: Daypart | null): number {
  switch (part) {
    case "morning":
      return hour === 12 ? 0 : hour;
    case "noon":
    case "afternoon":
      return hour < 12 && hour !== 0 ? hour + 12 : hour;
    case "evening":
      return hour < 12 ? hour + 12 : hour;
    case "night":
      if (hour === 12) return 0;
      return hour >= 6 && hour < 12 ? hour + 12 : hour;
    default:
      // Without a hint, "в 3" in a planner almost always means 15:00; 8–11 stay morning.
      return hour >= 1 && hour <= 7 ? hour + 12 : hour;
  }
}

function suffixDaypart(word: string | undefined): Daypart | null {
  switch (word) {
    case "утра":
      return "morning";
    case "дня":
      return "afternoon";
    case "вечера":
      return "evening";
    case "ночи":
      return "night";
    default:
      return null;
  }
}

class Scanner {
  readonly spans: Array<[number, number]> = [];
  work: string;
  constructor(readonly original: string) {
    this.work = original.toLowerCase().replace(/ё/g, "е");
  }

  /** Runs a rule; `handler` returns false to reject a match (leaving the text intact). */
  take(source: string, handler: (m: RegExpExecArray) => boolean | void): void {
    const re = new RegExp(source, "giu");
    let m: RegExpExecArray | null;
    const accepted: Array<[number, number]> = [];
    while ((m = re.exec(this.work)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (handler(m) !== false) accepted.push([m.index, m.index + m[0].length]);
    }
    for (const [a, b] of accepted) {
      this.work = this.work.slice(0, a) + " ".repeat(b - a) + this.work.slice(b);
      this.spans.push([a, b]);
    }
  }

  rest(): string {
    let out = "";
    for (let i = 0; i < this.original.length; i++) out += this.work[i] === " " && this.original[i] !== " " ? " " : this.original[i];
    return out.replace(/\s+/g, " ").trim();
  }
}

export function parseDateTime(text: string, now: DateTime, opts: ParseOptions = {}): DateParse {
  const s = new Scanner(text);
  const today = now.startOf("day");

  let date: DateTime | null = null;
  let time: { hour: number; minute: number; explicitPart: boolean } | null = null;
  let endTime: { hour: number; minute: number } | null = null;
  let exact: DateTime | null = null;
  let durationMin: number | null = null;
  let range: DateRangeLabeled | null = null;
  let deadline = false;
  let recurrence: Recurrence | null = null;
  let daypart: Daypart | null = null;

  // ---- recurrence ----
  s.take(`${L}(?:каждый|каждое)\\s+(день|утро|вечер)${R}|${L}ежедневно${R}`, (m) => {
    recurrence = { freq: "daily", interval: 1 };
    if (m[1] === "утро") daypart = "morning";
    if (m[1] === "вечер") daypart = "evening";
  });
  s.take(`${L}(?:по\\s+будн\\p{L}*|в\\s+будни|каждый\\s+будний\\s+день)${R}`, () => {
    recurrence = { freq: "weekly", interval: 1, byWeekday: [1, 2, 3, 4, 5] };
  });
  s.take(`${L}(?:по\\s+выходным|каждые\\s+выходные)${R}`, () => {
    recurrence = { freq: "weekly", interval: 1, byWeekday: [6, 7] };
  });
  s.take(`${L}(?:(?:каждый|каждую|каждое|по)\\s+)${WEEKDAY}(?:(?:\\s*,\\s*|\\s+и\\s+)${WEEKDAY})*${R}`, (m) => {
    const days = [...m[0].matchAll(new RegExp(WEEKDAY, "giu"))].map((x) => weekdayIndex(x[1]));
    // "по пятницу" is not a rule; plural dative ("по пятницам") or "каждый/каждую" is.
    if (m[0].startsWith("по") && !/ам$|ям$/.test(m[0])) return false;
    recurrence = { freq: "weekly", interval: 1, byWeekday: [...new Set(days)].sort() };
  });
  s.take(`${L}(?:каждую\\s+неделю|еженедельно)${R}`, () => {
    recurrence = { freq: "weekly", interval: 1 };
  });
  s.take(`${L}(?:каждый\\s+месяц|ежемесячно)${R}`, () => {
    recurrence = { freq: "monthly", interval: 1 };
  });
  s.take(`${L}(?:каждый\\s+год|ежегодно)${R}`, () => {
    recurrence = { freq: "yearly", interval: 1 };
  });
  s.take(`${L}кажд(?:ые|ый|ую)\\s+(${NUM})\\s+(дн\\p{L}*|день|недел\\p{L}*|месяц\\p{L}*)${R}`, (m) => {
    const n = parseNumber(m[1]);
    if (!n) return false;
    const unit = m[2];
    recurrence = { freq: unit.startsWith("недел") ? "weekly" : unit.startsWith("месяц") ? "monthly" : "daily", interval: n };
  });

  // ---- relative offsets: "через два часа", "через полчаса", "через неделю" ----
  s.take(`${L}через\\s+полчаса${R}`, () => {
    exact = now.plus({ minutes: 30 });
  });
  s.take(`${L}через\\s+полтора\\s+часа${R}`, () => {
    exact = now.plus({ minutes: 90 });
  });
  s.take(
    `${L}через\\s+(?:(${NUM})\\s+)?(минут\\p{L}*|мин|час\\p{L}*|д(?:ень|ня|ней)|сутки|недел\\p{L}*|месяц\\p{L}*|год\\p{L}*|лет)${R}`,
    (m) => {
      const n = m[1] ? parseNumber(m[1]) : 1;
      if (n === null) return false;
      const unit = m[2];
      if (unit.startsWith("мин")) exact = now.plus({ minutes: n });
      else if (unit.startsWith("час")) exact = now.plus({ hours: n });
      else if (unit.startsWith("д") || unit === "сутки") date = today.plus({ days: n });
      else if (unit.startsWith("недел")) date = today.plus({ weeks: n });
      else if (unit.startsWith("месяц")) date = today.plus({ months: n });
      else date = today.plus({ years: n });
    },
  );

  // ---- deadlines & periods ----
  s.take(`${L}(?:до|к)\\s+конц[аеу]\\s+(дня|недели|месяца|года)${R}|${L}в\\s+конце\\s+(недели|месяца)${R}`, (m) => {
    const unit = m[1] ?? m[2];
    deadline = true;
    const end =
      unit === "дня" ? today : unit === "недели" ? weekRange(today).to.minus({ days: 1 }) : unit === "месяца" ? monthRange(today).to.minus({ days: 1 }) : today.endOf("year").startOf("day");
    date = end;
    range = { from: today, to: end.plus({ days: 1 }), label: `до конца ${unit}` };
  });
  s.take(`${L}(?:на|в|во)?\\s*(следующ\\p{L}*|будущ\\p{L}*|эт\\p{L}*|текущ\\p{L}*|прошл\\p{L}*)\\s+(недел\\p{L}*|месяц\\p{L}*)${R}`, (m) => {
    const which = m[1];
    const isWeek = m[2].startsWith("недел");
    const base = isWeek ? weekRange(today) : monthRange(today);
    const shift = which.startsWith("след") || which.startsWith("буд") ? 1 : which.startsWith("прошл") ? -1 : 0;
    const from = isWeek ? base.from.plus({ weeks: shift }) : base.from.plus({ months: shift });
    const to = isWeek ? from.plus({ weeks: 1 }) : from.plus({ months: 1 });
    const label = isWeek
      ? shift === 1 ? "следующую неделю" : shift === -1 ? "прошлую неделю" : "эту неделю"
      : shift === 1 ? "следующий месяц" : shift === -1 ? "прошлый месяц" : "этот месяц";
    range = { from, to, label };
  });
  s.take(`${L}(?:на|в|во)?\\s*(?:эти\\s+)?(?:выходны[хе]|выходные)${R}`, () => {
    const sat = weekRange(today).from.plus({ days: 5 });
    range = { from: sat, to: sat.plus({ days: 2 }), label: "выходные" };
  });
  s.take(`${L}(?:на|в|во)?\\s*(?:эт\\p{L}+\\s+)?(?:неделю|недел[еи])${R}`, () => {
    if (range) return false;
    range = { ...weekRange(today), label: "эту неделю" };
  });

  // ---- relative days ----
  s.take(`${L}(?:(на|до|к)\\s+)?(сегодня|завтра|послезавтра|позавчера|вчера)(?:шн\\p{L}+)?${R}`, (m) => {
    const offsets: Record<string, number> = { сегодня: 0, завтра: 1, послезавтра: 2, вчера: -1, позавчера: -2 };
    date = today.plus({ days: offsets[m[2]] });
    if (m[1] === "до" || m[1] === "к") deadline = true;
  });

  // ---- weekdays: "в пятницу", "в следующий вторник", "до четверга" ----
  s.take(`${L}(?:(в|во|на|к|до)\\s+)?(?:(следующ\\p{L}*|эт\\p{L}*|ближайш\\p{L}*|прошл\\p{L}*|будущ\\p{L}*)\\s+)?${WEEKDAY}${R}`, (m) => {
    const wd = weekdayIndex(m[3]);
    const mod = m[2] ?? "";
    const thisWeek = weekRange(today).from.plus({ days: wd - 1 });
    if (mod.startsWith("след") || mod.startsWith("буд")) date = thisWeek.plus({ weeks: 1 });
    else if (mod.startsWith("прошл")) date = thisWeek.minus({ weeks: 1 });
    else if (mod.startsWith("эт")) date = thisWeek;
    else {
      const diff = (wd - today.weekday + 7) % 7;
      date = opts.preferPast && diff !== 0 ? today.plus({ days: diff - 7 }) : today.plus({ days: diff });
    }
    if (m[1] === "до" || m[1] === "к") deadline = true;
  });

  // ---- explicit times with minutes (before dates, so "в 15.30" is a time) ----
  const takeClock = (h: string, mi: string, part?: string) => {
    const hour = Number(h);
    const minute = Number(mi);
    if (hour > 23 || minute > 59) return false;
    const p = suffixDaypart(part);
    time = { hour: p ? applyDaypart(hour, p) : hour, minute, explicitPart: Boolean(p) || hour >= 13 || hour === 0 || h.length === 2 };
    return true;
  };
  s.take(`${L}с\\s+(\\d{1,2})(?:[:.](\\d{2}))?\\s+до\\s+(\\d{1,2})(?:[:.](\\d{2}))?(?:\\s+${DAYPART_SUFFIX})?${R}`, (m) => {
    const p = suffixDaypart(m[5]);
    const h1 = Number(m[1]);
    const h2 = Number(m[3]);
    if (h1 > 23 || h2 > 23) return false;
    let start = p ? applyDaypart(h1, p) : applyDaypart(h1, null);
    let end = p ? applyDaypart(h2, p) : applyDaypart(h2, null);
    if (end <= start && end + 12 <= 23) end += 12;
    if (start > end && start - 12 >= 0) start -= 12;
    time = { hour: start, minute: Number(m[2] ?? 0), explicitPart: true };
    endTime = { hour: end, minute: Number(m[4] ?? 0) };
  });
  s.take(`${L}(?:(?:в|во|к|около|после|на)\\s+)?(\\d{1,2}):(\\d{2})(?:\\s+${DAYPART_SUFFIX})?${R}`, (m) => takeClock(m[1], m[2], m[3]));
  s.take(`${L}(?:в|во|к|около|после)\\s+(\\d{1,2})\\.(\\d{2})(?:\\s+${DAYPART_SUFFIX})?${R}`, (m) => takeClock(m[1], m[2], m[3]));

  // ---- explicit dates ----
  const setDayMonth = (day: number, month: number, year: number | null) => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    let d = today.set({ month, day, ...(year ? { year: year < 100 ? 2000 + year : year } : {}) });
    if (!d.isValid || d.day !== day) return false;
    if (!year && !opts.preferPast && d < today.minus({ days: 1 })) d = d.plus({ years: 1 });
    date = d;
    return true;
  };
  s.take(`${L}(?:(?:на|к|до)\\s+)?(\\d{1,2}|${ORD})(?:-?(?:го|е|ое))?\\s+${MONTH}(?:\\s+(\\d{4})(?:\\s*(?:года|г\\.?))?)?${R}`, (m) => {
    const day = parseNumber(m[1]);
    if (day === null) return false;
    const ok = setDayMonth(day, monthIndex(m[2]), m[3] ? Number(m[3]) : null);
    if (ok && /^(до|к)\s/.test(m[0])) deadline = true;
    return ok;
  });
  s.take(`${L}(?:(?:на|к|до)\\s+)?(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{2,4}))?${R}`, (m) =>
    setDayMonth(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null),
  );
  s.take(`${L}(?:(?:на|к|до)\\s+)?(\\d{1,2})(?:-?(?:го|е))\\s*(?:числа)?${R}|${L}(\\d{1,2}|${ORD})\\s+числа${R}`, (m) => {
    const day = parseNumber(m[1] ?? m[2]);
    if (day === null || day < 1 || day > 31) return false;
    let d = today.set({ day });
    if (!d.isValid || d.day !== day) return false;
    if (d < today && !opts.preferPast) d = d.plus({ months: 1 });
    date = d;
  });

  // ---- dayparts ----
  s.take(`${L}(?:(?:сегодня|завтра)\\s+)?(утром|с\\s+утра|днем|в\\s+обед|после\\s+обеда|вечером|ночью)${R}`, (m) => {
    const w = m[1];
    daypart = w.includes("утр") ? "morning" : w === "днем" ? "afternoon" : w.includes("обед") ? "noon" : w === "вечером" ? "evening" : "night";
  });
  s.take(`${L}(?:в\\s+)?(полдень|полночь)${R}`, (m) => {
    time = { hour: m[1] === "полдень" ? 12 : 0, minute: 0, explicitPart: true };
    if (m[1] === "полночь" && !date) date = today.plus({ days: 1 });
  });

  // ---- half hours: "в половине третьего", "в полтретьего" ----
  s.take(`${L}(?:в\\s+)?(?:половин[еау]\\s+|пол-?\\s?)(${ORD})(?:\\s+${DAYPART_SUFFIX})?${R}`, (m) => {
    const n = parseNumber(m[1]);
    if (!n || n > 12) return false;
    const p = suffixDaypart(m[2]);
    time = { hour: applyDaypart(n - 1 === 0 ? 12 : n - 1, p), minute: 30, explicitPart: Boolean(p) };
  });

  // ---- duration: "на два часа", "на полчаса", "на 45 минут" ----
  s.take(`${L}на\\s+полчаса${R}`, () => {
    durationMin = 30;
  });
  s.take(`${L}на\\s+полтора\\s+часа${R}`, () => {
    durationMin = 90;
  });
  s.take(`${L}на\\s+(?:(${NUM})\\s+)?(минут\\p{L}*|час\\p{L}*)${R}(?!\\s+${DAYPART_SUFFIX})`, (m) => {
    const n = m[1] ? parseNumber(m[1]) : 1;
    if (!n) return false;
    durationMin = m[2].startsWith("мин") ? n : n * 60;
  });

  // ---- "в час дня", "в час ночи" ----
  s.take(`${L}(?:в|к|около|после|на)\\s+час(?:\\s+${DAYPART_SUFFIX})?${R}`, (m) => {
    const p = suffixDaypart(m[1]);
    time = { hour: applyDaypart(1, p), minute: 0, explicitPart: true };
  });

  // ---- bare hours: "в 10 утра", "в три часа дня", "к девяти", "в 7 вечера" ----
  s.take(
    `${L}(?:в|во|к|около|после|на)\\s+(${NUM}|двум|трем|четырем)(?:\\s+час(?:а|ов)?)?(?:\\s+(${NUM})\\s+минут\\p{L}*)?(?:\\s+${DAYPART_SUFFIX})?${R}(?!\\s*(?:-?го|числа|недел|месяц|год|лет|раз|процент|минут|%))`,
    (m) => {
      const raw = m[1] === "двум" ? 2 : m[1] === "трем" ? 3 : m[1] === "четырем" ? 4 : parseNumber(m[1]);
      if (raw === null || raw > 24) return false;
      const minute = m[2] ? parseNumber(m[2]) ?? 0 : 0;
      if (minute > 59) return false;
      const p = suffixDaypart(m[3]);
      time = { hour: raw === 24 ? 0 : p ? applyDaypart(raw, p) : raw, minute, explicitPart: Boolean(p) || raw >= 13 };
    },
  );

  // ---- resolve ----
  // TypeScript cannot see assignments made inside the closures above; re-read through a cast.
  const st = { date, time, endTime, exact, range, daypart, recurrence, deadline, durationMin } as {
    deadline: boolean;
    durationMin: number | null;
    date: DateTime | null;
    time: { hour: number; minute: number; explicitPart: boolean } | null;
    endTime: { hour: number; minute: number } | null;
    exact: DateTime | null;
    range: DateRangeLabeled | null;
    daypart: Daypart | null;
    recurrence: Recurrence | null;
  };

  let hour: number | null = null;
  let minute = 0;
  if (st.time) {
    hour = st.time.explicitPart ? st.time.hour : applyDaypart(st.time.hour, st.daypart);
    minute = st.time.minute;
  } else if (st.daypart) {
    hour = DAYPART_DEFAULT[st.daypart];
  }

  let start: DateTime | null = null;
  let end: DateTime | null = null;
  let allDay = false;
  let rolledToTomorrow = false;
  let baseDate = st.date;

  // A recurring weekly rule without a date starts on its nearest weekday.
  const rec = st.recurrence;
  if (!baseDate && rec?.byWeekday?.length) {
    for (let i = 0; i < 7; i++) {
      const d = today.plus({ days: i });
      if (rec.byWeekday.includes(d.weekday)) {
        const candidate = hour !== null ? d.set({ hour, minute }) : d;
        if (hour === null || candidate > now || i > 0) {
          baseDate = d;
          break;
        }
      }
    }
    baseDate ??= today.plus({ days: 7 });
  }

  if (st.exact) {
    start = st.exact.set({ second: 0, millisecond: 0 });
    if (hour !== null && st.time) start = start.set({ hour, minute });
  } else if (hour !== null) {
    const base = baseDate ?? today;
    start = base.set({ hour, minute, second: 0, millisecond: 0 });
    if (!baseDate && !opts.preferPast && start <= now) {
      start = start.plus({ days: 1 });
      rolledToTomorrow = true;
    }
  } else if (baseDate) {
    start = baseDate.startOf("day");
    allDay = true;
  } else if (st.range && st.deadline) {
    start = st.range.to.minus({ days: 1 });
    allDay = true;
  }

  if (start && st.endTime && !allDay) {
    end = start.set({ hour: st.endTime.hour, minute: st.endTime.minute });
    if (end <= start) end = end.plus({ days: 1 });
  }

  let outRange = st.range;
  if (!outRange && baseDate) {
    const r = dayRange(baseDate);
    outRange = { ...r, label: "" };
  }

  return {
    start,
    end,
    durationMin: st.durationMin,
    allDay,
    hasDate: Boolean(baseDate || st.exact || (st.range && st.deadline)),
    hasTime: hour !== null || Boolean(st.exact),
    range: outRange,
    deadline: st.deadline,
    recurrence: st.recurrence,
    rolledToTomorrow,
    spans: s.spans.sort((a, b) => a[0] - b[0]),
    rest: s.rest(),
  };
}
