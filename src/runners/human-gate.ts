import { appendEvent } from "../events/events";
import type { HumanGateStageConfig, ModelProfile } from "../config/schema";
import type { StageOutcome } from "../engine/engine";
import type { StageState } from "../engine/state";

export async function runHumanGateStage(
  stageConfig: HumanGateStageConfig,
  stageState: StageState,
  _profiles: Record<string, ModelProfile>,
  _cwd: string,
  runDir: string,
  nowFn: () => Date,
  _signal: AbortSignal | undefined
): Promise<StageOutcome> {
  if (stageState.entered_at === undefined) {
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
