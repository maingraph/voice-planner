import type { Db } from "./db.js";
import type { Item, ItemStatus, ItemType, Recurrence } from "../domain/types.js";

interface ItemRow {
  id: string;
  user_id: string;
  type: ItemType;
  title: string;
  notes: string | null;
  start_at: string | null;
  end_at: string | null;
  all_day: number;
  timezone: string;
  status: ItemStatus;
  recurrence: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  last_notified_at: string | null;
  source_text: string | null;
  embedding: string | null;
}

function toItem(r: ItemRow): Item {
  return {
    id: r.id,
    userId: r.user_id,
    type: r.type,
    title: r.title,
    notes: r.notes,
    startAt: r.start_at,
    endAt: r.end_at,
    allDay: r.all_day === 1,
    timezone: r.timezone,
    status: r.status,
    recurrence: r.recurrence ? (JSON.parse(r.recurrence) as Recurrence) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    lastNotifiedAt: r.last_notified_at,
    sourceText: r.source_text,
  };
}

function toRow(i: Item): Omit<ItemRow, "embedding"> {
  return {
    id: i.id,
    user_id: i.userId,
    type: i.type,
    title: i.title,
    notes: i.notes,
    start_at: i.startAt,
    end_at: i.endAt,
    all_day: i.allDay ? 1 : 0,
    timezone: i.timezone,
    status: i.status,
    recurrence: i.recurrence ? JSON.stringify(i.recurrence) : null,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    completed_at: i.completedAt,
    last_notified_at: i.lastNotifiedAt,
    source_text: i.sourceText,
  };
}

/** Persistence for items. Time-window filtering of recurring items is done in the service. */
export class ItemsRepo {
  constructor(private readonly db: Db) {}

  insert(item: Item): void {
    this.db
      .prepare(
        `INSERT INTO items (id, user_id, type, title, notes, start_at, end_at, all_day, timezone, status,
           recurrence, created_at, updated_at, completed_at, last_notified_at, source_text)
         VALUES (@id, @user_id, @type, @title, @notes, @start_at, @end_at, @all_day, @timezone, @status,
           @recurrence, @created_at, @updated_at, @completed_at, @last_notified_at, @source_text)`,
      )
      .run(toRow(item));
  }

  update(item: Item): void {
    this.db
      .prepare(
        `UPDATE items SET type=@type, title=@title, notes=@notes, start_at=@start_at, end_at=@end_at,
           all_day=@all_day, timezone=@timezone, status=@status, recurrence=@recurrence,
           updated_at=@updated_at, completed_at=@completed_at, last_notified_at=@last_notified_at,
           source_text=@source_text
         WHERE id=@id AND user_id=@user_id`,
      )
      .run(toRow(item));
  }

  get(userId: string, id: string): Item | null {
    const row = this.db.prepare(`SELECT * FROM items WHERE user_id=? AND id=?`).get(userId, id) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  delete(userId: string, id: string): boolean {
    return this.db.prepare(`DELETE FROM items WHERE user_id=? AND id=?`).run(userId, id).changes > 0;
  }

  /**
   * Candidates that may intersect [fromUtc, toUtc): non-recurring items starting inside the window
   * plus every recurring item that started before its end. Undated items are included on request.
   */
  listCandidates(userId: string, fromUtc: string, toUtc: string, includeUndated: boolean): Item[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM items WHERE user_id=@userId AND (
           (recurrence IS NULL AND start_at >= @from AND start_at < @to)
           OR (recurrence IS NOT NULL AND start_at < @to)
           OR (@undated = 1 AND start_at IS NULL)
         ) ORDER BY start_at`,
      )
      .all({ userId, from: fromUtc, to: toUtc, undated: includeUndated ? 1 : 0 }) as ItemRow[];
    return rows.map(toItem);
  }

  all(userId: string): Item[] {
    const rows = this.db.prepare(`SELECT * FROM items WHERE user_id=? ORDER BY created_at DESC`).all(userId) as ItemRow[];
    return rows.map(toItem);
  }

  setEmbedding(id: string, vector: number[] | null): void {
    this.db.prepare(`UPDATE items SET embedding=? WHERE id=?`).run(vector ? JSON.stringify(vector) : null, id);
  }

  embeddings(userId: string): Map<string, number[]> {
    const rows = this.db
      .prepare(`SELECT id, embedding FROM items WHERE user_id=? AND embedding IS NOT NULL`)
      .all(userId) as { id: string; embedding: string }[];
    return new Map(rows.map((r) => [r.id, JSON.parse(r.embedding) as number[]]));
  }
}
