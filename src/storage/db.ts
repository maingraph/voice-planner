import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type Db = Database.Database;

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS items (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('task','meeting','reminder')),
     title TEXT NOT NULL,
     notes TEXT,
     start_at TEXT,
     end_at TEXT,
     all_day INTEGER NOT NULL DEFAULT 0,
     timezone TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
     recurrence TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     completed_at TEXT,
     last_notified_at TEXT,
     source_text TEXT,
     embedding TEXT
   );
   CREATE INDEX IF NOT EXISTS items_user_start ON items(user_id, start_at);
   CREATE TABLE IF NOT EXISTS sessions (
     user_id TEXT PRIMARY KEY,
     data TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
];

/** Opens (and migrates) the SQLite database. Use ":memory:" in tests. */
export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}
