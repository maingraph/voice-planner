import { DateTime } from "luxon";
import type { AssistantAction, DialogueEngine, TurnContext, TurnResult } from "../agent/types.js";
import {
  capitalize,
  dayPhrase,
  deadlinePhrase,
  describeInDay,
  describeOccurrence,
  occurrenceView,
  plural,
  whenPhrase,
} from "../domain/format.js";
import type { MissingField, PlannerService } from "../domain/planner-service.js";
import { describeRecurrence } from "../domain/recurrence.js";
import { dayRange } from "../domain/time.js";
import { TYPE_LABELS, type ItemDraft, type ItemType, type Occurrence, type Recurrence } from "../domain/types.js";
import { parseDateTime, type DateParse } from "./date-parser.js";
import { parseNumber } from "./numbers.js";
import {
  detectIntent,
  detectType,
  isNo,
  isYes,
  isYesNoQuestion,
  mentionsFuture,
  mentionsPast,
  norm,
  pickIndex,
  refersToPrevious,
  typesMentioned,
  type Intent,
} from "./intents.js";

// ---------- pending dialogue state (stored in the session as JSON) ----------

interface StoredDraft {
  type: ItemType;
  title: string;
  start: string | null;
  allDay: boolean;
  end: string | null;
  durationMin: number | null;
  recurrence: Recurrence | null;
  deadline: boolean;
  sourceText: string;
}

type Pending =
  | { kind: "create"; draft: StoredDraft; missing: MissingField; attempts: number }
  | { kind: "create-conflict"; draft: StoredDraft }
  | { kind: "choose"; action: "complete" | "delete" | "update"; ids: string[]; text: string }
  | { kind: "update-conflict"; id: string; start: string; end: string | null; allDay: boolean };

const MAX_LIST_ITEMS = 12;

const HELP_TEXT =
  "Я веду ваши задачи, напоминания и встречи. Попробуйте сказать: «Напомни завтра в 10 позвонить Ивану», " +
  "«Добавь встречу с командой в четверг в 15:00», «Что у меня на этой неделе?», «Найди задачу про договор», " +
  "«Перенеси её на пятницу» или «Отметь задачу про отчёт выполненной».";

function toStored(d: ItemDraft & { deadline?: boolean }, text: string): StoredDraft {
  return {
    type: d.type,
    title: d.title,
    start: d.start ? d.start.toISO() : null,
    allDay: Boolean(d.allDay),
    end: d.end ? d.end.toISO() : null,
    durationMin: d.durationMin ?? null,
    recurrence: d.recurrence ?? null,
    deadline: Boolean(d.deadline),
    sourceText: text,
  };
}

function fromStored(s: StoredDraft, zone: string): ItemDraft & { deadline: boolean } {
  return {
    type: s.type,
    title: s.title,
    start: s.start ? DateTime.fromISO(s.start, { setZone: true }).setZone(zone) : null,
    allDay: s.allDay,
    end: s.end ? DateTime.fromISO(s.end, { setZone: true }).setZone(zone) : null,
    durationMin: s.durationMin,
    recurrence: s.recurrence,
    deadline: s.deadline,
    sourceText: s.sourceText,
  };
}

// ---------- title extraction ----------

const LEADING_FILLER = /^(?:пожалуйста|плиз|слушай|так|ну|окей|ок|давай|ассистент|эй)[,\s]+/iu;
const COMMAND_PATTERNS: RegExp[] = [
  /(?<![\p{L}])(?:напомни(?:те)?|напомнить)(?:\s+(?:мне|нам))?(?:\s+(?:о|об|обо|про|что|чтобы))?(?:\s+(?:нужно|надо))?(?![\p{L}])/giu,
  /(?<![\p{L}])(?:поставь|поставить|добавь|добавить|создай|создать|сделай|запиши|записать|запланируй|запланировать|назначь|назначить|внеси|заведи|установи)(?:\s+(?:мне|нам))?(?:\s+(?:новую|новое|новый))?(?:\s+(?:задачу|задача|напоминание|дело|в\s+календарь|в\s+список|в\s+планы))?(?![\p{L}])/giu,
  /(?<![\p{L}])(?:у\s+меня(?:\s+будет)?|(?:мне\s+)?(?:нужно|надо|необходимо|хорошо|неплохо)(?:\s+бы)?|не\s+забыть|не\s+забудь|я\s+должен|я\s+должна|хочу|хотел\p{L}*\s+бы|пожалуйста)(?![\p{L}])/giu,
  /^(?:что|чтобы|о|об|про)\s+/iu,
];

