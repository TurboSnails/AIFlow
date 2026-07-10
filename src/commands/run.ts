import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadModelsConfig, loadPipelineConfig, loadProjectConfig } from "../config/loader";
import { hashConfigDir as realHashConfigDir } from "../config/config-hash";
import { createRunId, runPipelineOnce, type EngineDeps, type StageOutcome } from "../engine/engine";
import { runRalphLoop } from "../runners/ralph-loop";
import { runBrainstormStage } from "../runners/brainstorm";
import { runSpecStage } from "../runners/spec";
import { runPlanStage } from "../runners/plan";
import { runHumanGateStage } from "../runners/human-gate";
import { runAgentTask as realRunAgentTask, type AgentTask, type AgentResult } from "../adapters/opencode";
import { runReviewGate as realRunReviewGate } from "../gate/review-gate";
import { runChecks } from "../gate/check-runner";
import type { BudgetTracker } from "../gate/budget";
import {
  callReviewer as realCallReviewer,
  callLlm as realCallLlm,
  callLlmFanOut as realCallLlmFanOut,
  llmRetryContext,
  type ReviewerCallResult,
} from "../llm/client";
import { revParseHead, stageAll, diffCached, diffCachedFileNames, diffConflictFileNames, diffFilesSinceMergeBase, commit, checkoutClean, checkoutConfigOnly } from "../git";
import { assertCleanIfAutoClean } from "./dirty-guard";
import {
  createWorktree as realCreateWorktree,
  removeWorktree as realRemoveWorktree,
  tryMergeBack,
  resolveConflict,
  type WorktreeContext,
} from "../worktree/manager";
import { appendEvent } from "../events/events";
import type { EngineState } from "../engine/state";
import type {
  ModelProfile,
  RalphLoopStageConfig,
  BrainstormStageConfig,
  SpecStageConfig,
  PlanStageConfig,
  ProjectConfig,
} from "../config/schema";

export interface RunCommandOverrides {
  runAgentTask?: (task: AgentTask) => Promise<AgentResult>;
  callReviewer?: (profile: ModelProfile, prompt: string) => Promise<ReviewerCallResult>;
  callLlm?: typeof realCallLlm;
  callLlmFanOut?: typeof realCallLlmFanOut;
  createWorktree?: (cwd: string, runId: string) => Promise<WorktreeContext>;
  removeWorktree?: (ctx: WorktreeContext) => Promise<void>;
  tryMergeBack?: (
    ctx: WorktreeContext,
    autonomy: string,
    maxDriftFiles?: number
  ) => Promise<"merged" | "conflict" | "skipped" | "drift">;
  resolveConflict?: (ctx: WorktreeContext) => Promise<"aborted" | "failed">;
  diffConflictFileNames?: (cwd: string) => Promise<string[]>;
  diffFilesSinceMergeBase?: (cwd: string, branch: string) => Promise<string[]>;
}

export interface RequirementInput {
  requirement?: string;
  requirementFile?: string;
}

function projectConfigPath(cwd: string): string {
  return join(cwd, ".aiflow", "config", "project.yaml");
}

function loadProjectConfigWithDefaults(cwd: string): ProjectConfig {
  const path = projectConfigPath(cwd);
  if (existsSync(path)) {
    return loadProjectConfig(path);
  }
  return {
    max_drift_files: 50,
    on_unresolved: "ask_human",
    dashboard: { port: 3000, host: "127.0.0.1" },
  };
}

