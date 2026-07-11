import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { broadcastEvent } from "../../src/dashboard/server/ws";
import { startCollector } from "../../src/dashboard/server/collector";
import { createDb } from "../../src/dashboard/server/db";

test("broadcastEvent sends JSON to ready clients", () => {
  const messages: string[] = [];
  const clientA = { readyState: 1, send: (msg: string) => messages.push(msg) } as unknown as WebSocket;
  const clientB = { readyState: 0, send: (msg: string) => messages.push(msg) } as unknown as WebSocket;
  const wss = { clients: new Set([clientA, clientB]) } as unknown as import("ws").WebSocketServer;

  broadcastEvent(wss, { run_id: "r1", event: { type: "stage_start", stage: "plan" } });
  expect(messages).toHaveLength(1);
  expect(JSON.parse(messages[0])).toEqual({ run_id: "r1", event: { type: "stage_start", stage: "plan" } });
});

test("collector broadcasts new events wrapped with run_id", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "ws-collector-"));
  const runDir = join(runsRoot, "r1");
  mkdirSync(runDir);
  writeFileSync(join(runDir, "events.jsonl"), "\n");

  const db = createDb(":memory:");
  const broadcasts: object[] = [];
  const collector = startCollector(
    runsRoot,
    db,
    { usePolling: true, interval: 20, awaitWriteFinish: false },
    { broadcast: (event: object) => broadcasts.push(event) }
  );

  await new Promise((resolve) => setTimeout(resolve, 150));
  appendFileSync(
    join(runDir, "events.jsonl"),
    JSON.stringify({ ts: "2026-07-10T00:00:00Z", type: "stage_start", stage: "plan" }) + "\n"
  );
  await new Promise((resolve) => setTimeout(resolve, 250));

  expect(broadcasts.length).toBeGreaterThanOrEqual(1);
  expect(broadcasts[0]).toMatchObject({ run_id: "r1", event: { type: "stage_start", stage: "plan" } });

  await collector.close();
});

test("collector broadcasts only include the run_id from the changed run directory", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "ws-scoped-"));
  const runDir1 = join(runsRoot, "r1");
  const runDir2 = join(runsRoot, "r2");
  mkdirSync(runDir1);
  mkdirSync(runDir2);
  writeFileSync(join(runDir1, "events.jsonl"), "\n");
  writeFileSync(join(runDir2, "events.jsonl"), "\n");

  const db2 = createDb(":memory:");
  const broadcasts: object[] = [];
  const collector = startCollector(
    runsRoot,
    db2,
    { usePolling: true, interval: 20, awaitWriteFinish: false },
    { broadcast: (event: object) => broadcasts.push(event) }
  );

  await new Promise((resolve) => setTimeout(resolve, 150));
  appendFileSync(
    join(runDir2, "events.jsonl"),
    JSON.stringify({ ts: "2026-07-10T00:00:00Z", type: "stage_done", stage: "plan" }) + "\n"
  );
  await new Promise((resolve) => setTimeout(resolve, 250));

  expect(broadcasts.length).toBeGreaterThanOrEqual(1);
  expect(broadcasts[0]).toMatchObject({ run_id: "r2" });

  await collector.close();
});
