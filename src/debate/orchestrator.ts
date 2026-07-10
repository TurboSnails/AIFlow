import { callLlm, callLlmFanOut, type LlmCallResult } from "../llm/client";
import type { BrainstormStageConfig, ModelProfile } from "../config/schema";
import type { BudgetTracker } from "../gate/budget";
import type { OpenQuestion, Decision } from "../specboard/types";
import { ModeratorOutputSchema, type DebateDispute } from "./schemas";

export interface DebateDeps {
  callLlmFanOut: typeof callLlmFanOut;
  callLlm: typeof callLlm;
}

export interface DebateResult {
  report: string;
  openQuestions: OpenQuestion[];
  decisions: Decision[];
  rounds: number;
  /** High-level outcome of the debate. */
  result: "pass" | "fail";
  /** Why the debate stopped. Only meaningful when result is "pass". */
  reason: "converged" | "max_rounds" | "stalled";
  /** Number of models that produced a usable round-1 proposal. */
  successes: number;
  /** True if the budget was exceeded before the debate could finish. */
  overBudget: boolean;
  /** Aggregated token and cost usage across all LLM calls. */
  usage: { inTok: number; outTok: number; costUsd: number };
  /** Per-round summary of resolved and remaining disputes. */
  roundSummaries: { round: number; resolved: number; remaining: number }[];
}

interface RoundEntry {
  profile: ModelProfile;
  name: string;
  label: string;
  ok: boolean;
  text?: string;
  error?: string;
  usage?: LlmCallResult["usage"];
}

function addUsage(
  usage: DebateResult["usage"],
  result?: { usage: LlmCallResult["usage"] }
): DebateResult["usage"] {
  if (!result) return usage;
  return {
    inTok: usage.inTok + result.usage.inTok,
    outTok: usage.outTok + result.usage.outTok,
    costUsd: usage.costUsd + result.usage.costUsd,
  };
}

function renderProposalPrompt(requirement: string): string {
  return [
    "You are brainstorming an implementation approach for the following requirement.",
    "Produce: a concise solution overview, key design decisions, risks, and a rough effort estimate.",
    "",
    "## Requirement",
    requirement,
  ].join("\n");
}

function renderResponsePrompt(
  requirement: string,
  label: string,
  others: { label: string; text: string }[],
  priorDisputes: DebateDispute[]
): string {
  const lines = [
    renderProposalPrompt(requirement),
    "",
    "## Other proposals from this round (anonymized)",
    ...others.map((o) => `### ${o.label}\n${o.text}`),
    "",
    "Critique the other proposals and revise your own proposal in response.",
  ];
  if (priorDisputes.length > 0) {
    lines.push("", "## Open disputes from the previous round", ...priorDisputes.map((d) => `- ${d.id}: ${d.topic}`));
  }
  lines.push("", `Respond as ${label}.`);
  return lines.join("\n");
}

function renderModeratorPrompt(
  requirement: string,
  proposals: { label: string; text: string }[],
  priorDisputes: DebateDispute[]
): string {
  return [
    "You are the moderator of a multi-model debate. Review the anonymized proposals below and decide which disputes are resolved and which remain open.",
    "Output strictly JSON matching this schema:",
    '{ "resolved": [{ "id": "string", "topic": "string", "resolution": "string" }], "remaining_disputes": [{ "id": "string", "topic": "string", "positions": { "model_name": "position" } }] }',
    "",
    "## Requirement",
    requirement,
    "",
    "## Proposals",
    ...proposals.map((p) => `### ${p.label}\n${p.text}`),
    ...(priorDisputes.length > 0
      ? ["", "## Prior disputes", ...priorDisputes.map((d) => `- ${d.id}: ${d.topic}`)]
      : []),
  ].join("\n");
}

function renderReport(
  requirement: string,
  decisions: Decision[],
  openQuestions: OpenQuestion[]
): string {
  const lines = [
    "# Debate Report",
    "",
    "## Requirement",
    requirement,
    "",
    "## Decisions",
  ];
  if (decisions.length === 0) {
    lines.push("No decisions were reached.");
  } else {
    for (const d of decisions) {
      lines.push(`- **${d.id}** (${d.topic}): ${d.resolution}`);
    }
  }
  lines.push("", "## Open Questions");
  if (openQuestions.length === 0) {
    lines.push("All disputes converged.");
  } else {
    for (const q of openQuestions) {
      lines.push(`- **${q.id}** (${q.topic})`);
      for (const [model, position] of Object.entries(q.positions)) {
        lines.push(`  - ${model}: ${position}`);
      }
    }
  }
  return lines.join("\n");
}

function parseModeratorOutput(text: string): { resolved: { id: string; topic: string; resolution: string }[]; remaining_disputes: DebateDispute[] } {
  try {
    const parsed = JSON.parse(text);
    return ModeratorOutputSchema.parse(parsed);
  } catch (err) {
    throw new Error(`Moderator output is not valid JSON/Zod: ${err instanceof Error ? err.message : String(err)}\nRaw text: ${text}`);
  }
}

function toRoundEntries(
  config: BrainstormStageConfig,
  profiles: Record<string, ModelProfile>,
  fanOutResults: Array<{ profile: ModelProfile; ok: boolean; result?: LlmCallResult; error?: string }>
): RoundEntry[] {
  return config.models.map((name, i) => {
    const res = fanOutResults[i];
    return {
      profile: profiles[name],
      name,
      label: `Model ${i + 1}`,
      ok: res?.ok ?? false,
      text: res?.ok && res.result ? res.result.text : undefined,
      error: res?.ok ? undefined : res?.error,
      usage: res?.ok && res.result ? res.result.usage : undefined,
    };
  });
}

