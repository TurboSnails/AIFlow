import { join } from "node:path";
import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { readPrd, writePrd, selectNextStory, markStoryPassed, recordStoryFailure, type Story, type Prd } from "../prd";
import { runAgentTask as realRunAgentTask, type AgentTask, type AgentResult } from "../adapters/opencode";
import { runReviewGate as realRunReviewGate, type ReviewGateOutcome } from "../gate/review-gate";
import { revParseHead, stageAll, diffCached, commit, checkoutClean } from "../git";
import { appendEvent } from "../events/events";
import type { RalphLoopStageConfig, ModelProfile } from "../config/schema";
import type { RalphLoopStopReason } from "../engine/state";

export interface RalphLoopDeps {
  runAgentTask: (task: AgentTask) => Promise<AgentResult>;
  runReviewGate: (
    config: RalphLoopStageConfig["gate"],
    reviewerProfile: ModelProfile,
    cwd: string,
    diff: string,
    acceptance: string[]
  ) => Promise<ReviewGateOutcome>;
  git: {
    revParseHead: typeof revParseHead;
    stageAll: typeof stageAll;
    diffCached: typeof diffCached;
    commit: typeof commit;
    checkoutClean: typeof checkoutClean;
  };
}

export interface RalphLoopResult {
  storyId: string;
  result: "pass" | "fail" | "suspended";
  usage: { inTok: number; outTok: number; costUsd: number };
}

const defaultDeps: RalphLoopDeps = {
  runAgentTask: realRunAgentTask,
  runReviewGate: (config, reviewerProfile, cwd, diff, acceptance) =>
    realRunReviewGate(config, reviewerProfile, cwd, diff, acceptance),
  git: { revParseHead, stageAll, diffCached, commit, checkoutClean },
};

export function renderPrompt(story: Story, specExcerpt: string, progressTail: string, fixListContent: string): string {
  return [
    "You are implementing one story in an existing codebase.",
    "",
    `## Story ${story.id}: ${story.title}`,
    "Acceptance criteria:",
    ...story.acceptance.map((a) => `- ${a}`),
    "",
    "## Spec excerpt",
    specExcerpt,
    "",
    progressTail ? `## Recent progress\n${progressTail}` : "",
    fixListContent ? `## Previous review feedback to address\n${fixListContent}` : "",
    "",
    "Make the necessary code changes directly in the working directory. Do not ask for confirmation.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function readTail(path: string, maxChars: number): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8");
  return content.slice(-maxChars);
}