export function extractTitle(rest: string, type: ItemType): string {
  let t = rest;
  for (let i = 0; i < 3; i++) t = t.replace(LEADING_FILLER, "");
  for (const p of COMMAND_PATTERNS) t = t.replace(p, " ");
  t = t
    .replace(/[«»"“”]/g, "")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/^[\s,.!?;:—-]+|[\s,.!?;:—-]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/(?:\s|^)(?:на|в|во|к|с|до|по|о|об|и|а)$/iu, "")
    .trim();
  t = t.replace(/^(?:встречу|встрече)(?![\p{L}])/iu, "встреча");
  if (type === "meeting") {
    if (!t) return "Встреча";
    if (/^(?:с|со)\s/iu.test(t)) t = `встреча ${t}`;
  }
  return capitalize(t);
}

// ---------- engine ----------

/**
 * Offline dialogue engine: deterministic intent rules + the Russian date parser.
 * Runs when no LLM is configured and serves as a fallback when the LLM is unavailable.
 */
export class RuleEngine implements DialogueEngine {
  readonly name = "rules";

  constructor(private readonly planner: PlannerService) {}

  async handle(ctx: TurnContext): Promise<TurnResult> {
    const pending = ctx.session.pending as Pending | null;
    ctx.session.pending = null;
    if (pending) {
      const answered = await this.continuePending(ctx, pending);
      if (answered) return answered;
    }
    return this.dispatch(ctx, detectIntent(ctx.text));
  }

  private async dispatch(ctx: TurnContext, intent: Intent): Promise<TurnResult> {
    switch (intent) {
      case "cancel":
        return say("Хорошо, отменяю.");
      case "help":
        return say(HELP_TEXT);
      case "greeting":
        return say("Привет! Чем помочь? Можно добавить задачу или встречу, спросить о планах или найти старую запись.");
      case "thanks":
        return say("Пожалуйста! Обращайтесь.");
      case "undo":
        return this.undo(ctx);
      case "complete":
        return this.complete(ctx);
      case "delete":
        return this.remove(ctx);
      case "update":
        return this.update(ctx);
      case "search":
        return this.search(ctx);
      case "list":
        return this.list(ctx);
      case "create":
        return this.create(ctx);
      default: {
        // A bare "завтра в 10 купить хлеб" is still a task.
        // Questions we have no intent for are out of scope — never turn them into tasks.
        if (/\?\s*$/.test(ctx.text) || /^(?:какая|какой|какое|какие|сколько|почему|зачем|как|где|кто|что такое)(?![\p{L}])/iu.test(norm(ctx.text))) {
          return say("Я умею работать только с задачами, напоминаниями и встречами. Например, спросите «Что у меня завтра?» или скажите «Напомни в 18 позвонить маме».");
        }
        const parsed = parseDateTime(ctx.text, this.planner.now(ctx.zone));
        if (parsed.hasDate || parsed.hasTime || parsed.range) return this.create(ctx, parsed);
        // "Купить билеты в Казань", "Позвонить маме" — an infinitive opener is a to-do.
        if (/^[\p{L}-]+(?:ть|ться|чь|ти)(?![\p{L}])/iu.test(norm(ctx.text)) && !/\?\s*$/.test(ctx.text)) return this.create(ctx, parsed);
        return say(`Не совсем понял. ${HELP_TEXT}`);
      }
    }
  }

  // ----- create -----

  private async create(ctx: TurnContext, parsed?: DateParse): Promise<TurnResult> {
    const now = this.planner.now(ctx.zone);
    const p = parsed ?? parseDateTime(ctx.text, now);
    const type = detectType(ctx.text);
    // "на следующей неделе сделать X" → due by the end of that period.
    const byPeriod = !p.start && p.range && type === "task";
    const draft = {
      type,
      title: extractTitle(p.rest, type),
      start: byPeriod ? p.range!.to.minus({ days: 1 }) : p.start,
      allDay: byPeriod ? true : p.allDay,
      end: p.end,
      durationMin: p.durationMin,
      recurrence: p.recurrence,
      deadline: p.deadline || Boolean(byPeriod),
      sourceText: ctx.text,
    };
    return this.tryCreate(ctx, draft, false, p.rolledToTomorrow);
  }

  private async tryCreate(
    ctx: TurnContext,
    draft: ItemDraft & { deadline?: boolean },
    allowConflict: boolean,
    rolled = false,
  ): Promise<TurnResult> {
    const now = this.planner.now(ctx.zone);
    const res = await this.planner.create(ctx.userId, ctx.zone, draft, { allowConflict });
    if (res.status === "needs_info") {
      ctx.session.pending = { kind: "create", draft: toStored(draft, ctx.text), missing: res.missing, attempts: 0 } satisfies Pending;
      return ask(this.questionFor(draft, res.missing));
    }
    if (res.status === "conflict") {
      ctx.session.pending = { kind: "create-conflict", draft: toStored(draft, draft.sourceText ?? ctx.text) } satisfies Pending;
      const list = res.conflicts.map((c) => `«${c.item.title}» (${whenPhrase(c.start, c.end, false, now)})`).join(", ");
      return ask(`В это время уже есть ${res.conflicts.length > 1 ? "встречи" : "встреча"} ${list}. Всё равно добавить или выбрать другое время?`, [
        { kind: "listed", items: res.conflicts.map((c) => occurrenceView(c, now)) },
      ]);
    }
    const occ = res.occurrence;
    const view = occurrenceView(occ, now);
    let reply: string;
    const repeat = res.item.recurrence ? `, ${describeRecurrence(res.item.recurrence)}` : "";
    if (res.item.type === "reminder") {
      reply = `Хорошо, напомню ${whenPhrase(occ.start, null, false, now)}${repeat}: ${lowerFirst(res.item.title)}.`;
    } else if (res.item.type === "meeting") {
      reply = `Встреча добавлена: «${res.item.title}», ${whenPhrase(occ.start, occ.end, false, now)}${repeat}.`;
    } else {
      const when = !occ.start
        ? "без срока"
        : draft.deadline && occ.item.allDay
          ? `срок — ${deadlinePhrase(occ.start, now)}`
          : whenPhrase(occ.start, null, res.item.allDay, now);
      reply = `Задача добавлена: «${res.item.title}», ${when}${repeat}.`;
    }
    if (rolled) reply += " Сегодня это время уже прошло, поэтому поставил на завтра.";
    return { reply, actions: [{ kind: "created", items: [view] }], awaiting: false, focusIds: [res.item.id] };
  }

  private questionFor(draft: ItemDraft, missing: MissingField): string {
    if (missing === "title") return draft.type === "reminder" ? "О чём напомнить?" : draft.type === "meeting" ? "С кем или о чём встреча?" : "Что нужно сделать?";
    if (draft.type === "meeting") return draft.start ? "На какое время поставить встречу?" : "Когда поставить встречу? Назовите день и время.";
    if (missing === "date") return "Когда напомнить?";
    return "Во сколько напомнить?";
  }

  // ----- pending continuations -----

  private async continuePending(ctx: TurnContext, pending: Pending): Promise<TurnResult | null> {
    const now = this.planner.now(ctx.zone);
    const intent = detectIntent(ctx.text);
    if (intent === "cancel" || (pending.kind !== "create-conflict" && pending.kind !== "update-conflict" && isNo(ctx.text) && norm(ctx.text).length < 12)) {
      return say("Хорошо, не буду.");
    }

    // A different command (search, list, reschedule…) means the user moved on.
    const NEW_COMMAND: Intent[] = ["update", "delete", "complete", "search", "list", "help", "undo", "greeting"];
    if (NEW_COMMAND.includes(intent)) return null;

    if (pending.kind === "create") {
      const draft = fromStored(pending.draft, ctx.zone);
      if (intent === "create" && pending.missing !== "title") {
        // "Добавь встречу с Петей завтра в 10" while we wait for a time → a new item, not an answer.
        const p0 = parseDateTime(ctx.text, now);
        if (extractTitle(p0.rest, detectType(ctx.text)).length > 0 && !/^(?:в|на|к|давай|лучше|пусть)\s/iu.test(norm(ctx.text))) return null;
      }
      if (pending.missing === "title") {
        if (intent !== "unknown" && intent !== "create") return null;
        const title = extractTitle(ctx.text, draft.type);
        if (!title) return null;
        return this.tryCreate(ctx, { ...draft, title }, false);
      }
      // Missing time/date: accept "в 15:00", "завтра", "в три", or a bare "15".
      let p = parseDateTime(ctx.text, now);
      if (!p.hasTime && !p.hasDate && /^\s*(?:\d{1,2}(?:[:.]\d{2})?|[\p{L}\s]{2,20})\s*$/u.test(ctx.text)) {
        p = parseDateTime(`в ${ctx.text}`, now);
      }
      if (!p.hasTime && !p.hasDate) {
        if (intent !== "unknown") return null; // the user moved on to something else
        if (pending.attempts >= 1) return say("Не получилось разобрать время. Давайте начнём заново — повторите запрос целиком.");
        ctx.session.pending = { ...pending, attempts: pending.attempts + 1 } satisfies Pending;
        return ask(`Не понял время. Скажите, например: «завтра в 15:00». ${this.questionFor(draft, pending.missing)}`);
      }
      const merged = mergeWhen(draft.start ?? null, draft.allDay ?? false, p, now);
      const end = p.end ?? null;
      return this.tryCreate(ctx, { ...draft, start: merged.start, allDay: merged.allDay, end, durationMin: p.durationMin ?? draft.durationMin }, false, merged.rolled);
    }

    if (pending.kind === "create-conflict") {
      const draft = fromStored(pending.draft, ctx.zone);
      // A new time wins over "да" ("давай в 17").
      const p = parseDateTime(ctx.text, now);
      if (p.hasTime || p.hasDate) {
        const merged = mergeWhen(draft.start ?? null, false, p, now);
        return this.tryCreate(ctx, { ...draft, start: merged.start, allDay: false, end: p.end, durationMin: draft.durationMin }, false);
      }
      if (isYes(ctx.text)) return this.tryCreate(ctx, draft, true);
      if (isNo(ctx.text)) return say("Хорошо, не добавляю. Если нужно — назовите другое время.");
      return null;
    }

    if (pending.kind === "choose") {
      const items = pending.ids.map((id) => this.planner.get(ctx.userId, id)).filter((i) => i !== null);
      const idx = pickIndex(ctx.text, items.length);
      let chosen = idx !== null ? items[idx] : null;
      if (!chosen) {
        const hits = await this.planner.searchItems(ctx.userId, ctx.zone, ctx.text, { limit: 3 });
        chosen = hits.find((h) => pending.ids.includes(h.item.id))?.item ?? null;
      }
      if (!chosen) return intent === "unknown" ? ask("Не понял, какую именно. Назовите номер: первую, вторую…") : null;
      ctx.session.lastItemIds = [chosen.id];
      if (pending.action === "complete") return this.completeItem(ctx, chosen.id);
      if (pending.action === "delete") return this.deleteItem(ctx, chosen.id);
      return this.applyUpdate(ctx, chosen.id, pending.text);
    }

    if (pending.kind === "update-conflict") {
      const p = parseDateTime(ctx.text, now);
      if (p.hasTime || p.hasDate) return this.applyUpdate(ctx, pending.id, ctx.text);
      if (isYes(ctx.text)) {
        const start = DateTime.fromISO(pending.start, { setZone: true }).setZone(ctx.zone);
        const end = pending.end ? DateTime.fromISO(pending.end, { setZone: true }).setZone(ctx.zone) : null;
        return this.finishUpdate(ctx, pending.id, { start, end, allDay: pending.allDay }, true);
      }
      if (isNo(ctx.text)) return say("Хорошо, оставляю как было.");
      return null;
    }
    return null;
  }

  // ----- list -----

  private async list(ctx: TurnContext): Promise<TurnResult> {
    const now = this.planner.now(ctx.zone);
    const past = mentionsPast(ctx.text);
    const p = parseDateTime(ctx.text, now, { preferPast: past });
    const types = typesMentioned(ctx.text);
    let range = p.range ? { from: p.range.from, to: p.range.to } : null;
    let label = p.range?.label ?? "";
    const explicit = Boolean(range);
    if (/без (?:срока|даты|дедлайна)/u.test(norm(ctx.text))) {
      const undated = this.planner.allItems(ctx.userId).filter((i) => !i.startAt && i.status === "pending" && (!types || types.includes(i.type)));
      const views = undated.map((i) => occurrenceView(this.planner.firstOccurrence(i, ctx.zone), now));
      const reply = undated.length
        ? `Без срока ${undated.length} ${plural(undated.length, TYPE_LABELS.task.plural)}: ${undated.slice(0, 10).map((i) => `«${i.title}»`).join(", ")}.`
        : "Задач без срока нет.";
      return { reply, actions: [{ kind: "listed", items: views }], awaiting: false, focusIds: undated.map((i) => i.id) };
    }
    const everything = /(?:^|\s)(?:все|всё|весь список)(?:\s|$)/u.test(norm(ctx.text));
    if (!range) {
      range = { from: now.startOf("day"), to: now.startOf("day").plus(everything ? { years: 1 } : { days: 7 }) };
      label = everything ? "" : "ближайшие 7 дней";
    }
    const includeDone = past || range.to <= now;
    const occurrences = this.planner.list(ctx.userId, ctx.zone, range, { types, includeDone, includeUndated: !explicit });
    const singleDay = range.to.diff(range.from, "days").days <= 1;
    const subject = types?.length === 1 ? TYPE_LABELS[types[0]].plural : types?.includes("task") ? TYPE_LABELS.task.plural : (["запись", "записи", "записей"] as [string, string, string]);
    const header = singleDay ? capitalize(dayPhrase(range.from, now)) : label ? `На ${label}` : everything ? "Всего впереди" : "В ближайшие 7 дней";
    const yesNo = isYesNoQuestion(ctx.text);
    const views = occurrences.map((o) => occurrenceView(o, now));
    const actions: AssistantAction[] = [{ kind: "listed", items: views }];
    const focusIds = occurrences.map((o) => o.item.id);

    if (occurrences.length === 0) {
      const what = types?.length ? subject[2] : "ничего не запланировано";
      const reply = yesNo ? `Нет, ${lowerFirst(header)} ${types?.length ? `${what} нет` : "ничего не запланировано"}.` : `${header} ${types?.length ? `${what} нет` : what}.`;
      return { reply: reply.replace(/\s+/g, " "), actions, awaiting: false, focusIds };
    }

    const count = `${occurrences.length} ${plural(occurrences.length, subject)}`;
    const dated = occurrences.filter((o) => o.start);
    const undated = occurrences.filter((o) => !o.start);
    const parts: string[] = [];
    if (singleDay) {
      parts.push(dated.slice(0, MAX_LIST_ITEMS).map(describeInDay).join("; "));
    } else {
      const byDay = new Map<string, Occurrence[]>();
      for (const o of dated.slice(0, MAX_LIST_ITEMS)) {
        const key = o.start!.toISODate()!;
        byDay.set(key, [...(byDay.get(key) ?? []), o]);
      }
      for (const day of byDay.values()) parts.push(`${capitalize(dayPhrase(day[0].start!, now))}: ${day.map(describeInDay).join("; ")}`);
    }
    if (undated.length) parts.push(`Без срока: ${undated.slice(0, 5).map((o) => `«${o.item.title}»`).join(", ")}`);
    const more = dated.length > MAX_LIST_ITEMS ? ` И ещё ${dated.length - MAX_LIST_ITEMS}.` : "";
    const lead = yesNo ? `Да, ${lowerFirst(header)} ${count}` : `${header} ${count}`;
    const reply = `${lead}${singleDay ? ":" : "."} ${parts.filter(Boolean).join(". ")}.${more}`;
    return { reply, actions, awaiting: false, focusIds };
  }

  // ----- search -----

  private searchQuery(text: string): string {
    const now = DateTime.now();
    return parseDateTime(text, now)
      .rest.toLowerCase()
      .replace(/ё/g, "е")
      .replace(/(?<![\p{L}])(?:найди|найти|поищи|ищи|отыщи|разыщи|покажи|мне|пожалуйста|когда-то|когда то|как-то|однажды|когда|у меня|есть ли|был[аио]? ли|я|ставил[а]?|создавал[а]?|записывал[а]?|добавлял[а]?|планировал[а]?|намечал[а]?|все|всё|что|был|была|было|были|будет|будут|назначен\p{L}*|запланирован\p{L}*|стоит)(?![\p{L}])/gu, " ")
      .replace(/(?<![\p{L}])(?:задач\p{L}*|встреч\p{L}*|напоминани\p{L}*|запис\p{L}*|событи\p{L}*|дело|дела)(?![\p{L}])/gu, " ")
      .replace(/(?<![\p{L}])(?:про|о|об|по|насчет|касательно|связанн\p{L}*|ее|его|их|она|он)(?![\p{L}])/gu, " ")
      .replace(/[?!.,]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private async search(ctx: TurnContext): Promise<TurnResult> {
    const now = this.planner.now(ctx.zone);
    const query = this.searchQuery(ctx.text);
    const types = typesMentioned(ctx.text);
    const asksWhen = /(?:^|\s)когда(?:\s|$)/u.test(norm(ctx.text)) && !/когда-то|когда то/u.test(norm(ctx.text));
    const period = /(?:^|\s)когда\s+(?:у меня\s+)?(?:был|была|было|были)(?:\s|$)/u.test(norm(ctx.text)) ? "past" : mentionsFuture(ctx.text) && asksWhen ? "future" : "any";
    if (!query) return ask("Что именно найти? Например: «найди задачу про презентацию».");

    let hits = await this.planner.searchItems(ctx.userId, ctx.zone, query, { types, period, limit: 5 });
    if (!hits.length && period !== "any") hits = await this.planner.searchItems(ctx.userId, ctx.zone, query, { types, limit: 5 });
    if (!hits.length && types) hits = await this.planner.searchItems(ctx.userId, ctx.zone, query, { limit: 5 });
    if (!hits.length) return say(`Не нашёл ничего про «${query}». Попробуйте сказать иначе.`);

    // Keep only results reasonably close to the best one.
    const top = hits[0].score;
    const shown = hits.filter((h) => h.score >= top - 0.25);
    const occs = shown.map((h) => this.planner.relevantOccurrence(h.item, ctx.zone));
    const views = occs.map((o) => occurrenceView(o, now));
    const actions: AssistantAction[] = [{ kind: "found", items: views }];
    const focusIds = occs.map((o) => o.item.id);

    if (occs.length === 1) {
      const o = occs[0];
      if (asksWhen && o.start) {
        const past = o.start < now;
        const verb =
          o.item.type === "meeting" ? (past ? "была" : "будет") : o.item.type === "task" ? (past ? "была запланирована" : "запланирована") : past ? "было запланировано" : "запланировано";
        const reply = `${capitalize(TYPE_LABELS[o.item.type].one)} «${o.item.title}» ${verb} ${whenPhrase(o.start, o.end, o.item.allDay, now)}.`;
        return { reply, actions, awaiting: false, focusIds };
      }
      return { reply: `Нашёл: ${describeOccurrence(o, now)}.`, actions, awaiting: false, focusIds };
    }
    const list = occs.map((o, i) => `${i + 1}) ${describeOccurrence(o, now)}`).join("; ");
    return { reply: `Нашёл ${occs.length} ${plural(occs.length, ["запись", "записи", "записей"])}: ${list}.`, actions, awaiting: false, focusIds };
  }

  // ----- target resolution for complete / delete / update -----

  private async resolveTarget(
    ctx: TurnContext,
    action: "complete" | "delete" | "update",
  ): Promise<{ id: string } | { result: TurnResult }> {
    const query = this.searchQuery(
      ctx.text.replace(
        /(?<![\p{L}])(?:отметь|пометь|отмечай|поставь|сделай|выполнен\p{L}*|сделан\p{L}*|готов\p{L}*|завершен\p{L}*|выполнил\p{L}*|сделал\p{L}*|закончил\p{L}*|закрой|заверши|удали|удалить|убери|сотри|отмени|отменить|перенеси|перенести|передвинь|сдвинь|подвинь|измени|поменяй|переименуй|исправь|как|позже|раньше|вперед|назад|время|название|на час|на \d+ минут\p{L}*)(?![\p{L}])/giu,
        " ",
      ),
    );
    const meaningful = query.replace(/(?<![\p{L}])(?:это|эту|этот|эта|последн\p{L}*|предыдущ\p{L}*|только|что|в|на|и)(?![\p{L}])/gu, "").trim();
    const last = ctx.session.lastItemIds.find((id) => this.planner.get(ctx.userId, id));
    if ((refersToPrevious(ctx.text) || !meaningful) && last) return { id: last };
    if (!meaningful) return { result: say("Уточните, о какой записи речь — например: «отметь задачу про отчёт выполненной».") };

    const types = typesMentioned(ctx.text);
    let hits = await this.planner.searchItems(ctx.userId, ctx.zone, meaningful, { types, limit: 5 });
    if (action === "complete") hits = hits.filter((h) => h.item.status === "pending");
    if (!hits.length) return { result: say(`Не нашёл записи про «${meaningful}».`) };
    const close = hits.filter((h) => h.score >= hits[0].score - 0.1);
    if (close.length === 1) return { id: close[0].item.id };

    const now = this.planner.now(ctx.zone);
    const occs = close.slice(0, 4).map((h) => this.planner.relevantOccurrence(h.item, ctx.zone));
    ctx.session.pending = { kind: "choose", action, ids: occs.map((o) => o.item.id), text: ctx.text } satisfies Pending;
    const verb = action === "complete" ? "отметить" : action === "delete" ? "удалить" : "изменить";
    const list = occs.map((o, i) => `${i + 1}) ${describeOccurrence(o, now)}`).join("; ");
    return { result: ask(`Нашёл несколько: ${list}. Какую ${verb}?`, [{ kind: "found", items: occs.map((o) => occurrenceView(o, now)) }]) };
  }

  // ----- complete -----

  private async complete(ctx: TurnContext): Promise<TurnResult> {
    const target = await this.resolveTarget(ctx, "complete");
    if ("result" in target) return target.result;
    return this.completeItem(ctx, target.id);
  }

  private completeItem(ctx: TurnContext, id: string): TurnResult {
    const now = this.planner.now(ctx.zone);
    const undo = /не выполнен|не сделан|верни в работу|сними отметку/u.test(norm(ctx.text));
    const res = this.planner.complete(ctx.userId, ctx.zone, id, !undo);
    if (!res) return say("Эта запись уже удалена.");
    const view = occurrenceView(res.advancedTo ?? this.planner.firstOccurrence(res.item, ctx.zone), now);
    const reply = res.advancedTo
      ? `Отметил «${res.item.title}». Следующий раз — ${whenPhrase(res.advancedTo.start, res.advancedTo.end, res.item.allDay, now)}.`
      : undo
        ? `Вернул «${res.item.title}» в работу.`
        : `Отлично, «${res.item.title}» отмечено как выполненное.`;
    return { reply, actions: [{ kind: "completed", items: [view] }], awaiting: false, focusIds: [id] };
  }

  // ----- delete / undo -----

  private async remove(ctx: TurnContext): Promise<TurnResult> {
    const target = await this.resolveTarget(ctx, "delete");
    if ("result" in target) return target.result;
    return this.deleteItem(ctx, target.id);
  }

  private deleteItem(ctx: TurnContext, id: string): TurnResult {
    const now = this.planner.now(ctx.zone);
    const item = this.planner.delete(ctx.userId, id);
    if (!item) return say("Эта запись уже удалена.");
    ctx.session.lastDeleted = item;
    const view = occurrenceView(this.planner.firstOccurrence(item, ctx.zone), now);
    return {
      reply: `Удалил ${TYPE_LABELS[item.type].acc} «${item.title}». Если это ошибка, скажите «верни».`,
      actions: [{ kind: "deleted", items: [view] }],
      awaiting: false,
      focusIds: [],
    };
  }

  private undo(ctx: TurnContext): TurnResult {
    const item = ctx.session.lastDeleted;
    if (!item) return say("Нечего восстанавливать.");
    this.planner.restore(item);
    ctx.session.lastDeleted = null;
    const now = this.planner.now(ctx.zone);
    const occ = this.planner.relevantOccurrence(item, ctx.zone);
    return {
      reply: `Вернул ${TYPE_LABELS[item.type].acc} «${item.title}» (${whenPhrase(occ.start, occ.end, item.allDay, now)}).`,
      actions: [{ kind: "restored", items: [occurrenceView(occ, now)] }],
      awaiting: false,
      focusIds: [item.id],
    };
  }

  // ----- update / reschedule -----

  private async update(ctx: TurnContext): Promise<TurnResult> {
    const target = await this.resolveTarget(ctx, "update");
    if ("result" in target) return target.result;
    return this.applyUpdate(ctx, target.id, ctx.text);
  }

  private async applyUpdate(ctx: TurnContext, id: string, text: string): Promise<TurnResult> {
    const item = this.planner.get(ctx.userId, id);
    if (!item) return say("Эта запись уже удалена.");
    const now = this.planner.now(ctx.zone);
    const current = this.planner.relevantOccurrence(item, ctx.zone);
    const t = norm(text);

    // Rename: "переименуй её в «Созвон с Петей»".
    const rename = /(?:переименуй|измени название|поменяй название|назови)\p{L}*.*?\s(?:в|на)\s+(.+)$/u.exec(text);
    if (rename && /переименуй|название|назови/u.test(t)) {
      const title = rename[1].replace(/[«»"“”]/g, "").trim();
      const res = await this.planner.update(ctx.userId, ctx.zone, id, { title });
      if (res.status !== "updated") return say("Не получилось переименовать.");
      return updated(`Готово, теперь называется «${res.item.title}».`, res.occurrence, now);
    }

    // Relative shift: "на час позже", "на 30 минут раньше", "на два дня вперёд".
    const shift = /на\s+(?:(\d+|[\p{L}]+)\s+)?(минут\p{L}*|час\p{L}*|дн\p{L}*|день|недел\p{L}*)\s+(позже|раньше|вперед|назад)/u.exec(t);
    if (shift && current.start) {
      const n = shift[1] ? parseNumber(shift[1]) ?? 1 : 1;
      const sign = shift[3] === "раньше" || shift[3] === "назад" ? -1 : 1;
      const unit = shift[2].startsWith("мин") ? "minutes" : shift[2].startsWith("час") ? "hours" : shift[2].startsWith("недел") ? "weeks" : "days";
      const start = current.start.plus({ [unit]: sign * n });
      const end = current.end ? current.end.plus({ [unit]: sign * n }) : null;
      return this.finishUpdate(ctx, id, { start, end, allDay: item.allDay }, false);
    }

    const p = parseDateTime(text, now);
    if (!p.hasDate && !p.hasTime) {
      ctx.session.lastItemIds = [id];
      return ask(`На когда перенести «${item.title}»?`);
    }
    const merged = mergeWhen(current.start, item.allDay, p, now);
    let end: DateTime | null = p.end;
    if (!end && current.start && current.end && merged.start && !merged.allDay) end = merged.start.plus(current.end.diff(current.start));
    return this.finishUpdate(ctx, id, { start: merged.start, end, allDay: merged.allDay }, false);
  }

  private async finishUpdate(
    ctx: TurnContext,
    id: string,
    when: { start: DateTime | null; end: DateTime | null; allDay: boolean },
    allowConflict: boolean,
  ): Promise<TurnResult> {
    const now = this.planner.now(ctx.zone);
    const res = await this.planner.update(ctx.userId, ctx.zone, id, { start: when.start, end: when.end, allDay: when.allDay }, { allowConflict });
    if (res.status === "not_found") return say("Эта запись уже удалена.");
    if (res.status === "conflict") {
      ctx.session.pending = {
        kind: "update-conflict",
        id,
        start: when.start!.toISO()!,
        end: when.end ? when.end.toISO() : null,
        allDay: when.allDay,
      } satisfies Pending;
      const list = res.conflicts.map((c) => `«${c.item.title}» (${whenPhrase(c.start, c.end, false, now)})`).join(", ");
      return ask(`В это время уже есть ${list}. Всё равно перенести?`);
    }
    const o = res.occurrence;
    return updated(`Готово: «${res.item.title}» теперь ${whenPhrase(o.start, o.end, res.item.allDay, now)}.`, o, now);
  }
}

// ---------- helpers ----------

/** Combines a new partial date/time with an existing start: only-time keeps the day, only-date keeps the time. */
function mergeWhen(
  existing: DateTime | null,
  existingAllDay: boolean,
  p: DateParse,
  now: DateTime,
): { start: DateTime | null; allDay: boolean; rolled: boolean } {
  if (!p.start) return { start: existing, allDay: existingAllDay, rolled: false };
  if (p.hasDate && p.hasTime) return { start: p.start, allDay: false, rolled: false };
  if (p.hasDate && !p.hasTime) {
    if (existing && !existingAllDay) return { start: p.start.set({ hour: existing.hour, minute: existing.minute }), allDay: false, rolled: false };
    return { start: p.start, allDay: true, rolled: false };
  }
  // Only a time was given.
  if (existing) {
    let start = existing.set({ hour: p.start.hour, minute: p.start.minute, second: 0, millisecond: 0 });
    let rolled = false;
    if (existingAllDay && dayRange(existing).from.hasSame(now, "day") && start <= now) {
      start = start.plus({ days: 1 });
      rolled = true;
    }
    return { start, allDay: false, rolled };
  }
  return { start: p.start, allDay: false, rolled: p.rolledToTomorrow };
}

function lowerFirst(s: string): string {
  // Keep proper names and acronyms: only lower a capital followed by a lowercase letter.
  return /^[А-ЯЁA-Z][а-яёa-z]/u.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

function say(reply: string): TurnResult {
  return { reply, actions: [], awaiting: false, focusIds: [] };
}

function ask(reply: string, actions: AssistantAction[] = []): TurnResult {
  return { reply, actions, awaiting: true, focusIds: [] };
}

function updated(reply: string, occ: Occurrence, now: DateTime): TurnResult {
  return { reply, actions: [{ kind: "updated", items: [occurrenceView(occ, now)] }], awaiting: false, focusIds: [occ.item.id] };
}
