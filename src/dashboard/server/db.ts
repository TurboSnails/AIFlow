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

export function tailRun(
  db: Database,
  runDir: string,
  cursor?: number,
  onEvent?: (event: DashboardEvent) => void,
): { cursor: number; ingested: number } {
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
    if (onEvent) {
      try {
        onEvent(JSON.parse(line) as DashboardEvent);
      } catch {
        // ignore malformed lines; parseEventLine already validated
      }
    }
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

export function getRuns(db: Database): Array<{ run_id: string; ts: string; status: string }> {
  return db
    .prepare(`
      SELECT run_id, ts, type as status
      FROM events e
      WHERE id = (
        SELECT id FROM events WHERE run_id = e.run_id ORDER BY ts DESC, id DESC LIMIT 1
      )
      ORDER BY ts DESC
    `)
    .all() as ReturnType<typeof getRuns>;
}

export function getStageEventsForRun(
  db: Database,
  runId: string,
): Array<{ id: number; run_id: string; ts: string; type: string; payload: string }> {
  return db
    .prepare("SELECT id, run_id, ts, type, payload FROM events WHERE run_id = ? AND (type LIKE 'stage_%' OR type = 'human_gate') ORDER BY ts, id")
    .all(runId) as ReturnType<typeof getStageEventsForRun>;
}

export function getCostForRun(
  db: Database,
  runId: string,
): { total_in: number; total_out: number; total_usd: number; stages: Array<{ stage: string; in: number; out: number; usd: number }> } {
  const rows = getEventsForRun(db, runId);
  let total_in = 0;
  let total_out = 0;
  let total_usd = 0;
  const stageMap = new Map<string, { in: number; out: number; usd: number }>();
  for (const row of rows) {
    if (row.type !== "llm_call") continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const usage = payload.usage as Record<string, number> | undefined;
    if (!usage) continue;
    const inTok = usage.inTok ?? usage.in_tokens ?? 0;
    const outTok = usage.outTok ?? usage.out_tokens ?? 0;
    const cost = usage.costUsd ?? usage.cost_usd ?? 0;
    total_in += inTok;
    total_out += outTok;
    total_usd += cost;
    const stage = String(payload.stage ?? "unknown");
    const existing = stageMap.get(stage) ?? { in: 0, out: 0, usd: 0 };
    existing.in += inTok;
    existing.out += outTok;
    existing.usd += cost;
    stageMap.set(stage, existing);
  }
  const stages = Array.from(stageMap.entries()).map(([stage, vals]) => ({ stage, ...vals }));
  return { total_in, total_out, total_usd, stages };
}

export function getEventsForRun(
  db: Database,
  runId: string,
): Array<{ id: number; run_id: string; ts: string; type: string; payload: string }> {
  return db
    .prepare("SELECT id, run_id, ts, type, payload FROM events WHERE run_id = ? ORDER BY ts, id")
    .all(runId) as ReturnType<typeof getEventsForRun>;
}
