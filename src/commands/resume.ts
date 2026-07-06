import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadModelsConfig, loadPipelineConfig } from "../config/loader";
import type { ModelProfile } from "../config/schema";
import { isTerminalStatus, runPipelineOnce } from "../engine/engine";
import type { EngineState } from "../engine/state";

export interface ResumeResult {
  status: "resumed" | "noop_terminal" | "no_runs" | "missing_run_dir";
  state?: EngineState;
  message?: string;
  runId?: string;
}

function pickLatestRun(cwd: string): string | undefined {
  const root = join(cwd, ".aiflow", "runs");
  if (!existsSync(root)) return undefined;
  const entries = readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory());
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs);
  return entries[0];
}

export async function runResume(cwd: string, opts: { runId?: string; pipeline?: string; force?: boolean }): Promise<ResumeResult> {
  const runId = opts.runId ?? pickLatestRun(cwd);
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

  const profiles: Record<string, ModelProfile> = modelsConfig.profiles;
  const state = await runPipelineOnce(
    pipelineConfig,
    profiles,
    cwd,
    runDir,
    "",
    undefined,
    undefined,
    { resume: true, force: opts.force ?? false },
  );

  if (wasTerminal && !opts.force) return { status: "noop_terminal", state, runId };
  return { status: "resumed", state, runId };
}
