import type { DateTime } from "luxon";

export const ITEM_TYPES = ["task", "meeting", "reminder"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_STATUSES = ["pending", "done"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export type RecurrenceFreq = "daily" | "weekly" | "monthly" | "yearly";

export interface Recurrence {
  freq: RecurrenceFreq;
  /** Repeat every N periods (1 = every day/week/...). */
  interval: number;
  /** ISO weekdays 1 (Mon) … 7 (Sun); only for weekly rules. */
  byWeekday?: number[];
  /** Local date (YYYY-MM-DD) after which the rule stops. */
  until?: string;
}

/** A stored task / meeting / reminder. All instants are UTC ISO strings. */
export interface Item {
  id: string;
  userId: string;
  type: ItemType;
  title: string;
  notes: string | null;
  /** Start (meeting/reminder) or due moment (task). Null for undated tasks. */
  startAt: string | null;
  endAt: string | null;
  /** True when only a calendar date is known (no time of day). */
  allDay: boolean;
  /** IANA zone the item was created in; all-day dates are interpreted in it. */
  timezone: string;
  status: ItemStatus;
  recurrence: Recurrence | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** Start of the last occurrence a notification was sent for. */
  lastNotifiedAt: string | null;
  /** Original user phrase, kept for search and debugging. */
  sourceText: string | null;
}

/** A concrete occurrence of an item inside a time window (recurring items expand). */
export interface Occurrence {
  item: Item;
  start: DateTime | null;
  end: DateTime | null;
}

/** What the NLU layers hand to the service when creating or changing an item. */
export interface ItemDraft {
  type: ItemType;
  title: string;
  notes?: string | null;
  /** Zoned start; for all-day items the time part is ignored. */
  start?: DateTime | null;
  allDay?: boolean;
  end?: DateTime | null;
  durationMin?: number | null;
  recurrence?: Recurrence | null;
  sourceText?: string | null;
}

export interface DateRange {
  from: DateTime;
  /** Exclusive upper bound. */
  to: DateTime;
}

export const TYPE_LABELS: Record<ItemType, { one: string; acc: string; plural: [string, string, string] }> = {
  task: { one: "задача", acc: "задачу", plural: ["задача", "задачи", "задач"] },
  meeting: { one: "встреча", acc: "встречу", plural: ["встреча", "встречи", "встреч"] },
  reminder: { one: "напоминание", acc: "напоминание", plural: ["напоминание", "напоминания", "напоминаний"] },
};
