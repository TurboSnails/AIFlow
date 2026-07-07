import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApprove } from "../../src/commands/approve";

function setupRun(stages: Array<{ id: string; status: string; entered_at?: string }>): { cwd: string; runId: string } {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-approve-test-"));
  const runId = "20260706_000000_abc123";
  const runDir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(cwd, ".aiflow", "config", "pipelines"), { recursive: true });
  writeFileSync(
    join(cwd, ".aiflow", "config", "models.yaml"),
    `profiles:\n  main-dev:\n    channel: opencode\n    provider: opencode\n    model: x\n`
  );
  writeFileSync(
    join(cwd, ".aiflow", "config", "pipelines", "test-pipeline.yaml"),
    `name: test-pipeline\nstages:\n${stages.map((s) => `  - id: ${s.id}\n    type: human_gate\n    prompt: "p"\n`).join("")}`
  );
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      run_id: runId,
      pipeline: "test-pipeline",
      stages,
      cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    })
  );
  return { cwd, runId };
}

test("approves the sole waiting_human stage and continues the pipeline", async () => {
  const { cwd, runId } = setupRun([{ id: "confirm", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" }]);
  try {
    const result = await runApprove(cwd, { runId }, { runners: { human_gate: async () => ({ result: "pass" }) } });
    expect(result.status).toBe("resumed");
    expect(result.state!.stages[0].status).toBe("done");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("errors when no stage is waiting", async () => {
  const { cwd, runId } = setupRun([{ id: "confirm", status: "done" }]);
  try {
    const result = await runApprove(cwd, { runId });
    expect(result.status).toBe("no_waiting_stage");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("errors when --stage names a stage that isn't waiting", async () => {
  const { cwd, runId } = setupRun([{ id: "confirm", status: "done" }]);
  try {
    const result = await runApprove(cwd, { runId, stage: "confirm" });
    expect(result.status).toBe("stage_not_waiting");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("errors with no_runs when .aiflow/runs is missing entirely", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-approve-empty-"));
  try {
    const result = await runApprove(cwd, {});
    expect(result.status).toBe("no_runs");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("errors with ambiguous_stage when multiple stages are waiting_human and no --stage given", async () => {
  const { cwd, runId } = setupRun([
    { id: "confirm-a", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" },
    { id: "confirm-b", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" },
  ]);
  try {
    const result = await runApprove(cwd, { runId });
    expect(result.status).toBe("ambiguous_stage");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("--stage disambiguates and resumes only the named stage, leaving the other waiting", async () => {
  const { cwd, runId } = setupRun([
    { id: "confirm-a", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" },
    { id: "confirm-b", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" },
  ]);
  try {
    // No deps override here: use the real default human_gate runner (runHumanGateStage)
    // so that the untouched "confirm-b" stage is genuinely re-evaluated by the actual
    // stage logic (which correctly stays "waiting_human" on a repeat call with no
    // timeout configured), rather than an unconditional always-"pass" mock that would
    // mask a regression.
    const result = await runApprove(cwd, { runId, stage: "confirm-a" });
    expect(result.status).toBe("resumed");
    expect(result.state!.stages[0].status).toBe("done");
    // The other, non-targeted stage must remain waiting_human -- runApprove only
    // flips the named stage to "done" directly; the resume loop then re-visits
    // "confirm-b" via the real human_gate runner, which stays waiting_human since
    // it has already entered and has no timeout configured.
    expect(result.state!.stages[1].status).toBe("waiting_human");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resumed pipeline actually continues past the approved stage to the next runner", async () => {
  const { cwd, runId } = setupRun([
    { id: "confirm", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" },
    { id: "second", status: "pending" },
  ]);
  try {
    const calls: string[] = [];
    const result = await runApprove(cwd, { runId }, {
      runners: {
        human_gate: async (stageConfig) => {
          calls.push(stageConfig.id);
          return { result: "pass" };
        },
      },
    });
    expect(result.status).toBe("resumed");
    expect(result.state!.stages[0].status).toBe("done");
    expect(result.state!.stages[1].status).toBe("done");
    // only "second" should have been invoked by the runner since "confirm" was
    // already flipped to done by runApprove before runPipelineOnce started.
    expect(calls).toEqual(["second"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runApprove stops with a paused downstream stage when given an already-aborted signal", async () => {
  const { cwd, runId } = setupRun([
    { id: "confirm", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" },
    { id: "develop", status: "pending" },
  ]);
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await runApprove(cwd, { runId }, { runners: {} }, controller.signal);
    expect(result.status).toBe("resumed");
    expect(result.state!.stages[1].status).toBe("paused");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
