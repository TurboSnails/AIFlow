import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, ingestEvents, getEventsForRun } from "../../src/dashboard/server/db";

test("ingests events into sqlite", () => {
  const db = createDb(":memory:");
  const runDir = mkdtempSync(join(tmpdir(), "dash-"));
  const runId = runDir.split("/").pop()!;
  writeFileSync(
    join(runDir, "events.jsonl"),
    JSON.stringify({ ts: "2026-07-10T00:00:00Z", type: "stage_start", stage: "s" }) + "\n"
  );
  ingestEvents(db, runDir);
  expect(getEventsForRun(db, runId).length).toBe(1);
});
