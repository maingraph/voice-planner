import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

/**
 * End-to-end dialogue scenarios from the task description, run through the
 * offline rule engine (no LLM) with Wednesday 4 Nov 2026, 12:00 as "now".
 */

describe("1. creating tasks and reminders", () => {
  it("«Напомни мне завтра в 10 утра позвонить Ивану»", async () => {
    const app = makeApp();
    const r = await app.say("Напомни мне завтра в 10 утра позвонить Ивану");
    expect(r.reply).toBe("Хорошо, напомню завтра в 10:00: позвонить Ивану.");
    const item = r.actions[0].items[0];
    expect(item).toMatchObject({ type: "reminder", title: "Позвонить Ивану", start: "2026-11-05T10:00:00", allDay: false });
  });

  it("«В пятницу нужно отправить отчет»", async () => {
    const app = makeApp();
    const r = await app.say("В пятницу нужно отправить отчет");
    expect(r.actions[0].items[0]).toMatchObject({ type: "task", title: "Отправить отчет", start: "2026-11-06", allDay: true });
    expect(r.reply).toBe("Задача добавлена: «Отправить отчет», послезавтра.");
  });

  it("«Поставь задачу купить билеты до конца недели»", async () => {
    const app = makeApp();
    const r = await app.say("Поставь задачу купить билеты до конца недели");
    expect(r.actions[0].items[0]).toMatchObject({ type: "task", title: "Купить билеты", start: "2026-11-08" });
    expect(r.reply).toContain("срок — до воскресенья, 8 ноября");
  });

  it("task without any date is allowed", async () => {
    const app = makeApp();
    const r = await app.say("Нужно купить подарок маме");
    expect(r.actions[0].items[0]).toMatchObject({ type: "task", title: "Купить подарок маме", start: null });
  });

  it("relative time «через два часа»", async () => {
    const app = makeApp();
    const r = await app.say("Напомни через два часа выключить духовку");
    expect(r.actions[0].items[0]).toMatchObject({ type: "reminder", title: "Выключить духовку", start: "2026-11-04T14:00:00" });
  });

  it("reminder without time asks a clarifying question, then completes", async () => {
    const app = makeApp();
    const q = await app.say("Напомни завтра заплатить за интернет");
    expect(q.awaiting).toBe(true);
    expect(q.reply).toBe("Во сколько напомнить?");
    const r = await app.say("в 9 утра");
    expect(r.actions[0].items[0]).toMatchObject({ title: "Заплатить за интернет", start: "2026-11-05T09:00:00" });
  });

  it("a time that already passed today moves to tomorrow and says so", async () => {
    const app = makeApp();
    const r = await app.say("Напомни в 9 утра сделать зарядку");
    expect(r.actions[0].items[0].start).toBe("2026-11-05T09:00:00");
    expect(r.reply).toContain("уже прошло");
  });
});

