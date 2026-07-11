import { callLlm, callLlmFanOut, type LlmCallResult } from "../llm/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrainstormStageConfig, ModelProfile } from "../config/schema";
import type { BudgetTracker } from "../gate/budget";
import type { OpenQuestion, Decision } from "../specboard/types";
import {
  ModeratorOutputSchema,
  RoundArtifactSchema,
  RoundProposalSchema,
  type RoundProposal,
  type DebateDispute,
} from "./schemas";

export interface DebateDeps {
  callLlmFanOut: typeof callLlmFanOut;
  callLlm: typeof callLlm;
  maxRetrySteps?: number;
  maxTokenCost?: number;
}

export interface Usage {
  inTok: number;
  outTok: number;
  costUsd: number;
}

export interface RoundSummary {
  round: number;
  resolved: number;
  remaining: number;
}

/** Public result shape returned by {@link runDebate}. */
export interface DebateResult {
  report: string;
  openQuestions: OpenQuestion[];
  decisions: Decision[];
  rounds: number;
}

/** Internal outcome shape used by the runner and tests that need telemetry. */
export interface DebateOutcome extends DebateResult {
  result: "pass" | "fail";
  reason?: "converged" | "max_rounds" | "stalled";
  successes: number;
  overBudget: boolean;
  usage: Usage;
  roundSummaries: RoundSummary[];
  proposals: RoundProposal[];
  /** Raw moderator output when the failure was caused by a moderator parse error. */
  rawModeratorText?: string;
}

interface RoundEntry {
  profile: ModelProfile;
  name: string;
  label: string;
  ok: boolean;
  text?: string;
  proposal?: RoundProposal;
  error?: string;
  usage?: LlmCallResult["usage"];
}

function addUsage(
  usage: Usage,
  result?: { usage: LlmCallResult["usage"] }
): Usage {
  if (!result) return usage;
  return {
    inTok: usage.inTok + result.usage.inTok,
    outTok: usage.outTok + result.usage.outTok,
    costUsd: usage.costUsd + result.usage.costUsd,
  };
}

function cleanJsonText(text: string): string {
  return text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
}

function parseRoundProposal(
  text: string,
  author: string,
  profile_real: string
): RoundProposal {
  const cleaned = cleanJsonText(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `Round proposal is not valid JSON: ${err instanceof Error ? err.message : String(err)}\nRaw text: ${text}`
    );
  }
  return RoundProposalSchema.parse({ ...(parsed as Record<string, unknown>), author, profile_real });
}

function roundProposalSchemaJson(): string {
  return JSON.stringify(
    {
      author: "your model identifier",
      profile_real: "actual model name",
      content_md:
        "string - concise solution overview, key design decisions, risks, and effort estimate",
      stance_changes: ["list of changes from your prior proposal"],
      critiques: [
        {
          target: "target model identifier",
          point: "specific, concrete critique",
          severity: "blocker|major|minor|nit",
        },
      ],
    },
    null,
    2
  );
}

function persistRoundArtifact(
  runDir: string | undefined,
  round: number,
  proposals: RoundProposal[],
  moderator: unknown
): void {
  if (!runDir) return;
  const artifact = RoundArtifactSchema.parse({ round, proposals, moderator });
  const debateDir = join(runDir, "artifacts", "debate");
  mkdirSync(debateDir, { recursive: true });
  writeFileSync(
    join(debateDir, `round-${round}.json`),
    JSON.stringify(artifact, null, 2)
  );
}

function renderProposalPrompt(requirement: string): string {
  return [
    "You are brainstorming an implementation approach for the following requirement.",
    "Output strictly JSON matching this schema:",
    roundProposalSchemaJson(),
    "",
    "Your content_md should include sections: Solution Overview, Key Design Decisions, Risks, and Effort Estimate.",
    "",
    "## Requirement",
    requirement,
  ].join("\n");
}

function renderResponsePrompt(
  requirement: string,
  label: string,
  others: { label: string; proposal: RoundProposal }[],
  priorDisputes: DebateDispute[]
): string {
  const lines = [
    renderProposalPrompt(requirement),
    "",
    "## Other proposals from this round",
    ...others.map((o) => `### ${o.label}\n${o.proposal.content_md}`),
    "",
    "Critique the other proposals and revise your own proposal in response.",
    "For each critique, include a target, a concrete point, and a severity (blocker, major, minor, or nit).",
    "Use stance_changes to summarize how your own position changed from the previous round.",
  ];
  if (priorDisputes.length > 0) {
    lines.push(
      "",
      "## Open disputes from the previous round",
      ...priorDisputes.flatMap((d) => {
        const positionLines = Object.entries(d.positions)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([modelName, position]) => `  - ${modelName}: ${position}`);
        return [`- ${d.id}: ${d.topic}`, ...positionLines];
      })
    );
  }
  lines.push("", `Respond as ${label}.`);
  return lines.join("\n");
}

