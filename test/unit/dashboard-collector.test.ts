import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, ingestEvents, tailRun, getEventsForRun } from "../../src/dashboard/server/db";
import { startCollector } from "../../src/dashboard/server/collector";

test("ingests events into sqlite", () => {
  const db = createDb(":memory:");
  const runDir = mkdtempSync(join(tmpdir(), "dash-"));
  const runId = basename(runDir);
  writeFileSync(
    join(runDir, "events.jsonl"),
    JSON.stringify({ ts: "2026-07-10T00:00:00Z", type: "stage_start", stage: "s" }) + "\n"
  );
  ingestEvents(db, runDir);
  const events = getEventsForRun(db, runId);
  expect(events.length).toBe(1);
  expect(events[0].type).toBe("stage_start");
  expect(events[0].ts).toBe("2026-07-10T00:00:00Z");
  expect(JSON.parse(events[0].payload).stage).toBe("s");
});

test("tailRun ingests only new bytes and tracks cursor", () => {
  const db = createDb(":memory:");
  const runDir = mkdtempSync(join(tmpdir(), "dash-"));
  const runId = basename(runDir);
  const path = join(runDir, "events.jsonl");
  writeFileSync(path, JSON.stringify({ ts: "2026-07-10T00:00:00Z", type: "stage_start" }) + "\n");
  const first = tailRun(db, runDir);
  expect(first.ingested).toBe(1);
  appendFileSync(path, JSON.stringify({ ts: "2026-07-10T00:00:01Z", type: "stage_done" }) + "\n");
  const second = tailRun(db, runDir, first.cursor);
  expect(second.ingested).toBe(1);
  const events = getEventsForRun(db, runId);
  expect(events.length).toBe(2);
  expect(events[1].type).toBe("stage_done");
});

test("tailRun does not duplicate events when called repeatedly", () => {
  const db = createDb(":memory:");
  const runDir = mkdtempSync(join(tmpdir(), "dash-"));
  const runId = basename(runDir);
  const path = join(runDir, "events.jsonl");
  writeFileSync(path, JSON.stringify({ ts: "2026-07-10T00:00:00Z", type: "stage_start" }) + "\n");
  tailRun(db, runDir);
  tailRun(db, runDir);
  expect(getEventsForRun(db, runId).length).toBe(1);
});

test("collector ingests new events on file change", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "dash-runs-"));
  const runDir = join(runsRoot, "r1");
  mkdirSync(runDir);
  writeFileSync(join(runDir, "events.jsonl"), "\n");
  const dbPath = join(runsRoot, "dashboard.sqlite");
  const collector = startCollector(runsRoot, dbPath, { usePolling: true, interval: 20, awaitWriteFinish: false });

  await new Promise((resolve) => setTimeout(resolve, 150));
  appendFileSync(join(runDir, "events.jsonl"), JSON.stringify({ ts: "2026-07-10T00:00:00Z", type: "stage_start" }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 250));

  const db = createDb(dbPath);
  const events = getEventsForRun(db, "r1");
  expect(events.length).toBe(1);
  expect(events[0].type).toBe("stage_start");

  await collector.close();
});

test("tailRun updates cursor when file has not grown", () => {
  const db = createDb(":memory:");
  const runDir = mkdtempSync(join(tmpdir(), "dash-"));
  const path = join(runDir, "events.jsonl");
  writeFileSync(path, JSON.stringify({ ts: "2026-07-10T00:00:00Z", type: "stage_start" }) + "\n");
  const first = tailRun(db, runDir);
  expect(first.ingested).toBe(1);
  const second = tailRun(db, runDir, first.cursor);
  expect(second.cursor).toBe(first.cursor);
  expect(second.ingested).toBe(0);
});

test("ignores malformed event lines", () => {
  const db = createDb(":memory:");
  const runDir = mkdtempSync(join(tmpdir(), "dash-"));
  const runId = basename(runDir);
  const path = join(runDir, "events.jsonl");
  writeFileSync(
    path,
    [
      JSON.stringify({ ts: "2026-07-10T00:00:00Z", type: "stage_start" }),
      "not-json",
      JSON.stringify({ missing: "fields" }),
      JSON.stringify({ ts: "2026-07-10T00:00:01Z", type: "stage_done" }),
    ].join("\n") + "\n"
  );
  ingestEvents(db, runDir);
  const events = getEventsForRun(db, runId);
  expect(events.length).toBe(2);
  expect(events.map((e) => e.type)).toEqual(["stage_start", "stage_done"]);
});

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx < 0 ? p : p.slice(idx + 1);
}
