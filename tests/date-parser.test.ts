import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { parseDateTime } from "../src/nlu/date-parser.js";
import { NOW_ISO, ZONE } from "./helpers.js";

const now = DateTime.fromISO(NOW_ISO, { zone: ZONE }); // Wed 04.11.2026 12:00
const fmt = (text: string) => {
  const r = parseDateTime(text, now);
  return r.start ? r.start.toFormat(r.allDay ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm") : null;
};

describe("Russian date/time parser", () => {
  it.each([
    ["сегодня", "2026-11-04"],
    ["завтра", "2026-11-05"],
    ["послезавтра", "2026-11-06"],
    ["в пятницу", "2026-11-06"],
    ["в среду", "2026-11-04"],
    ["в понедельник", "2026-11-09"],
    ["во вторник", "2026-11-10"],
    ["в следующую среду", "2026-11-11"],
    ["в эту субботу", "2026-11-07"],
    ["15 ноября", "2026-11-15"],
    ["1 декабря", "2026-12-01"],
    ["третьего января", "2027-01-03"],
    ["15.11", "2026-11-15"],
    ["25-го числа", "2026-11-25"],
    ["через три дня", "2026-11-07"],
    ["через неделю", "2026-11-11"],
    ["до конца недели", "2026-11-08"],
    ["до конца месяца", "2026-11-30"],
  ])("date: %s → %s", (text, expected) => {
    expect(fmt(text)).toBe(expected);
  });

  it.each([
    ["завтра в 10 утра", "2026-11-05 10:00"],
    ["завтра в 10", "2026-11-05 10:00"],
    ["завтра в 3", "2026-11-05 15:00"],
    ["завтра в 3 дня", "2026-11-05 15:00"],
    ["завтра в 7 вечера", "2026-11-05 19:00"],
    ["завтра в 11 вечера", "2026-11-05 23:00"],
    ["завтра в 2 ночи", "2026-11-05 02:00"],
    ["завтра в 15:00", "2026-11-05 15:00"],
    ["завтра в 9.30", "2026-11-05 09:30"],
    ["завтра в десять", "2026-11-05 10:00"],
    ["завтра в пять часов вечера", "2026-11-05 17:00"],
    ["завтра в половине третьего", "2026-11-05 14:30"],
    ["завтра утром", "2026-11-05 09:00"],
    ["завтра вечером в 8", "2026-11-05 20:00"],
    ["завтра в полдень", "2026-11-05 12:00"],
    ["в четверг в 11", "2026-11-05 11:00"],
    ["в 15:30", "2026-11-04 15:30"],
    ["в 9 утра", "2026-11-05 09:00"], // already passed today → tomorrow
    ["через два часа", "2026-11-04 14:00"],
    ["через 15 минут", "2026-11-04 12:15"],
    ["через полчаса", "2026-11-04 12:30"],
    ["через полтора часа", "2026-11-04 13:30"],
    ["15 ноября в 18:45", "2026-11-15 18:45"],
    ["сегодня вечером", "2026-11-04 19:00"],
  ])("date+time: %s → %s", (text, expected) => {
    expect(fmt(text)).toBe(expected);
  });

  it("keeps the rest of the phrase for the title", () => {
    expect(parseDateTime("Напомни мне завтра в 10 утра позвонить Ивану", now).rest).toBe("Напомни мне позвонить Ивану");
    expect(parseDateTime("В четверг в 11 у меня встреча с дизайнером", now).rest).toBe("у меня встреча с дизайнером");
  });

  it("time ranges and durations", () => {
    const r = parseDateTime("завтра с 14 до 15:30", now);
    expect(r.start?.toFormat("HH:mm")).toBe("14:00");
    expect(r.end?.toFormat("HH:mm")).toBe("15:30");
    expect(parseDateTime("завтра в 10 на полтора часа", now).durationMin).toBe(90);
    expect(parseDateTime("завтра в 10 на 2 часа", now).durationMin).toBe(120);
  });

  it("periods for queries", () => {
    const week = parseDateTime("что на этой неделе", now).range!;
    expect([week.from.toISODate(), week.to.toISODate(), week.label]).toEqual(["2026-11-02", "2026-11-09", "эту неделю"]);
    const next = parseDateTime("на следующей неделе", now).range!;
    expect([next.from.toISODate(), next.to.toISODate()]).toEqual(["2026-11-09", "2026-11-16"]);
    const weekend = parseDateTime("какие планы на выходные", now).range!;
    expect([weekend.from.toISODate(), weekend.to.toISODate()]).toEqual(["2026-11-07", "2026-11-09"]);
  });

  it("recurrence", () => {
    expect(parseDateTime("каждый день в 9", now).recurrence).toEqual({ freq: "daily", interval: 1 });
    expect(parseDateTime("по будням в 9:30", now).recurrence).toMatchObject({ freq: "weekly", byWeekday: [1, 2, 3, 4, 5] });
    expect(parseDateTime("по понедельникам и средам", now).recurrence).toMatchObject({ freq: "weekly", byWeekday: [1, 3] });
    expect(parseDateTime("каждые 2 недели", now).recurrence).toMatchObject({ freq: "weekly", interval: 2 });
    expect(parseDateTime("ежемесячно 5-го числа", now).recurrence).toMatchObject({ freq: "monthly" });
  });

  it("past preference for questions about history", () => {
    const r = parseDateTime("что было в понедельник", now, { preferPast: true });
    expect(r.start?.toISODate()).toBe("2026-11-02");
  });

  it("does not invent dates", () => {
    const r = parseDateTime("купить молоко", now);
    expect(r.start).toBeNull();
    expect(r.hasDate || r.hasTime).toBe(false);
  });
});
