import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { runCommand } from "../../src/commands/run";
import { runApprove } from "../../src/commands/approve";
import { runReject } from "../../src/commands/reject";
import { runPlanStage } from "../../src/runners/plan";
import type { ModelProfile, PlanStageConfig } from "../../src/config/schema";
import { runCost, summarizeRunCost } from "../../src/commands/cost";
import { readRunSnapshot } from "../../src/commands/monitor";

const FULL_PIPELINE = `name: full-auto
autonomy: full
stages:
  - id: ideate
    type: brainstorm
    models: ["main-dev", "reviewer"]
    synthesizer: main-dev
  - id: spec
    type: spec
    model: main-dev
  - id: confirm
    type: human_gate
    prompt: "Please review spec.md"
  - id: plan
    type: plan
    model: main-dev
  - id: develop
    type: ralph_loop
    model: main-dev
    per_story_fix_limit: 3
    gate:
      checks: []
      ai_review:
        enabled: false
        model: reviewer
        fail_on: ["blocker"]
`;

async function setupProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-multi-stage-"));
  mkdirSync(join(dir, ".aiflow", "config", "pipelines"), { recursive: true });
  writeFileSync(
    join(dir, ".aiflow", "config", "models.yaml"),
    `profiles:\n  main-dev:\n    channel: opencode\n    provider: opencode\n    model: x\n  reviewer:\n    channel: http\n    provider: y\n    model: z\n`
  );
  writeFileSync(join(dir, ".aiflow", "config", "pipelines", "full-auto.yaml"), FULL_PIPELINE);
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} config user.email "test@example.com"`;
  await $`git -C ${dir} config user.name "Test"`;
  await $`git -C ${dir} add -A`;
  await $`git -C ${dir} commit -q -m "initial"`;
  return dir;
}

const fakeCallLlm = async (opts: { prompt: string }) => ({
  text: opts.prompt.includes("JSON object")
    ? JSON.stringify({ branchName: "feat/x", stories: [{ id: "US-1", title: "t", acceptance: ["a"], priority: 1, passes: false, fixCount: 0 }] })
    : "a synthesized brainstorm result",
  usage: { inTok: 1, outTok: 1, costUsd: 0 },
});
const fakeCallLlmFanOut = async (profiles: ModelProfile[]) =>
  profiles.map((profile) => ({ profile, ok: true, result: { text: "an idea", usage: { inTok: 1, outTok: 1, costUsd: 0 } } }));
const validSpec = `---
spec_id: test-spec
version: 1
branch: main
---
<task id="US-1" priority="1">
## US-1

