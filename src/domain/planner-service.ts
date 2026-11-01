import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type { ItemsRepo } from "../storage/items-repo.js";
import type { SearchEngine, SearchHit } from "../search/search-engine.js";
import { expandOccurrences, nextOccurrence } from "./recurrence.js";
import { itemEnd, itemStart, toUtcIso } from "./time.js";
import type { DateRange, Item, ItemDraft, ItemType, Occurrence, Recurrence } from "./types.js";

export const DEFAULT_MEETING_MIN = 60;
/** Meetings are announced this many minutes before they start. */
export const MEETING_HEADS_UP_MIN = 10;

export type Clock = () => DateTime;

export type MissingField = "title" | "time" | "date";

export type CreateResult =
  | { status: "created"; item: Item; occurrence: Occurrence }
  | { status: "needs_info"; missing: MissingField; draft: ItemDraft }
  | { status: "conflict"; conflicts: Occurrence[]; draft: ItemDraft };

export type UpdateResult =
  | { status: "updated"; item: Item; occurrence: Occurrence; before: Occurrence }
  | { status: "not_found" }
  | { status: "conflict"; conflicts: Occurrence[]; item: Item };

export interface ItemPatch {
  type?: ItemType;
  title?: string;
  notes?: string | null;
  start?: DateTime | null;
  allDay?: boolean;
  end?: DateTime | null;
  durationMin?: number | null;
  recurrence?: Recurrence | null;
}

export interface ListFilter {
  types?: ItemType[];
  includeDone?: boolean;
  /** Also return items without a date (task inbox). */
  includeUndated?: boolean;
}

export interface SearchOptions {
  types?: ItemType[];
  /** Restrict to items that already happened / are still ahead. */
  period?: "past" | "future" | "any";
  related?: string[];
  limit?: number;
}

/**
 * Business logic for tasks, reminders and meetings. Independent of HTTP, LLMs and voice:
 * both the LLM agent and the rule-based engine call exactly these methods.
 */
export class PlannerService {
  constructor(
    private readonly repo: ItemsRepo,
    private readonly search: SearchEngine,
    private readonly clock: Clock = () => DateTime.now(),
  ) {}

  now(zone: string): DateTime {
    return this.clock().setZone(zone);
  }

  // ---------- create ----------

  /** Validates the draft, checks meeting conflicts and stores the item. */
  async create(userId: string, zone: string, draft: ItemDraft, opts: { allowConflict?: boolean } = {}): Promise<CreateResult> {
    const title = draft.title?.trim();
    if (!title) return { status: "needs_info", missing: "title", draft };
    const allDay = Boolean(draft.start && draft.allDay);
    if (draft.type === "meeting" && (!draft.start || allDay)) return { status: "needs_info", missing: "time", draft };
    if (draft.type === "reminder" && !draft.start) return { status: "needs_info", missing: "date", draft };
    if (draft.type === "reminder" && allDay) return { status: "needs_info", missing: "time", draft };

    const start = draft.start ? (allDay ? draft.start.startOf("day") : draft.start.set({ second: 0, millisecond: 0 })) : null;
    const end = this.resolveEnd(draft.type, start, allDay, draft.end, draft.durationMin);

    if (draft.type === "meeting" && start && end && !opts.allowConflict) {
      const conflicts = this.findConflicts(userId, zone, start, end, null);
      if (conflicts.length) return { status: "conflict", conflicts, draft };
    }

    const nowIso = toUtcIso(this.clock());
    const item: Item = {
      id: randomUUID(),
      userId,
      type: draft.type,
      title: title[0].toUpperCase() + title.slice(1),
      notes: draft.notes?.trim() || null,
      startAt: start ? toUtcIso(start) : null,
      endAt: end ? toUtcIso(end) : null,
      allDay,
      timezone: zone,
      status: "pending",
      recurrence: start ? (draft.recurrence ?? null) : null,
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null,
      lastNotifiedAt: null,
      sourceText: draft.sourceText ?? null,
    };
    this.repo.insert(item);
    void this.refreshEmbedding(item);
    return { status: "created", item, occurrence: this.firstOccurrence(item, zone) };
  }

  private resolveEnd(
    type: ItemType,
    start: DateTime | null,
    allDay: boolean,
    end: DateTime | null | undefined,
    durationMin: number | null | undefined,
  ): DateTime | null {
    if (!start || allDay) return null;
    if (end && end > start) return end;
    if (durationMin && durationMin > 0) return start.plus({ minutes: durationMin });
    return type === "meeting" ? start.plus({ minutes: DEFAULT_MEETING_MIN }) : null;
  }

