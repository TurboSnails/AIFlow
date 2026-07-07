import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { runAgentTask as realRunAgentTask, type AgentTask, type AgentResult } from "../adapters/opencode";
import { appendEvent } from "../events/events";
import { noopBudgetTracker, type BudgetTracker } from "../gate/budget";
import type { SpecStageConfig, ModelProfile } from "../config/schema";
import type { StageOutcome } from "../engine/engine";
import type { StageState } from "../engine/state";

export interface SpecDeps {
  runAgentTask: (task: AgentTask) => Promise<AgentResult>;
}

const defaultDeps: SpecDeps = { runAgentTask: realRunAgentTask };

function renderSpecPrompt(input: string, output: string): string {
  return [
    `Write a ${output} file for the following input, in an existing codebase.`,
    "The spec must include clear, verifiable acceptance criteria for a later implementation stage.",
    `Write the file directly to the project root as ${output}. Do not ask for confirmation.`,
    "",
    "## Input",
    input,
  ].join("\n");
}

export async function runSpecStage(
  stageConfig: SpecStageConfig,
  _stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  _nowFn: () => Date,
  _signal: AbortSignal | undefined,
  deps: SpecDeps = defaultDeps,
  budget: BudgetTracker = noopBudgetTracker
): Promise<StageOutcome> {
  const artifactsDir = join(runDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const brainstormPath = join(artifactsDir, "brainstorm-report.md");
  const requirementPath = join(artifactsDir, "requirement.md");
  const input = existsSync(brainstormPath)
    ? readFileSync(brainstormPath, "utf-8")
    : existsSync(requirementPath)
      ? readFileSync(requirementPath, "utf-8")
      : "";

  const profile = profiles[stageConfig.model];
  const agentResult = await deps.runAgentTask({
    profile,
    prompt: renderSpecPrompt(input, stageConfig.output),
    cwd,
    timeoutMs: 10 * 60 * 1000,
    runDir,
    stage: stageConfig.id,
    story: "spec",
  });

  if (budget.record(agentResult.usage.costUsd)) {
    return { result: "paused", reason: "budget_exceeded", usage: agentResult.usage };
  }

  const outputExists = existsSync(join(cwd, stageConfig.output));
  const result: "pass" | "fail" = agentResult.ok && outputExists ? "pass" : "fail";
  appendEvent(runDir, { ts: new Date().toISOString(), type: "spec_result", stage: stageConfig.id, result });
  return { result, usage: agentResult.usage };
}
