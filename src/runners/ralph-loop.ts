import { join } from "node:path";
import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { readPrd, writePrd, selectNextStory, markStoryPassed, recordStoryFailure, type Story } from "../prd";
import { runAgentTask as realRunAgentTask, type AgentTask, type AgentResult } from "../adapters/opencode";
import { runReviewGate as realRunReviewGate, type ReviewGateOutcome } from "../gate/review-gate";
import { revParseHead, stageAll, diffCached, commit } from "../git";
import { appendEvent } from "../events/events";
import type { RalphLoopStageConfig, ModelProfile } from "../config/schema";

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
  git: { revParseHead, stageAll, diffCached, commit },
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
