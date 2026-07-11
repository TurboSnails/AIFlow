import { test, expect, mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../../src/dashboard/server/api";
import { createDb, ingestEvents } from "../../src/dashboard/server/db";
import { readGateAnswer } from "../../src/gate-answer/answer";

function setupProject(prefix: string) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  const runsRoot = join(cwd, ".aiflow", "runs");
  mkdirSync(runsRoot, { recursive: true });
  return { cwd, runsRoot };
}

function writeState(runDir: string, runId: string, stageStatus: string) {
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      run_id: runId,
      pipeline: "demo",
      stages: [{ id: "plan", status: stageStatus }],
    }),
  );
}

function setupRun(runsRoot: string, runId: string, stageStatus = "waiting_human") {
  const runDir = join(runsRoot, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "events.jsonl"),
    [
      JSON.stringify({ ts: "2026-07-10T00:00:00Z", type: "stage_start", stage: "plan" }),
      JSON.stringify({ ts: "2026-07-10T00:00:01Z", type: "stage_done", stage: "plan" }),
    ].join("\n") + "\n",
  );
  writeState(runDir, runId, stageStatus);
  return runDir;
}

test("GET /api/runs returns list with status from state.json", async () => {
  const { runsRoot } = setupProject("api-runs-");
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1", "done");
  ingestEvents(db, runDir);

  const app = createApp({ db, runsRoot });
  const res = await request(app).get("/api/runs");
  expect(res.status).toBe(200);
  expect(res.body.runs).toHaveLength(1);
  expect(res.body.runs[0].run_id).toBe("r1");
  expect(res.body.runs[0].status).toBe("done");
});

