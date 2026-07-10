import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseOpenSpec } from "../openspec/parser";
import { PrdSchema } from "../prd";
import { registerArtifact } from "../specboard/specboard";
import { appendEvent } from "../events/events";
import { noopBudgetTracker, type BudgetTracker } from "../gate/budget";
import type { PlanStageConfig, ModelProfile } from "../config/schema";
import type { StageOutcome } from "../engine/engine";
import type { StageState } from "../engine/state";

export interface PlanDeps {
  parseOpenSpec: typeof parseOpenSpec;
  registerArtifact: typeof registerArtifact;
}

const defaultDeps: PlanDeps = { parseOpenSpec, registerArtifact };

const zeroUsage = { inTok: 0, outTok: 0, costUsd: 0 };

export async function runPlanStage(
  stageConfig: PlanStageConfig,
  _stageState: StageState,
  _profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  _nowFn: () => Date,
  _signal: AbortSignal | undefined,
  deps: PlanDeps = defaultDeps,
  _budget: BudgetTracker = noopBudgetTracker
): Promise<StageOutcome> {
  const specPath = join(cwd, stageConfig.input);
  if (!existsSync(specPath)) {
    appendEvent(runDir, { ts: new Date().toISOString(), type: "plan_result", stage: stageConfig.id, result: "fail" });
    return { result: "fail", usage: zeroUsage };
  }

  const specText = readFileSync(specPath, "utf-8");
  const parsed = deps.parseOpenSpec(specText);
  if (!parsed.success) {
    appendEvent(runDir, { ts: new Date().toISOString(), type: "plan_result", stage: stageConfig.id, result: "fail" });
    return { result: "fail", usage: zeroUsage };
  }

  const prd = {
    branchName: parsed.spec.meta.branch,
    stories: parsed.spec.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      acceptance: task.acceptance,
      priority: task.priority,
      passes: false,
      fixCount: 0,
    })),
  };

  const validated = PrdSchema.safeParse(prd);
  if (!validated.success) {
    appendEvent(runDir, { ts: new Date().toISOString(), type: "plan_result", stage: stageConfig.id, result: "fail" });
    return { result: "fail", usage: zeroUsage };
  }

  writeFileSync(join(cwd, stageConfig.output), JSON.stringify(validated.data, null, 2));
  deps.registerArtifact(runDir, "prd", stageConfig.output);
  appendEvent(runDir, { ts: new Date().toISOString(), type: "plan_result", stage: stageConfig.id, result: "pass" });
  return { result: "pass", usage: zeroUsage };
}
