import type { ModelProfile, ReviewGateConfig } from "../config/schema";
import { ReviewOutputSchema, type ReviewIssue } from "../gate/review-schema";
import { buildReviewPrompt } from "../gate/review-gate";

export interface ReviewMatrixDeps {
  callReviewer: (
    profile: ModelProfile,
    prompt: string
  ) => Promise<{
    data: unknown;
    usage: { inTok: number; outTok: number; costUsd: number };
  }>;
}

export interface ReviewMatrixResult {
  aiReview: "pass" | "fail" | "skipped" | "needs_arbitration";
  issues: ReviewIssue[];
  verdicts: Record<string, "pass" | "fail" | "skipped">;
  usage: { inTok: number; outTok: number; costUsd: number };
}

export async function runReviewMatrix(
  config: ReviewGateConfig["ai_review"],
  reviewers: Record<string, ModelProfile>,
  authorProfile: string,
  _cwd: string,
  diff: string,
  acceptance: string[],
  deps: ReviewMatrixDeps
): Promise<ReviewMatrixResult> {
  const emptyResult = (
    aiReview: ReviewMatrixResult["aiReview"]
  ): ReviewMatrixResult => ({
    aiReview,
    issues: [],
    verdicts: {},
    usage: { inTok: 0, outTok: 0, costUsd: 0 },
  });

  if (!config.enabled) {
    return emptyResult("skipped");
  }

  const remainingNames = (config.reviewers ?? []).filter(
    (name) => name !== authorProfile
  );
  if (remainingNames.length === 0) {
    return config.strict ? emptyResult("fail") : emptyResult("skipped");
  }

  const prompt = buildReviewPrompt(diff, acceptance);

  const results = await Promise.all(
    remainingNames.map(async (name) => {
      try {
        const profile = reviewers[name];
        if (!profile) {
          return {
            name,
            verdict: "skipped" as const,
            issues: [] as ReviewIssue[],
            usage: { inTok: 0, outTok: 0, costUsd: 0 },
          };
        }
        const { data, usage: callUsage } = await deps.callReviewer(profile, prompt);
        const parsed = ReviewOutputSchema.safeParse(data);
        if (!parsed.success) {
          return {
            name,
            verdict: "fail" as const,
            issues: [] as ReviewIssue[],
            usage: callUsage,
          };
        }
        const hasIssues = parsed.data.issues.length > 0;
        return {
          name,
          verdict: hasIssues ? ("fail" as const) : ("pass" as const),
          issues: parsed.data.issues,
          usage: callUsage,
        };
      } catch {
        return {
          name,
          verdict: "fail" as const,
          issues: [] as ReviewIssue[],
          usage: { inTok: 0, outTok: 0, costUsd: 0 },
        };
      }
    })
  );

  const issues: ReviewIssue[] = [];
  const verdicts: Record<string, "pass" | "fail" | "skipped"> = {};
  const usage = { inTok: 0, outTok: 0, costUsd: 0 };

  for (const { name, verdict, issues: reviewerIssues, usage: reviewerUsage } of results) {
    verdicts[name] = verdict;
    issues.push(...reviewerIssues);
    usage.inTok += reviewerUsage.inTok;
    usage.outTok += reviewerUsage.outTok;
    usage.costUsd += reviewerUsage.costUsd;
  }

  const nonSkipped = Object.entries(verdicts).filter(
    ([, verdict]) => verdict !== "skipped"
  );
  if (nonSkipped.length === 0) {
    return { ...emptyResult(config.strict ? "fail" : "skipped"), verdicts };
  }

  const hasPass = nonSkipped.some(([, verdict]) => verdict === "pass");
  const hasFail = nonSkipped.some(([, verdict]) => verdict === "fail");

  let aiReview: ReviewMatrixResult["aiReview"];
  if (hasPass && hasFail) {
    aiReview = "needs_arbitration";
  } else if (hasFail) {
    aiReview = "fail";
  } else {
    aiReview = "pass";
  }

  return { aiReview, issues, verdicts, usage };
}
