import { writeStateAtomic, type EngineState, type StageStatus } from "./state";
import { readEvents } from "../events/events";
import { runRalphLoopOnce as realRunRalphLoopOnce, type RalphLoopResult } from "../runners/ralph-loop";
import { writeRunReport } from "../commands/report";
import type { PipelineConfig, ModelProfile } from "../config/schema";

export interface EngineDeps {
  runRalphLoopOnce: (
    stageConfig: PipelineConfig["stages"][number],
    profiles: Record<string, ModelProfile>,
    cwd: string,
    runDir: string,
    specExcerpt: string
  ) => Promise<RalphLoopResult>;
  writeRunReport?: (runDir: string, state: EngineState, now: Date, startedAt: Date) => void;
}

const defaultDeps: EngineDeps = {
  runRalphLoopOnce: (stageConfig, profiles, cwd, runDir, specExcerpt) =>
    realRunRalphLoopOnce(stageConfig, profiles, cwd, runDir, specExcerpt),
  writeRunReport: (runDir, state, now, startedAt) => {
    const events = readEvents(runDir);
    writeRunReport(runDir, state, events, { now, startedAt });
  },
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
  const startedAt = new Date();
  const effectiveDeps: EngineDeps = { ...defaultDeps, ...deps };
  let state: EngineState = {
    run_id: runDir.split("/").pop() ?? "unknown",
    pipeline: pipeline.name,
    stages: [{ id: stage.id, status: "pending" }],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
  };
  writeStateAtomic(runDir, state);

  const writeReportNow = () => {
    if (!effectiveDeps.writeRunReport) return;
    try {
      effectiveDeps.writeRunReport(runDir, state, new Date(), startedAt);
    } catch {
      // never block engine on report errors
    }
  };

  if (signal?.aborted) {
    state = { ...state, stages: [{ id: stage.id, status: "aborted" }] };
    writeStateAtomic(runDir, state);
    writeReportNow();
    return state;
  }

  state = { ...state, stages: [{ id: stage.id, status: "running" }] };
  writeStateAtomic(runDir, state);

  const result = await effectiveDeps.runRalphLoopOnce(stage, profiles, cwd, runDir, specExcerpt);

  const resultToStatus: Record<RalphLoopResult["result"], StageStatus> = {
    pass: "done",
    fail: "failed",
    suspended: "suspended",
  };
  const finalStatus = resultToStatus[result.result];
  state = { ...state, stages: [{ id: stage.id, status: finalStatus }] };
  writeStateAtomic(runDir, state);
  writeReportNow();
  return state;
}