  /** Overlapping pending meetings (half-open intervals). */
  findConflicts(userId: string, zone: string, start: DateTime, end: DateTime, excludeId: string | null): Occurrence[] {
    const window = { from: start.startOf("day"), to: end.endOf("day") };
    return this.list(userId, zone, window, { types: ["meeting"] }).filter(
      (o) => o.item.id !== excludeId && o.start && o.end && o.start < end && o.end > start,
    );
  }

  // ---------- read ----------

  get(userId: string, id: string): Item | null {
    return this.repo.get(userId, id);
  }

  /** Every item of the user, newest first. */
  allItems(userId: string): Item[] {
    return this.repo.all(userId);
  }

  /** Occurrences intersecting the range, recurring items expanded, sorted by time. */
  list(userId: string, zone: string, range: DateRange, filter: ListFilter = {}): Occurrence[] {
    // Widen the SQL window by a day so all-day items stored in another zone are not missed.
    const candidates = this.repo.listCandidates(
      userId,
      toUtcIso(range.from.minus({ days: 1 })),
      toUtcIso(range.to.plus({ days: 1 })),
      Boolean(filter.includeUndated),
    );
    const out: Occurrence[] = [];
    for (const item of candidates) {
      if (filter.types?.length && !filter.types.includes(item.type)) continue;
      if (!filter.includeDone && item.status === "done") continue;
      const start = itemStart(item, zone);
      if (!start) {
        out.push({ item, start: null, end: null });
        continue;
      }
      const end = itemEnd(item, zone);
      const durationMs = end ? end.toMillis() - start.toMillis() : 0;
      const starts = item.recurrence ? expandOccurrences(start, item.recurrence, range) : [start];
      for (const s of starts) {
        if (s < range.from || s >= range.to) continue;
        out.push({ item, start: s, end: end ? s.plus({ milliseconds: durationMs }) : null });
      }
    }
    return out.sort(compareOccurrences);
  }

  firstOccurrence(item: Item, zone: string): Occurrence {
    const start = itemStart(item, zone);
    return { item, start, end: itemEnd(item, zone) };
  }

  /** The occurrence closest to now — next upcoming for recurring items. */
  relevantOccurrence(item: Item, zone: string): Occurrence {
    const first = this.firstOccurrence(item, zone);
    if (!item.recurrence || !first.start) return first;
    const now = this.now(zone);
    if (first.start >= now) return first;
    const next = nextOccurrence(first.start, item.recurrence, now.minus({ minutes: 1 }));
    if (!next) return first;
    const shift = next.diff(first.start);
    return { item, start: next, end: first.end ? first.end.plus(shift) : null };
  }

  async searchItems(userId: string, zone: string, text: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const now = this.now(zone);
    const items = this.repo.all(userId).filter((i) => {
      if (opts.types?.length && !opts.types.includes(i.type)) return false;
      if (!opts.period || opts.period === "any") return true;
      const occ = this.relevantOccurrence(i, zone);
      if (!occ.start) return opts.period === "future";
      return opts.period === "past" ? occ.start < now : occ.start >= now.startOf("day");
    });
    const vectors = this.search.semantic ? this.repo.embeddings(userId) : undefined;
    const hits = await this.search.search(items, { text, related: opts.related }, vectors);
    return hits.slice(0, opts.limit ?? 5);
  }

  // ---------- update ----------

  async update(userId: string, zone: string, id: string, patch: ItemPatch, opts: { allowConflict?: boolean } = {}): Promise<UpdateResult> {
    const item = this.repo.get(userId, id);
    if (!item) return { status: "not_found" };
    const before = this.firstOccurrence(item, zone);
    const next: Item = { ...item };
    if (patch.type) next.type = patch.type;
    if (patch.title?.trim()) next.title = patch.title.trim()[0].toUpperCase() + patch.title.trim().slice(1);
    if (patch.notes !== undefined) next.notes = patch.notes?.trim() || null;
    if (patch.recurrence !== undefined) next.recurrence = patch.recurrence;

    const timeChanged = patch.start !== undefined || patch.end !== undefined || patch.durationMin !== undefined || patch.allDay !== undefined;
    if (timeChanged) {
      const oldStart = before.start;
      const oldDuration = before.start && before.end ? before.end.diff(before.start).as("minutes") : null;
      const start = patch.start === undefined ? oldStart : patch.start;
      const allDay = Boolean(start && (patch.allDay ?? (patch.start === undefined ? item.allDay : false)));
      const normalized = start ? (allDay ? start.startOf("day") : start.set({ second: 0, millisecond: 0 })) : null;
      const duration = patch.durationMin ?? (patch.end ? null : oldDuration);
      const end = this.resolveEnd(next.type, normalized, allDay, patch.end, duration);
      next.startAt = normalized ? toUtcIso(normalized) : null;
      next.endAt = end ? toUtcIso(end) : null;
      next.allDay = allDay;
      next.timezone = zone;
      next.lastNotifiedAt = null;
      if (!normalized) next.recurrence = null;
    }

    if (next.type === "meeting" && next.startAt && next.endAt && timeChanged && !opts.allowConflict) {
      const occ = this.firstOccurrence(next, zone);
      const conflicts = this.findConflicts(userId, zone, occ.start!, occ.end!, item.id);
      if (conflicts.length) return { status: "conflict", conflicts, item };
    }

    next.updatedAt = toUtcIso(this.clock());
    this.repo.update(next);
    if (next.title !== item.title || next.notes !== item.notes) void this.refreshEmbedding(next);
    return { status: "updated", item: next, occurrence: this.relevantOccurrence(next, zone), before };
  }

