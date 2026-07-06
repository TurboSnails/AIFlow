import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHumanGateStage } from "../../src/runners/human-gate";
import type { HumanGateStageConfig, ModelProfile } from "../../src/config/schema";
import type { StageState } from "../../src/engine/state";

const profiles: Record<string, ModelProfile> = {};
const pendingStageState: StageState = { id: "confirm", status: "pending" };
const fixedNow = () => new Date("2026-07-06T12:00:00.000Z");

test("first call: enters waiting_human and sets entered_at", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-human-gate-test-"));
  const stageConfig: HumanGateStageConfig = { id: "confirm", type: "human_gate", prompt: "confirm please", on_timeout: "abort" };
  try {
    const outcome = await runHumanGateStage(stageConfig, pendingStageState, profiles, "/tmp/x", runDir, fixedNow, undefined);
    expect(outcome.result).toBe("waiting_human");
    expect(outcome.entered_at).toBe("2026-07-06T12:00:00.000Z");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("second call with no timeout configured: stays waiting_human, does not re-set entered_at", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-human-gate-test-"));
  const stageConfig: HumanGateStageConfig = { id: "confirm", type: "human_gate", prompt: "confirm please", on_timeout: "abort" };
  const waitingState: StageState = { id: "confirm", status: "waiting_human", entered_at: "2026-07-06T11:00:00.000Z" };
  try {
    const outcome = await runHumanGateStage(stageConfig, waitingState, profiles, "/tmp/x", runDir, fixedNow, undefined);
    expect(outcome.result).toBe("waiting_human");
    expect(outcome.entered_at).toBeUndefined();
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("second call, timeout configured but not yet elapsed: stays waiting_human", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-human-gate-test-"));
  const stageConfig: HumanGateStageConfig = { id: "confirm", type: "human_gate", prompt: "x", timeout: 3600, on_timeout: "abort" };
  const waitingState: StageState = { id: "confirm", status: "waiting_human", entered_at: "2026-07-06T11:59:00.000Z" };
  try {
    const outcome = await runHumanGateStage(stageConfig, waitingState, profiles, "/tmp/x", runDir, fixedNow, undefined);
    expect(outcome.result).toBe("waiting_human");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("timeout elapsed with on_timeout=abort: result is aborted with reason", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-human-gate-test-"));
  const stageConfig: HumanGateStageConfig = { id: "confirm", type: "human_gate", prompt: "x", timeout: 60, on_timeout: "abort" };
  const waitingState: StageState = { id: "confirm", status: "waiting_human", entered_at: "2026-07-06T11:00:00.000Z" };
  try {
    const outcome = await runHumanGateStage(stageConfig, waitingState, profiles, "/tmp/x", runDir, fixedNow, undefined);
    expect(outcome.result).toBe("aborted");
    expect(outcome.reason).toBe("human_gate_timeout");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("timeout elapsed with on_timeout=approve: result is pass", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-human-gate-test-"));
  const stageConfig: HumanGateStageConfig = { id: "confirm", type: "human_gate", prompt: "x", timeout: 60, on_timeout: "approve" };
  const waitingState: StageState = { id: "confirm", status: "waiting_human", entered_at: "2026-07-06T11:00:00.000Z" };
  try {
    const outcome = await runHumanGateStage(stageConfig, waitingState, profiles, "/tmp/x", runDir, fixedNow, undefined);
    expect(outcome.result).toBe("pass");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