describe("2. creating meetings", () => {
  it("«Добавь встречу с командой завтра в 15:00»", async () => {
    const app = makeApp();
    const r = await app.say("Добавь встречу с командой завтра в 15:00");
    expect(r.actions[0].items[0]).toMatchObject({ type: "meeting", title: "Встреча с командой", start: "2026-11-05T15:00:00", end: "2026-11-05T16:00:00" });
    expect(r.reply).toBe("Встреча добавлена: «Встреча с командой», завтра с 15:00 до 16:00.");
  });

  it("«В четверг в 11 у меня встреча с дизайнером»", async () => {
    const app = makeApp();
    const r = await app.say("В четверг в 11 у меня встреча с дизайнером");
    expect(r.actions[0].items[0]).toMatchObject({ type: "meeting", title: "Встреча с дизайнером", start: "2026-11-05T11:00:00" });
  });

  it("missing time → «На какое время поставить встречу?» (spec example)", async () => {
    const app = makeApp();
    const q = await app.say("Поставь встречу с Иваном завтра");
    expect(q.reply).toBe("На какое время поставить встречу?");
    expect(q.awaiting).toBe(true);
    const r = await app.say("в 14:30");
    expect(r.actions[0].items[0]).toMatchObject({ type: "meeting", title: "Встреча с Иваном", start: "2026-11-05T14:30:00" });
  });

  it("clarification accepts a bare number answer", async () => {
    const app = makeApp();
    await app.say("Поставь встречу с Иваном завтра");
    const r = await app.say("16");
    expect(r.actions[0].items[0].start).toBe("2026-11-05T16:00:00");
  });

  it("explicit range «с 14 до 15:30»", async () => {
    const app = makeApp();
    const r = await app.say("Завтра с 14 до 15:30 созвон с юристом");
    expect(r.actions[0].items[0]).toMatchObject({ type: "meeting", start: "2026-11-05T14:00:00", end: "2026-11-05T15:30:00" });
  });

  it("detects conflicting meetings and lets the user choose another time", async () => {
    const app = makeApp();
    await app.say("Добавь встречу с командой завтра в 15:00");
    const q = await app.say("Завтра в 15:30 встреча с бухгалтером");
    expect(q.awaiting).toBe(true);
    expect(q.reply).toContain("уже есть встреча «Встреча с командой»");
    const r = await app.say("давай в 17");
    expect(r.actions[0].items[0]).toMatchObject({ title: "Встреча с бухгалтером", start: "2026-11-05T17:00:00" });
  });

  it("conflict can be confirmed with «да»", async () => {
    const app = makeApp();
    await app.say("Добавь встречу с командой завтра в 15:00");
    await app.say("Завтра в 15:30 встреча с бухгалтером");
    const r = await app.say("да, всё равно добавь");
    expect(r.actions[0].kind).toBe("created");
  });

  it("recurring meeting «каждый понедельник в 10»", async () => {
    const app = makeApp();
    const r = await app.say("Каждый понедельник в 10 планёрка");
    expect(r.actions[0].items[0]).toMatchObject({ type: "meeting", start: "2026-11-09T10:00:00", recurrence: "каждую неделю (пн)" });
  });
});

describe("3. upcoming events", () => {
  async function seeded() {
    const app = makeApp();
    await app.say("Сегодня в 15:00 встреча с командой");
    await app.say("Напомни сегодня в 18 забрать посылку");
    await app.say("Завтра в 10 созвон с заказчиком");
    await app.say("В пятницу нужно отправить отчет");
    await app.say("На следующей неделе подготовить презентацию");
    return app;
  }

  it("«Что у меня сегодня?» and its paraphrases give the same answer", async () => {
    const app = await seeded();
    const replies = [
      await app.say("Что у меня сегодня?"),
      await app.say("Какие планы на сегодня?"),
      await app.say("Покажи мои дела на сегодня"),
    ].map((r) => r.reply);
    expect(replies[0]).toBe(
      "Сегодня 2 записи: с 15:00 до 16:00 — встреча «Встреча с командой»; в 18:00 — напоминание «Забрать посылку».",
    );
    expect(new Set(replies).size).toBe(1);
  });

  it("«Есть ли у меня встречи сегодня?» answers yes/no with meetings only", async () => {
    const app = await seeded();
    const r = await app.say("Есть ли у меня встречи сегодня?");
    expect(r.reply).toBe("Да, сегодня 1 встреча: с 15:00 до 16:00 — встреча «Встреча с командой».");
    const none = await app.say("Есть ли у меня встречи в субботу?");
    expect(none.reply).toMatch(/^Нет,/);
  });

  it("«Какие задачи у меня на завтра?» filters by type", async () => {
    const app = await seeded();
    const r = await app.say("Какие задачи у меня на завтра?");
    expect(r.reply).toBe("Завтра задач нет.");
  });

  it("«Что запланировано на эту неделю?» groups by day", async () => {
    const app = await seeded();
    const r = await app.say("Что запланировано на эту неделю?");
    expect(r.reply).toMatch(/^На эту неделю 4 записи\. Сегодня: .*Завтра: .*Послезавтра: задача «Отправить отчет»\.$/);
  });

  it("«на следующей неделе» query", async () => {
    const app = await seeded();
    const r = await app.say("Что у меня на следующей неделе?");
    expect(r.reply).toContain("Подготовить презентацию");
  });
});

