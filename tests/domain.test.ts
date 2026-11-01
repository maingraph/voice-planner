import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { toICalendar } from "../src/domain/ical.js";
import { expandOccurrences } from "../src/domain/recurrence.js";
import { detectIntent } from "../src/nlu/intents.js";
import { extractTitle } from "../src/nlu/rule-engine.js";
import { SearchEngine } from "../src/search/search-engine.js";
import type { Item } from "../src/domain/types.js";
import { makeApp, ZONE } from "./helpers.js";

function item(title: string, extra: Partial<Item> = {}): Item {
  return {
    id: title,
    userId: "u",
    type: "task",
    title,
    notes: null,
    startAt: null,
    endAt: null,
    allDay: false,
    timezone: ZONE,
    status: "pending",
    recurrence: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    completedAt: null,
    lastNotifiedAt: null,
    sourceText: null,
    ...extra,
  };
}

describe("intent detection: paraphrases map to one action", () => {
  it.each([
    ["Что у меня сегодня?", "list"],
    ["Какие планы на сегодня?", "list"],
    ["Покажи мои встречи на сегодня", "list"],
    ["Есть ли у меня встречи сегодня?", "list"],
    ["Чем я занят завтра?", "list"],
    ["Напомни мне завтра в 10 утра позвонить Ивану", "create"],
    ["В пятницу нужно отправить отчет", "create"],
    ["Поставь задачу купить билеты до конца недели", "create"],
    ["В четверг в 11 у меня встреча с дизайнером", "create"],
    ["Найди задачу про презентацию", "search"],
    ["Когда у меня была встреча с Иваном?", "search"],
    ["Я когда-то ставил задачу по договору, найди её", "search"],
    ["А перенеси её на завтра", "update"],
    ["Удали встречу с Иваном", "delete"],
    ["Отметь задачу про отчёт выполненной", "complete"],
    ["Я сделал отчёт", "complete"],
    ["Верни", "undo"],
    ["отмена", "cancel"],
    ["Что ты умеешь?", "help"],
  ])("%s → %s", (text, intent) => {
    expect(detectIntent(text)).toBe(intent);
  });
});

describe("title extraction", () => {
  it.each([
    ["Напомни мне позвонить Ивану", "reminder", "Позвонить Ивану"],
    ["нужно отправить отчет", "task", "Отправить отчет"],
    ["Поставь задачу купить билеты", "task", "Купить билеты"],
    ["Добавь встречу с командой", "meeting", "Встреча с командой"],
    ["у меня встреча с дизайнером", "meeting", "Встреча с дизайнером"],
    ["Напомни про оплату квартиры", "reminder", "Оплату квартиры"],
  ] as const)("%s → %s", (rest, type, title) => {
    expect(extractTitle(rest, type)).toBe(title);
  });
});

describe("search engine", () => {
  const engine = new SearchEngine();
  const items = [
    item("Подготовить презентацию для инвесторов"),
    item("Согласовать контракт с поставщиком"),
    item("Встреча с Иваном", { type: "meeting" }),
    item("Купить молоко"),
  ];
  const top = async (q: string, related?: string[]) => (await engine.search(items, { text: q, related }))[0]?.item.title;

  it("matches word forms via stemming", async () => {
    expect(await top("презентации")).toBe("Подготовить презентацию для инвесторов");
    expect(await top("Иваном")).toBe("Встреча с Иваном");
  });
  it("matches synonyms from the domain thesaurus", async () => {
    expect(await top("договор")).toBe("Согласовать контракт с поставщиком");
    expect(await top("слайды")).toBe("Подготовить презентацию для инвесторов");
  });
  it("uses LLM-provided related terms", async () => {
    expect(await top("молочка", ["молоко", "продукты"])).toBe("Купить молоко");
  });
  it("tolerates typos", async () => {
    expect(await top("презентацыя")).toBe("Подготовить презентацию для инвесторов");
  });
  it("returns nothing for unrelated queries", async () => {
    expect(await engine.search(items, { text: "ремонт автомобиля" })).toHaveLength(0);
  });
});

describe("recurrence expansion", () => {
  it("weekly on weekdays inside a range", () => {
    const first = DateTime.fromISO("2026-11-02T09:30", { zone: ZONE }); // Monday
    const range = { from: DateTime.fromISO("2026-11-05", { zone: ZONE }), to: DateTime.fromISO("2026-11-12", { zone: ZONE }) };
    const out = expandOccurrences(first, { freq: "weekly", interval: 1, byWeekday: [1, 3, 5] }, range).map((d) => d.toFormat("ccc dd HH:mm"));
    expect(out).toEqual(["Fri 06 09:30", "Mon 09 09:30", "Wed 11 09:30"]);
  });
  it("daily with until", () => {
    const first = DateTime.fromISO("2026-11-01T20:00", { zone: ZONE });
    const range = { from: DateTime.fromISO("2026-11-01", { zone: ZONE }), to: DateTime.fromISO("2026-12-01", { zone: ZONE }) };
    expect(expandOccurrences(first, { freq: "daily", interval: 1, until: "2026-11-05" }, range)).toHaveLength(5);
  });
  it("monthly far in the future does not iterate forever", () => {
    const first = DateTime.fromISO("2020-01-15T10:00", { zone: ZONE });
    const range = { from: DateTime.fromISO("2026-11-01", { zone: ZONE }), to: DateTime.fromISO("2026-12-01", { zone: ZONE }) };
    expect(expandOccurrences(first, { freq: "monthly", interval: 1 }, range).map((d) => d.toISODate())).toEqual(["2026-11-15"]);
  });
});

describe("planner service", () => {
  it("lists recurring items inside a week", async () => {
    const app = makeApp();
    await app.say("По будням в 9:30 стендап");
    const now = app.now();
    const week = app.planner.list(app.user, ZONE, { from: now.startOf("day"), to: now.startOf("day").plus({ days: 7 }) });
    expect(week.map((o) => o.start!.toFormat("ccc"))).toEqual(["Thu", "Fri", "Mon", "Tue"]);
  });

  it("fires reminders once, meetings 10 minutes early", async () => {
    const app = makeApp();
    await app.say("Напомни сегодня в 12:30 выпить воды");
    await app.say("Сегодня в 13:00 встреча с командой");
    app.setNow("2026-11-04T12:30:20");
    expect(app.planner.dueNotifications(app.user, ZONE).map((o) => o.item.title)).toEqual(["Выпить воды"]);
    expect(app.planner.dueNotifications(app.user, ZONE)).toHaveLength(0);
    app.setNow("2026-11-04T12:51:00");
    expect(app.planner.dueNotifications(app.user, ZONE).map((o) => o.item.title)).toEqual(["Встреча с командой"]);
  });

  it("exports iCalendar with recurrence rules", async () => {
    const app = makeApp();
    await app.say("Каждый понедельник в 10 планёрка");
    const ics = toICalendar(app.planner.allItems(app.user));
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
    expect(ics).toContain("DTSTART:20261109T070000Z");
  });

  it("all-day items keep their calendar date in another time zone", async () => {
    const app = makeApp();
    await app.say("В пятницу нужно отправить отчет");
    const [occ] = app.planner.list(app.user, "America/New_York", {
      from: DateTime.fromISO("2026-11-06", { zone: "America/New_York" }),
      to: DateTime.fromISO("2026-11-07", { zone: "America/New_York" }),
    });
    expect(occ.start!.toISODate()).toBe("2026-11-06");
  });
});
