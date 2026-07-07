import { test, expect, mock } from "bun:test";
import { runReviewGate } from "../../src/gate/review-gate";
import type { ReviewGateConfig, ModelProfile } from "../../src/config/schema";

const reviewerProfile: ModelProfile = {
  channel: "http",
  provider: "minimax",
  model: "some-model",
  base_url: "https://example.invalid/v1",
  api_key_env: "TEST_KEY",
};

const baseConfig: ReviewGateConfig = {
  checks: ["npm run lint"],
  ai_review: { enabled: true, model: "reviewer", fail_on: ["blocker"], fail_threshold: { major: 3 }, strict: false },
};

test("checks failing skips AI review entirely", async () => {
  const runChecks = mock(async () => ({ pass: false, failedCommand: "npm run lint", output: "lint error" }));
  const callReviewer = mock(async () => ({ data: { summary: "unused", issues: [] }, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
  const outcome = await runReviewGate(baseConfig, reviewerProfile, "/tmp/x", "diff", ["accept"], {
    runChecks,
    callReviewer,
  });
  expect(outcome.checks).toBe("fail");
  expect(outcome.aiReview).toBe("skipped");
  expect(callReviewer).not.toHaveBeenCalled();
});

test("checks passing and AI review returning no fail_on-severity issues passes the gate", async () => {
  const runChecks = mock(async () => ({ pass: true, output: "" }));
  const callReviewer = mock(async () => ({
    data: {
      summary: "looks fine",
      issues: [{ severity: "minor", file: "a.ts", line: 1, title: "t", detail: "d", suggestion: "s" }],
    },
    usage: { inTok: 10, outTok: 5, costUsd: 0.001 },
  }));
  const outcome = await runReviewGate(baseConfig, reviewerProfile, "/tmp/x", "diff", ["accept"], {
    runChecks,
    callReviewer,
  });
  expect(outcome.checks).toBe("pass");
  expect(outcome.aiReview).toBe("pass");
  expect(outcome.blockers).toBe(0);
  expect(outcome.usage).toEqual({ inTok: 10, outTok: 5, costUsd: 0.001 });
});

test("checks passing but AI review returning a blocker fails the gate", async () => {
  const runChecks = mock(async () => ({ pass: true, output: "" }));
  const callReviewer = mock(async () => ({
    data: {
      summary: "found a problem",
      issues: [{ severity: "blocker", file: "a.ts", line: 1, title: "t", detail: "d", suggestion: "s" }],
    },
    usage: { inTok: 0, outTok: 0, costUsd: 0 },
  }));
  const outcome = await runReviewGate(baseConfig, reviewerProfile, "/tmp/x", "diff", ["accept"], {
    runChecks,
    callReviewer,
  });
  expect(outcome.aiReview).toBe("fail");
  expect(outcome.blockers).toBe(1);
});

test("checks passing and AI review parse failure with strict:false falls back to pass after one retry", async () => {
  const runChecks = mock(async () => ({ pass: true, output: "" }));
  let callCount = 0;
  const callReviewer = mock(async () => {
    callCount++;
    return { data: { not: "valid shape" }, usage: { inTok: callCount, outTok: callCount * 2, costUsd: callCount * 0.001 } };
  });
  const outcome = await runReviewGate(baseConfig, reviewerProfile, "/tmp/x", "diff", ["accept"], {
    runChecks,
    callReviewer,
  });
  expect(callCount).toBe(2);
  expect(outcome.aiReview).toBe("pass");
  expect(outcome.usage).toEqual({ inTok: 3, outTok: 6, costUsd: 0.003 });
});

test("checks passing and AI review parse failure with strict:true fails the gate after one retry", async () => {
  const runChecks = mock(async () => ({ pass: true, output: "" }));
  let callCount = 0;
  const callReviewer = mock(async () => {
    callCount++;
    return { data: { not: "valid shape" }, usage: { inTok: callCount, outTok: callCount * 2, costUsd: callCount * 0.001 } };
  });
  const strictConfig: ReviewGateConfig = { ...baseConfig, ai_review: { ...baseConfig.ai_review, strict: true } };
  const outcome = await runReviewGate(strictConfig, reviewerProfile, "/tmp/x", "diff", ["accept"], {
    runChecks,
    callReviewer,
  });
  expect(callCount).toBe(2);
  expect(outcome.aiReview).toBe("fail");
  expect(outcome.usage).toEqual({ inTok: 3, outTok: 6, costUsd: 0.003 });
});
