import { DateTime } from "luxon";
import { z } from "zod";
import { occurrenceView } from "../domain/format.js";
import type { PlannerService } from "../domain/planner-service.js";
import { parseLocal } from "../domain/time.js";
import { ITEM_TYPES, type Recurrence } from "../domain/types.js";
import type { ToolSpec } from "../llm/provider.js";
import type { SessionState } from "../storage/sessions-repo.js";
import type { AssistantAction } from "./types.js";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const TIME = z.string().regex(/^\d{1,2}:\d{2}$/, "HH:MM");
const TYPE = z.enum(ITEM_TYPES);

const RecurrenceSchema = z.object({
  freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).max(365).optional().describe("Every N periods, default 1"),
  weekdays: z.array(z.number().int().min(1).max(7)).optional().describe("ISO weekdays 1=Mon…7=Sun, weekly only"),
  until: DATE.optional().describe("Last date of the series"),
});

const schemas = {
  create_item: z.object({
    type: TYPE.describe("reminder — user asked to be reminded; meeting — meeting/call/appointment with someone; task — anything to do"),
    title: z.string().min(1).describe("Short Russian title without date words: «Позвонить Ивану», «Встреча с командой»"),
    date: DATE.optional().describe("Local date. Omit for tasks without a date"),
    time: TIME.optional().describe("Local 24h time. Omit if the user gave no time"),
    end_time: TIME.optional(),
    duration_minutes: z.number().int().min(5).max(1440).optional(),
    notes: z.string().optional(),
    recurrence: RecurrenceSchema.optional(),
    allow_conflict: z.boolean().optional().describe("Only after the user explicitly confirmed an overlapping meeting"),
  }),
  list_items: z.object({
    from_date: DATE.describe("First day, inclusive"),
    to_date: DATE.describe("Last day, inclusive"),
    types: z.array(TYPE).optional(),
    include_done: z.boolean().optional(),
    include_undated: z.boolean().optional().describe("Also return tasks without a date"),
  }),
  search_items: z.object({
    query: z.string().min(1).describe("Key words of what to find, e.g. «презентация», «Иван», «договор»"),
    related_terms: z.array(z.string()).max(10).optional().describe("Synonyms and close concepts in Russian, e.g. for «договор»: контракт, соглашение"),
    types: z.array(TYPE).optional(),
    period: z.enum(["past", "future", "any"]).optional(),
  }),
  update_item: z.object({
    id: z.string(),
    title: z.string().optional(),
    type: TYPE.optional(),
    date: DATE.optional().describe("New date; if time is omitted the old time is kept"),
    time: TIME.optional().describe("New time; if date is omitted the old date is kept"),
    end_time: TIME.optional(),
    duration_minutes: z.number().int().min(5).max(1440).optional(),
    clear_date: z.boolean().optional().describe("Remove the date entirely (task becomes undated)"),
    notes: z.string().optional(),
    recurrence: RecurrenceSchema.nullable().optional().describe("null stops repeating"),
    allow_conflict: z.boolean().optional(),
  }),
  complete_item: z.object({
    id: z.string(),
    done: z.boolean().optional().describe("false re-opens the item"),
  }),
  delete_item: z.object({ id: z.string() }),
  restore_last_deleted: z.object({}),
};

type ToolName = keyof typeof schemas;

const DESCRIPTIONS: Record<ToolName, string> = {
  create_item:
    "Create a task, reminder or meeting. Returns status created | needs_info (ask the user the suggested_question) | conflict (overlapping meetings — ask the user).",
  list_items: "List items scheduled in a date range (recurring items are expanded). Use for «что у меня сегодня», «планы на неделю».",
  search_items:
    "Find items by meaning across all dates (past and future, done or not). Use for «найди задачу про…», «когда была встреча с…», and to get an id before changing an item.",
  update_item: "Change an existing item: reschedule, rename, change type/notes/recurrence. Returns updated | conflict | not_found.",
  complete_item: "Mark an item as done (recurring items move to the next occurrence).",
  delete_item: "Delete an item.",
  restore_last_deleted: "Undo the most recent deletion («верни», «восстанови»).",
};

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export const TOOL_SPECS: ToolSpec[] = (Object.keys(schemas) as ToolName[]).map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  inputSchema: jsonSchema(schemas[name]),
}));

