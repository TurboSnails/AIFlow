import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { callLlm } from "../llm/client";
import { PrdSchema } from "../prd";
import { noopBudgetTracker, type BudgetTracker } from "../gate/budget";
import type { PlanStageConfig, ModelProfile } from "../config/schema";
import type { StageOutcome } from "../engine/engine";
import type { StageState } from "../engine/state";

export interface PlanDeps {
  callLlm?: typeof callLlm;
}

export const defaultDeps: PlanDeps = { callLlm };

const zeroUsage = { inTok: 0, outTok: 0, costUsd: 0 };

export async function runPlanStage(
  stageConfig: PlanStageConfig,
  _stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  _nowFn: () => Date,
  _signal: AbortSignal | undefined,
  deps: PlanDeps = defaultDeps,
  _budget: BudgetTracker = noopBudgetTracker
): Promise<StageOutcome> {
  const profile = profiles[stageConfig.model];
  if (!profile) throw new Error(`Unknown model ${stageConfig.model}`);
  const specPath = join(cwd, stageConfig.input);
  if (!existsSync(specPath)) {
    return { result: "fail", usage: zeroUsage };
  }
  const spec = readFileSync(specPath, "utf-8");
  const prompt = `Convert the following spec into a JSON prd matching this schema: ${JSON.stringify(PrdSchema.shape)}.\n\n${spec}`;
  const result = await (deps.callLlm ?? callLlm)({ profile, prompt, jsonMode: true });
  let data: unknown;
  try {
    data = JSON.parse(result.text);
    PrdSchema.parse(data);
  } catch (err) {
    const retry = await (deps.callLlm ?? callLlm)({
      profile,
      prompt: `${prompt}\n\nPrevious attempt failed with: ${err}. Please fix and return valid JSON only.`,
      jsonMode: true,
    });
    data = JSON.parse(retry.text);
    PrdSchema.parse(data);
  }
  writeFileSync(join(cwd, stageConfig.output), JSON.stringify(data, null, 2));
  return { result: "pass" };
}
