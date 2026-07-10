import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlanStage } from "../../src/runners/plan";
import { parseOpenSpec } from "../../src/openspec/parser";
import { registerArtifact } from "../../src/specboard/specboard";
import type { PlanStageConfig, ModelProfile } from "../../src/config/schema";
import type { StageState } from "../../src/engine/state";

const profiles: Record<string, ModelProfile> = { "main-dev": { channel: "http", provider: "x", model: "y" } };
const stageConfig: PlanStageConfig = { id: "plan", type: "plan", model: "main-dev", input: "spec.md", output: "prd.json" };
const pendingStageState: StageState = { id: "plan", status: "pending" };
const zeroUsage = { inTok: 0, outTok: 0, costUsd: 0 };

const validOpenSpec = `---
spec_id: test-spec
version: 1
branch: feat/x
---
<task id="US-1" priority="1">
## Story one

Acceptance:
- [ ] it does A
- [ ] it does B
</task>
<task id="US-2" priority="2">
## Story two

Acceptance:
- [ ] it does C
</task>
`;

test("valid OpenSpec -> pass, correct prd.json, artifact registered", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-plan-test-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-plan-test-run-"));
  try {
    writeFileSync(join(cwd, "spec.md"), validOpenSpec);
    const registerArtifactMock = mock(registerArtifact);

    const outcome = await runPlanStage(
      stageConfig,
      pendingStageState,
      profiles,
      cwd,
      runDir,
      () => new Date(),
      undefined,
      { parseOpenSpec, registerArtifact: registerArtifactMock }
    );

    expect(outcome.result).toBe("pass");
    expect(outcome.usage).toEqual(zeroUsage);

    const written = JSON.parse(readFileSync(join(cwd, "prd.json"), "utf-8"));
    expect(written).toEqual({
      branchName: "feat/x",
      stories: [
        { id: "US-1", title: "Story one", acceptance: ["it does A", "it does B"], priority: 1, passes: false, fixCount: 0 },
        { id: "US-2", title: "Story two", acceptance: ["it does C"], priority: 2, passes: false, fixCount: 0 },
      ],
    });

    expect(registerArtifactMock).toHaveBeenCalledTimes(1);
    expect(registerArtifactMock.mock.calls[0]).toEqual([runDir, "prd", "prd.json"]);

    const board = JSON.parse(readFileSync(join(runDir, "specboard.json"), "utf-8"));
    expect(board.artifacts.prd).toBe("prd.json");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("missing spec.md -> parse fails -> stage fail", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-plan-test-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-plan-test-run-"));
  try {
    const outcome = await runPlanStage(stageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined);

    expect(outcome.result).toBe("fail");
    expect(outcome.usage).toEqual(zeroUsage);
    expect(existsSync(join(cwd, "prd.json"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("invalid OpenSpec content -> parse fails -> stage fail", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-plan-test-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-plan-test-run-"));
  try {
    writeFileSync(join(cwd, "spec.md"), "not a valid OpenSpec");

    const outcome = await runPlanStage(stageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined);

    expect(outcome.result).toBe("fail");
    expect(outcome.usage).toEqual(zeroUsage);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("PRD validation failure (e.g. missing branch) -> stage fail", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-plan-test-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-plan-test-run-"));
  try {
    writeFileSync(join(cwd, "spec.md"), "irrelevant");
    const fakeParse = mock(() => ({
      success: true as const,
      spec: { meta: {}, tasks: [] } as any,
    }));

    const outcome = await runPlanStage(
      stageConfig,
      pendingStageState,
      profiles,
      cwd,
      runDir,
      () => new Date(),
      undefined,
      { parseOpenSpec: fakeParse, registerArtifact }
    );

    expect(fakeParse).toHaveBeenCalledTimes(1);
    expect(outcome.result).toBe("fail");
    expect(outcome.usage).toEqual(zeroUsage);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
