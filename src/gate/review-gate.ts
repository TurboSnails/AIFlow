import { runChecks as realRunChecks, type CheckResult } from "./check-runner";
import { callReviewer as realCallReviewer, callLlm as realCallLlm, type ReviewerCallResult, type LlmCallOptions, type LlmCallResult } from "../llm/client";
import { ReviewOutputSchema, type ReviewOutput, type ArbitrationOutput } from "./review-schema";
import type { ReviewGateConfig, ModelProfile } from "../config/schema";
import { runReviewMatrix as realRunReviewMatrix, type ReviewMatrixResult, type ReviewMatrixDeps } from "../review/matrix";
import { runArbitrator as realRunArbitrator } from "../review/arbitrator";

export const MAX_DIFF_CHARS = 8000;

export interface ReviewGateMatrix {
  verdicts: Record<string, "pass" | "fail" | "skipped">;
  arbitrated: boolean;
  arbitrator?: string;
  final: "pass" | "fail";
}

export interface ReviewGateOutcome {
  checks: "pass" | "fail";
  aiReview: "pass" | "fail" | "skipped";
  blockers: number;
  checkOutput?: string;
  reviewOutput?: ReviewOutput;
  usage?: { inTok: number; outTok: number; costUsd: number };
  matrix?: ReviewGateMatrix;
  issueSets?: ReviewOutput[];
}

export interface ReviewGateDeps {
  runChecks: (commands: string[], cwd: string) => Promise<CheckResult>;
  callReviewer: (
    profile: ModelProfile,
    prompt: string,
    stage?: string,
    fetchFn?: typeof fetch,
    maxRetrySteps?: number,
    maxTokenCost?: number
  ) => Promise<ReviewerCallResult>;
  runReviewMatrix?: (
    config: ReviewGateConfig["ai_review"],
    reviewers: Record<string, ModelProfile>,
    authorProfile: string,
    cwd: string,
    diff: string,
    acceptance: string[],
    deps: ReviewMatrixDeps,
    stage?: string
  ) => Promise<ReviewMatrixResult>;
  runArbitrator?: (
    profile: ModelProfile,
    diff: string,
    issueSets: ReviewOutput[],
    acceptance: string[],
    stage?: string,
    maxRetrySteps?: number,
    maxTokenCost?: number
  ) => Promise<ArbitrationOutput>;
  reviewers?: Record<string, ModelProfile>;
  authorProfile?: string;
  stage?: string;
  maxRetrySteps?: number;
  maxTokenCost?: number;
}

function defaultCallLlm(opts: LlmCallOptions): Promise<LlmCallResult> {
  return realCallLlm(opts);
}

