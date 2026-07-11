import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApprove } from "../../src/commands/approve";
import { readGateAnswer } from "../../src/gate-answer/answer";
import { readEvents } from "../../src/events/events";

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

function setupRunWithPipeline(
  pipelineYaml: string,
  stages: Array<{ id: string; status: string; entered_at?: string }>
): { cwd: string; runId: string; runDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-approve-test-"));
  const runId = "20260706_000000_abc123";
  const runDir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(cwd, ".aiflow", "config", "pipelines"), { recursive: true });
  writeFileSync(
    join(cwd, ".aiflow", "config", "models.yaml"),
    `profiles:\n  main-dev:\n    channel: opencode\n    provider: opencode\n    model: x\n`
  );
  writeFileSync(join(cwd, ".aiflow", "config", "pipelines", "test-pipeline.yaml"), pipelineYaml);
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      run_id: runId,
      pipeline: "test-pipeline",
      stages,
      cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    })
  );
  return { cwd, runId, runDir };
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
    // The resume loop revisits the waiting gate; the runner consumes the
    // gate-answer.json written by runApprove and returns pass, then runs
    // the downstream stage.
    expect(calls).toEqual(["confirm", "second"]);
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

test("writes gate-answer.json and a gate_answered event before resuming", async () => {
  const { cwd, runId } = setupRun([{ id: "confirm", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" }]);
  const runDir = join(cwd, ".aiflow", "runs", runId);
  try {
    const result = await runApprove(cwd, { runId }, {
      runners: {
        human_gate: async () => ({ result: "pass" }),
      },
    });
    expect(result.status).toBe("resumed");

    const answer = readGateAnswer(runDir);
    expect(answer).not.toBeUndefined();
    expect(answer!.stage).toBe("confirm");
    expect(answer!.status).toBe("answered");
    expect(answer!.action).toBe("approve");
    expect(answer!.answered_at).toBeTruthy();

    const events = readEvents(runDir);
    const answeredEvent = events.find((e) => e.type === "gate_answered");
    expect(answeredEvent).toBeDefined();
    expect((answeredEvent as any).stage).toBe("confirm");
    expect((answeredEvent as any).by).toBe("cli");
    expect((answeredEvent as any).action).toBe("approve");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("--stage writes gate-answer.json only for the named stage", async () => {
  const { cwd, runId } = setupRun([
    { id: "confirm-a", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" },
    { id: "confirm-b", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" },
  ]);
  const runDir = join(cwd, ".aiflow", "runs", runId);
  try {
    const result = await runApprove(cwd, { runId, stage: "confirm-a" });
    expect(result.status).toBe("resumed");

    const answer = readGateAnswer(runDir);
    expect(answer!.stage).toBe("confirm-a");
    expect(answer!.action).toBe("approve");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("unresolved questions pause at the brainstorm stage, not a later human_gate", async () => {
  const pipelineYaml = `name: test-pipeline
autonomy: full
stages:
  - id: brainstorm
    type: brainstorm
    models: [a, b]
    synthesizer: main-dev
  - id: gate
    type: human_gate
    prompt: "ok?"
`;
  const { cwd, runId, runDir } = setupRunWithPipeline(
    pipelineYaml,
    [
      { id: "brainstorm", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" },
      { id: "gate", status: "pending" },
    ]
  );
  writeFileSync(
    join(runDir, "specboard.json"),
    JSON.stringify({
      requirement: "test",
      artifacts: {},
      open_questions: [{ id: "q1", topic: "t1", positions: {} }],
      decisions: [],
      review_matrix: {},
    })
  );
  try {
    await expect(runApprove(cwd, { runId })).rejects.toThrow(/unresolved open questions/);
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
    expect(state.stages[0].status).toBe("waiting_human");
    expect(state.stages[1].status).toBe("pending");
    expect(existsSync(join(runDir, "gate-answer.json"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("main_dev_decides resolves open questions and runs the downstream human_gate", async () => {
  const pipelineYaml = `name: test-pipeline
autonomy: full
stages:
  - id: brainstorm
    type: brainstorm
    models: [a, b]
    synthesizer: main-dev
    on_unresolved: main_dev_decides
  - id: gate
    type: human_gate
    prompt: "ok?"
`;
  const { cwd, runId, runDir } = setupRunWithPipeline(
    pipelineYaml,
    [
      { id: "brainstorm", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" },
      { id: "gate", status: "pending" },
    ]
  );
  writeFileSync(
    join(runDir, "specboard.json"),
    JSON.stringify({
      requirement: "test",
      artifacts: {},
      open_questions: [{ id: "q1", topic: "t1", positions: {} }],
      decisions: [],
      review_matrix: {},
    })
  );
  try {
    const result = await runApprove(cwd, { runId }, {
      callLlm: async () => ({
        text: JSON.stringify({ resolutions: [{ id: "q1", resolution: "resolved by main dev" }] }),
        usage: { inTok: 0, outTok: 0, costUsd: 0 },
      }),
      runners: {},
    });
    expect(result.status).toBe("resumed");
    expect(result.state!.stages[0].status).toBe("done");
    expect(result.state!.stages[1].status).toBe("waiting_human");
    const answer = readGateAnswer(runDir);
    expect(answer).not.toBeUndefined();
    expect(answer!.stage).toBe("gate");
    expect(answer!.status).toBe("waiting");
    const board = JSON.parse(readFileSync(join(runDir, "specboard.json"), "utf-8"));
    expect(board.open_questions).toHaveLength(0);
    expect(board.decisions).toHaveLength(1);
    expect(board.decisions[0].resolution).toBe("resolved by main dev");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("ask_human rejects approval of a non-gate stage with unresolved questions", async () => {
  const pipelineYaml = `name: test-pipeline
autonomy: full
stages:
  - id: brainstorm
    type: brainstorm
    models: [a, b]
    synthesizer: main-dev
  - id: gate
    type: human_gate
    prompt: "ok?"
`;
  const { cwd, runId, runDir } = setupRunWithPipeline(
    pipelineYaml,
    [
      { id: "brainstorm", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" },
      { id: "gate", status: "pending" },
    ]
  );
  writeFileSync(
    join(runDir, "specboard.json"),
    JSON.stringify({
      requirement: "test",
      artifacts: {},
      open_questions: [{ id: "q1", topic: "t1", positions: {} }],
      decisions: [],
      review_matrix: {},
    })
  );
  try {
    await expect(runApprove(cwd, { runId })).rejects.toThrow(/unresolved open questions/);
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
    expect(state.stages[1].status).toBe("pending");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("main_dev_decides resolves open questions when approving a non-gate stage", async () => {
  const pipelineYaml = `name: test-pipeline
autonomy: full
stages:
  - id: brainstorm
    type: brainstorm
    models: [a, b]
    synthesizer: main-dev
    on_unresolved: main_dev_decides
`;
  const { cwd, runId, runDir } = setupRunWithPipeline(
    pipelineYaml,
    [{ id: "brainstorm", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" }]
  );
  writeFileSync(
    join(runDir, "specboard.json"),
    JSON.stringify({
      requirement: "test",
      artifacts: {},
      open_questions: [{ id: "q1", topic: "t1", positions: {} }],
      decisions: [],
      review_matrix: {},
    })
  );
  try {
    const result = await runApprove(cwd, { runId }, {
      callLlm: async () => ({
        text: JSON.stringify({ resolutions: [{ id: "q1", resolution: "resolved by main dev" }] }),
        usage: { inTok: 0, outTok: 0, costUsd: 0 },
      }),
      runners: {},
    });
    expect(result.status).toBe("resumed");
    expect(result.state!.stages[0].status).toBe("done");
    const board = JSON.parse(readFileSync(join(runDir, "specboard.json"), "utf-8"));
    expect(board.open_questions).toHaveLength(0);
    expect(board.decisions).toHaveLength(1);
    expect(board.decisions[0].resolution).toBe("resolved by main dev");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("main_dev_decides passes budget limits to callLlm and records usage in state", async () => {
  const pipelineYaml = `name: test-pipeline
autonomy: full
budget:
  max_cost_usd: 1
  max_retry_steps: 7
  max_token_cost: 500
stages:
  - id: brainstorm
    type: brainstorm
    models: [a, b]
    synthesizer: main-dev
    on_unresolved: main_dev_decides
`;
  const { cwd, runId, runDir } = setupRunWithPipeline(
    pipelineYaml,
    [{ id: "brainstorm", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" }]
  );
  writeFileSync(
    join(runDir, "specboard.json"),
    JSON.stringify({
      requirement: "test",
      artifacts: {},
      open_questions: [{ id: "q1", topic: "t1", positions: {} }],
      decisions: [],
      review_matrix: {},
    })
  );
  try {
    let seenOptions: any;
    const result = await runApprove(cwd, { runId }, {
      callLlm: async (opts: any) => {
        seenOptions = opts;
        return {
          text: JSON.stringify({ resolutions: [{ id: "q1", resolution: "resolved by main dev" }] }),
          usage: { inTok: 10, outTok: 20, costUsd: 0.05 },
        };
      },
      runners: {},
    });
    expect(result.status).toBe("resumed");
    expect(result.state!.stages[0].status).toBe("done");
    expect(result.state!.cost).toEqual({ input_tokens: 10, output_tokens: 20, est_usd: 0.05 });
    expect(seenOptions.maxRetrySteps).toBe(7);
    expect(seenOptions.maxTokenCost).toBe(500);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("main_dev_decides aborts when budget limit is exceeded", async () => {
  const pipelineYaml = `name: test-pipeline
autonomy: full
budget:
  max_cost_usd: 0.01
stages:
  - id: brainstorm
    type: brainstorm
    models: [a, b]
    synthesizer: main-dev
    on_unresolved: main_dev_decides
`;
  const { cwd, runId, runDir } = setupRunWithPipeline(
    pipelineYaml,
    [{ id: "brainstorm", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" }]
  );
  writeFileSync(
    join(runDir, "specboard.json"),
    JSON.stringify({
      requirement: "test",
      artifacts: {},
      open_questions: [{ id: "q1", topic: "t1", positions: {} }],
      decisions: [],
      review_matrix: {},
    })
  );
  try {
    await expect(runApprove(cwd, { runId }, {
      callLlm: async () => ({
        text: JSON.stringify({ resolutions: [{ id: "q1", resolution: "resolved by main dev" }] }),
        usage: { inTok: 0, outTok: 0, costUsd: 0.02 },
      }),
      runners: {},
    })).rejects.toThrow(/Budget exceeded/);
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
    expect(state.stages[0].status).toBe("aborted");
    expect(state.stages[0].reason).toBe("budget_exceeded");
    const board = JSON.parse(readFileSync(join(runDir, "specboard.json"), "utf-8"));
    expect(board.open_questions).toHaveLength(1);
    expect(board.decisions).toHaveLength(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("ralph_loop stage-level on_unresolved main_dev_decides resolves open questions", async () => {
  const pipelineYaml = `name: test-pipeline
autonomy: full
stages:
  - id: develop
    type: ralph_loop
    model: main-dev
    on_unresolved: main_dev_decides
    gate:
      checks: []
      ai_review:
        enabled: false
        model: reviewer
        fail_on: ["blocker"]
`;
  const { cwd, runId, runDir } = setupRunWithPipeline(
    pipelineYaml,
    [{ id: "develop", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" }]
  );
  writeFileSync(
    join(runDir, "specboard.json"),
    JSON.stringify({
      requirement: "test",
      artifacts: {},
      open_questions: [{ id: "q1", topic: "t1", positions: {} }],
      decisions: [],
      review_matrix: {},
    })
  );
  try {
    const result = await runApprove(cwd, { runId }, {
      callLlm: async () => ({
        text: JSON.stringify({ resolutions: [{ id: "q1", resolution: "resolved by main dev" }] }),
        usage: { inTok: 0, outTok: 0, costUsd: 0 },
      }),
      runners: {},
    });
    expect(result.status).toBe("resumed");
    expect(result.state!.stages[0].status).toBe("done");
    const board = JSON.parse(readFileSync(join(runDir, "specboard.json"), "utf-8"));
    expect(board.open_questions).toHaveLength(0);
    expect(board.decisions).toHaveLength(1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("main_dev_decides rejects resolutions with missing question IDs", async () => {
  const pipelineYaml = `name: test-pipeline
autonomy: full
stages:
  - id: brainstorm
    type: brainstorm
    models: [a, b]
    synthesizer: main-dev
    on_unresolved: main_dev_decides
`;
  const { cwd, runId, runDir } = setupRunWithPipeline(
    pipelineYaml,
    [{ id: "brainstorm", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" }]
  );
  writeFileSync(
    join(runDir, "specboard.json"),
    JSON.stringify({
      requirement: "test",
      artifacts: {},
      open_questions: [
        { id: "q1", topic: "t1", positions: {} },
        { id: "q2", topic: "t2", positions: {} },
      ],
      decisions: [],
      review_matrix: {},
    })
  );
  try {
    await expect(runApprove(cwd, { runId }, {
      callLlm: async () => ({
        text: JSON.stringify({ resolutions: [{ id: "q1", resolution: "resolved" }] }),
        usage: { inTok: 0, outTok: 0, costUsd: 0 },
      }),
      runners: {},
    })).rejects.toThrow(/missing=\[q2\]/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("main_dev_decides rejects resolutions with unknown question IDs", async () => {
  const pipelineYaml = `name: test-pipeline
autonomy: full
stages:
  - id: brainstorm
    type: brainstorm
    models: [a, b]
    synthesizer: main-dev
    on_unresolved: main_dev_decides
`;
  const { cwd, runId, runDir } = setupRunWithPipeline(
    pipelineYaml,
    [{ id: "brainstorm", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" }]
  );
  writeFileSync(
    join(runDir, "specboard.json"),
    JSON.stringify({
      requirement: "test",
      artifacts: {},
      open_questions: [{ id: "q1", topic: "t1", positions: {} }],
      decisions: [],
      review_matrix: {},
    })
  );
  try {
    await expect(runApprove(cwd, { runId }, {
      callLlm: async () => ({
        text: JSON.stringify({ resolutions: [{ id: "q1", resolution: "resolved" }, { id: "q2", resolution: "unknown" }] }),
        usage: { inTok: 0, outTok: 0, costUsd: 0 },
      }),
      runners: {},
    })).rejects.toThrow(/unknown=\[q2\]/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function setupWaitingRun(autoClean: boolean): { cwd: string; runId: string; runDir: string; stateJson: string } {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-approve-dirty-"));
  mkdirSync(join(cwd, ".aiflow", "config", "pipelines"), { recursive: true });
  writeFileSync(
    join(cwd, ".aiflow", "config", "models.yaml"),
    "profiles:\n  main-dev:\n    channel: opencode\n    provider: x\n    model: y\n  reviewer:\n    channel: http\n    provider: y\n    model: z\n"
  );
  writeFileSync(
    join(cwd, ".aiflow", "config", "pipelines", "gated.yaml"),
    `name: gated\nstages:\n  - id: confirm\n    type: human_gate\n    prompt: "ok?"\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    per_story_fix_limit: 3\n    auto_clean: ${autoClean}\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n`
  );
  const runId = "20260708_130000_abcd12";
  const runDir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const stateJson = JSON.stringify({
    run_id: runId,
    pipeline: "gated",
    stages: [
      { id: "confirm", status: "waiting_human" },
      { id: "develop", status: "pending" },
    ],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
  });
  writeFileSync(join(runDir, "state.json"), stateJson);
  return { cwd, runId, runDir, stateJson };
}

test("approve rejects a dirty tree for an auto_clean pipeline without recording the approval", async () => {
  const { cwd, runId, runDir, stateJson } = setupWaitingRun(true);
  try {
    await expect(
      runApprove(cwd, { runId }, undefined, undefined, async () => false)
    ).rejects.toThrow(/auto_clean enabled on a ralph_loop stage/);
    // state.json 未被改动：confirm 仍是 waiting_human，approval 没落盘。
    const after = readFileSync(join(runDir, "state.json"), "utf-8");
    expect(after).toBe(stateJson);
    // gate-answer.json 也不应被创建。
    expect(existsSync(join(runDir, "gate-answer.json"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
