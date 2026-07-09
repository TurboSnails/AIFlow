import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listRunIdsByMtimeDesc } from "../runs/store";
import { loadModelsConfig, loadPipelineConfig } from "../config/loader";
import { runPipelineOnce, type EngineDeps } from "../engine/engine";
import { writeStateAtomic, type EngineState } from "../engine/state";
import { assertCleanIfAutoClean } from "./dirty-guard";

export interface ApproveResult {
  status: "resumed" | "no_runs" | "missing_run_dir" | "no_waiting_stage" | "ambiguous_stage" | "stage_not_waiting";
  state?: EngineState;
  message?: string;
  runId?: string;
}

export async function runApprove(
  cwd: string,
  opts: { runId?: string; stage?: string },
  deps?: EngineDeps,
  signal?: AbortSignal,
  isCleanFn?: (cwd: string) => Promise<boolean>
): Promise<ApproveResult> {
  const runId = opts.runId ?? listRunIdsByMtimeDesc(cwd)[0];
  if (!runId) return { status: "no_runs", message: `No .aiflow/runs found in ${cwd}` };
  const runDir = join(cwd, ".aiflow", "runs", runId);
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) {
    return { status: "missing_run_dir", runId, message: `Run directory ${runDir} exists but has no state.json` };
  }

  const state = JSON.parse(readFileSync(statePath, "utf-8")) as EngineState;
  const waitingStages = state.stages.filter((s) => s.status === "waiting_human");

  let targetIndex: number;
  if (opts.stage) {
    targetIndex = state.stages.findIndex((s) => s.id === opts.stage);
    if (targetIndex === -1 || state.stages[targetIndex].status !== "waiting_human") {
      return { status: "stage_not_waiting", runId, message: `Stage "${opts.stage}" is not awaiting approval` };
    }
  } else {
    if (waitingStages.length === 0) {
      return { status: "no_waiting_stage", runId, message: "No stage is awaiting approval" };
    }
    if (waitingStages.length > 1) {
      return { status: "ambiguous_stage", runId, message: "Multiple stages awaiting approval; use --stage to disambiguate" };
    }
    targetIndex = state.stages.findIndex((s) => s.id === waitingStages[0].id);
  }

  const modelsConfig = loadModelsConfig(join(cwd, ".aiflow", "config", "models.yaml"));
  const pipelineConfig = loadPipelineConfig(join(cwd, ".aiflow", "config", "pipelines", `${state.pipeline}.yaml`));

  await assertCleanIfAutoClean(cwd, pipelineConfig, state.pipeline, isCleanFn);

  state.stages[targetIndex] = { id: state.stages[targetIndex].id, status: "done" };
  writeStateAtomic(runDir, state);

  const resultState = await runPipelineOnce(pipelineConfig, modelsConfig.profiles, cwd, runDir, deps, signal, { resume: true });

  return { status: "resumed", state: resultState, runId };
}