describe("4. searching old items", () => {
  async function seeded() {
    const app = makeApp({ now: "2026-10-20T09:00:00" });
    await app.say("Подготовить презентацию для инвесторов к пятнице");
    await app.say("Встреча с Иваном 28 октября в 15:00");
    await app.say("Поставь задачу согласовать контракт с поставщиком");
    await app.say("Купить билеты в Казань");
    app.setNow("2026-11-04T12:00:00");
    return app;
  }

  it("«Найди задачу про презентацию»", async () => {
    const app = await seeded();
    const r = await app.say("Найди задачу про презентацию");
    expect(r.reply).toContain("«Подготовить презентацию для инвесторов»");
    expect(r.actions[0].items).toHaveLength(1);
  });

  it("«Когда у меня была встреча с Иваном?»", async () => {
    const app = await seeded();
    const r = await app.say("Когда у меня была встреча с Иваном?");
    expect(r.reply).toBe("Встреча «Встреча с Иваном» была 28 октября с 15:00 до 16:00.");
  });

  it("«Я когда-то ставил задачу по договору, найди её» finds «контракт» via synonyms", async () => {
    const app = await seeded();
    const r = await app.say("Я когда-то ставил задачу по договору, найди ее");
    expect(r.reply).toContain("Согласовать контракт с поставщиком");
  });

  it("tolerates inflection and typos", async () => {
    const app = await seeded();
    expect((await app.say("найди билеты")).reply).toContain("Купить билеты в Казань");
    expect((await app.say("найди презентацыю")).reply).toContain("презентацию");
  });

  it("reports when nothing is found", async () => {
    const app = await seeded();
    const r = await app.say("Найди задачу про ремонт машины");
    expect(r.reply).toMatch(/^Не нашёл ничего/);
  });
});

describe("persistence, context and extras", () => {
  it("data survives between requests and dialogue context works: «перенеси её на завтра»", async () => {
    const app = makeApp();
    await app.say("В пятницу в 11 встреча с дизайнером");
    const r = await app.say("А перенеси её на завтра");
    expect(r.actions[0].items[0]).toMatchObject({ title: "Встреча с дизайнером", start: "2026-11-05T11:00:00" });
    expect(r.reply).toBe("Готово: «Встреча с дизайнером» теперь завтра с 11:00 до 12:00.");
  });

  it("reschedules a found item by description and shifts relative time", async () => {
    const app = makeApp();
    await app.say("Завтра в 10 созвон с заказчиком");
    const r = await app.say("Перенеси созвон с заказчиком на 16:00");
    expect(r.actions[0].items[0].start).toBe("2026-11-05T16:00:00");
    const later = await app.say("сдвинь её на час позже");
    expect(later.actions[0].items[0].start).toBe("2026-11-05T17:00:00");
  });

  it("marks a task done by voice", async () => {
    const app = makeApp();
    await app.say("В пятницу нужно отправить отчет");
    const r = await app.say("Отметь задачу про отчет выполненной");
    expect(r.actions[0].kind).toBe("completed");
    expect(r.actions[0].items[0].status).toBe("done");
  });

  it("completing a recurring item moves it to the next occurrence", async () => {
    const app = makeApp();
    await app.say("Каждый день в 20:00 напомни выпить витамины");
    const r = await app.say("Готово, я выпил витамины");
    expect(r.reply).toContain("Следующий раз — завтра в 20:00");
  });

  it("deletes by voice and undoes with «верни»", async () => {
    const app = makeApp();
    await app.say("Завтра в 10 созвон с заказчиком");
    const del = await app.say("Удали созвон с заказчиком");
    expect(del.actions[0].kind).toBe("deleted");
    expect(app.planner.allItems(app.user)).toHaveLength(0);
    const undo = await app.say("верни");
    expect(undo.actions[0].kind).toBe("restored");
    expect(app.planner.allItems(app.user)).toHaveLength(1);
  });

  it("asks which item when several match", async () => {
    const app = makeApp();
    await app.say("Завтра в 10 встреча с Иваном");
    await app.say("В пятницу в 12 встреча с Иваном Петровым");
    const q = await app.say("Удали встречу с Иваном");
    expect(q.awaiting).toBe(true);
    expect(q.reply).toMatch(/^Нашёл несколько: 1\)/);
    const r = await app.say("вторую");
    expect(r.actions[0].kind).toBe("deleted");
    expect(r.actions[0].items[0].title).toBe("Встреча с Иваном Петровым");
  });

  it("users are isolated", async () => {
    const app = makeApp();
    await app.say("Завтра в 10 созвон с заказчиком");
    const other = await app.assistant.handle("another-user-2", "Europe/Moscow", "Что у меня завтра?");
    expect(other.reply).toBe("Завтра ничего не запланировано.");
  });

  it("can cancel a clarification", async () => {
    const app = makeApp();
    await app.say("Поставь встречу с Иваном завтра");
    const r = await app.say("отмена");
    expect(r.reply).toBe("Хорошо, не буду.");
    expect(app.planner.allItems(app.user)).toHaveLength(0);
  });
});

