import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRalphLoopOnce } from "../../src/runners/ralph-loop";
import { writePrd, readPrd, type Prd } from "../../src/prd";
import type { RalphLoopStageConfig, ModelProfile } from "../../src/config/schema";
import { readEvents } from "../../src/events/events";
import { runRalphLoop } from "../../src/runners/ralph-loop";
import { createBudgetTracker, type BudgetTracker } from "../../src/gate/budget";

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
  auto_clean: false,
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
  mkdirSync(join(cwd, ".aiflow", "config"), { recursive: true });
  writePrd(join(cwd, "prd.json"), samplePrd());
  return { cwd, runDir };
}

function twoStoryPrd(): Prd {
  return {
    branchName: "feat/two-stories",
    stories: [
      { id: "US-1", title: "First", acceptance: ["a"], priority: 1, passes: false, fixCount: 0 },
      { id: "US-2", title: "Second", acceptance: ["b"], priority: 2, passes: false, fixCount: 0 },
    ],
  };
}

function makeFixtureDirsWith(prd: Prd) {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-ralph-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-ralph-run-"));
  mkdirSync(join(cwd, ".aiflow", "config"), { recursive: true });
  writePrd(join(cwd, "prd.json"), prd);
  return { cwd, runDir };
}

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

function alwaysOkAgent(usage = { inTok: 10, outTok: 5, costUsd: 0.001 }) {
  return mock(async () => ({ ok: true, transcriptPath: "unused", usage }));
}

