import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHumanGateStage } from "../../src/runners/human-gate";
import { readGateAnswer } from "../../src/gate-answer/answer";
import { readEvents } from "../../src/events/events";
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

test("first call writes gate-answer.json waiting state", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-human-gate-test-"));
  const stageConfig: HumanGateStageConfig = { id: "confirm", type: "human_gate", prompt: "confirm please", on_timeout: "abort" };
  try {
    const outcome = await runHumanGateStage(stageConfig, pendingStageState, profiles, "/tmp/x", runDir, fixedNow, undefined);
    expect(outcome.result).toBe("waiting_human");

    const answer = readGateAnswer(runDir);
    expect(answer).toBeDefined();
    expect(answer!.stage).toBe("confirm");
    expect(answer!.status).toBe("waiting");
    expect(answer!.action).toBeNull();
    expect(answer!.answered_at).toBeNull();
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("resuming with an answered approve gate returns pass", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-human-gate-test-"));
  const stageConfig: HumanGateStageConfig = { id: "confirm", type: "human_gate", prompt: "confirm please", on_timeout: "abort" };
  const waitingState: StageState = { id: "confirm", status: "waiting_human", entered_at: "2026-07-06T11:00:00.000Z" };
  writeFileSync(
    join(runDir, "gate-answer.json"),
    JSON.stringify({ stage: "confirm", prompt: "confirm please", status: "answered", answered_at: "2026-07-10T12:00:00Z", action: "approve", reason: null })
  );
  try {
    const outcome = await runHumanGateStage(stageConfig, waitingState, profiles, "/tmp/x", runDir, fixedNow, undefined);
    expect(outcome.result).toBe("pass");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("resuming with an answered reject gate returns aborted", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-human-gate-test-"));
  const stageConfig: HumanGateStageConfig = { id: "confirm", type: "human_gate", prompt: "confirm please", on_timeout: "abort" };
  const waitingState: StageState = { id: "confirm", status: "waiting_human", entered_at: "2026-07-06T11:00:00.000Z" };
  writeFileSync(
    join(runDir, "gate-answer.json"),
    JSON.stringify({ stage: "confirm", prompt: "confirm please", status: "answered", answered_at: "2026-07-10T12:00:00Z", action: "reject", reason: "no" })
  );
  try {
    const outcome = await runHumanGateStage(stageConfig, waitingState, profiles, "/tmp/x", runDir, fixedNow, undefined);
    expect(outcome.result).toBe("aborted");
    expect(outcome.reason).toBe("human_gate_rejected");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("resuming with an answered gate for a different stage stays waiting", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-human-gate-test-"));
  const stageConfig: HumanGateStageConfig = { id: "confirm-b", type: "human_gate", prompt: "confirm b", on_timeout: "abort" };
  const waitingState: StageState = { id: "confirm-b", status: "waiting_human", entered_at: "2026-07-06T11:00:00.000Z" };
  writeFileSync(
    join(runDir, "gate-answer.json"),
    JSON.stringify({ stage: "confirm-a", prompt: "confirm a", status: "answered", answered_at: "2026-07-10T12:00:00Z", action: "approve", reason: null })
  );
  try {
    const outcome = await runHumanGateStage(stageConfig, waitingState, profiles, "/tmp/x", runDir, fixedNow, undefined);
    expect(outcome.result).toBe("waiting_human");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("first call does not emit a second human_gate_waiting event when re-entered", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-human-gate-test-"));
  const stageConfig: HumanGateStageConfig = { id: "confirm", type: "human_gate", prompt: "confirm please", on_timeout: "abort" };
  try {
    await runHumanGateStage(stageConfig, pendingStageState, profiles, "/tmp/x", runDir, fixedNow, undefined);
    const eventsAfterFirst = readEvents(runDir).filter((e) => e.type === "human_gate_waiting").length;
    expect(eventsAfterFirst).toBe(1);

    // Simulate the engine resuming before any external answer arrives. The
    // runner must not emit a duplicate waiting event.
    const waitingState: StageState = { id: "confirm", status: "waiting_human", entered_at: fixedNow().toISOString() };
    await runHumanGateStage(stageConfig, waitingState, profiles, "/tmp/x", runDir, fixedNow, undefined);
    const eventsAfterSecond = readEvents(runDir).filter((e) => e.type === "human_gate_waiting").length;
    expect(eventsAfterSecond).toBe(1);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
