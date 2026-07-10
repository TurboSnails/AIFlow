import { test, expect, mock, describe } from "bun:test";
import { mkdtempSync, rmSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipelineOnce, createRunId, summarizePipelineOutcome } from "../../src/engine/engine";
import { readState } from "../../src/engine/state";
import type { PipelineConfig, ModelProfile } from "../../src/config/schema";
import type { EngineState } from "../../src/engine/state";
import { readEvents } from "../../src/events/events";

const pipeline: PipelineConfig = {
  name: "ralph-only",
  stages: [
    {
      id: "develop",
      type: "ralph_loop",
      model: "main-dev",
      per_story_fix_limit: 3,
      max_iterations: 10,
      stall_limit: 3,
      auto_clean: false,
      gate: { checks: [], ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] } },
    },
  ],
};

const profiles: Record<string, ModelProfile> = {
  "main-dev": { channel: "opencode", provider: "opencode", model: "x" },
  reviewer: { channel: "http", provider: "minimax", model: "y" },
};

test("createRunId returns a non-empty, filesystem-safe string", () => {
  const id = createRunId();
  expect(id.length).toBeGreaterThan(0);
  expect(id).toMatch(/^[a-zA-Z0-9_]+$/);
});

test("runPipelineOnce marks the stage done and writes final state.json on success", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const ralphLoop = mock(async () => ({ result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, {
      runners: { ralph_loop: ralphLoop },
    });
    expect(state.stages[0].status).toBe("done");
    const persisted = readState(runDir);
    expect(persisted.stages[0].status).toBe("done");
    const reportPath = join(runDir, "run-report.md");
    expect(existsSync(reportPath)).toBe(true);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce writes a run-report.md mentioning each terminal result", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const ralphLoop = mock(async () => ({
      result: "suspended" as const,
      reason: "stories_suspended" as const,
      usage: { inTok: 0, outTok: 0, costUsd: 0 },
    }));
    await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, { runners: { ralph_loop: ralphLoop } });
    appendFileSync(
      join(runDir, "events.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), type: "story_result", story: "US-1", result: "suspended" }) + "\n",
    );
    const state = readState(runDir);
    const events = (await import("../../src/events/events")).readEvents(runDir);
    const { renderRunReport } = await import("../../src/commands/report");
    const report = renderRunReport(state, events, { now: new Date(), startedAt: new Date(Date.now() - 90_000) });
    expect(report).toContain("## Stages");
    expect(report).toContain("develop");
    expect(report).toContain("US-1");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce marks the stage suspended when the runner returns suspended", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const ralphLoop = mock(async () => ({
      result: "suspended" as const,
      reason: "max_iterations" as const,
      usage: { inTok: 0, outTok: 0, costUsd: 0 },
    }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, {
      runners: { ralph_loop: ralphLoop },
    });
    expect(state.stages[0].status).toBe("suspended");
    const persisted = readState(runDir);
    expect(persisted.stages[0].status).toBe("suspended");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce marks the stage aborted when a human_gate runner times out with on_timeout: abort", async () => {
  // Regression test: STATUS_MAP must still map StageOutcome's "aborted" result
  // (returned by human-gate.ts's genuinely-terminal on_timeout: abort case,
  // independent of the unrelated signal-triggered "paused" result) through to
  // an "aborted" stage status. This path had no test coverage and silently
  // broke when "aborted" was over-narrowed out of StageOutcome.
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const humanGate = mock(async () => ({
      result: "aborted" as const,
      reason: "human_gate_timeout" as const,
    }));
    const gatePipeline: PipelineConfig = {
      name: "gate-only",
      stages: [{ id: "review", type: "human_gate", prompt: "Approve?", timeout: 1, on_timeout: "abort" }],
    };
    const state = await runPipelineOnce(gatePipeline, profiles, "/tmp/does-not-matter", runDir, {
      runners: { human_gate: humanGate },
    });
    expect(state.stages[0].status).toBe("aborted");
    const persisted = readState(runDir);
    expect(persisted.stages[0].status).toBe("aborted");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce passes the runner's reason through onto state.stages[i].reason", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const ralphLoop = mock(async () => ({
      result: "suspended" as const,
      reason: "stall" as const,
      usage: { inTok: 0, outTok: 0, costUsd: 0 },
    }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, {
      runners: { ralph_loop: ralphLoop },
    });
    expect(state.stages[0].reason).toBe("stall");
    const persisted = readState(runDir);
    expect(persisted.stages[0].reason).toBe("stall");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce aggregates the runner's usage into state.cost", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const ralphLoop = mock(async () => ({
      result: "pass" as const,
      usage: { inTok: 123, outTok: 45, costUsd: 0.0067 },
    }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, {
      runners: { ralph_loop: ralphLoop },
    });
    expect(state.cost).toEqual({ input_tokens: 123, output_tokens: 45, est_usd: 0.0067 });
    const persisted = readState(runDir);
    expect(persisted.cost).toEqual({ input_tokens: 123, output_tokens: 45, est_usd: 0.0067 });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce throws a clear error for a stage type with no registered runner", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  // As of Task 10, engine.ts's defaultDeps registers a real adapter for every
  // known StageConfig["type"] (ralph_loop/brainstorm/spec/plan/human_gate), so
  // this test can no longer use one of those to exercise the "no runner
  // registered" throw. It uses a stage type outside the discriminated union
  // instead, to prove executeStage's defensive check still fires for a truly
  // unregistered type (e.g. a future stage type added without a default).
  const unknownTypePipeline: PipelineConfig = {
    name: "has-unknown-type",
    stages: [
      {
        id: "mystery",
        type: "totally_unregistered_stage_type",
      } as unknown as PipelineConfig["stages"][number],
    ],
  };
  try {
    await expect(
      runPipelineOnce(unknownTypePipeline, profiles, "/tmp/does-not-matter", runDir, { runners: {} })
    ).rejects.toThrow(/No runner registered for stage type "totally_unregistered_stage_type"/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce's dependency merge does not let overriding one runner wipe out another type's default (ralph_loop stays registered)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-engine-test-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    writeFileSync(join(cwd, "prd.json"), JSON.stringify({ branchName: "x", stories: [] }));
    // Override a completely unrelated stage type — must NOT affect ralph_loop's default runner.
    // Under the old flat-spread bug, this wipes out defaultDeps.runners.ralph_loop entirely,
    // and the ralph_loop stage below would fail with "No runner registered for stage type ralph_loop".
    const unrelatedOverride = mock(async () => ({ result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
    const state = await runPipelineOnce(pipeline, profiles, cwd, runDir, {
      runners: { brainstorm: unrelatedOverride },
    });
    // With an empty prd.json (no pending stories), the real default ralph_loop runner
    // (adaptRalphLoop -> runRalphLoop) returns "pass" immediately with zero agent/git calls.
    expect(state.stages[0].status).toBe("done");
    expect(unrelatedOverride).not.toHaveBeenCalled();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce drops an unrecognized reason string rather than passing it through unchecked", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const ralphLoop = mock(async () => ({ result: "suspended" as const, reason: "not_a_real_reason", usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, {
      runners: { ralph_loop: ralphLoop },
    });
    expect(state.stages[0].reason).toBeUndefined();
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("summarizePipelineOutcome reports success and exit 0 only when every stage is done", () => {
  const allDone: EngineState = {
    run_id: "r1",
    pipeline: "p",
    stages: [{ id: "a", status: "done" }, { id: "b", status: "done" }],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
  };
  const outcome = summarizePipelineOutcome(allDone);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.line).toContain("a");
  expect(outcome.line).toContain("b");
});

test("summarizePipelineOutcome reports the first non-done stage and exit 1, even if it isn't stages[0]", () => {
  const laterStageFailed: EngineState = {
    run_id: "r1",
    pipeline: "p",
    stages: [{ id: "a", status: "done" }, { id: "b", status: "failed" }],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
  };
  const outcome = summarizePipelineOutcome(laterStageFailed);
  expect(outcome.exitCode).toBe(1);
  expect(outcome.line).toContain("b");
  expect(outcome.line).toContain("failed");
});

test("runPipelineOnce marks the stage aborted when the signal is already aborted", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const controller = new AbortController();
    controller.abort();
    const ralphLoop = mock(async () => ({ result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
    const state = await runPipelineOnce(
      pipeline,
      profiles,
      "/tmp/does-not-matter",
      runDir,
      { runners: { ralph_loop: ralphLoop } },
      controller.signal
    );
    expect(state.stages[0].status).toBe("paused");
    expect(ralphLoop).not.toHaveBeenCalled();
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

describe("runPipelineOnce resume", () => {
  test("resume re-runs a pending stage by reading the existing state.json", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-resume-"));
    try {
      writeFileSync(
        join(runDir, "state.json"),
        JSON.stringify({
          run_id: runDir.split("/").pop(),
          pipeline: pipeline.name,
          stages: [{ id: "develop", status: "pending" }],
          cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
        }),
      );
      const ralphLoop = mock(async () => ({ result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
      const state = await runPipelineOnce(
        pipeline,
        profiles,
        "/tmp/does-not-matter",
        runDir,
        { runners: { ralph_loop: ralphLoop }, nowFn: () => new Date("2026-07-05T20:00:00.000Z") },
        undefined,
        { resume: true, now: new Date("2026-07-05T20:00:00.000Z") },
      );
      expect(state.stages[0].status).toBe("done");
      expect(ralphLoop).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test("resume is a no-op when the only stage is already terminal (without --force)", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-resume-"));
    try {
      writeFileSync(
        join(runDir, "state.json"),
        JSON.stringify({
          run_id: runDir.split("/").pop(),
          pipeline: pipeline.name,
          stages: [{ id: "develop", status: "failed" }],
          cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
        }),
      );
      const ralphLoop = mock(async () => ({ result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
      const state = await runPipelineOnce(
        pipeline,
        profiles,
        "/tmp/does-not-matter",
        runDir,
        { runners: { ralph_loop: ralphLoop }, nowFn: () => new Date() },
        undefined,
        { resume: true },
      );
      expect(state.stages[0].status).toBe("failed");
      expect(ralphLoop).not.toHaveBeenCalled();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test("runPipelineOnce resumes a paused stage without --force (paused is not terminal)", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-resume-"));
    try {
      writeFileSync(
        join(runDir, "state.json"),
        JSON.stringify({
          run_id: runDir.split("/").pop(),
          pipeline: pipeline.name,
          stages: [{ id: "develop", status: "paused" }],
          cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
        }),
      );
      const ralphLoop = mock(async () => ({ result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
      const state = await runPipelineOnce(
        pipeline,
        profiles,
        "/tmp/does-not-matter",
        runDir,
        { runners: { ralph_loop: ralphLoop }, nowFn: () => new Date() },
        undefined,
        { resume: true },
      );
      expect(state.stages[0].status).toBe("done");
      expect(ralphLoop).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test("resume --force overrides a terminal stage and re-runs it", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-resume-"));
    try {
      writeFileSync(
        join(runDir, "state.json"),
        JSON.stringify({
          run_id: runDir.split("/").pop(),
          pipeline: pipeline.name,
          stages: [{ id: "develop", status: "suspended" }],
          cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
        }),
      );
      const ralphLoop = mock(async () => ({ result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
      const state = await runPipelineOnce(
        pipeline,
        profiles,
        "/tmp/does-not-matter",
        runDir,
        { runners: { ralph_loop: ralphLoop }, nowFn: () => new Date() },
        undefined,
        { resume: true, force: true },
      );
      expect(state.stages[0].status).toBe("done");
      expect(ralphLoop).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test("resume surfaces a clear error when state.json does not exist", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-resume-empty-"));
    try {
      const ralphLoop = mock(async () => ({ result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
      await expect(
        runPipelineOnce(
          pipeline,
          profiles,
          "/tmp/does-not-matter",
          runDir,
          { runners: { ralph_loop: ralphLoop } },
          undefined,
          { resume: true },
        ),
      ).rejects.toThrow(/ENOENT/);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

test("runPipelineOnce builds a budget tracker from pipeline.budget and passes it to the runner", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const budgetPipeline: PipelineConfig = { ...pipeline, budget: { max_cost_usd: 5 } };
    let seenLimit: number | undefined;
    const ralphLoop = mock(async (_stage, _stageState, _profiles, _cwd, _runDir, _nowFn, _signal, budget) => {
      seenLimit = budget?.limitUsd;
      return { result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } };
    });
    const state = await runPipelineOnce(budgetPipeline, profiles, "/tmp/does-not-matter", runDir, {
      runners: { ralph_loop: ralphLoop },
    });
    expect(seenLimit).toBe(5);
    expect(state.budget).toEqual({ limit_usd: 5 });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce's budget tracker for a later stage starts from the cost already spent in earlier stages", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const twoStagePipeline: PipelineConfig = {
      name: "two-stage",
      budget: { max_cost_usd: 10 },
      stages: [
        { id: "first", type: "ralph_loop", model: "main-dev", per_story_fix_limit: 3, max_iterations: 10, stall_limit: 3, auto_clean: false, gate: { checks: [], ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] } } },
        { id: "second", type: "ralph_loop", model: "main-dev", per_story_fix_limit: 3, max_iterations: 10, stall_limit: 3, auto_clean: false, gate: { checks: [], ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] } } },
      ],
    };
    let secondStageExceeded: boolean | undefined;
    const ralphLoop = mock(async (stage, _stageState, _profiles, _cwd, _runDir, _nowFn, _signal, budget) => {
      if (stage.id === "second") secondStageExceeded = budget?.record(0.000001);
      return { result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: stage.id === "first" ? 10 : 0 } };
    });
    await runPipelineOnce(twoStagePipeline, profiles, "/tmp/does-not-matter", runDir, {
      runners: { ralph_loop: ralphLoop },
    });
    expect(secondStageExceeded).toBe(true);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce with no pipeline.budget passes a tracker with limitUsd undefined", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    let seenLimit: number | undefined = -1;
    const ralphLoop = mock(async (_stage, _stageState, _profiles, _cwd, _runDir, _nowFn, _signal, budget) => {
      seenLimit = budget?.limitUsd;
      return { result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } };
    });
    await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, { runners: { ralph_loop: ralphLoop } });
    expect(seenLimit).toBeUndefined();
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce writes a stage_cost event per stage that reports usage, and their sum equals state.cost", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-cost-"));
  try {
    const ralphLoop = mock(async () => ({ result: "pass" as const, usage: { inTok: 120, outTok: 45, costUsd: 0.9 } }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, {
      runners: { ralph_loop: ralphLoop },
    });
    const events = readEvents(runDir);
    const stageCosts = events.filter((e) => e.type === "stage_cost");
    expect(stageCosts).toEqual([
      { ts: expect.any(String), type: "stage_cost", stage: "develop", in_tok: 120, out_tok: 45, cost_usd: 0.9 },
    ]);
    // 不变式：stage_cost 之和 == run 级 state.cost
    const sum = stageCosts.reduce((a, e) => a + (e.type === "stage_cost" ? e.cost_usd : 0), 0);
    expect(sum).toBeCloseTo(state.cost.est_usd, 10);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce does not write a stage_cost event for a stage that reports no usage", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-cost-nousage-"));
  try {
    const twoStage: PipelineConfig = {
      name: "gated",
      stages: [
        { id: "confirm", type: "human_gate", prompt: "ok?", on_timeout: "abort" },
        {
          id: "develop",
          type: "ralph_loop",
          model: "main-dev",
          per_story_fix_limit: 3,
          max_iterations: 10,
          stall_limit: 3,
          auto_clean: false,
          gate: { checks: [], ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] } },
        },
      ],
    };
    // human_gate returns waiting_human with NO usage → pipeline pauses at stage 0, no stage_cost written.
    const state = await runPipelineOnce(twoStage, profiles, "/tmp/does-not-matter", runDir, {
      runners: {
        human_gate: mock(async () => ({ result: "waiting_human" as const })),
      },
    });
    expect(state.stages[0].status).toBe("waiting_human");
    const events = readEvents(runDir);
    expect(events.filter((e) => e.type === "stage_cost")).toEqual([]);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce persists budget.warn_at_pct into state", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const warnPipeline: PipelineConfig = {
      ...pipeline,
      budget: { max_cost_usd: 10, warn_at_pct: [0.5, 0.8] },
    };
    const ralphLoop = mock(async () => ({ result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
    const state = await runPipelineOnce(warnPipeline, profiles, "/tmp/does-not-matter", runDir, {
      runners: { ralph_loop: ralphLoop },
    });
    expect(state.budget).toEqual({ limit_usd: 10, warn_at_pct: [0.5, 0.8] });
    const persisted = readState(runDir);
    expect(persisted.budget).toEqual({ limit_usd: 10, warn_at_pct: [0.5, 0.8] });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce emits budget_warning when a stage crosses a warn threshold", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const deps = {
      runners: {
        // stage 花费 8 USD,limit 10,跨 0.5 与 0.8 — mirrors how real stage
        // runners (e.g. ralph-loop.ts) call budget.record() as spend occurs.
        ralph_loop: async (_stage: any, _stageState: any, _profiles: any, _cwd: any, _runDir: any, _nowFn: any, _signal: any, budget: any) => {
          budget?.record(8);
          return { result: "pass", usage: { inTok: 0, outTok: 0, costUsd: 8 } };
        },
      },
      nowFn: () => new Date("2026-07-08T00:00:00.000Z"),
    } as any;
    const warnPipeline = {
      name: "p",
      budget: { max_cost_usd: 10, warn_at_pct: [0.5, 0.8] },
      stages: [{ id: "build", type: "ralph_loop" }],
    } as any;
    await runPipelineOnce(warnPipeline, {}, "/tmp", runDir, deps);
    const events = readEvents(runDir);
    const warnings = events.filter((e) => e.type === "budget_warning");
    expect(warnings.map((w: any) => w.threshold_pct)).toEqual([0.5, 0.8]);
    expect(warnings.every((w: any) => w.stage === "build" && w.limit_usd === 10 && w.spent_usd === 8)).toBe(true);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce does not re-emit budget_warning on resume once the stage is completed", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const deps = {
      runners: {
        // stage 花费 8 USD,limit 10,跨 0.5 与 0.8 — mirrors how real stage
        // runners (e.g. ralph-loop.ts) call budget.record() as spend occurs.
        ralph_loop: async (_stage: any, _stageState: any, _profiles: any, _cwd: any, _runDir: any, _nowFn: any, _signal: any, budget: any) => {
          budget?.record(8);
          return { result: "pass", usage: { inTok: 0, outTok: 0, costUsd: 8 } };
        },
      },
      nowFn: () => new Date("2026-07-08T00:00:00.000Z"),
    } as any;
    const warnPipeline = {
      name: "p",
      budget: { max_cost_usd: 10, warn_at_pct: [0.5, 0.8] },
      stages: [{ id: "build", type: "ralph_loop" }],
    } as any;

    await runPipelineOnce(warnPipeline, {}, "/tmp", runDir, deps);
    const firstWarnings = readEvents(runDir).filter((e) => e.type === "budget_warning");
    expect(firstWarnings.map((w: any) => w.threshold_pct)).toEqual([0.5, 0.8]);

    // The stage is now "done" (terminal), so a resume run skips re-running it
    // and must not re-drain/re-emit either threshold's budget_warning.
    await runPipelineOnce(warnPipeline, {}, "/tmp", runDir, deps, undefined, { resume: true });
    const warningsAfterResume = readEvents(runDir).filter((e) => e.type === "budget_warning");
    expect(warningsAfterResume.length).toBe(2);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce emits no budget_warning when there is no budget", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const deps = {
      runners: { ralph_loop: async () => ({ result: "pass", usage: { inTok: 0, outTok: 0, costUsd: 8 } }) },
    } as any;
    const noBudgetPipeline = { name: "p", stages: [{ id: "build", type: "ralph_loop" }] } as any;
    await runPipelineOnce(noBudgetPipeline, {}, "/tmp", runDir, deps);
    expect(readEvents(runDir).some((e) => e.type === "budget_warning")).toBe(false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

describe("runPipelineOnce AutonomyPolicy integration", () => {
  const brainstormSpecPipeline = (autonomy: "interactive" | "gated" | "full"): PipelineConfig => ({
    name: "brainstorm-spec",
    autonomy,
    stages: [
      {
        id: "ideate",
        type: "brainstorm",
        models: ["main-dev", "reviewer"],
        synthesizer: "main-dev",
      },
      {
        id: "specify",
        type: "spec",
        model: "main-dev",
      },
    ],
  });

  test("pauses after brainstorm under gated autonomy and does not run spec", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-autonomy-"));
    try {
      const brainstormRunner = mock(async () => ({ result: "pass" as const, usage: { inTok: 10, outTok: 5, costUsd: 0.0001 } }));
      const specRunner = mock(async () => ({ result: "pass" as const, usage: { inTok: 10, outTok: 5, costUsd: 0.0001 } }));
      const state = await runPipelineOnce(brainstormSpecPipeline("gated"), profiles, "/tmp/does-not-matter", runDir, {
        runners: { brainstorm: brainstormRunner, spec: specRunner },
      });

      expect(state.stages[0].status).toBe("waiting_human");
      expect(state.stages[1].status).toBe("pending");
      expect(brainstormRunner).toHaveBeenCalledTimes(1);
      expect(specRunner).not.toHaveBeenCalled();

      const events = readEvents(runDir);
      expect(events.some((e) => e.type === "stage_start" && e.stage === "ideate")).toBe(true);
      expect(events.some((e) => e.type === "stage_done" && e.stage === "ideate" && e.result === "pass")).toBe(true);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test("runs both brainstorm and spec under full autonomy", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-autonomy-"));
    try {
      const brainstormRunner = mock(async () => ({ result: "pass" as const, usage: { inTok: 10, outTok: 5, costUsd: 0.0001 } }));
      const specRunner = mock(async () => ({ result: "pass" as const, usage: { inTok: 10, outTok: 5, costUsd: 0.0001 } }));
      const state = await runPipelineOnce(brainstormSpecPipeline("full"), profiles, "/tmp/does-not-matter", runDir, {
        runners: { brainstorm: brainstormRunner, spec: specRunner },
      });

      expect(state.stages[0].status).toBe("done");
      expect(state.stages[1].status).toBe("done");
      expect(brainstormRunner).toHaveBeenCalledTimes(1);
      expect(specRunner).toHaveBeenCalledTimes(1);

      const events = readEvents(runDir);
      expect(events.filter((e) => e.type === "stage_start").map((e) => (e as any).stage)).toEqual(["ideate", "specify"]);
      expect(events.filter((e) => e.type === "stage_done").map((e) => (e as any).stage)).toEqual(["ideate", "specify"]);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test("stage-level autonomy override takes precedence over pipeline autonomy", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-autonomy-"));
    try {
      const brainstormRunner = mock(async () => ({ result: "pass" as const, usage: { inTok: 10, outTok: 5, costUsd: 0.0001 } }));
      const specRunner = mock(async () => ({ result: "pass" as const, usage: { inTok: 10, outTok: 5, costUsd: 0.0001 } }));
      const pipeline: PipelineConfig = {
        name: "brainstorm-spec",
        autonomy: "full",
        stages: [
          {
            id: "ideate",
            type: "brainstorm",
            autonomy: "gated",
            models: ["main-dev", "reviewer"],
            synthesizer: "main-dev",
          },
          {
            id: "specify",
            type: "spec",
            model: "main-dev",
          },
        ],
      };
      const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, {
        runners: { brainstorm: brainstormRunner, spec: specRunner },
      });

      expect(state.stages[0].status).toBe("waiting_human");
      expect(state.stages[1].status).toBe("pending");
      expect(brainstormRunner).toHaveBeenCalledTimes(1);
      expect(specRunner).not.toHaveBeenCalled();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test("interactive autonomy pauses after a ralph_loop stage and records autonomy_pause reason", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-autonomy-interactive-"));
    try {
      const interactivePipeline: PipelineConfig = {
        name: "ralph-interactive",
        autonomy: "interactive",
        stages: [
          {
            id: "develop",
            type: "ralph_loop",
            model: "main-dev",
            per_story_fix_limit: 3,
            max_iterations: 10,
            stall_limit: 3,
            auto_clean: false,
            gate: { checks: [], ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] } },
          },
        ],
      };
      const ralphLoop = mock(async () => ({
        result: "pass" as const,
        usage: { inTok: 10, outTok: 5, costUsd: 0.0001 },
      }));
      const state = await runPipelineOnce(interactivePipeline, profiles, "/tmp/does-not-matter", runDir, {
        runners: { ralph_loop: ralphLoop },
      });

      expect(state.stages[0].status).toBe("waiting_human");
      expect(state.stages[0].reason).toBe("autonomy_pause");
      expect(ralphLoop).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
