import { appendEvent } from "../events/events";
import type { HumanGateStageConfig, ModelProfile } from "../config/schema";
import type { StageOutcome } from "../engine/engine";
import type { StageState } from "../engine/state";
import { readGateAnswer, writeGateAnswer } from "../gate-answer/answer";

export async function runHumanGateStage(
  stageConfig: HumanGateStageConfig,
  stageState: StageState,
  _profiles: Record<string, ModelProfile>,
  _cwd: string,
  runDir: string,
  nowFn: () => Date,
  _signal: AbortSignal | undefined
): Promise<StageOutcome> {
  const existing = readGateAnswer(runDir);
  if (existing?.status === "answered" && existing.stage === stageConfig.id) {
    if (existing.action === "approve") {
      return { result: "pass" };
    }
    if (existing.action === "reject") {
      return { result: "aborted", reason: "human_gate_rejected" };
    }
  }

  if (stageState.entered_at === undefined) {
    writeGateAnswer(runDir, {
      stage: stageConfig.id,
      prompt: stageConfig.prompt,
      status: "waiting",
      answered_at: null,
      action: null,
      reason: null,
    });
    appendEvent(runDir, {
      ts: new Date().toISOString(),
      type: "human_gate_waiting",
      stage: stageConfig.id,
      prompt: stageConfig.prompt,
    });
    return { result: "waiting_human", entered_at: nowFn().toISOString() };
  }

  if (stageConfig.timeout === undefined) {
    return { result: "waiting_human" };
  }

  const elapsedMs = nowFn().getTime() - Date.parse(stageState.entered_at);
  if (elapsedMs < stageConfig.timeout * 1000) {
    return { result: "waiting_human" };
  }

  if (stageConfig.on_timeout === "approve") {
    return { result: "pass" };
  }
  return { result: "aborted", reason: "human_gate_timeout" };
}