Acceptance:
- [ ] It works
</task>
`;
const fakeRunAgentTaskWritingSpec = async (task: { cwd: string }) => {
  writeFileSync(join(task.cwd, "spec.md"), validSpec);
  return { ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } };
};

test("full pipeline pauses at human_gate, then approve resumes and runs the remaining stages", async () => {
  const dir = await setupProject();
  try {
    const fakeCreateWorktree = async (cwd: string, runId: string) => ({
      originalCwd: cwd,
      worktreePath: cwd,
      branch: `aiflow/${runId}`,
    });
    const state = await runCommand(
      dir,
      "full-auto",
      { runAgentTask: fakeRunAgentTaskWritingSpec, callLlm: fakeCallLlm, callLlmFanOut: fakeCallLlmFanOut, createWorktree: fakeCreateWorktree, removeWorktree: async () => {} },
      { requirement: "Add offline cache" }
    );
    expect(state.stages.map((s) => s.status)).toEqual(["done", "done", "waiting_human", "pending", "pending"]);
    expect(existsSync(join(dir, "spec.md"))).toBe(true);

    // approve triggers a resume, which re-enters runPipelineOnce with NO deps of its own in
    // the real CLI path — so it falls back entirely to engine.ts's defaultDeps.runners. Plan
    // now parses the OpenSpec produced by the spec stage, so only ralph_loop needs to be
    // mocked here to keep the test hermetic.
    const runId = state.run_id;
    const approveResult = await runApprove(dir, { runId }, {
      runners: {
        ralph_loop: async () => ({ result: "pass" }),
      },
    });
    expect(approveResult.status).toBe("resumed");
    expect(approveResult.state!.stages.map((s) => s.status)).toEqual(["done", "done", "done", "done", "done"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("full pipeline pauses at human_gate, then reject aborts without running the remaining stages", async () => {
  const dir = await setupProject();
  try {
    const state = await runCommand(
      dir,
      "full-auto",
      { runAgentTask: fakeRunAgentTaskWritingSpec, callLlm: fakeCallLlm, callLlmFanOut: fakeCallLlmFanOut },
      { requirement: "Add offline cache" }
    );
    expect(state.stages[2].status).toBe("waiting_human");

    const rejectResult = runReject(dir, { runId: state.run_id, reason: "not ready" });
    expect(rejectResult.status).toBe("rejected");
    expect(rejectResult.state!.stages[2].status).toBe("aborted");
    expect(rejectResult.state!.stages[3].status).toBe("pending"); // plan never ran
    expect(rejectResult.state!.stages[4].status).toBe("pending"); // develop never ran
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a budget-exceeded run releases its lock, and a second run in the same project can then acquire it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-safety-integration-"));
  try {
    mkdirSync(join(dir, ".aiflow", "config", "pipelines"), { recursive: true });
    writeFileSync(
      join(dir, ".aiflow", "config", "models.yaml"),
      "profiles:\n  main-dev:\n    channel: opencode\n    provider: x\n    model: y\n  reviewer:\n    channel: http\n    provider: y\n    model: z\n"
    );
    writeFileSync(
      join(dir, ".aiflow", "config", "pipelines", "budgeted.yaml"),
      'name: budgeted\nbudget:\n  max_cost_usd: 1\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    per_story_fix_limit: 3\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n'
    );
    writeFileSync(
      join(dir, "prd.json"),
      JSON.stringify({ branchName: "x", stories: [{ id: "US-1", title: "t", acceptance: [], priority: 1, passes: false, fixCount: 0 }] })
    );
    await $`git -C ${dir} init -q`;
    await $`git -C ${dir} config user.email "test@example.com"`;
    await $`git -C ${dir} config user.name "Test"`;
    await $`git -C ${dir} add -A`;
    await $`git -C ${dir} commit -q -m "initial"`;

    const expensiveAgent = async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 5 } });

    const state = await runCommand(dir, "budgeted", { runAgentTask: expensiveAgent });
    expect(state.stages[0].status).toBe("paused");
    expect(state.stages[0].reason).toBe("budget_exceeded");
    expect(existsSync(join(dir, ".aiflow", "run.lock"))).toBe(false);

    // A second, independent run in the same project must be able to acquire the lock immediately.
    writeFileSync(
      join(dir, ".aiflow", "config", "pipelines", "cheap.yaml"),
      'name: cheap\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    per_story_fix_limit: 3\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n'
    );
    const freeAgent = async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } });
    const second = await runCommand(dir, "cheap", { runAgentTask: freeAgent });
    expect(second.stages[0].status).toBe("done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aiflow cost per-stage totals reconcile with state.cost after a real mocked run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-cost-e2e-"));
  try {
    mkdirSync(join(dir, ".aiflow", "config", "pipelines"), { recursive: true });
    writeFileSync(
      join(dir, ".aiflow", "config", "models.yaml"),
      "profiles:\n  main-dev:\n    channel: opencode\n    provider: x\n    model: y\n  reviewer:\n    channel: http\n    provider: y\n    model: z\n"
    );
    writeFileSync(
      join(dir, ".aiflow", "config", "pipelines", "priced.yaml"),
      'name: priced\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    per_story_fix_limit: 3\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n'
    );
    writeFileSync(
      join(dir, "prd.json"),
      JSON.stringify({ branchName: "x", stories: [{ id: "US-1", title: "t", acceptance: [], priority: 1, passes: false, fixCount: 0 }] })
    );
    await $`git -C ${dir} init -q`;
    await $`git -C ${dir} config user.email "test@example.com"`;
    await $`git -C ${dir} config user.name "Test"`;
    await $`git -C ${dir} add -A`;
    await $`git -C ${dir} commit -q -m "initial"`;

    // Story starts with passes:false so ralph_loop makes one agent call and produces usage;
    // the mocked agent then flips it to pass, generating a stage_cost event.
    const state = await runCommand(dir, "priced", { runAgentTask: async () => ({ ok: true, transcriptPath: "u", usage: { inTok: 5, outTok: 2, costUsd: 0.03 } }) });

    const snap = readRunSnapshot(dir, state.run_id)!;
    const summary = summarizeRunCost(state.run_id, snap.state, snap.events);
    // per-stage total reconciles with run-level state.cost
    expect(summary.totalCostUsd).toBeCloseTo(snap.state.cost.est_usd, 10);

    let out = "";
    const code = runCost(dir, { runId: state.run_id, color: false, write: (s) => { out += s; } });
    expect(code).toBe(0);
    expect(out).toContain("develop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run without --requirement fails before creating any run directory", async () => {
  const dir = await setupProject();
  try {
    await expect(runCommand(dir, "full-auto")).rejects.toThrow(/requires --requirement/);
    expect(existsSync(join(dir, ".aiflow", "runs"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const WORKTREE_PIPELINE = `name: worktree-dev
