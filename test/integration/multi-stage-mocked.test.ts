import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { runCommand } from "../../src/commands/run";
import { runApprove } from "../../src/commands/approve";
import { runReject } from "../../src/commands/reject";
import { runPlanStage } from "../../src/runners/plan";
import type { PlanStageConfig } from "../../src/config/schema";

const FULL_PIPELINE = `name: full-auto
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
const fakeCallLlmFanOut = async (profiles: unknown[]) =>
  profiles.map((profile) => ({ profile, ok: true, result: { text: "an idea", usage: { inTok: 1, outTok: 1, costUsd: 0 } } }));
const fakeRunAgentTaskWritingSpec = async (task: { cwd: string }) => {
  writeFileSync(join(task.cwd, "spec.md"), "# Spec\nAcceptance: implement US-1");
  return { ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } };
};

test("full pipeline pauses at human_gate, then approve resumes and runs the remaining stages", async () => {
  const dir = await setupProject();
  try {
    const state = await runCommand(
      dir,
      "full-auto",
      { runAgentTask: fakeRunAgentTaskWritingSpec, callLlm: fakeCallLlm, callLlmFanOut: fakeCallLlmFanOut },
      { requirement: "Add offline cache" }
    );
    expect(state.stages.map((s) => s.status)).toEqual(["done", "done", "waiting_human", "pending", "pending"]);
    expect(existsSync(join(dir, "spec.md"))).toBe(true);

    // approve triggers a resume, which re-enters runPipelineOnce with NO deps of its own in
    // the real CLI path — so it falls back entirely to engine.ts's defaultDeps.runners (Task 10),
    // which for `plan` means the REAL callLlm. Override both `plan` and `ralph_loop` here so this
    // stays a hermetic mocked test — only `human_gate`/`spec`/`brainstorm` are skipped (already done).
    const runId = state.run_id;
    const approveResult = await runApprove(dir, { runId }, {
      runners: {
        plan: (stageConfig, stageState, profiles, cwd2, runDir2, nowFn, signal) =>
          runPlanStage(stageConfig as PlanStageConfig, stageState, profiles, cwd2, runDir2, nowFn, signal, { callLlm: fakeCallLlm }),
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

test("run without --requirement fails before creating any run directory", async () => {
  const dir = await setupProject();
  try {
    await expect(runCommand(dir, "full-auto")).rejects.toThrow(/requires --requirement/);
    expect(existsSync(join(dir, ".aiflow", "runs"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
