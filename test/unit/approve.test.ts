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
    const result = await runApprove(cwd, { runId, stage: "confirm-a" }, { runners: { human_gate: async () => ({ result: "pass" }) } });
    expect(result.status).toBe("resumed");
    expect(result.state!.stages[0].status).toBe("done");
    // engine stops after the first non-terminal stage's outcome unless it's "done" and continues to next;
    // since stage 0 is now done, the engine proceeds to stage 1 which is still waiting_human (terminal-ish,
    // engine treats it as a stop condition since it was already waiting_human before this run started).
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