  /**
   * Marks an item done. A recurring item is moved to its next occurrence instead,
   * like most to-do apps do, so the series keeps going.
   */
  complete(userId: string, zone: string, id: string, done = true): { item: Item; advancedTo: Occurrence | null } | null {
    const item = this.repo.get(userId, id);
    if (!item) return null;
    const nowIso = toUtcIso(this.clock());
    if (done && item.recurrence && item.startAt) {
      const occ = this.relevantOccurrence(item, zone);
      const first = this.firstOccurrence(item, zone);
      const next = occ.start ? nextOccurrence(first.start!, item.recurrence, occ.start) : null;
      if (next) {
        const shift = next.diff(first.start!);
        const end = first.end ? first.end.plus(shift) : null;
        const updated: Item = {
          ...item,
          startAt: toUtcIso(next),
          endAt: end ? toUtcIso(end) : null,
          lastNotifiedAt: null,
          updatedAt: nowIso,
        };
        this.repo.update(updated);
        return { item: updated, advancedTo: this.firstOccurrence(updated, zone) };
      }
    }
    const updated: Item = {
      ...item,
      status: done ? "done" : "pending",
      completedAt: done ? nowIso : null,
      updatedAt: nowIso,
    };
    this.repo.update(updated);
    return { item: updated, advancedTo: null };
  }

  delete(userId: string, id: string): Item | null {
    const item = this.repo.get(userId, id);
    if (!item) return null;
    this.repo.delete(userId, id);
    return item;
  }

  /** Puts a previously deleted item back (voice "undo"). */
  restore(item: Item): Item {
    if (!this.repo.get(item.userId, item.id)) {
      this.repo.insert({ ...item, updatedAt: toUtcIso(this.clock()) });
      void this.refreshEmbedding(item);
    }
    return item;
  }

  // ---------- notifications ----------

  /**
   * Occurrences whose notification moment passed within the last `lookbackMin` minutes and
   * were not announced yet. Reminders and timed tasks fire at their time; meetings a bit earlier.
   */
  dueNotifications(userId: string, zone: string, lookbackMin = 15): Occurrence[] {
    const now = this.now(zone);
    const range = { from: now.minus({ minutes: lookbackMin }), to: now.plus({ minutes: MEETING_HEADS_UP_MIN + 1 }) };
    const due: Occurrence[] = [];
    for (const occ of this.list(userId, zone, range)) {
      if (!occ.start || occ.item.allDay) continue;
      const fireAt = occ.item.type === "meeting" ? occ.start.minus({ minutes: MEETING_HEADS_UP_MIN }) : occ.start;
      if (fireAt > now || fireAt < range.from) continue;
      const startIso = toUtcIso(occ.start);
      if (occ.item.lastNotifiedAt && occ.item.lastNotifiedAt >= startIso) continue;
      this.repo.update({ ...occ.item, lastNotifiedAt: startIso });
      due.push(occ);
    }
    return due;
  }

  private async refreshEmbedding(item: Item): Promise<void> {
    if (!this.search.semantic) return;
    try {
      this.repo.setEmbedding(item.id, await this.search.embedItem(item));
    } catch (err) {
      console.warn("[search] failed to embed item:", (err as Error).message);
    }
  }
}

function compareOccurrences(a: Occurrence, b: Occurrence): number {
  if (!a.start && !b.start) return a.item.createdAt.localeCompare(b.item.createdAt);
  if (!a.start) return 1;
  if (!b.start) return -1;
  // Within a day, all-day items go after timed ones.
  if (a.start.hasSame(b.start, "day") && a.item.allDay !== b.item.allDay) return a.item.allDay ? 1 : -1;
  return a.start.toMillis() - b.start.toMillis();
}
