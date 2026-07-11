import { join } from "node:path";
import { mkdirSync, appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { writeFileAtomic } from "../atomic/atomic-write";
import { readPrd, writePrd, selectNextStory, markStoryPassed, recordStoryFailure, type Story, type Prd } from "../prd";
import { runAgentTask as realRunAgentTask, type AgentTask, type AgentResult } from "../adapters/opencode";
import { runReviewGate as realRunReviewGate, type ReviewGateOutcome, type ReviewGateDeps } from "../gate/review-gate";
import { runChecks as realRunChecks } from "../gate/check-runner";
import { callReviewer as realCallReviewer } from "../llm/client";
import { hashConfigDir as realHashConfigDir, hashSpecFile as realHashSpecFile } from "../config/config-hash";
import { readSpecBoard as realReadSpecBoard, recordReviewMatrix } from "../specboard/specboard";
import type { SpecBoard } from "../specboard/types";
import { revParseHead, stageAll, diffCached, diffCachedFileNames, commit, checkoutClean, checkoutConfigOnly } from "../git";
import { appendEvent, type GateResultAiflowEvent } from "../events/events";
import type { ReviewVerdictAiflowEvent, ReviewArbitratedAiflowEvent, StorySuspendedAiflowEvent } from "../events/new-events";
import type { RalphLoopStageConfig, ModelProfile } from "../config/schema";
import type { RalphLoopStopReason } from "../engine/state";
import { noopBudgetTracker, type BudgetTracker } from "../gate/budget";

export interface RalphLoopDeps {
  runAgentTask: (task: AgentTask) => Promise<AgentResult>;
  runReviewGate: (
    config: RalphLoopStageConfig["gate"],
    reviewerProfile: ModelProfile,
    cwd: string,
    diff: string,
    acceptance: string[],
    deps?: ReviewGateDeps
  ) => Promise<ReviewGateOutcome>;
  git: {
    revParseHead: typeof revParseHead;
    stageAll: typeof stageAll;
    diffCached: typeof diffCached;
    diffCachedFileNames: typeof diffCachedFileNames;
    commit: typeof commit;
    checkoutClean: typeof checkoutClean;
    checkoutConfigOnly: typeof checkoutConfigOnly;
  };
  hashConfigDir: (cwd: string) => string;
  readSpecBoard?: (runDir: string) => SpecBoard;
  hashSpecFile?: (specPath: string) => string | undefined;
  maxDriftFiles?: number;
  defaultChecks?: string[];
}

export interface RalphLoopResult {
  storyId: string;
  result: "pass" | "fail" | "suspended" | "paused";
  usage: { inTok: number; outTok: number; costUsd: number };
}

const defaultDeps: RalphLoopDeps = {
  runAgentTask: realRunAgentTask,
  runReviewGate: (config, reviewerProfile, cwd, diff, acceptance, deps) =>
    realRunReviewGate(config, reviewerProfile, cwd, diff, acceptance, deps),
  git: { revParseHead, stageAll, diffCached, diffCachedFileNames, commit, checkoutClean, checkoutConfigOnly },
  hashConfigDir: realHashConfigDir,
  readSpecBoard: realReadSpecBoard,
  hashSpecFile: realHashSpecFile,
  maxDriftFiles: 50,
};

export function assertTamperGuard(cwd: string, runDir: string): void {
  const board = realReadSpecBoard(runDir);
  if (board.spec_hash) {
    const currentSpecHash = realHashSpecFile(join(cwd, "spec.md"));
    if (currentSpecHash !== board.spec_hash) {
      throw new Error(`Spec hash mismatch: spec.md was modified after the spec stage.`);
    }
  }
  if (board.config_hash) {
    const currentConfigHash = realHashConfigDir(cwd);
    if (currentConfigHash !== board.config_hash) {
      throw new Error(`Config hash mismatch: .aiflow/config was modified after run start.`);
    }
  }
}

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

function emitStorySuspended(runDir: string, storyId: string, reason: StorySuspendedAiflowEvent["reason"]): void {
  appendEvent(runDir, { ts: new Date().toISOString(), type: "story_suspended", story: storyId, reason });
}

function archiveReview(runDir: string, storyId: string, gateOutcome: ReviewGateOutcome): void {
  const reviewsDir = join(runDir, "artifacts", "reviews");
  mkdirSync(reviewsDir, { recursive: true });
  const archive = {
    storyId,
    checks: gateOutcome.checks,
    aiReview: gateOutcome.aiReview,
    blockers: gateOutcome.blockers,
    matrix: gateOutcome.matrix,
    issueSets: gateOutcome.issueSets,
    reviewOutput: gateOutcome.reviewOutput,
  };
  writeFileAtomic(join(reviewsDir, `${storyId}.json`), JSON.stringify(archive, null, 2));
}

export async function runRalphLoopOnce(
  stageConfig: RalphLoopStageConfig,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  specExcerpt: string,
  deps: RalphLoopDeps = defaultDeps,
  budget: BudgetTracker = noopBudgetTracker
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
  const reviewerModel = stageConfig.gate.ai_review.model ??
    stageConfig.gate.ai_review.reviewers?.[0] ??
    stageConfig.model;
  const reviewerProfile = profiles[reviewerModel];

  const progressTail = readTail(progressPath, 4000);
  const fixListContent = readTail(fixListPath, 4000);
  const prompt = renderPrompt(story, specExcerpt, progressTail, fixListContent);

  const board = (deps.readSpecBoard ?? realReadSpecBoard)(runDir);
  const specPath = board.artifacts["spec"] ?? "spec.md";
  const specFullPath = join(cwd, specPath);
  const specExistedBefore = existsSync(specFullPath);
  const specContentBefore = specExistedBefore ? readFileSync(specFullPath, "utf-8") : undefined;

  await deps.git.revParseHead(cwd);
  const configHashBefore = deps.hashConfigDir(cwd);
  const specHashBefore = (deps.hashSpecFile ?? realHashSpecFile)(specFullPath);

  const agentResult = await deps.runAgentTask({
    profile: mainDevProfile,
    prompt,
    cwd,
    timeoutMs: 10 * 60 * 1000,
    runDir,
    stage: stageConfig.id,
    story: story.id,
  });

  if (agentResult.ok) {
    const configHashAfter = deps.hashConfigDir(cwd);
    const specHashAfter = (deps.hashSpecFile ?? realHashSpecFile)(specFullPath);
    if (configHashAfter !== configHashBefore || specHashAfter !== specHashBefore) {
      await deps.git.checkoutConfigOnly(cwd);
      if (specExistedBefore) {
        writeFileAtomic(specFullPath, specContentBefore!);
      } else {
        rmSync(specFullPath, { force: true });
      }
      const updatedPrd = recordStoryFailure(prd, story.id, stageConfig.per_story_fix_limit);
      writePrd(prdPath, updatedPrd);
      const configChanged = configHashAfter !== configHashBefore;
      const specChanged = specHashAfter !== specHashBefore;
      const changedTarget =
        configChanged && specChanged
          ? "`.aiflow/config/` 和 `spec.md`"
          : configChanged
            ? "`.aiflow/config/`"
            : "`spec.md`";
      appendFileSync(
        fixListPath,
        `\n## ${story.id} (round ${updatedPrd.stories.find((s) => s.id === story.id)!.fixCount})\n检测到 ${changedTarget} 在本轮被修改，已自动恢复并记为门禁失败。\n`
      );
      const reason: GateResultAiflowEvent["reason"] =
        configChanged && specChanged
          ? "config_and_spec_tampered"
          : configChanged
            ? "config_tampered"
            : "spec_tampered";
      appendEvent(runDir, {
        ts: new Date().toISOString(),
        type: "gate_result",
        stage: stageConfig.id,
        story: story.id,
        checks: "fail",
        ai_review: "skipped",
        blockers: 0,
        reason,
      });
      const suspended = updatedPrd.stories.find((s) => s.id === story.id)!.suspended === true;
      if (suspended) {
        emitStorySuspended(runDir, story.id,"fix_limit");
      }
      const result = suspended ? "suspended" : "fail";
      appendEvent(runDir, { ts: new Date().toISOString(), type: "story_result", story: story.id, result });
      budget.record(agentResult.usage.costUsd); // 记账；本轮因篡改结束，不熔断
      return { storyId: story.id, result, usage: agentResult.usage };
    }
  }

  if (agentResult.ok && budget.record(agentResult.usage.costUsd)) {
    return { storyId: story.id, result: "paused", usage: agentResult.usage };
  }

  if (!agentResult.ok) {
    const updatedPrd = recordStoryFailure(prd, story.id, stageConfig.per_story_fix_limit);
    writePrd(prdPath, updatedPrd);
    appendFileSync(fixListPath, `\n## ${story.id} (agent call failed)\nOpenCode agent invocation did not complete successfully.\n`);
    appendEvent(runDir, { ts: new Date().toISOString(), type: "story_result", story: story.id, result: "fail" });
    budget.record(agentResult.usage.costUsd); // 记账；本轮 agent 失败，不熔断
    return { storyId: story.id, result: "fail", usage: agentResult.usage };
  }

  await deps.git.stageAll(cwd);

  const maxDrift = deps.maxDriftFiles ?? 50;
  const changedFiles = await deps.git.diffCachedFileNames(cwd);
  if (changedFiles.length > maxDrift) {
    await deps.git.checkoutClean(cwd);
    const updatedPrd = recordStoryFailure(prd, story.id, stageConfig.per_story_fix_limit);
    writePrd(prdPath, updatedPrd);
    const fixCount = updatedPrd.stories.find((s) => s.id === story.id)!.fixCount;
    appendFileSync(
      fixListPath,
      `\n## ${story.id} (round ${fixCount})\nChanged files (${changedFiles.length}) exceed max_drift_files (${maxDrift}). Reverted and marked as failure.\n`
    );
    appendEvent(runDir, {
      ts: new Date().toISOString(),
      type: "gate_result",
      stage: stageConfig.id,
      story: story.id,
      checks: "fail",
      ai_review: "skipped",
      blockers: 0,
      reason: "max_drift_exceeded",
    });
    const suspended = updatedPrd.stories.find((s) => s.id === story.id)!.suspended === true;
    if (suspended) {
      emitStorySuspended(runDir, story.id,"fix_limit");
    }
    const result = suspended ? "suspended" : "fail";
    appendEvent(runDir, { ts: new Date().toISOString(), type: "story_result", story: story.id, result });
    budget.record(agentResult.usage.costUsd);
    return { storyId: story.id, result, usage: agentResult.usage };
  }

  const diff = await deps.git.diffCached(cwd);

  const gateConfig: RalphLoopStageConfig["gate"] =
    stageConfig.gate.checks.length === 0 && (deps.defaultChecks?.length ?? 0) > 0
      ? { ...stageConfig.gate, checks: deps.defaultChecks! }
      : stageConfig.gate;

  const gateOutcome = await deps.runReviewGate(gateConfig, reviewerProfile, cwd, diff, story.acceptance, {
    runChecks: realRunChecks,
    callReviewer: realCallReviewer,
    reviewers: profiles,
    authorProfile: stageConfig.model,
    stage: stageConfig.id,
  });
  const totalUsage = {
    inTok: agentResult.usage.inTok + (gateOutcome.usage?.inTok ?? 0),
    outTok: agentResult.usage.outTok + (gateOutcome.usage?.outTok ?? 0),
    costUsd: agentResult.usage.costUsd + (gateOutcome.usage?.costUsd ?? 0),
  };

  if (gateOutcome.usage && budget.record(gateOutcome.usage.costUsd)) {
    return { storyId: story.id, result: "paused", usage: totalUsage };
  }

  archiveReview(runDir, story.id, gateOutcome);

  if (gateOutcome.matrix) {
    recordReviewMatrix(runDir, story.id, gateOutcome.matrix);
    const verdictEvent: ReviewVerdictAiflowEvent = {
      ts: new Date().toISOString(),
      type: "review_verdict",
      stage: stageConfig.id,
      story: story.id,
      reviewers: gateOutcome.matrix.verdicts,
      arbitrated: gateOutcome.matrix.arbitrated,
      final: gateOutcome.matrix.final,
    };
    appendEvent(runDir, verdictEvent);
    if (gateOutcome.matrix.arbitrated) {
      const arbitratedEvent: ReviewArbitratedAiflowEvent = {
        ts: new Date().toISOString(),
        type: "review_arbitrated",
        stage: stageConfig.id,
        story: story.id,
        arbitrator: gateOutcome.matrix.arbitrator ?? reviewerProfile.model,
        verdict: gateOutcome.matrix.final,
      };
      appendEvent(runDir, arbitratedEvent);
    }
  }

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
    return { storyId: story.id, result: "pass", usage: totalUsage };
  }

  const updatedPrd = recordStoryFailure(prd, story.id, stageConfig.per_story_fix_limit);
  writePrd(prdPath, updatedPrd);
  const failureNote =
    gateOutcome.checks === "fail"
      ? `## ${story.id} (round ${updatedPrd.stories.find((s) => s.id === story.id)!.fixCount})\nDeterministic checks failed:\n${gateOutcome.checkOutput ?? ""}\n`
      : `## ${story.id} (round ${updatedPrd.stories.find((s) => s.id === story.id)!.fixCount})\nAI review flagged ${gateOutcome.blockers} blocking issue(s).\n`;
  appendFileSync(fixListPath, `\n${failureNote}`);

  const suspended = updatedPrd.stories.find((s) => s.id === story.id)!.suspended === true;
  if (suspended) {
    emitStorySuspended(runDir, story.id,"fix_limit");
  }
  const result = suspended ? "suspended" : "fail";
  appendEvent(runDir, { ts: new Date().toISOString(), type: "story_result", story: story.id, result });
  return { storyId: story.id, result, usage: totalUsage };
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

function suspendStoryById(
  prdPath: string,
  prd: Prd,
  storyId: string,
  reason: StorySuspendedAiflowEvent["reason"],
  runDir: string,
  stageId: string
): Prd {
  const story = prd.stories.find((s) => s.id === storyId);
  if (!story || story.suspended) return prd;
  const updated = {
    ...prd,
    stories: prd.stories.map((s) => (s.id === storyId ? { ...s, suspended: true } : s)),
  };
  writePrd(prdPath, updated);
  emitStorySuspended(runDir, storyId, reason);
  return updated;
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
  signal?: AbortSignal,
  budget: BudgetTracker = noopBudgetTracker
): Promise<RalphLoopSummary> {
  const usage = { inTok: 0, outTok: 0, costUsd: 0 };
  let iterations = 0;
  let stallCount = 0;
  const prdPath = join(cwd, "prd.json");

  while (true) {
    assertTamperGuard(cwd, runDir);
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

    const onceResult = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, specExcerpt, deps, budget);
    usage.inTok += onceResult.usage.inTok;
    usage.outTok += onceResult.usage.outTok;
    usage.costUsd += onceResult.usage.costUsd;

    if (onceResult.result === "paused") {
      const outcome: RalphLoopSummary = { result: "paused", reason: "budget_exceeded", iterations, usage };
      emitLoopResult(runDir, stageConfig.id, prd, outcome);
      return outcome;
    }

    let prdAfter = readPrd(prdPath);
    let suspendedAfter = countStories(prdAfter).suspended;

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
      prdAfter = suspendStoryById(prdPath, prdAfter, onceResult.storyId, "max_iterations", runDir, stageConfig.id);
      suspendedAfter = countStories(prdAfter).suspended;
      const outcome: RalphLoopSummary = { result: suspendedAfter > 0 ? "suspended" : "pass", reason: "max_iterations", iterations, usage };
      emitLoopResult(runDir, stageConfig.id, prdAfter, outcome);
      return outcome;
    }

    const progressed = onceResult.result === "pass" || suspendedAfter > suspendedBefore;
    stallCount = progressed ? 0 : stallCount + 1;

    if (stallCount >= stageConfig.stall_limit) {
      prdAfter = suspendStoryById(prdPath, prdAfter, onceResult.storyId, "stall", runDir, stageConfig.id);
      suspendedAfter = countStories(prdAfter).suspended;
      const outcome: RalphLoopSummary = { result: suspendedAfter > 0 ? "suspended" : "pass", reason: "stall", iterations, usage };
      emitLoopResult(runDir, stageConfig.id, prdAfter, outcome);
      return outcome;
    }
  }
}