export async function runDebate(
  config: BrainstormStageConfig,
  requirement: string,
  profiles: Record<string, ModelProfile>,
  deps: DebateDeps,
  budget?: BudgetTracker
): Promise<DebateResult> {
  const synthesizer = profiles[config.synthesizer];
  if (!synthesizer) throw new Error(`Synthesizer model "${config.synthesizer}" not found`);

  const modelProfiles = config.models.map((name) => {
    const p = profiles[name];
    if (!p) throw new Error(`Model "${name}" not found`);
    return p;
  });

  let usage: DebateResult["usage"] = { inTok: 0, outTok: 0, costUsd: 0 };
  let overBudget = false;

  // Round 1: independent proposals.
  const round1FanOut = await deps.callLlmFanOut(modelProfiles, () => renderProposalPrompt(requirement));
  let currentRound = toRoundEntries(config, profiles, round1FanOut);
  for (const entry of currentRound) {
    if (entry.usage) usage = addUsage(usage, { usage: entry.usage });
  }

  const successCount = currentRound.filter((e) => e.ok).length;
  if (successCount < 2) {
    return {
      report: renderReport(requirement, [], []),
      openQuestions: [],
      decisions: [],
      rounds: 1,
      result: "fail",
      reason: "max_rounds",
      successes: successCount,
      overBudget: false,
      usage,
      roundSummaries: [],
    };
  }

  if (budget) {
    overBudget = budget.record(usage.costUsd);
  }
  if (overBudget) {
    return {
      report: renderReport(requirement, [], []),
      openQuestions: [],
      decisions: [],
      rounds: 1,
      result: "pass",
      reason: "max_rounds",
      successes: successCount,
      overBudget: true,
      usage,
      roundSummaries: [],
    };
  }

  let priorDisputes: DebateDispute[] = [];
  let lastRemaining: DebateDispute[] = [];
  const resolvedById = new Map<string, Decision>();
  let reason: DebateResult["reason"] = "max_rounds";
  let rounds = 1;
  const roundSummaries: DebateResult["roundSummaries"] = [];

  for (let roundNumber = 1; roundNumber <= config.debate_rounds; roundNumber++) {
    const proposals = currentRound
      .filter((e) => e.ok && e.text)
      .map((e) => ({ label: e.label, text: e.text! }));

    const moderatorResult = await deps.callLlm({
      profile: synthesizer,
      prompt: renderModeratorPrompt(requirement, proposals, priorDisputes),
      jsonMode: true,
    });
    usage = addUsage(usage, { usage: moderatorResult.usage });
    if (budget) {
      overBudget = budget.record(moderatorResult.usage.costUsd);
    }
    if (overBudget) {
      reason = "max_rounds";
      break;
    }

    let output: ReturnType<typeof parseModeratorOutput>;
    try {
      output = parseModeratorOutput(moderatorResult.text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failureReport = [
        "# Debate Report",
        "",
        "## Requirement",
        requirement,
        "",
        "## Error",
        `Moderator output could not be parsed: ${message}`,
        "",
        "## Raw moderator output",
        moderatorResult.text,
      ].join("\n");
      return {
        report: failureReport,
        openQuestions: lastRemaining.map((d) => ({ ...d })),
        decisions: Array.from(resolvedById.values()),
        rounds,
        result: "fail",
        reason: "max_rounds",
        successes: successCount,
        overBudget: false,
        usage,
        roundSummaries,
      };
    }

    for (const r of output.resolved) {
      resolvedById.set(r.id, { id: r.id, topic: r.topic, resolution: r.resolution, by: config.synthesizer });
    }

    const remaining = output.remaining_disputes;
    lastRemaining = remaining;
    roundSummaries.push({ round: roundNumber, resolved: output.resolved.length, remaining: remaining.length });

    if (remaining.length === 0) {
      reason = "converged";
      break;
    }
    if (priorDisputes.length > 0 && remaining.length >= priorDisputes.length) {
      reason = "stalled";
      break;
    }
    if (roundNumber === config.debate_rounds) {
      reason = "max_rounds";
      break;
    }

    priorDisputes = remaining;
    rounds++;

    const nextFanOut = await deps.callLlmFanOut(modelProfiles, (profile) => {
      const idx = modelProfiles.indexOf(profile);
      const self = currentRound[idx];
      const others = currentRound
        .filter((e) => e.ok && e.text && e.name !== self.name)
        .map((e) => ({ label: e.label, text: e.text! }));
      return renderResponsePrompt(requirement, self.label, others, priorDisputes);
    });
    currentRound = toRoundEntries(config, profiles, nextFanOut);
    const fanOutCost = currentRound.reduce((sum, e) => sum + (e.usage?.costUsd ?? 0), 0);
    for (const entry of currentRound) {
      if (entry.usage) usage = addUsage(usage, { usage: entry.usage });
    }
    if (budget) {
      overBudget = budget.record(fanOutCost);
    }
    if (overBudget) {
      reason = "max_rounds";
      break;
    }
  }

  const finalOpenQuestions: OpenQuestion[] =
    reason === "stalled" || reason === "max_rounds" || overBudget
      ? lastRemaining.map((d) => ({ ...d }))
      : [];

  const decisions = Array.from(resolvedById.values());
  const report = renderReport(requirement, decisions, finalOpenQuestions);

  return {
    report,
    openQuestions: finalOpenQuestions,
    decisions,
    rounds,
    result: "pass",
    reason,
    successes: successCount,
    overBudget,
    usage,
    roundSummaries,
  };
}