const defaultDeps: ReviewGateDeps = {
  runChecks: realRunChecks,
  callReviewer: realCallReviewer,
  runReviewMatrix: realRunReviewMatrix,
  runArbitrator: (profile, diff, issueSets, acceptance, stage, maxRetrySteps, maxTokenCost) =>
    realRunArbitrator(profile, diff, issueSets, acceptance, {
      callLlm: defaultCallLlm,
      stage,
      maxRetrySteps,
      maxTokenCost,
    }),
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
  deps: ReviewGateDeps = defaultDeps
): Promise<ReviewGateOutcome> {
  const stage = deps.stage ?? "unknown";
  const reviewerName = reviewerProfile.model;
  const checkResult = await deps.runChecks(config.checks, cwd);
  if (!checkResult.pass) {
    return {
      checks: "fail",
      aiReview: "skipped",
      blockers: 0,
      checkOutput: checkResult.output,
      matrix: { verdicts: { [reviewerName]: "skipped" }, arbitrated: false, final: "fail" },
    };
  }

  if (!config.ai_review.enabled) {
    return {
      checks: "pass",
      aiReview: "skipped",
      blockers: 0,
      matrix: { verdicts: { [reviewerName]: "skipped" }, arbitrated: false, final: "pass" },
    };
  }

  const prompt = buildReviewPrompt(diff, storyAcceptance);
  const reviewersList = config.ai_review.reviewers;
  if (reviewersList && reviewersList.length > 1) {
    if (!deps.reviewers) {
      throw new Error("Multi-reviewer AI review requires a reviewers map");
    }
    const runMatrix = deps.runReviewMatrix ?? realRunReviewMatrix;
    const matrix = await runMatrix(
      config.ai_review,
      deps.reviewers,
      deps.authorProfile ?? reviewerProfile.model,
      cwd,
      diff,
      storyAcceptance,
      deps,
      stage
    );
    if (matrix.aiReview === "needs_arbitration") {
      const profiles = deps.reviewers;
      const mainDevProfile = profiles?.mainDev ?? profiles?.[Object.keys(profiles ?? {})[0]] ?? reviewerProfile;
      const runArb =
        deps.runArbitrator ??
        ((profile, d, issues, acceptance, s, maxRetrySteps, maxTokenCost) =>
          realRunArbitrator(profile, d, issues, acceptance, {
            callLlm: defaultCallLlm,
            stage: s,
            maxRetrySteps,
            maxTokenCost,
          }));
      const arbitration = await runArb(
        mainDevProfile,
        diff,
        matrix.issueSets,
        storyAcceptance,
        stage,
        deps.maxRetrySteps,
        deps.maxTokenCost
      );
      const aiReview = arbitration.verdict;
      const blockers = countBlockers(arbitration, config.ai_review.fail_on);
      return {
        checks: "pass",
        aiReview,
        blockers,
        reviewOutput: arbitration,
        usage: matrix.usage,
        matrix: {
          verdicts: matrix.verdicts,
          arbitrated: true,
          arbitrator: reviewerProfile.model,
          final: aiReview,
        },
        issueSets: matrix.issueSets,
      };
    }
    const blockers = matrix.aiReview === "fail" ? countBlockers({ summary: "", issues: matrix.issues }, config.ai_review.fail_on) : 0;
    return {
      checks: "pass",
      aiReview: matrix.aiReview,
      blockers,
      usage: matrix.usage,
      matrix: {
        verdicts: matrix.verdicts,
        arbitrated: false,
        final: matrix.aiReview === "skipped" ? "pass" : matrix.aiReview,
      },
      issueSets: matrix.issueSets,
    };
  }
  let lastError: unknown;
  const usage = { inTok: 0, outTok: 0, costUsd: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data: raw, usage: callUsage } = await deps.callReviewer(
        reviewerProfile,
        attempt === 0 ? prompt : `${prompt}\n\nYour previous response failed to parse as the required JSON shape: ${String(lastError)}`,
        stage,
        undefined,
        deps.maxRetrySteps,
        deps.maxTokenCost
      );
      usage.inTok += callUsage.inTok;
      usage.outTok += callUsage.outTok;
      usage.costUsd += callUsage.costUsd;
      const parsed = ReviewOutputSchema.safeParse(raw);
      if (parsed.success) {
        const blockers = countBlockers(parsed.data, config.ai_review.fail_on);
        const overThreshold = exceedsThreshold(parsed.data, config.ai_review.fail_threshold);
        const aiReview = blockers > 0 || overThreshold ? "fail" : "pass";
        return {
          checks: "pass",
          aiReview,
          blockers,
          reviewOutput: parsed.data,
          usage,
          matrix: {
            verdicts: { [reviewerName]: aiReview },
            arbitrated: false,
            final: aiReview,
          },
        };
      }
      lastError = parsed.error;
    } catch (err) {
      lastError = err;
    }
  }

  const fallbackAiReview = config.ai_review.strict ? "fail" : "pass";
  return {
    checks: "pass",
    aiReview: fallbackAiReview,
    blockers: config.ai_review.strict ? 1 : 0,
    usage,
    matrix: {
      verdicts: { [reviewerName]: "skipped" },
      arbitrated: false,
      final: fallbackAiReview,
    },
  };
}
