import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadModelsConfig, loadPipelineConfig } from "../config/loader";
import { createRunId, runPipelineOnce } from "../engine/engine";
import { runRalphLoop } from "../runners/ralph-loop";
import { runAgentTask as realRunAgentTask, type AgentTask, type AgentResult } from "../adapters/opencode";
import { runReviewGate as realRunReviewGate } from "../gate/review-gate";
import { runChecks } from "../gate/check-runner";
import { callReviewer as realCallReviewer } from "../llm/client";
import { revParseHead, stageAll, diffCached, commit } from "../git";
import type { EngineState } from "../engine/state";
import type { ModelProfile, StageConfig } from "../config/schema";

export interface RunCommandOverrides {
  runAgentTask?: (task: AgentTask) => Promise<AgentResult>;
  callReviewer?: (profile: ModelProfile, prompt: string) => Promise<unknown>;
}

export async function runCommand(
  cwd: string,
  pipelineName: string,
  overrides: RunCommandOverrides = {}
): Promise<EngineState> {
  const modelsConfig = loadModelsConfig(join(cwd, ".aiflow", "config", "models.yaml"));
  const pipelineConfig = loadPipelineConfig(join(cwd, ".aiflow", "config", "pipelines", `${pipelineName}.yaml`));

  const runId = createRunId();
  const runDir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(runDir, { recursive: true });

  const specPath = join(cwd, "spec.md");
  const specExcerpt = existsSync(specPath) ? readFileSync(specPath, "utf-8").slice(0, 4000) : "";

  const runAgentTask = overrides.runAgentTask ?? realRunAgentTask;
  const reviewerCallFn = overrides.callReviewer ?? realCallReviewer;

  const engineDeps = {
    runRalphLoop: (
      stageConfig: Extract<StageConfig, { type: "ralph_loop" }>,
      profiles: Record<string, ModelProfile>,
      runCwd: string,
      stageRunDir: string,
      spec: string,
      signal?: AbortSignal
    ) =>
      runRalphLoop(
        stageConfig,
        profiles,
        runCwd,
        stageRunDir,
        spec,
        {
          runAgentTask,
          runReviewGate: (config, reviewerProfile, gateCwd, diff, acceptance) =>
            realRunReviewGate(config, reviewerProfile, gateCwd, diff, acceptance, {
              runChecks,
              callReviewer: reviewerCallFn,
            }),
          git: { revParseHead, stageAll, diffCached, commit },
        },
        signal
      ),
  };

  return runPipelineOnce(pipelineConfig, modelsConfig.profiles, cwd, runDir, specExcerpt, engineDeps);
}
