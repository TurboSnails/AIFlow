import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlanStage, defaultDeps } from "../../src/runners/plan";
import type { PlanStageConfig, ModelProfile } from "../../src/config/schema";
import type { StageState } from "../../src/engine/state";

const profiles: Record<string, ModelProfile> = { "main-dev": { channel: "http", provider: "x", model: "y" } };
const stageConfig: PlanStageConfig = { id: "plan", type: "plan", model: "main-dev", input: "spec.md", output: "prd.json" };
const stageState: StageState = { id: "plan", status: "pending" };

const validPrd = {
  branchName: "feat/x",
  stories: [{ id: "T1", title: "t", acceptance: ["a"], priority: 1, passes: false, fixCount: 0 }],
};

function makeDirs(): { cwd: string; runDir: string } {
  return {
    cwd: mkdtempSync(join(tmpdir(), "aiflow-plan-test-")),
    runDir: mkdtempSync(join(tmpdir(), "aiflow-plan-test-run-")),
  };
}

function cleanup(cwd: string, runDir: string): void {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
}

test("plan stage calls the configured model and validates prd.json", async () => {
  const { cwd, runDir } = makeDirs();
  try {
    writeFileSync(join(cwd, "spec.md"), "some spec");
    const callLlm = mock(async () => ({
      text: JSON.stringify(validPrd),
      usage: { inTok: 1, outTok: 1, costUsd: 0 },
    }));
    const result = await runPlanStage(stageConfig, stageState, profiles, cwd, runDir, () => new Date(), undefined, { ...defaultDeps, callLlm });
    expect(result.result).toBe("pass");
    expect(existsSync(join(cwd, "prd.json"))).toBe(true);
    expect(callLlm).toHaveBeenCalledTimes(1);
  } finally {
    cleanup(cwd, runDir);
  }
});

test("plan stage retries once on invalid JSON and passes when retry is valid", async () => {
  const { cwd, runDir } = makeDirs();
  try {
    writeFileSync(join(cwd, "spec.md"), "some spec");
    let calls = 0;
    const callLlm = mock(async () => {
      calls += 1;
      if (calls === 1) return { text: "not json", usage: { inTok: 1, outTok: 1, costUsd: 0 } };
      return { text: JSON.stringify(validPrd), usage: { inTok: 2, outTok: 2, costUsd: 0 } };
    });
    const result = await runPlanStage(stageConfig, stageState, profiles, cwd, runDir, () => new Date(), undefined, { ...defaultDeps, callLlm });
    expect(result.result).toBe("pass");
    expect(callLlm).toHaveBeenCalledTimes(2);
    expect(existsSync(join(cwd, "prd.json"))).toBe(true);
  } finally {
    cleanup(cwd, runDir);
  }
});

test("missing spec.md returns stage fail", async () => {
  const { cwd, runDir } = makeDirs();
  try {
    const callLlm = mock(async () => ({ text: "{}", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));
    const result = await runPlanStage(stageConfig, stageState, profiles, cwd, runDir, () => new Date(), undefined, { ...defaultDeps, callLlm });
    expect(result.result).toBe('fail');
    expect(callLlm).toHaveBeenCalledTimes(0);
  } finally {
    cleanup(cwd, runDir);
  }
});

test("invalid JSON on all attempts returns stage fail", async () => {
  const { cwd, runDir } = makeDirs();
  try {
    writeFileSync(join(cwd, "spec.md"), "some spec");
    const callLlm = mock(async () => ({ text: "not json", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));
    const config: PlanStageConfig = { ...stageConfig, max_retry_steps: 1 };
    const result = await runPlanStage(config, stageState, profiles, cwd, runDir, () => new Date(), undefined, { ...defaultDeps, callLlm });
    expect(result.result).toBe('fail');
    expect(result.usage).toEqual({ inTok: 2, outTok: 2, costUsd: 0 });
    expect(callLlm).toHaveBeenCalledTimes(2);
  } finally {
    cleanup(cwd, runDir);
  }
});

test("unknown model throws before calling LLM", async () => {
  const { cwd, runDir } = makeDirs();
  try {
    writeFileSync(join(cwd, "spec.md"), "some spec");
    const callLlm = mock(async () => ({ text: JSON.stringify(validPrd), usage: { inTok: 1, outTok: 1, costUsd: 0 } }));
    const badConfig: PlanStageConfig = { ...stageConfig, model: "missing" };
    await expect(runPlanStage(badConfig, stageState, profiles, cwd, runDir, () => new Date(), undefined, { ...defaultDeps, callLlm })).rejects.toThrow("Unknown model missing");
    expect(callLlm).toHaveBeenCalledTimes(0);
  } finally {
    cleanup(cwd, runDir);
  }
});
