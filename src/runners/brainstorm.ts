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
import { RoundProposalSchema, type RoundProposal, type Critique } from "../debate/schemas";
import type { Decision, OpenQuestion } from "../specboard/types";
import { registerArtifact, addOpenQuestions, addDecisions } from "../specboard/specboard";

type FanOutResult = { profile: ModelProfile; ok: boolean; result?: LlmCallResult; error?: string };

export interface BrainstormDeps {
  callLlm: typeof callLlm;
  callLlmFanOut: typeof callLlmFanOut;
  maxRetrySteps?: number;
  maxTokenCost?: number;
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

function cleanJsonText(text: string): string {
  return text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
}

function parseIndependentProposal(
  rawText: string,
  author: string,
  profile_real: string
): RoundProposal {
  try {
    const parsed = JSON.parse(cleanJsonText(rawText));
    return RoundProposalSchema.parse({ ...(parsed as Record<string, unknown>), author, profile_real });
  } catch {
    return {
      author,
      profile_real,
      content_md: rawText,
      stance_changes: [],
      critiques: [],
    };
  }
}

function extractSection(content: string, headings: string[]): string {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i].replace(/^#+\s*/, "").trim();
    const match = headings.some((h) => lineText.toLowerCase().startsWith(h.toLowerCase()));
    if (match) {
      const end = lines.findIndex((line, idx) => idx > i && /^#+\s+/.test(line.trim()));
      return lines
        .slice(i + 1, end === -1 ? undefined : end)
        .join("\n")
        .trim();
    }
  }
  return "";
}

function escapeCell(value: string): string {
  return value
    .replace(/\|/g, "\\|")
    .replace(/\n+/g, " ")
    .trim();
}

function renderComparisonMatrix(proposals: RoundProposal[]): string {
  if (proposals.length === 0) {
    return "## Comparison Matrix\n\nNo proposals available.\n";
  }
  const rows = proposals.map((p) => {
    const keyDesign =
      extractSection(p.content_md, ["Key Design", "Design Decisions", "Solution Overview"]) ||
      p.content_md.split("\n")[0] ||
      "(no content)";
    const risks =
      extractSection(p.content_md, ["Risks", "Risk"]) ||
      p.critiques.map((c) => `${c.severity ?? "?"}: ${c.point}`).join("; ") ||
      "(none listed)";
    const workload =
      extractSection(p.content_md, ["Effort", "Estimate", "Workload"]) ||
      "(none listed)";
    return `| ${escapeCell(p.author)} | ${escapeCell(keyDesign)} | ${escapeCell(risks)} | ${escapeCell(workload)} |`;
  });
  return [
    "## Comparison Matrix",
    "",
    "| Model | Key Design | Risks | Workload |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function severityWeight(severity?: string): number {
  switch (severity) {
    case "blocker":
      return 4;
    case "major":
      return 3;
    case "minor":
      return 2;
    case "nit":
      return 1;
    default:
      return 0;
  }
}

function pickBestProposal(proposals: RoundProposal[]): RoundProposal {
  let best = proposals[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const p of proposals) {
    if (p.critiques.length === 0) continue;
    const score = p.critiques.reduce((sum, c) => sum + severityWeight(c.severity), 0);
    if (score < bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

function renderRecommendation(
  proposals: RoundProposal[],
  decisions: Decision[] = [],
  openQuestions: OpenQuestion[] = []
): string {
  const lines = ["## Recommendation", ""];
  if (decisions.length > 0) {
    lines.push(
      `Adopt the ${decisions.length} resolved decision(s) and use the comparison matrix to select the implementation approach that best satisfies them.`
    );
  } else if (proposals.length > 0) {
    const best = pickBestProposal(proposals);
    const keyDesign =
      extractSection(best.content_md, ["Key Design", "Design Decisions", "Solution Overview"]) ||
      best.content_md.split("\n")[0] ||
      "See comparison matrix.";
    lines.push(`The recommended approach is from **${best.author}** (${best.profile_real}).`);
    lines.push(`Key design: ${keyDesign}`);
    lines.push(`Address the identified risks and workload before committing to an implementation.`);
  } else {
    lines.push("No proposals available to recommend.");
  }
  if (openQuestions.length > 0) {
    lines.push(
      `Resolve the ${openQuestions.length} open question(s) before committing to an implementation.`
    );
  }
  return lines.join("\n");
}

function renderIdeaPrompt(requirement: string): string {
  return [
    "You are brainstorming an implementation approach for the following requirement.",
    "Produce: a concise solution overview, key design decisions, risks, and a rough effort estimate.",
    "Use markdown headings for each section: Solution Overview, Key Design Decisions, Risks, and Effort Estimate.",
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
    "Synthesize the following independent proposals into a concise recommended approach and a list of open questions.",
    "Do not include a comparison matrix; one will be appended deterministically from the proposals.",
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
    const debate: DebateOutcome = await runDebateInternal(stageConfig, requirement, profiles, deps, runDir, budget);

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

    const report = [
      debate.report,
      renderComparisonMatrix(debate.proposals),
      renderRecommendation(debate.proposals, debate.decisions, debate.openQuestions),
    ].join("\n\n");
    writeFileAtomic(join(artifactsDir, stageConfig.output), report);
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
      reason: debate.reason ?? "max_rounds",
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

  const round1 = await deps.callLlmFanOut(modelProfiles, () => renderIdeaPrompt(requirement), { stage: stageConfig.id, maxRetrySteps: deps.maxRetrySteps, maxTokenCost: deps.maxTokenCost });
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
    maxRetrySteps: deps.maxRetrySteps,
    maxTokenCost: deps.maxTokenCost,
  });

  if (budget.record(synthesis.usage.costUsd)) {
    return { result: "paused", reason: "budget_exceeded", usage: sumUsage(rounds, synthesis) };
  }

  const appendix = finalRound
    .map((r, i) => (r.ok && r.result ? `## Model ${i + 1}\n${r.result.text}` : `## Model ${i + 1}\n(failed: ${r.error})`))
    .join("\n\n");

  const proposals: RoundProposal[] = [];
  for (let i = 0; i < finalRound.length; i++) {
    const r = finalRound[i];
    if (r.ok && r.result) {
      const name = stageConfig.models[i];
      proposals.push(parseIndependentProposal(r.result.text, name, profiles[name].model));
    }
  }

  const report = [
    synthesis.text,
    "---",
    "# Raw proposals",
    appendix,
    renderComparisonMatrix(proposals),
    renderRecommendation(proposals),
  ].join("\n\n");
  writeFileAtomic(join(artifactsDir, stageConfig.output), report);

  appendEvent(runDir, {
    ts: new Date().toISOString(),
    type: "brainstorm_result",
    stage: stageConfig.id,
    result: "pass",
    successes: successCount1,
  });
  return { result: "pass", usage: sumUsage(rounds, synthesis) };
}
