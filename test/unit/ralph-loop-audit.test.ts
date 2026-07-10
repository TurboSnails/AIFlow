import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRalphLoop } from "../../src/runners/ralph-loop";
import { writePrd, type Prd } from "../../src/prd";
import { readEvents } from "../../src/events/events";
import { readSpecBoard } from "../../src/specboard/specboard";
import type { RalphLoopStageConfig, ModelProfile } from "../../src/config/schema";

function samplePrd(): Prd {
  return {
    branchName: "feat/us-1",
    stories: [{ id: "US-1", title: "Implement clamp", acceptance: ["clamps correctly"], priority: 1, passes: false, fixCount: 0 }],
  };
}

const profiles: Record<string, ModelProfile> = {
  "main-dev": { channel: "opencode", provider: "opencode", model: "opencode/deepseek-v4-flash-free" },
  reviewer: { channel: "http", provider: "minimax", model: "x" },
};

function loopStageConfig(overrides: Partial<RalphLoopStageConfig> = {}): RalphLoopStageConfig {
  return {
    id: "develop",
    type: "ralph_loop",
    model: "main-dev",
    per_story_fix_limit: 3,
    max_iterations: 10,
    stall_limit: 3,
    auto_clean: false,
    gate: { checks: ["true"], ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] } },
    ...overrides,
  };
}

function makeFixtureDirs() {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-ralph-audit-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-ralph-audit-run-"));
  mkdirSync(join(cwd, ".aiflow", "config"), { recursive: true });
  writePrd(join(cwd, "prd.json"), samplePrd());
  return { cwd, runDir };
}

function fixedGit() {
  return {
    revParseHead: mock(async () => "abc123"),
    stageAll: mock(async () => {}),
    diffCached: mock(async () => "diff content"),
    diffCachedFileNames: mock(async () => ["src/a.ts"]),
    commit: mock(async () => {}),
    checkoutClean: mock(async () => {}),
    checkoutConfigOnly: mock(async () => {}),
  };
}

test("emits review_verdict and populates SpecBoard.review_matrix after a review gate", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const runAgentTask = mock(async () => ({
      ok: true,
      transcriptPath: "unused",
      usage: { inTok: 10, outTok: 5, costUsd: 0.001 },
    }));
    const runReviewGate = mock(async () => ({
      checks: "pass" as const,
      aiReview: "pass" as const,
      blockers: 0,
      matrix: {
        verdicts: { reviewer: "pass" },
        arbitrated: false,
        final: "pass" as const,
      },
    }));
    const git = fixedGit();

    await runRalphLoop(loopStageConfig(), profiles, cwd, runDir, "spec", { runAgentTask, runReviewGate, git, hashConfigDir: mock(() => "same-hash") });

    const events = readEvents(runDir);
    const verdict = events.find((e) => e.type === "review_verdict");
    expect(verdict).toBeDefined();
    expect(verdict).toMatchObject({ stage: "develop", story: "US-1", reviewers: { reviewer: "pass" }, final: "pass" });

    const board = readSpecBoard(runDir);
    expect(board.review_matrix["US-1"]).toEqual({ verdicts: { reviewer: "pass" }, arbitrated: false, final: "pass" });

    expect(existsSync(join(runDir, "artifacts", "reviews", "US-1.json"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("emits review_arbitrated when the gate was arbitrated", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const runAgentTask = mock(async () => ({
      ok: true,
      transcriptPath: "unused",
      usage: { inTok: 10, outTok: 5, costUsd: 0.001 },
    }));
    const runReviewGate = mock(async () => ({
      checks: "pass" as const,
      aiReview: "pass" as const,
      blockers: 0,
      matrix: {
        verdicts: { a: "fail", b: "pass" },
        arbitrated: true,
        arbitrator: "arbitrator-model",
        final: "pass" as const,
      },
    }));
    const git = fixedGit();

    await runRalphLoop(loopStageConfig(), profiles, cwd, runDir, "spec", { runAgentTask, runReviewGate, git, hashConfigDir: mock(() => "same-hash") });

    const events = readEvents(runDir);
    const arbitrated = events.find((e) => e.type === "review_arbitrated");
    expect(arbitrated).toBeDefined();
    expect(arbitrated).toMatchObject({ stage: "develop", story: "US-1", arbitrator: "arbitrator-model", verdict: "pass" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("emits story_suspended when fix_limit is exceeded", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const runAgentTask = mock(async () => ({
      ok: true,
      transcriptPath: "unused",
      usage: { inTok: 10, outTok: 5, costUsd: 0.001 },
    }));
    const runReviewGate = mock(async () => ({
      checks: "fail" as const,
      aiReview: "skipped" as const,
      blockers: 0,
      checkOutput: "nope",
    }));
    const git = fixedGit();

    await runRalphLoop(loopStageConfig({ per_story_fix_limit: 1 }), profiles, cwd, runDir, "spec", { runAgentTask, runReviewGate, git, hashConfigDir: mock(() => "same-hash") });

    const events = readEvents(runDir);
    const suspended = events.find((e) => e.type === "story_suspended");
    expect(suspended).toBeDefined();
    expect(suspended).toMatchObject({ story: "US-1", reason: "fix_limit" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("reverts and emits max_drift_exceeded when changed files exceed maxDriftFiles", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const runAgentTask = mock(async () => ({
      ok: true,
      transcriptPath: "unused",
      usage: { inTok: 10, outTok: 5, costUsd: 0.001 },
    }));
    const runReviewGate = mock(async () => ({
      checks: "pass" as const,
      aiReview: "skipped" as const,
      blockers: 0,
    }));
    const git = {
      ...fixedGit(),
      diffCachedFileNames: mock(async () => ["a", "b", "c"]),
    };

    await runRalphLoop(loopStageConfig(), profiles, cwd, runDir, "spec", { runAgentTask, runReviewGate, git, hashConfigDir: mock(() => "same-hash"), maxDriftFiles: 2 });

    const events = readEvents(runDir);
    const gate = events.find((e) => e.type === "gate_result" && e.reason === "max_drift_exceeded");
    expect(gate).toBeDefined();
    expect(gate).toMatchObject({ story: "US-1", checks: "fail", ai_review: "skipped" });
    expect(git.checkoutClean).toHaveBeenCalled();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("uses default_checks when gate checks are empty", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const runAgentTask = mock(async () => ({
      ok: true,
      transcriptPath: "unused",
      usage: { inTok: 10, outTok: 5, costUsd: 0.001 },
    }));
    const runReviewGate = mock(async () => ({
      checks: "pass" as const,
      aiReview: "skipped" as const,
      blockers: 0,
    }));
    const git = fixedGit();

    const stageConfig = loopStageConfig({ gate: { checks: [], ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] } } });
    await runRalphLoop(stageConfig, profiles, cwd, runDir, "spec", { runAgentTask, runReviewGate, git, hashConfigDir: mock(() => "same-hash"), defaultChecks: ["echo default"] });

    expect(runReviewGate).toHaveBeenCalled();
    const firstCall = runReviewGate.mock.calls[0];
    expect(firstCall[0].checks).toEqual(["echo default"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
