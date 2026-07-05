import { writeStateAtomic, type EngineState, type StageStatus } from "./state";
import { runRalphLoopOnce as realRunRalphLoopOnce, type RalphLoopResult } from "../runners/ralph-loop";
import type { PipelineConfig, ModelProfile } from "../config/schema";

export interface EngineDeps {
  runRalphLoopOnce: (
    stageConfig: PipelineConfig["stages"][number],
    profiles: Record<string, ModelProfile>,
    cwd: string,
    runDir: string,
    specExcerpt: string
  ) => Promise<RalphLoopResult>;
}

const defaultDeps: EngineDeps = {
  runRalphLoopOnce: (stageConfig, profiles, cwd, runDir, specExcerpt) =>
    realRunRalphLoopOnce(stageConfig, profiles, cwd, runDir, specExcerpt),
};

export function createRunId(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const rand = Math.random().toString(16).slice(2, 8);
  return `${stamp}_${rand}`;
}

export async function runPipelineOnce(
  pipeline: PipelineConfig,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  specExcerpt: string,
  deps: EngineDeps = defaultDeps,
  signal?: AbortSignal
): Promise<EngineState> {
  const stage = pipeline.stages[0];
  let state: EngineState = {
    run_id: runDir.split("/").pop() ?? "unknown",
    pipeline: pipeline.name,
    stages: [{ id: stage.id, status: "pending" }],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
  };
  writeStateAtomic(runDir, state);

  if (signal?.aborted) {
    state = { ...state, stages: [{ id: stage.id, status: "aborted" }] };
    writeStateAtomic(runDir, state);
    return state;
  }

  state = { ...state, stages: [{ id: stage.id, status: "running" }] };
  writeStateAtomic(runDir, state);

  const result = await deps.runRalphLoopOnce(stage, profiles, cwd, runDir, specExcerpt);

  const resultToStatus: Record<RalphLoopResult["result"], StageStatus> = {
    pass: "done",
    fail: "failed",
    suspended: "suspended",
  };
  const finalStatus = resultToStatus[result.result];
  state = { ...state, stages: [{ id: stage.id, status: finalStatus }] };
  writeStateAtomic(runDir, state);
  return state;
}
