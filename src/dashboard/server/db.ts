import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

export function createDb(path: string): Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, ts);
  `);
  return db;
}

export function ingestEvents(db: Database, runDir: string): void {
  const runId = runDir.split("/").pop() ?? "unknown";
  const eventsPath = join(runDir, "events.jsonl");
  const text = readFileSync(eventsPath, "utf-8");
  const insert = db.prepare(
    "INSERT INTO events (run_id, ts, type, payload) VALUES (?, ?, ?, ?)"
  );
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  for (const line of lines) {
    const event = JSON.parse(line) as Record<string, unknown>;
    const ts = String(event.ts ?? "");
    const type = String(event.type ?? "");
    const payload = JSON.stringify(event);
    insert.run(runId, ts, type, payload);
  }
}

export function getEventsForRun(
  db: Database,
  runId: string,
): Array<{ id: number; run_id: string; ts: string; type: string; payload: string }> {
  return db
    .prepare("SELECT id, run_id, ts, type, payload FROM events WHERE run_id = ? ORDER BY ts, id")
    .all(runId) as ReturnType<typeof getEventsForRun>;
}