describe("free-form phrasings (regression set)", () => {
  it.each([
    ["сделай напоминание на 8 вечера полить цветы", "Хорошо, напомню сегодня в 20:00: полить цветы."],
    ["напомни мне в понедельник утром про встречу с банком", "Хорошо, напомню в понедельник, 9 ноября в 09:00: встреча с банком."],
    ["запланируй обед с Олей в четверг в час дня", "Встреча добавлена: «Обед с Олей», завтра с 13:00 до 14:00."],
    ["встреча с клиентом 12 ноября в 10:30 на два часа", "Встреча добавлена: «Встреча с клиентом», 12 ноября с 10:30 до 12:30."],
    ["встреча на 10 завтра с бухгалтером", "Встреча добавлена: «Встреча с бухгалтером», завтра с 10:00 до 11:00."],
    ["завтра на 3 часа дня созвон с Москвой", "Встреча добавлена: «Созвон с Москвой», завтра с 15:00 до 16:00."],
    ["Надо бы позвонить в банк", "Задача добавлена: «Позвонить в банк», без срока."],
    ["Купить билеты в Казань", "Задача добавлена: «Купить билеты в Казань», без срока."],
    ["напомни через 20 минут проверить почту", "Хорошо, напомню сегодня в 12:20: проверить почту."],
    ["мне нужно до пятницы подготовить отчёт для директора", "Задача добавлена: «Подготовить отчёт для директора», срок — до пятницы, 6 ноября."],
    ["какая погода завтра?", "Я умею работать только с задачами, напоминаниями и встречами. Например, спросите «Что у меня завтра?» или скажите «Напомни в 18 позвонить маме»."],
  ])("%s", async (text, reply) => {
    const app = makeApp();
    expect((await app.say(text)).reply).toBe(reply);
  });

  it("«когда …?» questions are searches, with grammatical agreement", async () => {
    const app = makeApp();
    await app.say("в пятницу в 18:00 тренировка");
    await app.say("поставь созвон с Петей на понедельник в 12");
    expect((await app.say("когда у меня тренировка?")).reply).toBe("Задача «Тренировка» запланирована послезавтра в 18:00.");
    expect((await app.say("когда созвон с Петей")).reply).toBe("Встреча «Созвон с Петей» будет в понедельник, 9 ноября с 12:00 до 13:00.");
  });

  it("a new command abandons a pending clarification", async () => {
    const app = makeApp();
    await app.say("в пятницу в 18:00 тренировка");
    expect((await app.say("напомни купить молоко")).awaiting).toBe(true);
    const r = await app.say("перенеси тренировку на четверг");
    expect(r.reply).toBe("Готово: «Тренировка» теперь завтра в 18:00.");
    expect(app.planner.allItems(app.user)).toHaveLength(1);
  });

  it("lists tasks without a date", async () => {
    const app = makeApp();
    await app.say("Надо бы позвонить в банк");
    await app.say("Завтра в 10 созвон с заказчиком");
    expect((await app.say("какие задачи у меня без срока")).reply).toBe("Без срока 1 задача: «Позвонить в банк».");
  });
});
