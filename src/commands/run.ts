import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadModelsConfig, loadPipelineConfig } from "../config/loader";
import { createRunId, runPipelineOnce, type EngineDeps, type StageOutcome } from "../engine/engine";
import { runRalphLoop } from "../runners/ralph-loop";
import { runBrainstormStage } from "../runners/brainstorm";
import { runSpecStage } from "../runners/spec";
import { runPlanStage } from "../runners/plan";
import { runHumanGateStage } from "../runners/human-gate";
import { runAgentTask as realRunAgentTask, type AgentTask, type AgentResult } from "../adapters/opencode";
import { runReviewGate as realRunReviewGate } from "../gate/review-gate";
import { runChecks } from "../gate/check-runner";
import {
  callReviewer as realCallReviewer,
  callLlm as realCallLlm,
  callLlmFanOut as realCallLlmFanOut,
} from "../llm/client";
import { revParseHead, stageAll, diffCached, commit } from "../git";
import type { EngineState } from "../engine/state";
import type {
  ModelProfile,
  RalphLoopStageConfig,
  BrainstormStageConfig,
  SpecStageConfig,
  PlanStageConfig,
} from "../config/schema";

export interface RunCommandOverrides {
  runAgentTask?: (task: AgentTask) => Promise<AgentResult>;
  callReviewer?: (profile: ModelProfile, prompt: string) => Promise<unknown>;
  callLlm?: typeof realCallLlm;
  callLlmFanOut?: typeof realCallLlmFanOut;
}

export interface RequirementInput {
  requirement?: string;
  requirementFile?: string;
}

export async function runCommand(
  cwd: string,
  pipelineName: string,
  overrides: RunCommandOverrides = {},
  requirementInput: RequirementInput = {}
): Promise<EngineState> {
  const modelsConfig = loadModelsConfig(join(cwd, ".aiflow", "config", "models.yaml"));
  const pipelineConfig = loadPipelineConfig(join(cwd, ".aiflow", "config", "pipelines", `${pipelineName}.yaml`));

  const needsRequirement = pipelineConfig.stages.some((s) => s.type === "brainstorm" || s.type === "spec");
  const requirementText = requirementInput.requirementFile
    ? readFileSync(requirementInput.requirementFile, "utf-8")
    : requirementInput.requirement;
  if (needsRequirement && !requirementText) {
    throw new Error(
      `Pipeline "${pipelineName}" requires --requirement or --requirement-file (it contains a brainstorm or spec stage)`
    );
  }

  const runId = createRunId();
  const runDir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(runDir, { recursive: true });

  if (requirementText) {
    const artifactsDir = join(runDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "requirement.md"), requirementText);
  }

  const runAgentTask = overrides.runAgentTask ?? realRunAgentTask;
  const reviewerCallFn = overrides.callReviewer ?? realCallReviewer;
  const callLlmFn = overrides.callLlm ?? realCallLlm;
  const callLlmFanOutFn = overrides.callLlmFanOut ?? realCallLlmFanOut;

  const engineDeps: EngineDeps = {
    runners: {
      ralph_loop: async (stageConfig, _stageState, profiles, runCwd, stageRunDir, _nowFn, signal): Promise<StageOutcome> => {
        const specPath = join(runCwd, "spec.md");
        const specExcerpt = existsSync(specPath) ? readFileSync(specPath, "utf-8").slice(0, 4000) : "";
        const summary = await runRalphLoop(
          stageConfig as RalphLoopStageConfig,
          profiles,
          runCwd,
          stageRunDir,
          specExcerpt,
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
        );
        return { result: summary.result, reason: summary.reason, usage: summary.usage };
      },
      brainstorm: (stageConfig, stageState, profiles, runCwd, stageRunDir, nowFn, signal) =>
        runBrainstormStage(stageConfig as BrainstormStageConfig, stageState, profiles, runCwd, stageRunDir, nowFn, signal, {
          callLlm: callLlmFn,
          callLlmFanOut: callLlmFanOutFn,
        }),
      spec: (stageConfig, stageState, profiles, runCwd, stageRunDir, nowFn, signal) =>
        runSpecStage(stageConfig as SpecStageConfig, stageState, profiles, runCwd, stageRunDir, nowFn, signal, { runAgentTask }),
      plan: (stageConfig, stageState, profiles, runCwd, stageRunDir, nowFn, signal) =>
        runPlanStage(stageConfig as PlanStageConfig, stageState, profiles, runCwd, stageRunDir, nowFn, signal, { callLlm: callLlmFn }),
      human_gate: (stageConfig, stageState, profiles, runCwd, stageRunDir, nowFn, signal) =>
        runHumanGateStage(stageConfig as import("../config/schema").HumanGateStageConfig, stageState, profiles, runCwd, stageRunDir, nowFn, signal),
    },
  };

  return runPipelineOnce(pipelineConfig, modelsConfig.profiles, cwd, runDir, engineDeps, undefined, { requirement: requirementText });
}
