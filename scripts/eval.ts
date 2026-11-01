/**
 * Scenario evaluation against the configured engine (LLM if a key is set, rules otherwise).
 * Each case is a short dialogue on a fresh in-memory database with a fixed clock
 * (Wed 4 Nov 2026, 12:00 Moscow); checks look at stored data, not at the wording.
 *
 *   npm run eval               # uses .env
 *   LLM_PROVIDER=none npm run eval
 */
import { DateTime } from "luxon";
import { buildServices } from "../src/app.js";
import { loadConfig } from "../src/config/config.js";
import type { ChatResponse } from "../src/agent/assistant.js";
import type { Item } from "../src/domain/types.js";

const ZONE = "Europe/Moscow";
const NOW = DateTime.fromISO("2026-11-04T12:00:00", { zone: ZONE });

interface Ctx {
  items: () => Item[];
  replies: ChatResponse[];
}
interface Case {
  name: string;
  turns: string[];
  check: (c: Ctx) => string | null; // null = pass, otherwise reason
}

const local = (i: Item | undefined) => (i?.startAt ? DateTime.fromISO(i.startAt).setZone(ZONE).toFormat(i.allDay ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm") : null);
const expectItem = (items: Item[], type: string, titleRe: RegExp, when: string | null): string | null => {
  const it = items.find((i) => titleRe.test(i.title));
  if (!it) return `no item matching ${titleRe} (have: ${items.map((i) => i.title).join(", ") || "none"})`;
  if (it.type !== type) return `type ${it.type} ≠ ${type}`;
  if (local(it) !== when) return `when ${local(it)} ≠ ${when}`;
  return null;
};
const replyMatches = (r: ChatResponse | undefined, re: RegExp) => (r && re.test(r.reply) ? null : `reply «${r?.reply}» !~ ${re}`);

const CASES: Case[] = [
  { name: "reminder tomorrow 10am", turns: ["Напомни мне завтра в 10 утра позвонить Ивану"], check: (c) => expectItem(c.items(), "reminder", /иван/i, "2026-11-05 10:00") },
  { name: "task on Friday", turns: ["В пятницу нужно отправить отчет"], check: (c) => expectItem(c.items(), "task", /отч[её]т/i, "2026-11-06") },
  { name: "task until end of week", turns: ["Поставь задачу купить билеты до конца недели"], check: (c) => expectItem(c.items(), "task", /билет/i, "2026-11-08") },
  { name: "meeting tomorrow 15:00", turns: ["Добавь встречу с командой завтра в 15:00"], check: (c) => expectItem(c.items(), "meeting", /команд/i, "2026-11-05 15:00") },
  { name: "meeting Thursday at 11", turns: ["В четверг в 11 у меня встреча с дизайнером"], check: (c) => expectItem(c.items(), "meeting", /дизайнер/i, "2026-11-05 11:00") },
  {
    name: "clarify missing meeting time",
    turns: ["Поставь встречу с Иваном завтра", "в 14:30"],
    check: (c) => (c.replies[0].awaiting ? null : "first reply is not a question") ?? expectItem(c.items(), "meeting", /иван/i, "2026-11-05 14:30"),
  },
  { name: "in two hours", turns: ["Напомни через два часа выключить духовку"], check: (c) => expectItem(c.items(), "reminder", /духовк/i, "2026-11-04 14:00") },
  {
    name: "today's plan (3 paraphrases)",
    turns: ["Сегодня в 15:00 встреча с командой", "Что у меня сегодня?", "Какие планы на сегодня?", "Покажи мои встречи на сегодня"],
    check: (c) => c.replies.slice(1).map((r) => replyMatches(r, /команд/i)).find(Boolean) ?? null,
  },
  {
    name: "yes/no meetings today",
    turns: ["Сегодня в 15:00 встреча с командой", "Есть ли у меня встречи сегодня?"],
    check: (c) => replyMatches(c.replies[1], /^да/i),
  },
  {
    name: "week overview",
    turns: ["Завтра в 10 созвон с заказчиком", "В субботу купить подарок", "Что запланировано на эту неделю?"],
    check: (c) => replyMatches(c.replies[2], /заказчик[\s\S]*подар|подар[\s\S]*заказчик/i),
  },
  {
    name: "semantic search договор → контракт",
    turns: ["Поставь задачу согласовать контракт с поставщиком", "Я когда-то ставил задачу по договору, найди её"],
    check: (c) => replyMatches(c.replies[1], /контракт/i),
  },
  {
    name: "context: move it to tomorrow",
    turns: ["В пятницу в 11 встреча с дизайнером", "А перенеси её на завтра"],
    check: (c) => expectItem(c.items(), "meeting", /дизайнер/i, "2026-11-05 11:00"),
  },
  {
    name: "conflict detection",
    turns: ["Добавь встречу с командой завтра в 15:00", "Завтра в 15:30 встреча с бухгалтером"],
    check: (c) => (c.items().length === 1 ? null : "overlapping meeting was saved without asking"),
  },
  {
    name: "complete by description",
    turns: ["В пятницу нужно отправить отчет", "Отметь задачу про отчёт выполненной"],
    check: (c) => (c.items()[0]?.status === "done" ? null : "not marked done"),
  },
];

async function main() {
  const config = { ...loadConfig(), dbFile: ":memory:" };
  console.log(`Engine: ${config.llm.kind === "none" ? "rules" : config.llm.kind === "anthropic" ? config.llm.model : config.llm.model}\n`);
  let passed = 0;
  for (const c of CASES) {
    const services = buildServices(config, { clock: () => NOW });
    const user = "eval-user";
    const replies: ChatResponse[] = [];
    const started = Date.now();
    let failure: string | null;
    try {
      for (const t of c.turns) replies.push(await services.assistant.handle(user, ZONE, t));
      failure = c.check({ items: () => services.planner.allItems(user), replies });
    } catch (err) {
      failure = `error: ${(err as Error).message}`;
    }
    const ms = Date.now() - started;
    if (!failure) passed++;
    console.log(`${failure ? "✗" : "✓"} ${c.name} (${ms} ms)${failure ? `\n    ${failure}` : ""}`);
    if (failure || process.env.VERBOSE) replies.forEach((r, i) => console.log(`    > ${c.turns[i]}\n      ${r.reply} [${r.engine}]`));
  }
  console.log(`\n${passed}/${CASES.length} passed`);
  process.exit(passed === CASES.length ? 0 : 1);
}

main();