export async function runCommand(
  cwd: string,
  pipelineName: string,
  overrides: RunCommandOverrides = {},
  requirementInput: RequirementInput = {},
  signal?: AbortSignal,
  runId?: string
): Promise<EngineState> {
  const modelsConfig = loadModelsConfig(join(cwd, ".aiflow", "config", "models.yaml"));
  const pipelineConfig = loadPipelineConfig(join(cwd, ".aiflow", "config", "pipelines", `${pipelineName}.yaml`));
  const projectConfig = loadProjectConfigWithDefaults(cwd);

  const pipelineAutonomy = pipelineConfig.autonomy ?? "gated";
  const effectiveOnUnresolved: "ask_human" | "main_dev_decides" =
    pipelineConfig.on_unresolved ?? projectConfig.on_unresolved ?? "ask_human";

  const needsRequirement = pipelineConfig.stages.some((s) => s.type === "brainstorm" || s.type === "spec");
  const requirementText = requirementInput.requirementFile
    ? readFileSync(requirementInput.requirementFile, "utf-8")
    : requirementInput.requirement;
  if (needsRequirement && !requirementText) {
    throw new Error(
      `Pipeline "${pipelineName}" requires --requirement or --requirement-file (it contains a brainstorm or spec stage)`
    );
  }

  await assertCleanIfAutoClean(cwd, pipelineConfig, pipelineName);

  const effectiveRunId = runId ?? createRunId();
  const runDir = join(cwd, ".aiflow", "runs", effectiveRunId);
  mkdirSync(runDir, { recursive: true });

  const isolation = pipelineConfig.isolation ?? (pipelineAutonomy === "full" ? "worktree" : "none");
  let worktreeCtx: WorktreeContext | undefined;
  let runCwd = cwd;
  let worktreeHandled = false;
  if (isolation === "worktree") {
    const createWorktree = overrides.createWorktree ?? realCreateWorktree;
    worktreeCtx = await createWorktree(cwd, effectiveRunId);
    runCwd = worktreeCtx.worktreePath;
    appendEvent(runDir, {
      ts: new Date().toISOString(),
      type: "worktree",
      action: "create",
      branch: worktreeCtx.branch,
      path: worktreeCtx.worktreePath,
    });
  }

  if (requirementText) {
    const artifactsDir = join(runDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "requirement.md"), requirementText);
  }

  const runAgentTask = overrides.runAgentTask ?? realRunAgentTask;
  const reviewerCallFn = overrides.callReviewer ?? realCallReviewer;
  const callLlmFn = overrides.callLlm ?? realCallLlm;
  const callLlmFanOutFn = overrides.callLlmFanOut ?? realCallLlmFanOut;

  const wrappedCommit = async (commitCwd: string, message: string): Promise<void> => {
    await commit(commitCwd, message);
    if (worktreeCtx) {
      appendEvent(runDir, {
        ts: new Date().toISOString(),
        type: "worktree",
        action: "commit",
        branch: worktreeCtx.branch,
        path: worktreeCtx.worktreePath,
      });
    }
  };

  const engineDeps: EngineDeps = {
    runners: {
      ralph_loop: async (stageConfig, _stageState, profiles, stageCwd, stageRunDir, _nowFn, stageSignal, budget): Promise<StageOutcome> => {
        const specPath = join(stageCwd, "spec.md");
        const specExcerpt = existsSync(specPath) ? readFileSync(specPath, "utf-8").slice(0, 4000) : "";
        const summary = await runRalphLoop(
          stageConfig as RalphLoopStageConfig,
          profiles,
          stageCwd,
          stageRunDir,
          specExcerpt,
          {
            runAgentTask,
            runReviewGate: (config, reviewerProfile, gateCwd, diff, acceptance) =>
              realRunReviewGate(config, reviewerProfile, gateCwd, diff, acceptance, {
                runChecks,
                callReviewer: reviewerCallFn,
                stage: stageConfig.id,
              }),
            git: {
              revParseHead,
              stageAll,
              diffCached,
              diffCachedFileNames,
              commit: wrappedCommit,
              checkoutClean,
              checkoutConfigOnly,
            },
            hashConfigDir: realHashConfigDir,
            maxDriftFiles: projectConfig.max_drift_files,
            defaultChecks: projectConfig.default_checks,
          },
          stageSignal,
          budget
        );
        return { result: summary.result, reason: summary.reason, usage: summary.usage };
      },
      brainstorm: (stageConfig, stageState, profiles, stageCwd, stageRunDir, nowFn, stageSignal, budget) =>
        runBrainstormStage(stageConfig as BrainstormStageConfig, stageState, profiles, stageCwd, stageRunDir, nowFn, stageSignal, {
          callLlm: callLlmFn,
          callLlmFanOut: callLlmFanOutFn,
        }, budget),
      spec: (stageConfig, stageState, profiles, stageCwd, stageRunDir, nowFn, stageSignal, budget) =>
        runSpecStage(stageConfig as SpecStageConfig, stageState, profiles, stageCwd, stageRunDir, nowFn, stageSignal, { runAgentTask }, budget),
      plan: (stageConfig, stageState, profiles, stageCwd, stageRunDir, nowFn, stageSignal, budget) =>
        runPlanStage(stageConfig as PlanStageConfig, stageState, profiles, stageCwd, stageRunDir, nowFn, stageSignal, undefined, budget),
      human_gate: (stageConfig, stageState, profiles, stageCwd, stageRunDir, nowFn, stageSignal, _budget) =>
        runHumanGateStage(stageConfig as import("../config/schema").HumanGateStageConfig, stageState, profiles, stageCwd, stageRunDir, nowFn, stageSignal),
    },
  };

  try {
    return await llmRetryContext.run({ runDir }, async () => {
      const result = await runPipelineOnce(
        pipelineConfig,
        modelsConfig.profiles,
        runCwd,
        runDir,
        engineDeps,
        signal,
        { requirement: requirementText, on_unresolved: effectiveOnUnresolved }
      );

      if (worktreeCtx) {
        if (pipelineAutonomy === "full") {
          // Full autonomy: keep the branch for later manual merge; do not remove the worktree.
          worktreeHandled = true;
        } else {
          // Gated/interactive: attempt to merge the shadow branch back into the main branch.
          appendEvent(runDir, {
            ts: new Date().toISOString(),
            type: "worktree",
            action: "merge_attempt",
            branch: worktreeCtx.branch,
            path: worktreeCtx.worktreePath,
          });
          const mergeFn = overrides.tryMergeBack ?? tryMergeBack;
          const resolveFn = overrides.resolveConflict ?? resolveConflict;
          const conflictFilesFn = overrides.diffConflictFileNames ?? diffConflictFileNames;
          const driftFilesFn = overrides.diffFilesSinceMergeBase ?? diffFilesSinceMergeBase;
          const mergeResult = await mergeFn(worktreeCtx, pipelineAutonomy, projectConfig.max_drift_files);
          if (mergeResult === "merged") {
            appendEvent(runDir, {
              ts: new Date().toISOString(),
              type: "worktree",
              action: "resolved",
              branch: worktreeCtx.branch,
              path: worktreeCtx.worktreePath,
            });
            appendEvent(runDir, {
              ts: new Date().toISOString(),
              type: "worktree",
              action: "remove",
              branch: worktreeCtx.branch,
              path: worktreeCtx.worktreePath,
            });
            const removeWorktree = overrides.removeWorktree ?? realRemoveWorktree;
            await removeWorktree(worktreeCtx);
            worktreeHandled = true;
          } else if (mergeResult === "conflict" || mergeResult === "drift") {
            appendEvent(runDir, {
              ts: new Date().toISOString(),
              type: "worktree",
              action: "conflict",
              branch: worktreeCtx.branch,
              path: worktreeCtx.worktreePath,
            });
            const files =
              mergeResult === "drift"
                ? await driftFilesFn(worktreeCtx.originalCwd, worktreeCtx.branch)
                : await conflictFilesFn(worktreeCtx.originalCwd);
            if (mergeResult === "conflict") {
              await resolveFn(worktreeCtx);
            }
            appendEvent(runDir, {
              ts: new Date().toISOString(),
              type: "merge_conflict_unarbitrable",
              stage: pipelineConfig.stages[pipelineConfig.stages.length - 1]?.id ?? "run",
              files,
            });
            worktreeHandled = true;
            // Leave the worktree and branch in place so the user can resolve manually.
          }
        }
      }

      return result;
    });
  } finally {
    if (worktreeCtx && !worktreeHandled) {
      const removeWorktree = overrides.removeWorktree ?? realRemoveWorktree;
      appendEvent(runDir, {
        ts: new Date().toISOString(),
        type: "worktree",
        action: "remove",
        branch: worktreeCtx.branch,
        path: worktreeCtx.worktreePath,
      });
      try {
        await removeWorktree(worktreeCtx);
      } catch {
        // Best-effort cleanup: do not mask the pipeline outcome or original error.
      }
    }
  }
}
