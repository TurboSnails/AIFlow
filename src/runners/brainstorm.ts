import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { callLlm, callLlmFanOut, type LlmCallResult } from "../llm/client";
import { appendEvent } from "../events/events";
import type { BrainstormStageConfig, ModelProfile } from "../config/schema";
import type { StageOutcome } from "../engine/engine";
import type { StageState } from "../engine/state";

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

function renderDebatePrompt(requirement: string, others: string[]): string {
  return [
    renderIdeaPrompt(requirement),
    "",
    "## Other proposals from this round (anonymized)",
    ...others.map((text, i) => `### Model ${i + 1}\n${text}`),
    "",
    "Critique the other proposals and revise your own proposal in response.",
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
  deps: BrainstormDeps = defaultDeps
): Promise<StageOutcome> {
  const artifactsDir = join(runDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const requirementPath = join(artifactsDir, "requirement.md");
  const requirement = existsSync(requirementPath) ? readFileSync(requirementPath, "utf-8") : "";

  const modelProfiles = stageConfig.models.map((name) => profiles[name]);

  const round1 = await deps.callLlmFanOut(modelProfiles, () => renderIdeaPrompt(requirement));
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

  if (stageConfig.mode === "debate") {
    for (let round = 2; round <= stageConfig.debate_rounds; round++) {
      const previous = finalRound;
      finalRound = await deps.callLlmFanOut(modelProfiles, (profile) => {
        const others = previous.filter((r) => r.profile !== profile && r.ok && r.result).map((r) => r.result!.text);
        return renderDebatePrompt(requirement, others);
      });
      rounds.push(finalRound);
    }
  }

  const synthesizerProfile = profiles[stageConfig.synthesizer];
  const synthesis = await deps.callLlm({
    profile: synthesizerProfile,
    prompt: renderSynthesisPrompt(requirement, finalRound),
    thinking: true,
  });

  const appendix = finalRound
    .map((r, i) => (r.ok && r.result ? `## Model ${i + 1}\n${r.result.text}` : `## Model ${i + 1}\n(failed: ${r.error})`))
    .join("\n\n");
  writeFileSync(join(artifactsDir, stageConfig.output), `${synthesis.text}\n\n---\n\n# Raw proposals\n\n${appendix}\n`);

  appendEvent(runDir, {
    ts: new Date().toISOString(),
    type: "brainstorm_result",
    stage: stageConfig.id,
    result: "pass",
    successes: successCount1,
  });
  return { result: "pass", usage: sumUsage(rounds, synthesis) };
}
