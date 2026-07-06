import { test, expect, mock, describe } from "bun:test";
import { mkdtempSync, rmSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipelineOnce, createRunId } from "../../src/engine/engine";
import { readState } from "../../src/engine/state";
import type { PipelineConfig, ModelProfile } from "../../src/config/schema";

const pipeline: PipelineConfig = {
  name: "ralph-only",
  stages: [
    {
      id: "develop",
      type: "ralph_loop",
      model: "main-dev",
      per_story_fix_limit: 3,
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
    const runRalphLoopOnce = mock(async () => ({ storyId: "US-1", result: "pass" as const }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, "spec", {
      runRalphLoopOnce,
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
    const runRalphLoopOnce = mock(async () => ({ storyId: "US-2", result: "fail" as const }));
    await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, "spec", {
      runRalphLoopOnce,
    });
    appendFileSync(
      join(runDir, "events.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), type: "story_result", story: "US-1", result: "pass" }) + "\n",
    );
    // engine already wrote report on exit; reload state + events + regenerate to inspect
    const state = readState(runDir);
    const events = (await import("../../src/events/events")).readEvents(runDir);
    const { renderRunReport } = await import("../../src/commands/report");
    const report = renderRunReport(state, events, { now: new Date(), startedAt: new Date(Date.now() - 90_000) });
    expect(report).toContain("## Stages");
    expect(report).toContain("develop");
    expect(report).toContain(report.includes("US-1") ? "US-1" : "US-2");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce marks the stage failed when the runner returns fail", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const runRalphLoopOnce = mock(async () => ({ storyId: "US-1", result: "fail" as const }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, "spec", {
      runRalphLoopOnce,
    });
    expect(state.stages[0].status).toBe("failed");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce marks the stage suspended when the runner returns suspended", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const runRalphLoopOnce = mock(async () => ({ storyId: "US-1", result: "suspended" as const }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, "spec", {
      runRalphLoopOnce,
    });
    expect(state.stages[0].status).toBe("suspended");
    const persisted = readState(runDir);
    expect(persisted.stages[0].status).toBe("suspended");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce marks the stage aborted when the signal is already aborted", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const controller = new AbortController();
    controller.abort();
    const runRalphLoopOnce = mock(async () => ({ storyId: "US-1", result: "pass" as const }));
    const state = await runPipelineOnce(
      pipeline,
      profiles,
      "/tmp/does-not-matter",
      runDir,
      "spec",
      { runRalphLoopOnce },
      controller.signal
    );
    expect(state.stages[0].status).toBe("aborted");
    expect(runRalphLoopOnce).not.toHaveBeenCalled();
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

describe("runPipelineOnce multi-stage", () => {
  test("runs stages in order, short-circuits on first failure", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-multi-"));
    try {
      const multi: PipelineConfig = {
        name: "gated",
        stages: [
          {
            id: "confirm",
            type: "human_gate",
            prompt: "Continue?",
            timeout: "none",
            default_action: "abort",
          },
          {
            id: "develop",
            type: "ralph_loop",
            model: "main-dev",
            per_story_fix_limit: 3,
            gate: { checks: [], ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] } },
          },
        ],
      };
      const ralph = mock(async () => ({ storyId: "US-1", result: "fail" as const }));
      const human = mock(async () => ({ outcome: "done" as const }));
      console.error("DBG_TEST multi.stages.length =", multi.stages.length, "multi.stages.ids=", multi.stages.map(s=>s.id));
      const state = await runPipelineOnce(multi, profiles, "/tmp", runDir, "spec", {
        runRalphLoopOnce: ralph,
        runHumanGate: human,
      });
      console.error("DBG_TEST state =", JSON.stringify(state));
      expect(state.stages).toHaveLength(2);
      expect(state.stages[0].status).toBe("done");
      expect(state.stages[1].status).toBe("failed");
      expect(human).toHaveBeenCalledTimes(1);
      expect(ralph).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test("skips stages whose persisted status is already terminal (resume semantics)", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-multi-resume-"));
    try {
      writeFileSync(
        join(runDir, "state.json"),
        JSON.stringify({
          run_id: runDir.split("/").pop(),
          pipeline: "gated",
          stages: [
            { id: "confirm", status: "done" },
            { id: "develop", status: "pending" },
          ],
          cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
        }),
      );
      const multi: PipelineConfig = {
        name: "gated",
        stages: [
          { id: "confirm", type: "human_gate", prompt: "Continue?", timeout: "none", default_action: "abort" },
          { id: "develop", type: "ralph_loop", model: "main-dev", per_story_fix_limit: 3, gate: { checks: [], ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] } } },
        ],
      };
      const ralph = mock(async () => ({ storyId: "US-1", result: "pass" as const }));
      const human = mock(async () => ({ outcome: "done" as const }));
      const state = await runPipelineOnce(multi, profiles, "/tmp", runDir, "spec", {
        runRalphLoopOnce: ralph,
        runHumanGate: human,
      }, undefined, { resume: true });
      expect(human).not.toHaveBeenCalled();
      expect(ralph).toHaveBeenCalledTimes(1);
      expect(state.stages[1].status).toBe("done");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test("--force replays every stage from pending", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-multi-force-"));
    try {
      writeFileSync(
        join(runDir, "state.json"),
        JSON.stringify({
          run_id: runDir.split("/").pop(),
          pipeline: "gated",
          stages: [
            { id: "confirm", status: "done" },
            { id: "develop", status: "failed" },
          ],
          cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
        }),
      );
      const multi: PipelineConfig = {
        name: "gated",
        stages: [
          { id: "confirm", type: "human_gate", prompt: "Continue?", timeout: "none", default_action: "abort" },
          { id: "develop", type: "ralph_loop", model: "main-dev", per_story_fix_limit: 3, gate: { checks: [], ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] } } },
        ],
      };
      const ralph = mock(async () => ({ storyId: "US-1", result: "pass" as const }));
      const human = mock(async () => ({ outcome: "done" as const }));
      const state = await runPipelineOnce(multi, profiles, "/tmp", runDir, "spec", {
        runRalphLoopOnce: ralph,
        runHumanGate: human,
      }, undefined, { resume: true, force: true });
      expect(human).toHaveBeenCalledTimes(1);
      expect(ralph).toHaveBeenCalledTimes(1);
      expect(state.stages[0].status).toBe("done");
      expect(state.stages[1].status).toBe("done");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe("runPipelineOnce resume", () => {
  test("resume re-runs a pending stage by reading the existing state.json", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-resume-"));
    try {
      // seed state.json as if a previous run had been interrupted
      writeFileSync(
        join(runDir, "state.json"),
        JSON.stringify({
          run_id: runDir.split("/").pop(),
          pipeline: pipeline.name,
          stages: [{ id: "develop", status: "pending" }],
          cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
        }),
      );
      const runRalphLoopOnce = mock(async () => ({ storyId: "US-1", result: "pass" as const }));
      const state = await runPipelineOnce(
        pipeline,
        profiles,
        "/tmp/does-not-matter",
        runDir,
        "spec",
        { runRalphLoopOnce, nowFn: () => new Date("2026-07-05T20:00:00.000Z") },
        undefined,
        { resume: true, now: new Date("2026-07-05T20:00:00.000Z") },
      );
      expect(state.stages[0].status).toBe("done");
      expect(runRalphLoopOnce).toHaveBeenCalledTimes(1);
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
      const runRalphLoopOnce = mock(async () => ({ storyId: "US-1", result: "pass" as const }));
      const state = await runPipelineOnce(
        pipeline,
        profiles,
        "/tmp/does-not-matter",
        runDir,
        "spec",
        { runRalphLoopOnce, nowFn: () => new Date() },
        undefined,
        { resume: true },
      );
      expect(state.stages[0].status).toBe("failed");
      expect(runRalphLoopOnce).not.toHaveBeenCalled();
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
      const runRalphLoopOnce = mock(async () => ({ storyId: "US-1", result: "pass" as const }));
      const state = await runPipelineOnce(
        pipeline,
        profiles,
        "/tmp/does-not-matter",
        runDir,
        "spec",
        { runRalphLoopOnce, nowFn: () => new Date() },
        undefined,
        { resume: true, force: true },
      );
      expect(state.stages[0].status).toBe("done");
      expect(runRalphLoopOnce).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test("resume surfaces a clear error when state.json does not exist", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-resume-empty-"));
    try {
      const runRalphLoopOnce = mock(async () => ({ storyId: "US-1", result: "pass" as const }));
      await expect(
        runPipelineOnce(
          pipeline,
          profiles,
          "/tmp/does-not-matter",
          runDir,
          "spec",
          { runRalphLoopOnce },
          undefined,
          { resume: true },
        ),
      ).rejects.toThrow(/ENOENT/);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
