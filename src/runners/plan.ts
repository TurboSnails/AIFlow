import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../atomic/atomic-write";
import { callLlm } from "../llm/client";
import { PrdSchema } from "../prd";
import { registerArtifact } from "../specboard/specboard";
import { appendEvent } from "../events/events";
import type { PlanResultAiflowEvent } from "../events/events";
import { noopBudgetTracker, type BudgetTracker } from "../gate/budget";
import type { PlanStageConfig, ModelProfile } from "../config/schema";
import type { StageOutcome } from "../engine/engine";
import type { StageState } from "../engine/state";

export interface PlanDeps {
  callLlm?: typeof callLlm;
  registerArtifact?: typeof registerArtifact;
}

export const defaultDeps: PlanDeps = { callLlm, registerArtifact };

const zeroUsage = { inTok: 0, outTok: 0, costUsd: 0 };

function addUsage(
  a: NonNullable<StageOutcome["usage"]>,
  b: NonNullable<StageOutcome["usage"]>
): NonNullable<StageOutcome["usage"]> {
  return {
    inTok: a.inTok + b.inTok,
    outTok: a.outTok + b.outTok,
    costUsd: a.costUsd + b.costUsd,
  };
}

export async function runPlanStage(
  stageConfig: PlanStageConfig,
  _stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  _signal: AbortSignal | undefined,
  deps: PlanDeps = defaultDeps,
  budget: BudgetTracker = noopBudgetTracker
): Promise<StageOutcome> {
  const profile = profiles[stageConfig.model];
  if (!profile) throw new Error(`Unknown model ${stageConfig.model}`);

  const specPath = join(cwd, stageConfig.input);
  if (!existsSync(specPath)) {
    const event: PlanResultAiflowEvent = {
      ts: nowFn().toISOString(),
      type: "plan_result",
      stage: stageConfig.id,
      result: "fail",
    };
    appendEvent(runDir, event);
    return { result: "fail", reason: `Missing spec input: ${stageConfig.input}`, usage: zeroUsage };
  }

  const spec = readFileSync(specPath, "utf-8");
  const basePrompt = `Convert the following spec into a JSON prd matching this schema: ${JSON.stringify(PrdSchema.shape)}.\n\n${spec}`;
  const maxRetrySteps = stageConfig.max_retry_steps ?? 5;
  const maxAttempts = maxRetrySteps + 1;

  let totalUsage = zeroUsage;
  let lastError: unknown;
  const doCallLlm = deps.callLlm ?? callLlm;
  const doRegisterArtifact = deps.registerArtifact ?? registerArtifact;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nPrevious attempt failed with: ${lastError}. Please fix and return valid JSON only.`;

    const result = await doCallLlm({ profile, prompt, jsonMode: true });
    totalUsage = addUsage(totalUsage, result.usage);

    if (budget.record(result.usage.costUsd)) {
      return { result: "paused", reason: "budget_exceeded", usage: totalUsage };
    }

    try {
      const data = JSON.parse(result.text);
      PrdSchema.parse(data);
      const outputPath = join(cwd, stageConfig.output);
      writeFileAtomic(outputPath, JSON.stringify(data, null, 2));
      doRegisterArtifact(runDir, "prd", stageConfig.output);
      const event: PlanResultAiflowEvent = {
        ts: nowFn().toISOString(),
        type: "plan_result",
        stage: stageConfig.id,
        result: "pass",
      };
      appendEvent(runDir, event);
      return { result: "pass", usage: totalUsage };
    } catch (err) {
      lastError = err;
    }
  }

  const event: PlanResultAiflowEvent = {
    ts: nowFn().toISOString(),
    type: "plan_result",
    stage: stageConfig.id,
    result: "fail",
  };
  appendEvent(runDir, event);
  return { result: "fail", reason: String(lastError), usage: totalUsage };
}
