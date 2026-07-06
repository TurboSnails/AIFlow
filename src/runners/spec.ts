import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { runAgentTask as realRunAgentTask, type AgentTask, type AgentResult } from "../adapters/opencode";
import { appendEvent } from "../events/events";
import type { SpecStageConfig, ModelProfile } from "../config/schema";
import type { StageOutcome } from "../engine/engine";
import type { StageState } from "../engine/state";

export interface SpecDeps {
  runAgentTask: (task: AgentTask) => Promise<AgentResult>;
}

const defaultDeps: SpecDeps = { runAgentTask: realRunAgentTask };

function renderSpecPrompt(input: string): string {
  return [
    "Write a spec.md file for the following input, in an existing codebase.",
    "The spec must include clear, verifiable acceptance criteria for a later implementation stage.",
    "Write the file directly to the project root as spec.md. Do not ask for confirmation.",
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
  deps: SpecDeps = defaultDeps
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
    prompt: renderSpecPrompt(input),
    cwd,
    timeoutMs: 10 * 60 * 1000,
    runDir,
    stage: stageConfig.id,
    story: "spec",
  });

  const outputExists = existsSync(join(cwd, stageConfig.output));
  const result: "pass" | "fail" = agentResult.ok && outputExists ? "pass" : "fail";
  appendEvent(runDir, { ts: new Date().toISOString(), type: "spec_result", stage: stageConfig.id, result });
  return { result, usage: agentResult.usage };
}
