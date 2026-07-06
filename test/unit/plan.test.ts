import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlanStage } from "../../src/runners/plan";
import type { PlanStageConfig, ModelProfile } from "../../src/config/schema";
import type { StageState } from "../../src/engine/state";

const profiles: Record<string, ModelProfile> = { "main-dev": { channel: "http", provider: "x", model: "y" } };
const stageConfig: PlanStageConfig = { id: "plan", type: "plan", model: "main-dev", input: "spec.md", output: "prd.json" };
const pendingStageState: StageState = { id: "plan", status: "pending" };

const validPrd = {
  branchName: "feat/x",
  stories: [{ id: "US-1", title: "t", acceptance: ["a"], priority: 1, passes: false, fixCount: 0 }],
};

test("valid JSON on the first attempt: pass, prd.json written", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-plan-test-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-plan-test-run-"));
  try {
    writeFileSync(join(cwd, "spec.md"), "# Spec");
    const callLlm = mock(async () => ({ text: JSON.stringify(validPrd), usage: { inTok: 1, outTok: 1, costUsd: 0 } }));

    const outcome = await runPlanStage(stageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined, { callLlm });

    expect(outcome.result).toBe("pass");
    expect(callLlm).toHaveBeenCalledTimes(1);
    const written = JSON.parse(readFileSync(join(cwd, "prd.json"), "utf-8"));
    expect(written).toEqual(validPrd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("invalid JSON on the first attempt, valid on the retry: pass", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-plan-test-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-plan-test-run-"));
  try {
    writeFileSync(join(cwd, "spec.md"), "# Spec");
    let calls = 0;
    const prompts: string[] = [];
    const callLlm = mock(async (opts: { prompt: string }) => {
      calls += 1;
      prompts.push(opts.prompt);
      if (calls === 1) return { text: "not json at all", usage: { inTok: 1, outTok: 1, costUsd: 0 } };
      return { text: JSON.stringify(validPrd), usage: { inTok: 1, outTok: 1, costUsd: 0 } };
    });

    const outcome = await runPlanStage(stageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined, { callLlm });

    expect(outcome.result).toBe("pass");
    expect(calls).toBe(2);
    expect(prompts[1]).toContain("Your previous response failed validation");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("invalid JSON on both attempts: fail, no prd.json written", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-plan-test-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-plan-test-run-"));
  try {
    writeFileSync(join(cwd, "spec.md"), "# Spec");
    const callLlm = mock(async () => ({ text: "still not json", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));

    const outcome = await runPlanStage(stageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined, { callLlm });

    expect(outcome.result).toBe("fail");
    expect(callLlm).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