export async function runRalphLoopOnce(
  stageConfig: RalphLoopStageConfig,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  specExcerpt: string,
  deps: RalphLoopDeps = defaultDeps
): Promise<RalphLoopResult> {
  const artifactsDir = join(runDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const progressPath = join(artifactsDir, "progress.md");
  const fixListPath = join(artifactsDir, "fix_list.md");

  const prdPath = join(cwd, "prd.json");
  const prd = readPrd(prdPath);
  const story = selectNextStory(prd);
  if (!story) {
    throw new Error("No pending story found in prd.json");
  }

  const mainDevProfile = profiles[stageConfig.model];
  const reviewerProfile = profiles[stageConfig.gate.ai_review.model];

  const progressTail = readTail(progressPath, 4000);
  const fixListContent = readTail(fixListPath, 4000);
  const prompt = renderPrompt(story, specExcerpt, progressTail, fixListContent);

  await deps.git.revParseHead(cwd);

  const agentResult = await deps.runAgentTask({
    profile: mainDevProfile,
    prompt,
    cwd,
    timeoutMs: 10 * 60 * 1000,
    runDir,
    stage: stageConfig.id,
    story: story.id,
  });

  if (!agentResult.ok) {
    const updatedPrd = recordStoryFailure(prd, story.id, stageConfig.per_story_fix_limit);
    writePrd(prdPath, updatedPrd);
    appendFileSync(fixListPath, `\n## ${story.id} (agent call failed)\nOpenCode agent invocation did not complete successfully.\n`);
    appendEvent(runDir, { ts: new Date().toISOString(), type: "story_result", story: story.id, result: "fail" });
    return { storyId: story.id, result: "fail", usage: agentResult.usage };
  }

  await deps.git.stageAll(cwd);
  const diff = await deps.git.diffCached(cwd);

  const gateOutcome = await deps.runReviewGate(stageConfig.gate, reviewerProfile, cwd, diff, story.acceptance);

  appendEvent(runDir, {
    ts: new Date().toISOString(),
    type: "gate_result",
    stage: stageConfig.id,
    story: story.id,
    checks: gateOutcome.checks,
    ai_review: gateOutcome.aiReview,
    blockers: gateOutcome.blockers,
  });

  const gatePassed = gateOutcome.checks === "pass" && gateOutcome.aiReview !== "fail";

  if (gatePassed) {
    const updatedPrd = markStoryPassed(prd, story.id);
    writePrd(prdPath, updatedPrd);
    await deps.git.stageAll(cwd);
    await deps.git.commit(cwd, `feat(${story.id}): ${story.title}`);
    appendFileSync(progressPath, `\n## ${story.id}\n${story.title} — passed checks and AI review.\n`);
    appendEvent(runDir, { ts: new Date().toISOString(), type: "story_result", story: story.id, result: "pass" });
    return { storyId: story.id, result: "pass", usage: agentResult.usage };
  }

  const updatedPrd = recordStoryFailure(prd, story.id, stageConfig.per_story_fix_limit);
  writePrd(prdPath, updatedPrd);
  const failureNote =
    gateOutcome.checks === "fail"
      ? `## ${story.id} (round ${updatedPrd.stories.find((s) => s.id === story.id)!.fixCount})\nDeterministic checks failed:\n${gateOutcome.checkOutput ?? ""}\n`
      : `## ${story.id} (round ${updatedPrd.stories.find((s) => s.id === story.id)!.fixCount})\nAI review flagged ${gateOutcome.blockers} blocking issue(s).\n`;
  appendFileSync(fixListPath, `\n${failureNote}`);

  const suspended = updatedPrd.stories.find((s) => s.id === story.id)!.suspended === true;
  const result = suspended ? "suspended" : "fail";
  appendEvent(runDir, { ts: new Date().toISOString(), type: "story_result", story: story.id, result });
  return { storyId: story.id, result, usage: agentResult.usage };
}

export interface RalphLoopSummary {
  result: "pass" | "suspended" | "paused";
  reason?: RalphLoopStopReason;
  iterations: number;
  usage: { inTok: number; outTok: number; costUsd: number };
}

function countStories(prd: Prd): { done: number; suspended: number; pending: number } {
  let done = 0;
  let suspended = 0;
  let pending = 0;
  for (const s of prd.stories) {
    if (s.passes) done += 1;
    else if (s.suspended) suspended += 1;
    else pending += 1;
  }
  return { done, suspended, pending };
}

function emitLoopResult(
  runDir: string,
  stageId: string,
  prd: Prd,
  outcome: { result: RalphLoopSummary["result"]; reason?: RalphLoopStopReason; iterations: number }
): void {
  const counts = countStories(prd);
  appendEvent(runDir, {
    ts: new Date().toISOString(),
    type: "ralph_loop_result",
    stage: stageId,
    result: outcome.result,
    reason: outcome.reason,
    iterations: outcome.iterations,
    stories_done: counts.done,
    stories_suspended: counts.suspended,
    stories_pending: counts.pending,
  });
}

function finalizeOutcome(
  prd: Prd,
  iterations: number,
  usage: RalphLoopSummary["usage"]
): RalphLoopSummary {
  const anySuspended = prd.stories.some((s) => s.suspended === true);
  return {
    result: anySuspended ? "suspended" : "pass",
    reason: anySuspended ? "stories_suspended" : undefined,
    iterations,
    usage,
  };
}

/**
 * Repeatedly runs runRalphLoopOnce until every story is done/suspended,
 * max_iterations is reached, or stall_limit consecutive iterations make
 * no progress (technical design doc §6.6).
 */
export async function runRalphLoop(
  stageConfig: RalphLoopStageConfig,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  specExcerpt: string,
  deps: RalphLoopDeps = defaultDeps,
  signal?: AbortSignal
): Promise<RalphLoopSummary> {
  const usage = { inTok: 0, outTok: 0, costUsd: 0 };
  let iterations = 0;
  let stallCount = 0;
  const prdPath = join(cwd, "prd.json");

  while (true) {
    const prd = readPrd(prdPath);

    if (signal?.aborted) {
      const outcome: RalphLoopSummary = { result: "paused", iterations, usage };
      emitLoopResult(runDir, stageConfig.id, prd, outcome);
      return outcome;
    }

    if (selectNextStory(prd) === null) {
      const outcome = finalizeOutcome(prd, iterations, usage);
      emitLoopResult(runDir, stageConfig.id, prd, outcome);
      return outcome;
    }

    iterations += 1;
    const suspendedBefore = countStories(prd).suspended;

    const onceResult = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, specExcerpt, deps);
    usage.inTok += onceResult.usage.inTok;
    usage.outTok += onceResult.usage.outTok;
    usage.costUsd += onceResult.usage.costUsd;

    const prdAfter = readPrd(prdPath);
    const suspendedAfter = countStories(prdAfter).suspended;

    if (suspendedAfter > suspendedBefore && stageConfig.auto_clean) {
      await deps.git.checkoutClean(cwd);
      writePrd(prdPath, prdAfter);
      appendEvent(runDir, { ts: new Date().toISOString(), type: "story_auto_cleaned", story: onceResult.storyId });
    }

    if (selectNextStory(prdAfter) === null) {
      const outcome = finalizeOutcome(prdAfter, iterations, usage);
      emitLoopResult(runDir, stageConfig.id, prdAfter, outcome);
      return outcome;
    }

    if (iterations >= stageConfig.max_iterations) {
      const outcome: RalphLoopSummary = { result: "suspended", reason: "max_iterations", iterations, usage };
      emitLoopResult(runDir, stageConfig.id, prdAfter, outcome);
      return outcome;
    }

    const progressed = onceResult.result === "pass" || suspendedAfter > suspendedBefore;
    stallCount = progressed ? 0 : stallCount + 1;

    if (stallCount >= stageConfig.stall_limit) {
      const outcome: RalphLoopSummary = { result: "suspended", reason: "stall", iterations, usage };
      emitLoopResult(runDir, stageConfig.id, prdAfter, outcome);
      return outcome;
    }
  }
}
