import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";

export const DashboardEventSchema = z.object({
  ts: z.string(),
  type: z.string(),
}).passthrough();

export type DashboardEvent = z.infer<typeof DashboardEventSchema>;

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

    CREATE TABLE IF NOT EXISTS cursors (
      run_id TEXT PRIMARY KEY,
      offset INTEGER NOT NULL
    );
  `);
  return db;
}

function getCursor(db: Database, runId: string): number {
  const row = db.prepare("SELECT offset FROM cursors WHERE run_id = ?").get(runId) as { offset: number } | undefined;
  return row?.offset ?? 0;
}

function setCursor(db: Database, runId: string, offset: number): void {
  db.prepare("INSERT OR REPLACE INTO cursors (run_id, offset) VALUES (?, ?)").run(runId, offset);
}

export function ingestEvents(db: Database, runDir: string): void {
  const runId = basename(runDir);
  const eventsPath = join(runDir, "events.jsonl");
  let text: string;
  let size: number;
  try {
    text = readFileSync(eventsPath, "utf-8");
    size = statSync(eventsPath).size;
  } catch {
    return;
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  ingestLines(db, runId, lines, size);
}

function ingestLines(db: Database, runId: string, lines: string[], cursorOffset: number): void {
  const insert = db.transaction((rows: Array<{ ts: string; type: string; payload: string }>, cursorRunId: string, offset: number) => {
    const stmt = db.prepare("INSERT INTO events (run_id, ts, type, payload) VALUES (?, ?, ?, ?)");
    for (const row of rows) {
      stmt.run(cursorRunId, row.ts, row.type, row.payload);
    }
    setCursor(db, cursorRunId, offset);
  });
  const rows: Array<{ ts: string; type: string; payload: string }> = [];
  for (const line of lines) {
    const parsed = parseEventLine(line);
    if (!parsed) continue;
    rows.push(parsed);
  }
  insert(rows, runId, cursorOffset);
}

function parseEventLine(line: string): { ts: string; type: string; payload: string } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const result = DashboardEventSchema.safeParse(raw);
  if (!result.success) return null;
  return { ts: result.data.ts, type: result.data.type, payload: line };
}

export function tailRun(db: Database, runDir: string, cursor?: number): { cursor: number; ingested: number } {
  const runId = basename(runDir);
  const eventsPath = join(runDir, "events.jsonl");
  let size: number;
  try {
    size = statSync(eventsPath).size;
  } catch {
    return { cursor: cursor ?? getCursor(db, runId), ingested: 0 };
  }
  const start = cursor ?? getCursor(db, runId);
  if (start >= size) {
    setCursor(db, runId, size);
    return { cursor: size, ingested: 0 };
  }
  let chunk: Buffer;
  try {
    chunk = readFileSync(eventsPath).subarray(start, size);
  } catch {
    return { cursor: start, ingested: 0 };
  }
  const text = chunk.toString("utf-8");
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const insert = db.transaction((rows: Array<{ ts: string; type: string; payload: string }>, cursorRunId: string, cursorOffset: number) => {
    const stmt = db.prepare("INSERT INTO events (run_id, ts, type, payload) VALUES (?, ?, ?, ?)");
    for (const row of rows) {
      stmt.run(cursorRunId, row.ts, row.type, row.payload);
    }
    setCursor(db, cursorRunId, cursorOffset);
  });
  const rows: Array<{ ts: string; type: string; payload: string }> = [];
  for (const line of lines) {
    const parsed = parseEventLine(line);
    if (!parsed) continue;
    rows.push(parsed);
  }
  const nextCursor = start + Buffer.byteLength(text, "utf-8");
  if (rows.length > 0) {
    insert(rows, runId, nextCursor);
  } else {
    setCursor(db, runId, nextCursor);
  }
  return { cursor: nextCursor, ingested: rows.length };
}

export function getEventsForRun(
  db: Database,
  runId: string,
): Array<{ id: number; run_id: string; ts: string; type: string; payload: string }> {
  return db
    .prepare("SELECT id, run_id, ts, type, payload FROM events WHERE run_id = ? ORDER BY ts, id")
    .all(runId) as ReturnType<typeof getEventsForRun>;
}
