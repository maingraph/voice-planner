import type { Db } from "./db.js";
import type { Item } from "../domain/types.js";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
}

/**
 * Dialogue state per user. `pending` is an opaque slot owned by the rule-based engine
 * (clarifying questions); `lastItemIds` powers references like "перенеси её на завтра".
 */
export interface SessionState {
  history: ChatTurn[];
  lastItemIds: string[];
  pending: unknown | null;
  /** Last deleted item, so "верни" can undo a voice deletion. */
  lastDeleted: Item | null;
}

const MAX_HISTORY = 40;

export class SessionsRepo {
  constructor(private readonly db: Db) {}

  load(userId: string): SessionState {
    const row = this.db.prepare(`SELECT data FROM sessions WHERE user_id=?`).get(userId) as { data: string } | undefined;
    if (!row) return { history: [], lastItemIds: [], pending: null, lastDeleted: null };
    const parsed = JSON.parse(row.data) as Partial<SessionState>;
    return {
      history: parsed.history ?? [],
      lastItemIds: parsed.lastItemIds ?? [],
      pending: parsed.pending ?? null,
      lastDeleted: parsed.lastDeleted ?? null,
    };
  }

  save(userId: string, state: SessionState): void {
    const data: SessionState = { ...state, history: state.history.slice(-MAX_HISTORY) };
    this.db
      .prepare(
        `INSERT INTO sessions (user_id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
      )
      .run(userId, JSON.stringify(data), new Date().toISOString());
  }

  reset(userId: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(userId);
  }
}
