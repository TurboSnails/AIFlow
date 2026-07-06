import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRalphLoopOnce } from "../../src/runners/ralph-loop";
import { writePrd, readPrd, type Prd } from "../../src/prd";
import type { RalphLoopStageConfig, ModelProfile } from "../../src/config/schema";

function samplePrd(): Prd {
  return {
    branchName: "feat/us-1",
    stories: [{ id: "US-1", title: "Implement clamp", acceptance: ["clamps correctly"], priority: 1, passes: false, fixCount: 0 }],
  };
}

const stageConfig: RalphLoopStageConfig = {
  id: "develop",
  type: "ralph_loop",
  model: "main-dev",
  per_story_fix_limit: 3,
  max_iterations: 10,
  stall_limit: 3,
  gate: {
    checks: ["true"],
    ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] },
  },
};

const profiles: Record<string, ModelProfile> = {
  "main-dev": { channel: "opencode", provider: "opencode", model: "opencode/deepseek-v4-flash-free" },
  reviewer: { channel: "http", provider: "minimax", model: "x" },
};

function makeFixtureDirs() {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-ralph-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-ralph-run-"));
  writePrd(join(cwd, "prd.json"), samplePrd());
  return { cwd, runDir };
}

test("a passing gate marks the story passed, commits, and writes progress.md", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const runAgentTask = mock(async () => ({
      ok: true,
      transcriptPath: "unused",
      usage: { inTok: 10, outTok: 5, costUsd: 0.001 },
    }));
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = {
      revParseHead: mock(async () => "abc123"),
      stageAll: mock(async () => {}),
      diffCached: mock(async () => "diff content"),
      commit: mock(async () => {}),
    };

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
    });

    expect(result).toEqual({ storyId: "US-1", result: "pass", usage: { inTok: 10, outTok: 5, costUsd: 0.001 } });
    expect(git.commit).toHaveBeenCalledTimes(1);
    const prd = readPrd(join(cwd, "prd.json"));
    expect(prd.stories[0].passes).toBe(true);
    expect(existsSync(join(runDir, "artifacts", "progress.md"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a failing gate records fix_list.md, increments fixCount, and does not commit", async () => {
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
      checkOutput: "lint failed: missing semicolon",
    }));
    const git = {
      revParseHead: mock(async () => "abc123"),
      stageAll: mock(async () => {}),
      diffCached: mock(async () => "diff content"),
      commit: mock(async () => {}),
    };

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
    });

    expect(result).toEqual({ storyId: "US-1", result: "fail", usage: { inTok: 10, outTok: 5, costUsd: 0.001 } });
    expect(git.commit).not.toHaveBeenCalled();
    const prd = readPrd(join(cwd, "prd.json"));
    expect(prd.stories[0].passes).toBe(false);
    expect(prd.stories[0].fixCount).toBe(1);
    const fixList = readFileSync(join(runDir, "artifacts", "fix_list.md"), "utf-8");
    expect(fixList).toContain("missing semicolon");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an agent task that fails (ok:false) is treated as a failed iteration without calling the review gate", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const runAgentTask = mock(async () => ({
      ok: false,
      transcriptPath: "unused",
      usage: { inTok: 0, outTok: 0, costUsd: 0 },
    }));
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = {
      revParseHead: mock(async () => "abc123"),
      stageAll: mock(async () => {}),
      diffCached: mock(async () => ""),
      commit: mock(async () => {}),
    };

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
    });

    expect(result).toEqual({ storyId: "US-1", result: "fail", usage: { inTok: 0, outTok: 0, costUsd: 0 } });
    expect(runReviewGate).not.toHaveBeenCalled();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
