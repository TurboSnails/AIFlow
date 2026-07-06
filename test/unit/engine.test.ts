import { test, expect, mock, describe } from "bun:test";
import { mkdtempSync, rmSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipelineOnce, createRunId, summarizePipelineOutcome } from "../../src/engine/engine";
import { readState } from "../../src/engine/state";
import type { PipelineConfig, ModelProfile } from "../../src/config/schema";
import type { EngineState } from "../../src/engine/state";

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
    expect(state.stages[0].status).toBe("aborted");
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
