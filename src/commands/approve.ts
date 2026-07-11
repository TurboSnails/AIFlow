import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { listRunIdsByMtimeDesc } from "../runs/store";
import { loadModelsConfig, loadPipelineConfig, loadProjectConfig } from "../config/loader";
import { runPipelineOnce, type EngineDeps } from "../engine/engine";
import { writeStateAtomic, type EngineState } from "../engine/state";
import { appendEvent } from "../events/events";
import { writeGateAnswer } from "../gate-answer/answer";
import { assertCleanIfAutoClean } from "./dirty-guard";
import { callLlm, type LlmCallResult } from "../llm/client";
import { resolveOpenQuestions, readSpecBoard } from "../specboard/specboard";
import type { SpecBoard } from "../specboard/types";
import type { ModelProfile, ProjectConfig, BudgetConfig } from "../config/schema";
import { acquireRunLock, type AcquireLockOptions } from "../lock";


export interface ApproveResult {
  status: "resumed" | "no_runs" | "missing_run_dir" | "no_waiting_stage" | "ambiguous_stage" | "stage_not_waiting";
  state?: EngineState;
  message?: string;
  runId?: string;
}

const ResolutionsSchema = z.object({
  resolutions: z.array(
    z.object({
      id: z.string(),
      resolution: z.string(),
    })
  ),
});

async function resolveOpenQuestionsWithMainDev(
  board: SpecBoard,
  mainDevProfile: ModelProfile,
  budget: Pick<BudgetConfig, "max_retry_steps" | "max_token_cost"> | undefined,
  callLlmFn: typeof callLlm = callLlm
): Promise<{ resolutions: Array<{ id: string; resolution: string }>; usage: LlmCallResult["usage"] }> {
  const prompt = `You are the main-dev. Resolve the following open questions as JSON: { "resolutions": [{ "id": "...", "resolution": "..." }] }.\n${JSON.stringify(board.open_questions)}`;
  const result = await callLlmFn({
    profile: mainDevProfile,
    prompt,
    jsonMode: true,
    maxRetrySteps: budget?.max_retry_steps,
    maxTokenCost: budget?.max_token_cost,
  });
  const data = ResolutionsSchema.parse(JSON.parse(result.text));

  const openQuestionIds = new Set(board.open_questions.map((q) => q.id));
  const resolvedIds = data.resolutions.map((r) => r.id);
  const resolvedIdsSet = new Set(resolvedIds);

  const missing = [...openQuestionIds].filter((id) => !resolvedIdsSet.has(id));
  const unknown = resolvedIds.filter((id) => !openQuestionIds.has(id));

  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `Main-dev resolutions do not match open questions: missing=[${missing.join(", ")}], unknown=[${unknown.join(", ")}]`
    );
  }

  return { resolutions: data.resolutions, usage: result.usage };
}

function loadProjectConfigWithDefaults(cwd: string): ProjectConfig {
  const path = join(cwd, ".aiflow", "config", "project.yaml");
  if (existsSync(path)) {
    return loadProjectConfig(path);
  }
  return { max_drift_files: 50, on_unresolved: "ask_human", dashboard: { port: 3000, host: "127.0.0.1" } };
}

function selectMainDevProfile(profiles: Record<string, ModelProfile>): ModelProfile {
  const mainDev = profiles["main-dev"] ?? profiles["mainDev"];
  if (mainDev) return mainDev;
  const keys = Object.keys(profiles);
  if (keys.length === 0) {
    throw new Error("No model profiles configured");
  }
  return profiles[keys[0]];
}

export async function runApprove(
  cwd: string,
  opts: { runId?: string; stage?: string; lockOptions?: Pick<AcquireLockOptions, "onWaiting" | "onStaleReclaimed"> },
  deps?: EngineDeps & { callLlm?: typeof callLlm },
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

  const lock = await acquireRunLock(cwd, runId, { signal, ...(opts.lockOptions ?? {}) });
  try {
  let state = JSON.parse(readFileSync(statePath, "utf-8")) as EngineState;
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

  const projectConfig = loadProjectConfigWithDefaults(cwd);
  const board = readSpecBoard(runDir);
  const stageId = state.stages[targetIndex].id;
  const stageConfig = pipelineConfig.stages.find((s) => s.id === stageId);
  if (!stageConfig) {
    throw new Error(`Stage "${stageId}" not found in pipeline`);
  }

  const answeredAt = new Date().toISOString();

  if (stageConfig.type !== "human_gate") {
    if (board.open_questions.length > 0) {
      const effectiveOnUnresolved =
        (stageConfig.type === "brainstorm" || stageConfig.type === "ralph_loop") && stageConfig.on_unresolved
          ? stageConfig.on_unresolved
          : pipelineConfig.on_unresolved ?? projectConfig.on_unresolved;
      if (effectiveOnUnresolved === "main_dev_decides") {
        const mainDevProfile = selectMainDevProfile(modelsConfig.profiles);
        const { resolutions, usage } = await resolveOpenQuestionsWithMainDev(
          board,
          mainDevProfile,
          pipelineConfig.budget,
          deps?.callLlm
        );

        state.cost = {
          input_tokens: state.cost.input_tokens + usage.inTok,
          output_tokens: state.cost.output_tokens + usage.outTok,
          est_usd: state.cost.est_usd + usage.costUsd,
        };

        const maxCostUsd = pipelineConfig.budget?.max_cost_usd;
        if (maxCostUsd !== undefined && state.cost.est_usd >= maxCostUsd) {
          state = {
            ...state,
            stages: state.stages.map((s, idx) =>
              idx === targetIndex ? { ...s, status: "aborted", reason: "budget_exceeded" } : s
            ),
          };
          writeStateAtomic(runDir, state);
          throw new Error(
            `Budget exceeded: main-dev resolution cost $${usage.costUsd.toFixed(4)} brings total $${state.cost.est_usd.toFixed(4)} to the limit $${maxCostUsd.toFixed(4)}`
          );
        }

        for (const r of resolutions) {
          resolveOpenQuestions(runDir, [r.id], r.resolution, "main_dev");
        }
      } else if (effectiveOnUnresolved === "ask_human") {
        throw new Error(`Stage ${stageId} has unresolved open questions; resolve them before approving.`);
      }
    }
    state = {
      ...state,
      stages: state.stages.map((s, idx) => (idx === targetIndex ? { ...s, status: "done", reason: undefined } : s)),
    };
  } else {
    writeGateAnswer(runDir, {
      stage: stageId,
      prompt: stageConfig.prompt,
      status: "answered",
      answered_at: answeredAt,
      action: "approve",
      reason: null,
    });
    appendEvent(runDir, {
      ts: answeredAt,
      type: "gate_answered",
      stage: stageId,
      by: "cli",
      action: "approve",
    });
  }

  writeStateAtomic(runDir, state);

  const resultState = await runPipelineOnce(pipelineConfig, modelsConfig.profiles, cwd, runDir, deps, signal, { resume: true });

  return { status: "resumed", state: resultState, runId };
  } finally {
    lock.release();
  }
}