function renderVagueCritiquePrompt(
  requirement: string,
  label: string,
  ownProposal: string,
  others: { label: string; content_md: string }[]
): string {
  return [
    `You previously responded as ${label}, but at least one of your critiques was missing a severity or a concrete point.`,
    "Revise your response so that every critique includes a target, a specific point, and a severity (blocker, major, minor, or nit).",
    "Output strictly JSON matching the schema from the original prompt.",
    "",
    "## Requirement",
    requirement,
    "",
    "## Your prior proposal",
    ownProposal,
    "",
    "## Other proposals",
    ...others.map((o) => `### ${o.label}\n${o.content_md}`),
  ].join("\n");
}

function renderModeratorPrompt(
  requirement: string,
  proposals: { label: string; content_md: string }[],
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
    ...proposals.map((p) => `### ${p.label}\n${p.content_md}`),
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
    const entry: RoundEntry = {
      profile: profiles[name],
      name,
      label: `Model ${i + 1}`,
      ok: res?.ok ?? false,
      text: res?.ok && res.result ? res.result.text : undefined,
      error: res?.ok ? undefined : res?.error,
      usage: res?.ok && res.result ? res.result.usage : undefined,
    };
    if (entry.ok && entry.text) {
      try {
        entry.proposal = parseRoundProposal(entry.text, name, profiles[name].model);
      } catch (err) {
        entry.ok = false;
        entry.error = err instanceof Error ? err.message : String(err);
        entry.proposal = undefined;
      }
    }
    return entry;
  });
}

