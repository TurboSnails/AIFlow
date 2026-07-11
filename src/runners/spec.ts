import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runAgentTask as realRunAgentTask, type AgentTask, type AgentResult } from "../adapters/opencode";
import { parseOpenSpec as realParseOpenSpec, lintOpenSpec as realLintOpenSpec } from "../openspec/parser";
import type { OpenSpec } from "../openspec/schema";
import { registerArtifact as realRegisterArtifact } from "../specboard/specboard";
import { setSpecHash } from "../specboard/specboard";
import { hashSpecFile } from "../config/config-hash";
import { appendEvent } from "../events/events";
import type { SpecResultAiflowEvent } from "../events/events";
import { noopBudgetTracker, type BudgetTracker } from "../gate/budget";
import type { SpecStageConfig, ModelProfile } from "../config/schema";
import type { StageOutcome } from "../engine/engine";
import type { StageState } from "../engine/state";

export interface SpecDeps {
  runAgentTask: (task: AgentTask) => Promise<AgentResult>;
  parseOpenSpec?: (text: string) => { success: true; spec: OpenSpec } | { success: false; error: string };
  lintOpenSpec?: (spec: OpenSpec) => string[];
  registerArtifact?: (runDir: string, name: string, relativePath: string) => void;
  hashFile?: (path: string) => string;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const defaultDeps: SpecDeps = {
  runAgentTask: realRunAgentTask,
  parseOpenSpec: realParseOpenSpec,
  lintOpenSpec: realLintOpenSpec,
  registerArtifact: realRegisterArtifact,
  hashFile,
};

function renderSpecPrompt(input: string, output: string): string {
  return `Produce a spec in OpenSpec format: YAML frontmatter followed by Markdown body and <task id="..." priority="1" files="..."> blocks. Each task must have a checklist of acceptance criteria.`;
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

  const parseOpenSpec = deps.parseOpenSpec ?? defaultDeps.parseOpenSpec!;
  const lintOpenSpec = deps.lintOpenSpec ?? defaultDeps.lintOpenSpec!;
  const registerArtifact = deps.registerArtifact ?? defaultDeps.registerArtifact!;
  const hashFile = deps.hashFile ?? defaultDeps.hashFile!;

  if (budget.record(agentResult.usage.costUsd)) {
    return { result: "paused", reason: "budget_exceeded", usage: agentResult.usage };
  }

  const outputPath = join(cwd, stageConfig.output);
  const outputExists = existsSync(outputPath);

  let result: "pass" | "fail" = agentResult.ok && outputExists ? "pass" : "fail";
  let specHash: string | undefined;

  if (result === "pass") {
    const specText = readFileSync(outputPath, "utf-8");
    const parseResult = parseOpenSpec(specText);
    if (!parseResult.success) {
      result = "fail";
    } else {
      const lintErrors = lintOpenSpec(parseResult.spec);
      if (lintErrors.length > 0) {
        result = "fail";
      } else {
        specHash = hashSpecFile(outputPath);
        if (specHash) setSpecHash(runDir, specHash);
        registerArtifact(runDir, "spec", stageConfig.output);
      }
    }
  }

  const event: SpecResultAiflowEvent = {
    ts: new Date().toISOString(),
    type: "spec_result",
    stage: stageConfig.id,
    result,
  };
  if (specHash) event.spec_hash = specHash;
  appendEvent(runDir, event);
  return { result, usage: agentResult.usage };
}