test("GET /api/runs/:id returns run with events", async () => {
  const { runsRoot } = setupProject("api-runs-");
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

test("GET /api/runs/:id/stages returns stage statuses from state.json", async () => {
  const { runsRoot } = setupProject("api-runs-");
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1", "done");
  ingestEvents(db, runDir);

  const app = createApp({ db, runsRoot });
  const res = await request(app).get("/api/runs/r1/stages");
  expect(res.status).toBe(200);
  expect(res.body.stages).toHaveLength(1);
  expect(res.body.stages[0].id).toBe("plan");
  expect(res.body.stages[0].status).toBe("done");
});

test("GET /api/runs/:id/cost aggregates opencode_step_finish and stage_cost", async () => {
  const { runsRoot } = setupProject("api-runs-");
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1");
  writeFileSync(
    join(runDir, "events.jsonl"),
    [
      JSON.stringify({ ts: "2026-07-10T00:00:00Z", type: "stage_start", stage: "plan" }),
      JSON.stringify({
        ts: "2026-07-10T00:00:01Z",
        type: "opencode_step_finish",
        stage: "plan",
        in_tok: 10,
        out_tok: 5,
        cost_usd: 0.001,
      }),
      JSON.stringify({
        ts: "2026-07-10T00:00:02Z",
        type: "stage_cost",
        stage: "plan",
        in_tok: 20,
        out_tok: 10,
        cost_usd: 0.002,
      }),
    ].join("\n") + "\n",
  );
  ingestEvents(db, runDir);

  const app = createApp({ db, runsRoot });
  const res = await request(app).get("/api/runs/r1/cost");
  expect(res.status).toBe(200);
  expect(res.body.total_in).toBe(30);
  expect(res.body.total_out).toBe(15);
  expect(res.body.total_usd).toBeCloseTo(0.003, 6);
  expect(res.body.stages).toHaveLength(1);
  expect(res.body.stages[0]).toMatchObject({ stage: "plan", in: 30, out: 15, usd: 0.003 });
});

test("GET /api/runs/:id/stories returns artifacts from specboard.json", async () => {
  const { runsRoot } = setupProject("api-runs-");
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1");
  writeFileSync(
    join(runDir, "specboard.json"),
    JSON.stringify({
      requirement: "demo",
      artifacts: { story1: "story1.md", story2: "story2.md" },
      open_questions: [],
      decisions: [],
      review_matrix: {},
    }),
  );
  ingestEvents(db, runDir);

  const app = createApp({ db, runsRoot });
  const res = await request(app).get("/api/runs/r1/stories");
  expect(res.status).toBe(200);
  expect(res.body.stories).toHaveLength(2);
  expect(res.body.stories.map((s: { id: string }) => s.id)).toEqual(["story1", "story2"]);
});

test("GET /api/runs/:id/debates returns debate_round and debate_end events", async () => {
  const { runsRoot } = setupProject("api-runs-");
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1");
  writeFileSync(
    join(runDir, "events.jsonl"),
    [
      JSON.stringify({ ts: "2026-07-10T00:00:00Z", type: "stage_start", stage: "plan" }),
      JSON.stringify({
        ts: "2026-07-10T00:00:01Z",
        type: "debate_round",
        stage: "brainstorm",
        round: 1,
        resolved: 0,
        remaining: 2,
      }),
      JSON.stringify({
        ts: "2026-07-10T00:00:02Z",
        type: "debate_end",
        stage: "brainstorm",
        reason: "converged",
        open_questions: 0,
      }),
    ].join("\n") + "\n",
  );
  ingestEvents(db, runDir);

  const app = createApp({ db, runsRoot });
  const res = await request(app).get("/api/runs/r1/debates");
  expect(res.status).toBe(200);
  expect(res.body.debates).toHaveLength(2);
  expect(res.body.debates[0].type).toBe("debate_round");
  expect(res.body.debates[1].type).toBe("debate_end");
});

test("GET /api/runs/:id/reviews returns review_verdict events and review_matrix", async () => {
  const { runsRoot } = setupProject("api-runs-");
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1");
  writeFileSync(
    join(runDir, "events.jsonl"),
    [
      JSON.stringify({ ts: "2026-07-10T00:00:00Z", type: "stage_start", stage: "plan" }),
      JSON.stringify({
        ts: "2026-07-10T00:00:01Z",
        type: "review_verdict",
        stage: "plan",
        story: "story1",
        reviewers: { a: "pass" },
        arbitrated: false,
        final: "pass",
      }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(runDir, "specboard.json"),
    JSON.stringify({
      requirement: "demo",
      artifacts: {},
      open_questions: [],
      decisions: [],
      review_matrix: {
        story1: {
          verdicts: { a: "pass" },
          arbitrated: false,
          final: "pass",
        },
      },
    }),
  );
  ingestEvents(db, runDir);

  const app = createApp({ db, runsRoot });
  const res = await request(app).get("/api/runs/r1/reviews");
  expect(res.status).toBe(200);
  expect(res.body.reviews).toHaveLength(1);
  expect(res.body.reviews[0].type).toBe("review_verdict");
  expect(res.body.matrix).toHaveLength(1);
  expect(res.body.matrix[0].story_id).toBe("story1");
});

test("POST /api/runs/:id/gates/:stage/answer writes a valid GateAnswer round-trip", async () => {
  const { runsRoot } = setupProject("api-runs-");
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1", "waiting_human");
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

test("POST /api/runs/:id/gates/:stage/answer returns 409 when stage is not waiting", async () => {
  const { runsRoot } = setupProject("api-runs-");
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1", "done");
  ingestEvents(db, runDir);

  const app = createApp({ db, runsRoot });
  const res = await request(app)
    .post("/api/runs/r1/gates/plan/answer")
    .send({ action: "approve", reason: "looks good" });
  expect(res.status).toBe(409);
});

test("POST /api/runs/:id/gates/:stage/answer preserves prompt from existing gate-answer.json", async () => {
  const { runsRoot } = setupProject("api-runs-");
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1", "waiting_human");
  writeFileSync(
    join(runDir, "gate-answer.json"),
    JSON.stringify({
      stage: "plan",
      prompt: "Confirm the plan",
      status: "waiting",
      answered_at: null,
      action: null,
      reason: null,
    }),
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
  const { runsRoot } = setupProject("api-runs-");
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
  const { runsRoot } = setupProject("api-runs-");
  const db = createDb(":memory:");
  const runDir = setupRun(runsRoot, "r1");
  ingestEvents(db, runDir);

  const app = createApp({ db, runsRoot });
  const res = await request(app).get("/api/runs/r1..r2");
  expect(res.status).toBe(400);
});

test("gate-answer endpoint writes answer and resumes pipeline", async () => {
  const { runsRoot } = setupProject("api-runs-");
  const runId = "r1";
  const gateStage = "plan";
  const runApproveMock = mock(async () => ({ status: "resumed" as const }));
  const runDir = setupRun(runsRoot, runId, "waiting_human");
  const db = createDb(":memory:");
  ingestEvents(db, runDir);

  const app = createApp({ db, runsRoot, runApprove: runApproveMock });
  const res = await request(app)
    .post(`/api/runs/${runId}/gate-answer`)
    .send({ stage: gateStage, action: "approve" });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(runApproveMock).toHaveBeenCalled();
});

test("gate-answer endpoint returns 404 for invalid run id", async () => {
  const { runsRoot } = setupProject("api-runs-");
  const db = createDb(":memory:");
  const runApproveMock = mock(async () => ({ status: "resumed" as const }));

  const app = createApp({ db, runsRoot, runApprove: runApproveMock });
  const res = await request(app)
    .post("/api/runs/../../etc/gate-answer")
    .send({ stage: "plan", action: "approve" });
  expect(res.status).toBe(404);
  expect(runApproveMock).not.toHaveBeenCalled();
});

test("gate-answer endpoint returns 400 for missing stage in body", async () => {
  const { runsRoot } = setupProject("api-runs-");
  const runDir = setupRun(runsRoot, "r1", "waiting_human");
  const db = createDb(":memory:");
  ingestEvents(db, runDir);
  const runApproveMock = mock(async () => ({ status: "resumed" as const }));

  const app = createApp({ db, runsRoot, runApprove: runApproveMock });
  const res = await request(app)
    .post("/api/runs/r1/gate-answer")
    .send({ action: "approve" }); // missing stage
  expect(res.status).toBe(400);
  expect(runApproveMock).not.toHaveBeenCalled();
});