function fixedGit() {
  return {
    revParseHead: mock(async () => "abc123"),
    stageAll: mock(async () => {}),
    diffCached: mock(async () => "diff content"),
    commit: mock(async () => {}),
    checkoutClean: mock(async () => {}),
    checkoutConfigOnly: mock(async () => {}),
  };
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
      checkoutClean: mock(async () => {}),
      checkoutConfigOnly: mock(async () => {}),
    };

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir: mock(() => "same-hash"),
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
      checkoutClean: mock(async () => {}),
      checkoutConfigOnly: mock(async () => {}),
    };

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir: mock(() => "same-hash"),
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
      checkoutClean: mock(async () => {}),
      checkoutConfigOnly: mock(async () => {}),
    };

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir: mock(() => "same-hash"),
    });

    expect(result).toEqual({ storyId: "US-1", result: "fail", usage: { inTok: 0, outTok: 0, costUsd: 0 } });
    expect(runReviewGate).not.toHaveBeenCalled();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: all stories pass in sequence returns pass with no reason", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(twoStoryPrd());
  try {
    const runAgentTask = alwaysOkAgent();
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();

    const summary = await runRalphLoop(loopStageConfig(), profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir: mock(() => "same-hash"),
    });

    expect(summary.result).toBe("pass");
    expect(summary.reason).toBeUndefined();
    expect(summary.iterations).toBe(2);
    expect(summary.usage).toEqual({ inTok: 20, outTok: 10, costUsd: 0.002 });

    const prd = readPrd(join(cwd, "prd.json"));
    expect(prd.stories[0].passes).toBe(true);
    expect(prd.stories[1].passes).toBe(true);

    const events = readEvents(runDir);
    const loopEvent = events.find((e) => e.type === "ralph_loop_result");
    expect(loopEvent).toMatchObject({
      result: "pass",
      iterations: 2,
      stories_done: 2,
      stories_suspended: 0,
      stories_pending: 0,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: usage accumulates precisely across iterations with differing per-call values", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(twoStoryPrd());
  try {
    let call = 0;
    const runAgentTask = mock(async () => {
      call += 1;
      const usages = [
        { inTok: 5, outTok: 2, costUsd: 0.01 },
        { inTok: 7, outTok: 3, costUsd: 0.02 },
      ];
      return { ok: true, transcriptPath: "unused", usage: usages[call - 1] };
    });
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();

    const summary = await runRalphLoop(loopStageConfig(), profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir: mock(() => "same-hash"),
    });

    expect(summary.iterations).toBe(2);
    expect(summary.usage).toEqual({ inTok: 12, outTok: 5, costUsd: 0.03 });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: a story that exceeds per_story_fix_limit is skipped, the other story still completes, overall result is suspended/stories_suspended", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(twoStoryPrd());
  try {
    let call = 0;
    const runReviewGate = mock(async () => {
      call += 1;
      if (call <= 3) return { checks: "fail" as const, aiReview: "skipped" as const, blockers: 0, checkOutput: "still broken" };
      return { checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 };
    });
    const runAgentTask = alwaysOkAgent();
    const git = fixedGit();

    const summary = await runRalphLoop(
      loopStageConfig({ per_story_fix_limit: 2, stall_limit: 10, max_iterations: 10 }),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate, git, hashConfigDir: mock(() => "same-hash") }
    );

    expect(summary.result).toBe("suspended");
    expect(summary.reason).toBe("stories_suspended");
    expect(summary.iterations).toBe(4);

    const prd = readPrd(join(cwd, "prd.json"));
    const us1 = prd.stories.find((s) => s.id === "US-1")!;
    const us2 = prd.stories.find((s) => s.id === "US-2")!;
    expect(us1.suspended).toBe(true);
    expect(us1.passes).toBe(false);
    expect(us2.passes).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: stall_limit stops the loop before per_story_fix_limit when configured tighter", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(samplePrd());
  try {
    const runAgentTask = alwaysOkAgent();
    const runReviewGate = mock(async () => ({ checks: "fail" as const, aiReview: "skipped" as const, blockers: 0, checkOutput: "nope" }));
    const git = fixedGit();

    const summary = await runRalphLoop(
      loopStageConfig({ per_story_fix_limit: 100, stall_limit: 2, max_iterations: 100 }),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate, git, hashConfigDir: mock(() => "same-hash") }
    );

    expect(summary.result).toBe("suspended");
    expect(summary.reason).toBe("stall");
    expect(summary.iterations).toBe(2);

    const prd = readPrd(join(cwd, "prd.json"));
    expect(prd.stories[0].fixCount).toBe(2);
    expect(prd.stories[0].suspended).toBeFalsy();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: max_iterations stops the loop when neither stall_limit nor per_story_fix_limit has fired", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(samplePrd());
  try {
    const runAgentTask = alwaysOkAgent();
    const runReviewGate = mock(async () => ({ checks: "fail" as const, aiReview: "skipped" as const, blockers: 0, checkOutput: "nope" }));
    const git = fixedGit();

    const summary = await runRalphLoop(
      loopStageConfig({ per_story_fix_limit: 100, stall_limit: 100, max_iterations: 3 }),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate, git, hashConfigDir: mock(() => "same-hash") }
    );

    expect(summary.result).toBe("suspended");
    expect(summary.reason).toBe("max_iterations");
    expect(summary.iterations).toBe(3);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: an empty prd (no stories) returns pass immediately without calling the agent", async () => {
  const { cwd, runDir } = makeFixtureDirsWith({ branchName: "empty", stories: [] });
  try {
    const runAgentTask = alwaysOkAgent();
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();

    const summary = await runRalphLoop(loopStageConfig(), profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir: mock(() => "same-hash"),
    });

    expect(summary.result).toBe("pass");
    expect(summary.iterations).toBe(0);
    expect(summary.usage).toEqual({ inTok: 0, outTok: 0, costUsd: 0 });
    expect(runAgentTask).not.toHaveBeenCalled();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: an already-aborted signal returns aborted immediately without calling the agent", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(samplePrd());
  try {
    const controller = new AbortController();
    controller.abort();
    const runAgentTask = alwaysOkAgent();
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();

    const summary = await runRalphLoop(
      loopStageConfig(),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate, git, hashConfigDir: mock(() => "same-hash") },
      controller.signal
    );

    expect(summary.result).toBe("paused");
    expect(summary.iterations).toBe(0);
    expect(runAgentTask).not.toHaveBeenCalled();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: a signal aborted mid-run stops before the next iteration's agent call", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(samplePrd());
  try {
    const controller = new AbortController();
    let calls = 0;
    const runAgentTask = mock(async () => {
      calls += 1;
      if (calls === 2) controller.abort();
      return { ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } };
    });
    const runReviewGate = mock(async () => ({ checks: "fail" as const, aiReview: "skipped" as const, blockers: 0, checkOutput: "nope" }));
    const git = fixedGit();

    const summary = await runRalphLoop(
      loopStageConfig({ per_story_fix_limit: 100, stall_limit: 100, max_iterations: 100 }),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate, git, hashConfigDir: mock(() => "same-hash") },
      controller.signal
    );

    expect(summary.result).toBe("paused");
    expect(summary.iterations).toBe(2);
    expect(calls).toBe(2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: a second call against the same cwd resumes — already-done/in-progress work isn't repeated", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(twoStoryPrd());
  try {
    const git = fixedGit();
    const runAgentTask = alwaysOkAgent();

    // First "run": US-1 fails its only allotted attempt, hits max_iterations=1 before US-2 is ever touched.
    const failingGate = mock(async () => ({ checks: "fail" as const, aiReview: "skipped" as const, blockers: 0, checkOutput: "nope" }));
    const first = await runRalphLoop(
      loopStageConfig({ max_iterations: 1, stall_limit: 100, per_story_fix_limit: 100 }),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate: failingGate, git, hashConfigDir: mock(() => "same-hash") }
    );
    expect(first.result).toBe("suspended");
    expect(first.reason).toBe("max_iterations");
    const afterFirst = readPrd(join(cwd, "prd.json"));
    expect(afterFirst.stories[0].passes).toBe(false);
    expect(afterFirst.stories[0].fixCount).toBe(1);
    expect(afterFirst.stories[1].fixCount).toBe(0);

    // "Resume": a second runRalphLoop call against the same cwd, now with a gate that passes.
    const passingGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const second = await runRalphLoop(
      loopStageConfig({ max_iterations: 10, stall_limit: 3, per_story_fix_limit: 3 }),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate: passingGate, git, hashConfigDir: mock(() => "same-hash") }
    );
    expect(second.result).toBe("pass");
    expect(second.iterations).toBe(2); // US-1 (still pending from before) + US-2, not US-1 redone from scratch

    const afterSecond = readPrd(join(cwd, "prd.json"));
    expect(afterSecond.stories[0].passes).toBe(true);
    expect(afterSecond.stories[1].passes).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: auto_clean:true calls checkoutClean and emits story_auto_cleaned when a story is suspended", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(samplePrd());
  try {
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));
    const runReviewGate = mock(async () => ({ checks: "fail" as const, aiReview: "skipped" as const, blockers: 0, checkOutput: "nope" }));
    const checkoutClean = mock(async () => {});
    const git = { ...fixedGit(), checkoutClean };

    await runRalphLoop(
      loopStageConfig({ per_story_fix_limit: 1, auto_clean: true }),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate, git, hashConfigDir: mock(() => "same-hash") }
    );

    expect(checkoutClean).toHaveBeenCalledWith(cwd);
    const events = readEvents(runDir);
    expect(events.some((e) => e.type === "story_auto_cleaned")).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: auto_clean:true does not re-attempt a suspended story forever — the backlog still progresses to the next story", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(twoStoryPrd());
  try {
    const prdPath = join(cwd, "prd.json");
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));
    // US-1 always fails its gate (suspends after 1 attempt via per_story_fix_limit:1).
    // US-2 always passes.
    const runReviewGate = mock(async (config, reviewerProfile, cwdArg, diff, acceptance) => {
      if (acceptance[0] === "a") {
        return { checks: "fail" as const, aiReview: "skipped" as const, blockers: 0, checkOutput: "nope" };
      }
      return { checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 };
    });

    // Simulate real git behavior: prd.json is only ever "committed" via the commit()
    // call (which only fires when a story passes). checkoutClean must therefore revert
    // prd.json's on-disk content back to whatever it was at the last commit (or the
    // initial fixture state, if nothing has been committed yet) — exactly like real
    // `git checkout HEAD -- .` would, since the failure path's writePrd() is never
    // committed.
    let committedSnapshot = readFileSync(prdPath, "utf-8");
    const commit = mock(async () => {
      committedSnapshot = readFileSync(prdPath, "utf-8");
    });
    const checkoutClean = mock(async () => {
      writeFileSync(prdPath, committedSnapshot);
    });
    const git = { ...fixedGit(), commit, checkoutClean };

    const summary = await runRalphLoop(
      loopStageConfig({ per_story_fix_limit: 1, stall_limit: 100, max_iterations: 10, auto_clean: true }),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate, git, hashConfigDir: mock(() => "same-hash") }
    );

    expect(checkoutClean).toHaveBeenCalledTimes(1);
    // Without the fix, checkoutClean silently reverts prd.json's suspended flag back to
    // pending, so US-1 gets re-selected forever and US-2 is never touched — the loop
    // runs until max_iterations (10) with runAgentTask called 10 times, all for US-1.
    expect(runAgentTask.mock.calls.length).toBeGreaterThan(1);
    expect(summary.result).toBe("suspended");
    expect(summary.reason).toBe("stories_suspended");

    const prd = readPrd(prdPath);
    const us1 = prd.stories.find((s) => s.id === "US-1")!;
    const us2 = prd.stories.find((s) => s.id === "US-2")!;
    expect(us1.suspended).toBe(true);
    expect(us2.passes).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: auto_clean:false (default) never calls checkoutClean even when a story is suspended", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(samplePrd());
  try {
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));
    const runReviewGate = mock(async () => ({ checks: "fail" as const, aiReview: "skipped" as const, blockers: 0, checkOutput: "nope" }));
    const checkoutClean = mock(async () => {});
    const git = { ...fixedGit(), checkoutClean };

    await runRalphLoop(
      loopStageConfig({ per_story_fix_limit: 1 }),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate, git, hashConfigDir: mock(() => "same-hash") }
    );

    expect(checkoutClean).not.toHaveBeenCalled();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a config file changed by the agent mid-iteration fails the gate, reverts the config, and does not call the review gate", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    let hashCall = 0;
    const hashConfigDir = mock(() => {
      hashCall += 1;
      return hashCall === 1 ? "hash-before" : "hash-after-different";
    });
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir,
    });

    expect(result.result).toBe("fail");
    expect(runReviewGate).not.toHaveBeenCalled();
    expect(git.checkoutConfigOnly).toHaveBeenCalledWith(cwd);
    const prd = readPrd(join(cwd, "prd.json"));
    expect(prd.stories[0].fixCount).toBe(1);
    const fixList = readFileSync(join(runDir, "artifacts", "fix_list.md"), "utf-8");
    expect(fixList).toContain("aiflow/config");
    const events = readEvents(runDir);
    const gateEvent = events.find((e) => e.type === "gate_result");
    expect(gateEvent).toMatchObject({ checks: "fail", reason: "config_tampered" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("config tamper takes precedence over budget exceeded: checkoutConfigOnly is called and result is fail", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    let hashCall = 0;
    const hashConfigDir = mock(() => {
      hashCall += 1;
      return hashCall === 1 ? "hash-before" : "hash-after-different";
    });
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 10, outTok: 5, costUsd: 6 } }));
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();
    const budget = createBudgetTracker(5, 0);

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir,
    }, budget);

    expect(result.result).toBe("fail");
    expect(runReviewGate).not.toHaveBeenCalled();
    expect(git.checkoutConfigOnly).toHaveBeenCalledTimes(1);
    expect(git.checkoutConfigOnly).toHaveBeenCalledWith(cwd);
    const prd = readPrd(join(cwd, "prd.json"));
    expect(prd.stories[0].fixCount).toBe(1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("unchanged config hash before/after does not revert config or skip the review gate", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const hashConfigDir = mock(() => "same-hash-always");
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir,
    });

    expect(result.result).toBe("pass");
    expect(runReviewGate).toHaveBeenCalledTimes(1);
    expect(git.checkoutConfigOnly).not.toHaveBeenCalled();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoopOnce stops before the review gate when the agent call alone exceeds the budget", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 10, outTok: 5, costUsd: 6 } }));
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();
    const budget = createBudgetTracker(5, 0);

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir: mock(() => "same-hash"),
    }, budget);

    expect(result.result).toBe("paused");
    expect(runReviewGate).not.toHaveBeenCalled();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop stops the loop with reason budget_exceeded once cumulative spend reaches the limit", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(twoStoryPrd());
  try {
    const runAgentTask = alwaysOkAgent({ inTok: 1, outTok: 1, costUsd: 3 });
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();
    const budget = createBudgetTracker(5, 0);

    const summary = await runRalphLoop(loopStageConfig(), profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir: mock(() => "same-hash"),
    }, undefined, budget);

    expect(summary.result).toBe("paused");
    expect(summary.reason).toBe("budget_exceeded");
    expect(summary.iterations).toBe(2); // US-1 passes at cost 3, US-2's agent call brings total to 6 >= 5 and stops
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop with no budget tracker argument behaves exactly as before (no limit)", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(samplePrd());
  try {
    const runAgentTask = alwaysOkAgent();
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();

    const summary = await runRalphLoop(loopStageConfig(), profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir: mock(() => "same-hash"),
    });

    expect(summary.result).toBe("pass");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a failed agent call still records its cost in the budget tracker (without pausing)", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const recorded: number[] = [];
    const budget: BudgetTracker = {
      limitUsd: undefined,
      record: (delta: number) => { recorded.push(delta); return false; },
      drainPendingWarnings: () => [],
    };
    const runAgentTask = mock(async () => ({ ok: false, transcriptPath: "unused", usage: { inTok: 3, outTok: 1, costUsd: 0.4 } }));
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir: mock(() => "same-hash"),
    }, budget);

    expect(result.result).toBe("fail");
    expect(recorded).toContain(0.4);
    // agent 失败分支只经过一次记账 —— 主路径 record 被 agentResult.ok 短路。
    expect(recorded).toEqual([0.4]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a config-tamper iteration still records its cost in the budget tracker (without pausing)", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const recorded: number[] = [];
    const budget: BudgetTracker = {
      limitUsd: undefined,
      record: (delta: number) => { recorded.push(delta); return false; },
      drainPendingWarnings: () => [],
    };
    let hashCall = 0;
    const hashConfigDir = mock(() => {
      hashCall += 1;
      return hashCall === 1 ? "before" : "after-different";
    });
    const checkoutConfigOnly = mock(async () => {});
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 3, outTok: 1, costUsd: 0.7 } }));
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = { ...fixedGit(), checkoutConfigOnly };

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir,
    }, budget);

    expect(result.result).toBe("fail");
    expect(checkoutConfigOnly).toHaveBeenCalledWith(cwd);
    expect(runReviewGate).not.toHaveBeenCalled();
    expect(recorded).toContain(0.7);
    // 该次调用的成本只应记账一次 —— 篡改分支在主路径 budget.record 之前返回，无重复计。
    expect(recorded).toEqual([0.7]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
