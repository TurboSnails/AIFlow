import { runChecks as realRunChecks, type CheckResult } from "./check-runner";
import { callReviewer as realCallReviewer, type ReviewerCallResult } from "../llm/client";
import { ReviewOutputSchema, type ReviewOutput, type ArbitrationOutput } from "./review-schema";
import type { ReviewGateConfig, ModelProfile } from "../config/schema";
import { runReviewMatrix as realRunReviewMatrix, type ReviewMatrixResult, type ReviewMatrixDeps } from "../review/matrix";
import { runArbitrator as realRunArbitrator } from "../review/arbitrator";

export const MAX_DIFF_CHARS = 8000;

export interface ReviewGateOutcome {
  checks: "pass" | "fail";
  aiReview: "pass" | "fail" | "skipped";
  blockers: number;
  checkOutput?: string;
  reviewOutput?: ReviewOutput;
  usage?: { inTok: number; outTok: number; costUsd: number };
}

export interface ReviewGateDeps {
  runChecks: (commands: string[], cwd: string) => Promise<CheckResult>;
  callReviewer: (profile: ModelProfile, prompt: string) => Promise<ReviewerCallResult>;
  runReviewMatrix?: (
    config: ReviewGateConfig["ai_review"],
    reviewers: Record<string, ModelProfile>,
    authorProfile: string,
    cwd: string,
    diff: string,
    acceptance: string[],
    deps: ReviewMatrixDeps
  ) => Promise<ReviewMatrixResult>;
  runArbitrator?: (profile: ModelProfile, diff: string, issueSets: ReviewOutput[]) => Promise<ArbitrationOutput>;
}

const defaultDeps: ReviewGateDeps = {
  runChecks: realRunChecks,
  callReviewer: realCallReviewer,
  runReviewMatrix: realRunReviewMatrix,
  runArbitrator: realRunArbitrator,
};

export function buildReviewPrompt(diff: string, acceptance: string[]): string {
  const truncatedDiff = diff.slice(-MAX_DIFF_CHARS);
  return [
    "Review the following git diff against the story's acceptance criteria.",
    "Respond with ONLY a JSON object matching this shape:",
    '{"summary": string, "issues": [{"severity": "blocker"|"major"|"minor"|"nit", "file": string, "line": number, "title": string, "detail": string, "suggestion": string}]}',
    "",
    "Acceptance criteria:",
    ...acceptance.map((a) => `- ${a}`),
    "",
    "Diff:",
    truncatedDiff,
  ].join("\n");
}

function countBlockers(review: ReviewOutput, failOn: string[]): number {
  return review.issues.filter((issue) => failOn.includes(issue.severity)).length;
}

function exceedsThreshold(review: ReviewOutput, threshold: Record<string, number> | undefined): boolean {
  if (!threshold) return false;
  for (const [severity, limit] of Object.entries(threshold)) {
    const count = review.issues.filter((i) => i.severity === severity).length;
    if (count >= limit) return true;
  }
  return false;
}

export async function runReviewGate(
  config: ReviewGateConfig,
  reviewerProfile: ModelProfile,
  cwd: string,
  diff: string,
  storyAcceptance: string[],
  deps: ReviewGateDeps = defaultDeps,
  reviewers?: Record<string, ModelProfile>
): Promise<ReviewGateOutcome> {
  const checkResult = await deps.runChecks(config.checks, cwd);
  if (!checkResult.pass) {
    return { checks: "fail", aiReview: "skipped", blockers: 0, checkOutput: checkResult.output };
  }

  if (!config.ai_review.enabled) {
    return { checks: "pass", aiReview: "skipped", blockers: 0 };
  }

  const prompt = buildReviewPrompt(diff, storyAcceptance);
  const reviewersList = config.ai_review.reviewers;
  if (reviewersList && reviewersList.length > 1 && reviewers) {
    const runMatrix = deps.runReviewMatrix ?? realRunReviewMatrix;
    const matrix = await runMatrix(config.ai_review, reviewers, reviewerProfile.model, cwd, diff, storyAcceptance, deps);
    if (matrix.aiReview === "needs_arbitration") {
      const runArb = deps.runArbitrator ?? realRunArbitrator;
      const arbitration = await runArb(reviewerProfile, diff, matrix.issueSets);
      const aiReview = arbitration.verdict;
      const blockers = countBlockers(arbitration, config.ai_review.fail_on);
      return { checks: "pass", aiReview, blockers, reviewOutput: arbitration, usage: matrix.usage };
    }
    const blockers = matrix.aiReview === "fail" ? countBlockers({ summary: "", issues: matrix.issues }, config.ai_review.fail_on) : 0;
    return { checks: "pass", aiReview: matrix.aiReview, blockers, usage: matrix.usage };
  }
  let lastError: unknown;
  const usage = { inTok: 0, outTok: 0, costUsd: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data: raw, usage: callUsage } = await deps.callReviewer(
        reviewerProfile,
        attempt === 0 ? prompt : `${prompt}\n\nYour previous response failed to parse as the required JSON shape: ${String(lastError)}`
      );
      usage.inTok += callUsage.inTok;
      usage.outTok += callUsage.outTok;
      usage.costUsd += callUsage.costUsd;
      const parsed = ReviewOutputSchema.safeParse(raw);
      if (parsed.success) {
        const blockers = countBlockers(parsed.data, config.ai_review.fail_on);
        const overThreshold = exceedsThreshold(parsed.data, config.ai_review.fail_threshold);
        const aiReview = blockers > 0 || overThreshold ? "fail" : "pass";
        return { checks: "pass", aiReview, blockers, reviewOutput: parsed.data, usage };
      }
      lastError = parsed.error;
    } catch (err) {
      lastError = err;
    }
  }

  return {
    checks: "pass",
    aiReview: config.ai_review.strict ? "fail" : "pass",
    blockers: config.ai_review.strict ? 1 : 0,
    usage,
  };
}