function toRecurrence(r: z.infer<typeof RecurrenceSchema> | null | undefined): Recurrence | null | undefined {
  if (r === undefined) return undefined;
  if (r === null) return null;
  return { freq: r.freq, interval: r.interval ?? 1, byWeekday: r.weekdays?.length ? [...new Set(r.weekdays)].sort() : undefined, until: r.until };
}

const QUESTIONS = {
  meeting: { time: "На какое время поставить встречу?", date: "Когда поставить встречу?", title: "С кем или о чём встреча?" },
  reminder: { time: "Во сколько напомнить?", date: "Когда напомнить?", title: "О чём напомнить?" },
  task: { time: "На какое время?", date: "На какой день?", title: "Что нужно сделать?" },
} as const;

/**
 * Executes tool calls against the planner. Collects UI actions, the items the turn
 * focused on (for "её/его" follow-ups) and whether anything was changed.
 */
export class ToolExecutor {
  readonly actions: AssistantAction[] = [];
  focusIds: string[] = [];
  mutated = false;

  constructor(
    private readonly planner: PlannerService,
    private readonly userId: string,
    private readonly zone: string,
    private readonly session: SessionState,
    private readonly userText: string,
  ) {}

  async run(name: string, rawInput: unknown): Promise<{ content: string; isError: boolean }> {
    if (!(name in schemas)) return this.error(`Unknown tool ${name}`);
    const parsed = schemas[name as ToolName].safeParse(rawInput ?? {});
    if (!parsed.success) return this.error(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    try {
      const result = await this.dispatch(name as ToolName, parsed.data);
      return { content: JSON.stringify(result), isError: false };
    } catch (err) {
      return this.error((err as Error).message);
    }
  }

  private error(message: string) {
    return { content: JSON.stringify({ error: message }), isError: true };
  }

  private now(): DateTime {
    return this.planner.now(this.zone);
  }

  private when(date: string | undefined, time: string | undefined): DateTime | null {
    if (!date && !time) return null;
    const day = date ?? this.now().toISODate()!;
    const dt = parseLocal(day, time, this.zone);
    if (!dt) throw new Error(`Bad date/time: ${date} ${time}`);
    return dt;
  }

  // The parsed input type depends on the tool; each branch narrows it via the schema.
  private async dispatch(name: ToolName, input: any): Promise<unknown> {
    const now = this.now();
    switch (name) {
      case "create_item": {
        const i = input as z.infer<typeof schemas.create_item>;
        let start = this.when(i.date, i.time);
        // A time without a date that already passed today means tomorrow.
        if (start && !i.date && i.time && start <= now) start = start.plus({ days: 1 });
        const end = start && i.end_time ? parseLocal(start.toISODate()!, i.end_time, this.zone) : null;
        const res = await this.planner.create(
          this.userId,
          this.zone,
          {
            type: i.type,
            title: i.title,
            notes: i.notes,
            start,
            allDay: Boolean(start && !i.time),
            end,
            durationMin: i.duration_minutes,
            recurrence: toRecurrence(i.recurrence),
            sourceText: this.userText,
          },
          { allowConflict: i.allow_conflict },
        );
        if (res.status === "needs_info") return { status: "needs_info", missing: res.missing, suggested_question: QUESTIONS[i.type][res.missing] };
        if (res.status === "conflict") {
          return {
            status: "conflict",
            conflicts: res.conflicts.map((c) => occurrenceView(c, now)),
            hint: "Tell the user about the overlap and ask: add anyway or choose another time?",
          };
        }
        this.mutated = true;
        const view = occurrenceView(res.occurrence, now);
        this.actions.push({ kind: "created", items: [view] });
        this.focusIds = [res.item.id];
        return { status: "created", item: view };
      }

      case "list_items": {
        const i = input as z.infer<typeof schemas.list_items>;
        const from = parseLocal(i.from_date, null, this.zone);
        const to = parseLocal(i.to_date, null, this.zone);
        if (!from || !to) throw new Error("Bad range");
        const occ = this.planner.list(this.userId, this.zone, { from, to: to.plus({ days: 1 }) }, {
          types: i.types,
          includeDone: i.include_done ?? to < now.startOf("day"),
          includeUndated: i.include_undated,
        });
        const views = occ.map((o) => occurrenceView(o, now));
        this.actions.push({ kind: "listed", items: views });
        this.focusIds = views.map((v) => v.id);
        return { count: views.length, items: views };
      }

      case "search_items": {
        const i = input as z.infer<typeof schemas.search_items>;
        const hits = await this.planner.searchItems(this.userId, this.zone, i.query, {
          types: i.types,
          period: i.period,
          related: i.related_terms,
          limit: 6,
        });
        const views = hits.map((h) => ({ ...occurrenceView(this.planner.relevantOccurrence(h.item, this.zone), now), relevance: Number(h.score.toFixed(2)) }));
        if (views.length) {
          this.actions.push({ kind: "found", items: views });
          this.focusIds = views.map((v) => v.id);
        }
        return { count: views.length, items: views };
      }

      case "update_item": {
        const i = input as z.infer<typeof schemas.update_item>;
        const item = this.planner.get(this.userId, i.id);
        if (!item) return { status: "not_found" };
        const current = this.planner.relevantOccurrence(item, this.zone);
        let start: DateTime | null | undefined;
        let allDay: boolean | undefined;
        let end: DateTime | null | undefined;
        if (i.clear_date) {
          start = null;
        } else if (i.date || i.time) {
          const base = i.date ?? current.start?.toISODate() ?? now.toISODate()!;
          const time = i.time ?? (current.start && !item.allDay ? current.start.toFormat("HH:mm") : undefined);
          start = parseLocal(base, time, this.zone);
          if (!start) throw new Error("Bad date/time");
          allDay = !time;
          if (current.start && current.end && !allDay && !i.end_time && !i.duration_minutes) {
            end = start.plus(current.end.diff(current.start));
          }
        }
        if (i.end_time) end = parseLocal((start ?? current.start ?? now).toISODate()!, i.end_time, this.zone);
        const res = await this.planner.update(
          this.userId,
          this.zone,
          i.id,
          {
            title: i.title,
            type: i.type,
            notes: i.notes,
            start,
            allDay,
            end,
            durationMin: i.duration_minutes,
            recurrence: toRecurrence(i.recurrence),
          },
          { allowConflict: i.allow_conflict },
        );
        if (res.status === "not_found") return { status: "not_found" };
        if (res.status === "conflict") {
          return { status: "conflict", conflicts: res.conflicts.map((c) => occurrenceView(c, now)), hint: "Ask the user whether to move it anyway." };
        }
        this.mutated = true;
        const view = occurrenceView(res.occurrence, now);
        this.actions.push({ kind: "updated", items: [view] });
        this.focusIds = [res.item.id];
        return { status: "updated", before: occurrenceView(res.before, now).when, item: view };
      }

      case "complete_item": {
        const i = input as z.infer<typeof schemas.complete_item>;
        const res = this.planner.complete(this.userId, this.zone, i.id, i.done ?? true);
        if (!res) return { status: "not_found" };
        this.mutated = true;
        const view = occurrenceView(res.advancedTo ?? this.planner.firstOccurrence(res.item, this.zone), now);
        this.actions.push({ kind: "completed", items: [view] });
        this.focusIds = [res.item.id];
        return res.advancedTo ? { status: "advanced_to_next_occurrence", next: view.when, item: view } : { status: res.item.status, item: view };
      }

      case "delete_item": {
        const i = input as z.infer<typeof schemas.delete_item>;
        const item = this.planner.delete(this.userId, i.id);
        if (!item) return { status: "not_found" };
        this.mutated = true;
        this.session.lastDeleted = item;
        const view = occurrenceView(this.planner.firstOccurrence(item, this.zone), now);
        this.actions.push({ kind: "deleted", items: [view] });
        this.focusIds = [];
        return { status: "deleted", item: view };
      }

      case "restore_last_deleted": {
        const item = this.session.lastDeleted;
        if (!item) return { status: "nothing_to_restore" };
        this.planner.restore(item);
        this.session.lastDeleted = null;
        this.mutated = true;
        const view = occurrenceView(this.planner.relevantOccurrence(item, this.zone), now);
        this.actions.push({ kind: "restored", items: [view] });
        this.focusIds = [item.id];
        return { status: "restored", item: view };
      }
    }
  }
}
