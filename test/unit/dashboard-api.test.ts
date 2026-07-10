import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../../src/dashboard/server/api";
import { createDb, ingestEvents } from "../../src/dashboard/server/db";
import { readGateAnswer } from "../../src/gate-answer/answer";

function setupRun(runsRoot: string, runId: string) {
  const runDir = join(runsRoot, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "events.jsonl"),
    [
      JSON.stringify({ ts: "2026-07-10T00:00:00Z", type: "stage_start", stage: "plan" }),
      JSON.stringify({ ts: "2026-07-10T00:00:01Z", type: "stage_done", stage: "plan" }),
    ].join("\n") + "\n"
  );
  return runDir;
}

test("GET /api/runs returns list", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "api-runs-"));
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1");
  ingestEvents(db, runDir);

  const app = createApp({ db, runsRoot });
  const res = await request(app).get("/api/runs");
  expect(res.status).toBe(200);
  expect(res.body.runs).toHaveLength(1);
  expect(res.body.runs[0].run_id).toBe("r1");
});

test("GET /api/runs/:id returns run with events", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "api-runs-"));
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1");
  ingestEvents(db, runDir);

  const app = createApp({ db, runsRoot });
  const res = await request(app).get("/api/runs/r1");
  expect(res.status).toBe(200);
  expect(res.body.events).toHaveLength(2);
});

test("GET /api/runs/:id returns 404 for unknown run", async () => {
  const db = createDb(":memory:");
  const app = createApp({ db });
  const res = await request(app).get("/api/runs/nope");
  expect(res.status).toBe(404);
});

test("GET /api/runs/:id/stages returns stage events", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "api-runs-"));
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1");
  ingestEvents(db, runDir);

  const app = createApp({ db, runsRoot });
  const res = await request(app).get("/api/runs/r1/stages");
  expect(res.status).toBe(200);
  expect(res.body.stages).toHaveLength(2);
});

test("GET /api/runs/:id/cost returns zero when no cost events", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "api-runs-"));
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1");
  ingestEvents(db, runDir);

  const app = createApp({ db, runsRoot });
  const res = await request(app).get("/api/runs/r1/cost");
  expect(res.status).toBe(200);
  expect(res.body.total_usd).toBe(0);
});

test("POST /api/runs/:id/gates/:stage/answer writes a valid GateAnswer round-trip", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "api-runs-"));
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1");
  ingestEvents(db, runDir);

  const app = createApp({ db, runsRoot });
  const res = await request(app)
    .post("/api/runs/r1/gates/plan/answer")
    .send({ action: "approve", reason: "looks good" });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  const answer = readGateAnswer(runDir);
  expect(answer).toBeDefined();
  expect(answer!.action).toBe("approve");
  expect(answer!.stage).toBe("plan");
  expect(answer!.status).toBe("answered");
  expect(answer!.answered_at).toBeTruthy();
  expect(answer!.reason).toBe("looks good");
});

test("POST /api/runs/:id/gates/:stage/answer preserves prompt from existing gate-answer.json", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "api-runs-"));
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1");
  writeFileSync(
    join(runDir, "gate-answer.json"),
    JSON.stringify({ stage: "plan", prompt: "Confirm the plan", status: "waiting", answered_at: null, action: null, reason: null })
  );
  ingestEvents(db, runDir);

  const app = createApp({ db, runsRoot });
  const res = await request(app)
    .post("/api/runs/r1/gates/plan/answer")
    .send({ action: "reject", reason: "needs rework" });
  expect(res.status).toBe(200);
  const answer = readGateAnswer(runDir);
  expect(answer!.prompt).toBe("Confirm the plan");
  expect(answer!.action).toBe("reject");
});

test("path traversal run ids return 400 and do not touch files outside runsRoot", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "api-runs-"));
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1");
  ingestEvents(db, runDir);

  const app = createApp({ db, runsRoot });
  const res = await request(app)
    .post("/api/runs/foo%2Fbar/gates/plan/answer")
    .send({ action: "approve" });
  expect(res.status).toBe(400);
  expect(() => readFileSync(join(runsRoot, "..", "evil", "gate-answer.json"), "utf-8")).toThrow();
});

test("malicious run id with dots and slashes returns 400", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "api-runs-"));
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1");
  ingestEvents(db, runDir);

  const app = createApp({ db, runsRoot });
  const res = await request(app).get("/api/runs/r1..r2");
  expect(res.status).toBe(400);
});