export async function runDebateInternal(
  config: BrainstormStageConfig,
  requirement: string,
  profiles: Record<string, ModelProfile>,
  deps: DebateDeps,
  runDir?: string,
  budget?: BudgetTracker
): Promise<DebateOutcome> {
  const synthesizer = profiles[config.synthesizer];
  if (!synthesizer) throw new Error(`Synthesizer model "${config.synthesizer}" not found`);

  const modelProfiles = config.models.map((name) => {
    const p = profiles[name];
    if (!p) throw new Error(`Model "${name}" not found`);
    return p;
  });

  let usage: Usage = { inTok: 0, outTok: 0, costUsd: 0 };
  let overBudget = false;

  // Round 1: independent proposals.
  const round1FanOut = await deps.callLlmFanOut(modelProfiles, () => renderProposalPrompt(requirement), { stage: config.id, maxRetrySteps: deps.maxRetrySteps, maxTokenCost: deps.maxTokenCost });
  let currentRound = toRoundEntries(config, profiles, round1FanOut);
  for (const entry of currentRound) {
    if (entry.usage) usage = addUsage(usage, { usage: entry.usage });
  }

  const successCount = currentRound.filter((e) => e.ok).length;
  if (successCount < 2) {
    const proposals = currentRound
      .filter((e) => e.ok && e.proposal)
      .map((e) => e.proposal!);
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
      proposals,
    };
  }

  if (budget) {
    overBudget = budget.record(usage.costUsd);
  }
  if (overBudget) {
    const proposals = currentRound
      .filter((e) => e.ok && e.proposal)
      .map((e) => e.proposal!);
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
      proposals,
    };
  }

  let priorDisputes: DebateDispute[] = [];
  let lastRemaining: DebateDispute[] = [];
  const resolvedById = new Map<string, Decision>();
  let reason: DebateOutcome["reason"] = "max_rounds";
  let rounds = 1;
  const roundSummaries: RoundSummary[] = [];

  for (let roundNumber = 1; roundNumber <= config.debate_rounds; roundNumber++) {
    let proposals = currentRound
      .filter((e) => e.ok && e.proposal)
      .map((e) => e.proposal!);

    // Re-prompt models that produced vague critiques (missing severity or point).
    if (roundNumber >= 2) {
      const vagueAuthors = new Set(
        proposals
          .filter((p) => p.critiques.some((c) => !c.severity || !c.point))
          .map((p) => p.author)
      );
      if (vagueAuthors.size > 0) {
        const vagueProfiles = currentRound
          .filter((e) => e.ok && e.proposal && vagueAuthors.has(e.name))
          .map((e) => e.profile);
        const rePrompted = await deps.callLlmFanOut(
          vagueProfiles,
          (profile) => {
            const idx = modelProfiles.indexOf(profile);
            const self = currentRound[idx];
            const others = currentRound
              .filter((e) => e.ok && e.proposal && e.name !== self.name)
              .map((e) => ({ label: e.label, content_md: e.proposal!.content_md }));
            return renderVagueCritiquePrompt(
              requirement,
              self.label,
              self.proposal!.content_md,
              others
            );
          },
          { stage: config.id, maxRetrySteps: deps.maxRetrySteps, maxTokenCost: deps.maxTokenCost }
        );
        let rePromptCost = 0;
        for (const res of rePrompted) {
          const idx = modelProfiles.indexOf(res.profile);
          if (idx < 0) continue;
          const name = config.models[idx];
          const old = currentRound[idx];
          if (res.ok && res.result) {
            try {
              const proposal = parseRoundProposal(res.result.text, name, res.profile.model);
              currentRound[idx] = {
                ...old,
                ok: true,
                text: res.result.text,
                proposal,
                error: undefined,
                usage: res.result.usage,
              };
            } catch (err) {
              currentRound[idx] = {
                ...old,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
                proposal: undefined,
                usage: res.result.usage,
              };
            }
          } else {
            currentRound[idx] = {
              ...old,
              ok: false,
              error: res.error,
              proposal: undefined,
              usage: undefined,
            };
          }
          const newEntry = currentRound[idx];
          if (old.usage && newEntry.usage) {
            usage = {
              inTok: usage.inTok - old.usage.inTok + newEntry.usage.inTok,
              outTok: usage.outTok - old.usage.outTok + newEntry.usage.outTok,
              costUsd: usage.costUsd - old.usage.costUsd + newEntry.usage.costUsd,
            };
          } else if (newEntry.usage) {
            usage = addUsage(usage, { usage: newEntry.usage });
          }
          rePromptCost += newEntry.usage?.costUsd ?? 0;
        }
        proposals = currentRound
          .filter((e) => e.ok && e.proposal)
          .map((e) => e.proposal!);
        if (budget) {
          overBudget = budget.record(rePromptCost);
        }
        if (overBudget) {
          reason = "max_rounds";
          break;
        }
      }
    }

    const moderatorProposals = currentRound
      .filter((e) => e.ok && e.proposal)
      .map((e) => ({ label: e.label, content_md: e.proposal!.content_md }));

    const moderatorResult = await deps.callLlm({
      profile: synthesizer,
      prompt: renderModeratorPrompt(requirement, moderatorProposals, priorDisputes),
      jsonMode: true,
      stage: config.id,
      maxRetrySteps: deps.maxRetrySteps,
      maxTokenCost: deps.maxTokenCost,
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
        proposals,
        rawModeratorText: moderatorResult.text,
      };
    }

    for (const r of output.resolved) {
      resolvedById.set(r.id, { id: r.id, topic: r.topic, resolution: r.resolution, by: config.synthesizer });
    }

    const remaining = output.remaining_disputes;
    lastRemaining = remaining;
    roundSummaries.push({ round: roundNumber, resolved: output.resolved.length, remaining: remaining.length });
    persistRoundArtifact(runDir, roundNumber, proposals, output);

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
        .filter((e) => e.ok && e.proposal && e.name !== self.name)
        .map((e) => ({ label: e.label, proposal: e.proposal! }));
      return renderResponsePrompt(requirement, self.label, others, priorDisputes);
    }, { stage: config.id, maxRetrySteps: deps.maxRetrySteps, maxTokenCost: deps.maxTokenCost });
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

  const finalProposals = currentRound
    .filter((e) => e.ok && e.proposal)
    .map((e) => e.proposal!);
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
    proposals: finalProposals,
  };
}

/** Public entry point: returns a minimal {@link DebateResult} or throws on failure. */
export async function runDebate(
  config: BrainstormStageConfig,
  requirement: string,
  profiles: Record<string, ModelProfile>,
  deps: DebateDeps,
  runDir?: string,
  budget?: BudgetTracker
): Promise<DebateResult> {
  const outcome = await runDebateInternal(config, requirement, profiles, deps, runDir, budget);
  if (outcome.result === "fail") {
    const parts = [`Debate failed: ${outcome.reason ?? "unknown"}`];
    if (outcome.rawModeratorText) {
      parts.push("Raw moderator output:");
      parts.push(outcome.rawModeratorText);
    }
    throw new Error(parts.join("\n"));
  }
  const { report, openQuestions, decisions, rounds } = outcome;
  return { report, openQuestions, decisions, rounds };
}
