import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../atomic/atomic-write";
import { callLlm, callLlmFanOut, type LlmCallResult } from "../llm/client";
import { appendEvent } from "../events/events";
import { noopBudgetTracker, type BudgetTracker } from "../gate/budget";
import type { BrainstormStageConfig, ModelProfile } from "../config/schema";
import type { StageOutcome } from "../engine/engine";
import type { StageState } from "../engine/state";
import { runDebateInternal, type DebateOutcome } from "../debate/orchestrator";
import { registerArtifact, addOpenQuestions, addDecisions } from "../specboard/specboard";

type FanOutResult = { profile: ModelProfile; ok: boolean; result?: LlmCallResult; error?: string };

export interface BrainstormDeps {
  callLlm: typeof callLlm;
  callLlmFanOut: typeof callLlmFanOut;
}

const defaultDeps: BrainstormDeps = { callLlm, callLlmFanOut };

function sumUsage(rounds: FanOutResult[][], extra?: LlmCallResult) {
  const usage = { inTok: 0, outTok: 0, costUsd: 0 };
  for (const round of rounds) {
    for (const r of round) {
      if (r.ok && r.result) {
        usage.inTok += r.result.usage.inTok;
        usage.outTok += r.result.usage.outTok;
        usage.costUsd += r.result.usage.costUsd;
      }
    }
  }
  if (extra) {
    usage.inTok += extra.usage.inTok;
    usage.outTok += extra.usage.outTok;
    usage.costUsd += extra.usage.costUsd;
  }
  return usage;
}

function renderIdeaPrompt(requirement: string): string {
  return [
    "You are brainstorming an implementation approach for the following requirement.",
    "Produce: a concise solution overview, key design decisions, risks, and a rough effort estimate.",
    "",
    "## Requirement",
    requirement,
  ].join("\n");
}

function renderSynthesisPrompt(requirement: string, finalRound: FanOutResult[]): string {
  const proposals = finalRound
    .filter((r) => r.ok && r.result)
    .map((r, i) => `### Model ${i + 1}\n${r.result!.text}`)
    .join("\n\n");
  return [
    "Synthesize the following independent proposals into: a comparison matrix, a recommended approach, and a list of open questions.",
    "",
    "## Requirement",
    requirement,
    "",
    "## Proposals",
    proposals,
  ].join("\n");
}

export async function runBrainstormStage(
  stageConfig: BrainstormStageConfig,
  _stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  _nowFn: () => Date,
  _signal: AbortSignal | undefined,
  deps: BrainstormDeps = defaultDeps,
  budget: BudgetTracker = noopBudgetTracker
): Promise<StageOutcome> {
  const artifactsDir = join(runDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const requirementPath = join(artifactsDir, "requirement.md");
  const requirement = existsSync(requirementPath) ? readFileSync(requirementPath, "utf-8") : "";

  if (stageConfig.mode === "debate") {
    const debate: DebateOutcome = await runDebateInternal(stageConfig, requirement, profiles, deps, budget);

    if (debate.overBudget) {
      return { result: "paused", reason: "budget_exceeded", usage: debate.usage };
    }

    if (debate.result === "fail") {
      appendEvent(runDir, {
        ts: new Date().toISOString(),
        type: "brainstorm_result",
        stage: stageConfig.id,
        result: "fail",
        successes: debate.successes,
      });
      return { result: "fail", usage: debate.usage };
    }

    writeFileAtomic(join(artifactsDir, stageConfig.output), debate.report);
    registerArtifact(runDir, "brainstorm-report", join("artifacts", stageConfig.output));
    if (debate.openQuestions.length > 0) {
      addOpenQuestions(runDir, debate.openQuestions);
    }
    if (debate.decisions.length > 0) {
      addDecisions(runDir, debate.decisions);
    }

    for (const summary of debate.roundSummaries) {
      appendEvent(runDir, {
        ts: new Date().toISOString(),
        type: "debate_round",
        stage: stageConfig.id,
        round: summary.round,
        resolved: summary.resolved,
        remaining: summary.remaining,
      });
    }
    appendEvent(runDir, {
      ts: new Date().toISOString(),
      type: "debate_end",
      stage: stageConfig.id,
      reason: debate.reason,
      open_questions: debate.openQuestions.length,
    });
    appendEvent(runDir, {
      ts: new Date().toISOString(),
      type: "brainstorm_result",
      stage: stageConfig.id,
      result: "pass",
      successes: debate.successes,
    });

    return { result: "pass", usage: debate.usage };
  }

  const modelProfiles = stageConfig.models.map((name) => profiles[name]);

  const round1 = await deps.callLlmFanOut(modelProfiles, () => renderIdeaPrompt(requirement), { stage: stageConfig.id });
  const successCount1 = round1.filter((r) => r.ok).length;
  if (successCount1 < 2) {
    appendEvent(runDir, {
      ts: new Date().toISOString(),
      type: "brainstorm_result",
      stage: stageConfig.id,
      result: "fail",
      successes: successCount1,
    });
    return { result: "fail", usage: sumUsage([round1]) };
  }

  const rounds: FanOutResult[][] = [round1];
  let finalRound = round1;
  let overBudget = budget.record(sumUsage([round1]).costUsd);

  if (overBudget) {
    return { result: "paused", reason: "budget_exceeded", usage: sumUsage(rounds) };
  }

  const synthesizerProfile = profiles[stageConfig.synthesizer];
  const synthesis = await deps.callLlm({
    profile: synthesizerProfile,
    prompt: renderSynthesisPrompt(requirement, finalRound),
    thinking: true,
    stage: stageConfig.id,
  });

  if (budget.record(synthesis.usage.costUsd)) {
    return { result: "paused", reason: "budget_exceeded", usage: sumUsage(rounds, synthesis) };
  }

  const appendix = finalRound
    .map((r, i) => (r.ok && r.result ? `## Model ${i + 1}\n${r.result.text}` : `## Model ${i + 1}\n(failed: ${r.error})`))
    .join("\n\n");
  writeFileAtomic(join(artifactsDir, stageConfig.output), `${synthesis.text}\n\n---\n\n# Raw proposals\n\n${appendix}\n`);

  appendEvent(runDir, {
    ts: new Date().toISOString(),
    type: "brainstorm_result",
    stage: stageConfig.id,
    result: "pass",
    successes: successCount1,
  });
  return { result: "pass", usage: sumUsage(rounds, synthesis) };
}