isolation: worktree
autonomy: full
stages:
  - id: develop
    type: ralph_loop
    model: main-dev
    per_story_fix_limit: 3
    gate:
      checks: []
      ai_review:
        enabled: false
        model: reviewer
        fail_on: ["blocker"]
`;

test("run creates worktree when isolation=worktree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-worktree-integration-"));
  try {
    mkdirSync(join(dir, ".aiflow", "config", "pipelines"), { recursive: true });
    writeFileSync(
      join(dir, ".aiflow", "config", "models.yaml"),
      "profiles:\n  main-dev:\n    channel: opencode\n    provider: x\n    model: y\n  reviewer:\n    channel: http\n    provider: y\n    model: z\n"
    );
    writeFileSync(join(dir, ".aiflow", "config", "pipelines", "worktree.yaml"), WORKTREE_PIPELINE);
    writeFileSync(
      join(dir, "prd.json"),
      JSON.stringify({ branchName: "x", stories: [{ id: "US-1", title: "t", acceptance: [], priority: 1, passes: false, fixCount: 0 }] })
    );
    await $`git -C ${dir} init -q`;
    await $`git -C ${dir} config user.email "test@example.com"`;
    await $`git -C ${dir} config user.name "Test"`;
    await $`git -C ${dir} add -A`;
    await $`git -C ${dir} commit -q -m "initial"`;

    const worktreePath = join(dir, "aiflow-wt");
    await $`git -C ${dir} worktree add ${worktreePath} -b aiflow/test`.quiet();

    const createCalls: Array<{ cwd: string; runId: string }> = [];
    const removeCalls: Array<{ worktreePath: string }> = [];
    let agentCwd = "";
    const fakeAgent = async (task: { cwd: string }) => {
      agentCwd = task.cwd;
      writeFileSync(join(task.cwd, "impl.txt"), "done");
      return { ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } };
    };
    const fakeCreate = async (cwd: string, runId: string) => {
      createCalls.push({ cwd, runId });
      return { originalCwd: cwd, worktreePath, branch: `aiflow/${runId}` };
    };
    const fakeRemove = async (ctx: { worktreePath: string }) => {
      removeCalls.push({ worktreePath: ctx.worktreePath });
    };

    const runId = "20260101_120000_test";
    const state = await runCommand(
      dir,
      "worktree",
      { runAgentTask: fakeAgent, createWorktree: fakeCreate, removeWorktree: fakeRemove },
      {},
      undefined,
      runId
    );

    expect(createCalls).toEqual([{ cwd: dir, runId }]);
    expect(agentCwd).toBe(worktreePath);
    expect(state.stages[0].status).toBe("done");
    expect(removeCalls).toEqual([]);
    // full autonomy keeps the worktree/branch for manual merge; cleanup is not performed.

  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
