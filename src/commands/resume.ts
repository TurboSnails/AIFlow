import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listRunIdsByMtimeDesc } from "../runs/store";
import { loadModelsConfig, loadPipelineConfig } from "../config/loader";
import type { ModelProfile } from "../config/schema";
import { isTerminalStatus, runPipelineOnce, type EngineDeps } from "../engine/engine";
import type { EngineState } from "../engine/state";
import { assertCleanIfAutoClean } from "./dirty-guard";

export interface ResumeResult {
  status: "resumed" | "noop_terminal" | "no_runs" | "missing_run_dir";
  state?: EngineState;
  message?: string;
  runId?: string;
}

export async function runResume(
  cwd: string,
  opts: { runId?: string; pipeline?: string; force?: boolean; raiseBudget?: number },
  deps?: EngineDeps,
  signal?: AbortSignal,
  isCleanFn?: (cwd: string) => Promise<boolean>
): Promise<ResumeResult> {
  const runId = opts.runId ?? listRunIdsByMtimeDesc(cwd)[0];
  if (!runId) return { status: "no_runs", message: `No .aiflow/runs found in ${cwd}` };
  const runDir = join(cwd, ".aiflow", "runs", runId);
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) {
    return { status: "missing_run_dir", runId, message: `Run directory ${runDir} exists but has no state.json` };
  }
  const persisted = JSON.parse(readFileSync(statePath, "utf-8")) as EngineState;
  const pipelineName = opts.pipeline ?? persisted.pipeline;
  const wasTerminal = persisted.stages.every((s) => isTerminalStatus(s.status));

  const modelsConfig = loadModelsConfig(join(cwd, ".aiflow", "config", "models.yaml"));
  const pipelineConfig = loadPipelineConfig(join(cwd, ".aiflow", "config", "pipelines", `${pipelineName}.yaml`));

  // 脏树守卫必须先于任何盘上写入（含下方的 raiseBudget 写入），与 `aiflow run` 的
  // preflight 顺序一致 —— 拒绝一个脏树时不能已经改过 state.json。请勿把校验挪到它之前。
  await assertCleanIfAutoClean(cwd, pipelineConfig, pipelineName, isCleanFn);

  if (opts.raiseBudget !== undefined) {
    if (!Number.isFinite(opts.raiseBudget) || opts.raiseBudget <= 0) {
      throw new Error(`Invalid --raise-budget value: ${opts.raiseBudget}. Must be a positive number.`);
    }
    persisted.budget = { limit_usd: opts.raiseBudget };
    writeFileSync(statePath, JSON.stringify(persisted, null, 2));
  }

  const profiles: Record<string, ModelProfile> = modelsConfig.profiles;
  const state = await runPipelineOnce(
    pipelineConfig,
    profiles,
    cwd,
    runDir,
    deps,
    signal,
    { resume: true, force: opts.force ?? false },
  );

  if (wasTerminal && !opts.force) return { status: "noop_terminal", state, runId };
  return { status: "resumed", state, runId };
}
