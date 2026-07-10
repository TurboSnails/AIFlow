import type { ModelProfile, ReviewGateConfig } from "../config/schema";
import { ReviewOutputSchema, type ReviewIssue, type ReviewOutput } from "../gate/review-schema";
import { buildReviewPrompt } from "../gate/review-gate";

function reviewerVerdict(
  output: ReviewOutput,
  failOn: string[],
  threshold: Record<string, number> | undefined
): "pass" | "fail" {
  const counts = output.issues.reduce((acc, i) => {
    acc[i.severity] = (acc[i.severity] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const blocked = output.issues.filter((i) => failOn.includes(i.severity)).length;
  if (blocked > 0) return "fail";
  if (threshold) {
    for (const [severity, limit] of Object.entries(threshold)) {
      if ((counts[severity] ?? 0) >= limit) return "fail";
    }
  }
  return "pass";
}

export function deduplicateIssues(issues: ReviewIssue[]): ReviewIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.file}:${Math.floor((i.line ?? 0) / 3)}:${i.severity}:${i.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface ReviewMatrixDeps {
  callReviewer: (
    profile: ModelProfile,
    prompt: string,
    stage?: string,
    fetchFn?: typeof fetch,
    maxRetrySteps?: number,
    maxTokenCost?: number
  ) => Promise<{
    data: unknown;
    usage: { inTok: number; outTok: number; costUsd: number };
  }>;
  maxRetrySteps?: number;
  maxTokenCost?: number;
}

export interface ReviewMatrixResult {
  aiReview: "pass" | "fail" | "skipped" | "needs_arbitration";
  issues: ReviewIssue[];
  issueSets: ReviewOutput[];
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
  deps: ReviewMatrixDeps,
  stage = "unknown"
): Promise<ReviewMatrixResult> {
  const emptyResult = (
    aiReview: ReviewMatrixResult["aiReview"]
  ): ReviewMatrixResult => ({
    aiReview,
    issues: [],
    issueSets: [],
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
        const { data, usage: callUsage } = await deps.callReviewer(profile, prompt, stage, undefined, deps.maxRetrySteps, deps.maxTokenCost);
        const parsed = ReviewOutputSchema.safeParse(data);
        if (!parsed.success) {
          return {
            name,
            verdict: "fail" as const,
            issues: [] as ReviewIssue[],
            usage: callUsage,
          };
        }
        const verdict = reviewerVerdict(parsed.data, config.fail_on, config.fail_threshold);
        const issues = deduplicateIssues(parsed.data.issues);
        return {
          name,
          verdict,
          summary: parsed.data.summary,
          issues,
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
  const issueSets: ReviewOutput[] = [];
  const verdicts: Record<string, "pass" | "fail" | "skipped"> = {};
  const usage = { inTok: 0, outTok: 0, costUsd: 0 };

  for (const { name, verdict, summary, issues: reviewerIssues, usage: reviewerUsage } of results) {
    verdicts[name] = verdict;
    if (summary !== undefined) {
      issueSets.push({ summary, issues: reviewerIssues });
    }
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

  return { aiReview, issues, issueSets, verdicts, usage };
}
