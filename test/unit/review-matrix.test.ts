import { runReviewMatrix } from "../../src/review/matrix";
import type { ModelProfile } from "../../src/config/schema";

const reviewer: ModelProfile = {
  channel: "http",
  provider: "p",
  model: "m",
  base_url: "http://x",
  api_key_env: "K",
};

const reviewer2: ModelProfile = {
  channel: "http",
  provider: "p2",
  model: "m2",
  base_url: "http://x2",
  api_key_env: "K2",
};

function makeDeps(
  verdicts: Record<string, { issues: Record<string, unknown>[]; summary?: string }>
) {
  return {
    callReviewer: async (profile: ModelProfile) => {
      const v = verdicts[profile.model] ?? { summary: "s", issues: [] };
      return {
        data: { summary: v.summary ?? "s", issues: v.issues },
        usage: { inTok: 1, outTok: 1, costUsd: 0.001 },
      };
    },
  };
}

test("excludes author from reviewers", async () => {
  const deps = {
    callReviewer: async () => ({
      data: { summary: "s", issues: [] },
      usage: { inTok: 1, outTok: 1, costUsd: 0 },
    }),
  };
  const result = await runReviewMatrix(
    { enabled: true, reviewers: ["rev"], use_agent: false, fail_on: ["blocker"], strict: false },
    { rev: reviewer },
    "rev",
    "/tmp",
    "diff",
    ["acc"],
    deps
  );
  expect(result.aiReview).toBe("skipped");
});

test("single non-author reviewer with no issues passes", async () => {
  const deps = makeDeps({ m: { issues: [] } });
  const result = await runReviewMatrix(
    { enabled: true, reviewers: ["rev"], use_agent: false, fail_on: ["blocker"], strict: false },
    { rev: reviewer },
    "other",
    "/tmp",
    "diff",
    ["acc"],
    deps
  );
  expect(result.aiReview).toBe("pass");
  expect(result.verdicts).toEqual({ rev: "pass" });
  expect(result.issues).toEqual([]);
  expect(result.usage).toEqual({ inTok: 1, outTok: 1, costUsd: 0.001 });
});

test("single non-author reviewer with issues fails", async () => {
  const issue = { severity: "blocker", file: "f.ts", line: 1, title: "t", detail: "d", suggestion: "s" };
  const deps = makeDeps({ m: { issues: [issue] } });
  const result = await runReviewMatrix(
    { enabled: true, reviewers: ["rev"], use_agent: false, fail_on: ["blocker"], strict: false },
    { rev: reviewer },
    "other",
    "/tmp",
    "diff",
    ["acc"],
    deps
  );
  expect(result.aiReview).toBe("fail");
  expect(result.verdicts).toEqual({ rev: "fail" });
  expect(result.issues).toEqual([issue]);
});

test("multiple reviewers run in parallel and return needs_arbitration on split verdict", async () => {
  const issue = { severity: "blocker", file: "f.ts", line: 1, title: "t", detail: "d", suggestion: "s" };
  const deps = makeDeps({ m: { issues: [] }, m2: { issues: [issue] } });
  const result = await runReviewMatrix(
    { enabled: true, reviewers: ["a", "b"], use_agent: false, fail_on: ["blocker"], strict: false },
    { a: reviewer, b: reviewer2 },
    "other",
    "/tmp",
    "diff",
    ["acc"],
    deps
  );
  expect(result.aiReview).toBe("needs_arbitration");
  expect(result.verdicts).toEqual({ a: "pass", b: "fail" });
  expect(result.issues).toEqual([issue]);
});

test("all reviewers failing returns fail with merged issues", async () => {
  const issueA = { severity: "blocker", file: "a.ts", line: 1, title: "ta", detail: "da", suggestion: "sa" };
  const issueB = { severity: "major", file: "b.ts", line: 2, title: "tb", detail: "db", suggestion: "sb" };
  const deps = makeDeps({ m: { issues: [issueA] }, m2: { issues: [issueB] } });
  const result = await runReviewMatrix(
    { enabled: true, reviewers: ["a", "b"], use_agent: false, fail_on: ["blocker"], strict: false },
    { a: reviewer, b: reviewer2 },
    "other",
    "/tmp",
    "diff",
    ["acc"],
    deps
  );
  expect(result.aiReview).toBe("fail");
  expect(result.verdicts).toEqual({ a: "fail", b: "fail" });
  expect(result.issues).toEqual([issueA, issueB]);
});

test("all reviewers passing returns pass", async () => {
  const deps = makeDeps({ m: { issues: [] }, m2: { issues: [] } });
  const result = await runReviewMatrix(
    { enabled: true, reviewers: ["a", "b"], use_agent: false, fail_on: ["blocker"], strict: false },
    { a: reviewer, b: reviewer2 },
    "other",
    "/tmp",
    "diff",
    ["acc"],
    deps
  );
  expect(result.aiReview).toBe("pass");
  expect(result.verdicts).toEqual({ a: "pass", b: "pass" });
});

test("strict mode with no remaining reviewers after author exclusion returns fail", async () => {
  const deps = {
    callReviewer: async () => ({
      data: { summary: "s", issues: [] },
      usage: { inTok: 1, outTok: 1, costUsd: 0 },
    }),
  };
  const result = await runReviewMatrix(
    { enabled: true, reviewers: ["rev"], use_agent: false, fail_on: ["blocker"], strict: true },
    { rev: reviewer },
    "rev",
    "/tmp",
    "diff",
    ["acc"],
    deps
  );
  expect(result.aiReview).toBe("fail");
  expect(result.verdicts).toEqual({});
  expect(result.issues).toEqual([]);
});

test("disabled AI review returns skipped", async () => {
  const deps = {
    callReviewer: async () => ({
      data: { summary: "s", issues: [] },
      usage: { inTok: 1, outTok: 1, costUsd: 0 },
    }),
  };
  const result = await runReviewMatrix(
    { enabled: false, reviewers: ["rev"], use_agent: false, fail_on: ["blocker"], strict: false },
    { rev: reviewer },
    "other",
    "/tmp",
    "diff",
    ["acc"],
    deps
  );
  expect(result.aiReview).toBe("skipped");
  expect(result.verdicts).toEqual({});
  expect(result.usage).toEqual({ inTok: 0, outTok: 0, costUsd: 0 });
});

test("throws reviewer call counts as fail and continues", async () => {
  const deps = {
    callReviewer: async (profile: ModelProfile) => {
      if (profile.model === "m") throw new Error("boom");
      return { data: { summary: "s", issues: [] }, usage: { inTok: 1, outTok: 1, costUsd: 0.001 } };
    },
  };
  const result = await runReviewMatrix(
    { enabled: true, reviewers: ["a", "b"], use_agent: false, fail_on: ["blocker"], strict: false },
    { a: reviewer, b: reviewer2 },
    "other",
    "/tmp",
    "diff",
    ["acc"],
    deps
  );
  expect(result.aiReview).toBe("needs_arbitration");
  expect(result.verdicts).toEqual({ a: "fail", b: "pass" });
  expect(result.issues).toEqual([]);
});

test("aggregates usage across multiple reviewers", async () => {
  let callCount = 0;
  const deps = {
    callReviewer: async () => {
      callCount++;
      return {
        data: { summary: "s", issues: [] },
        usage: { inTok: 10, outTok: 5, costUsd: 0.01 },
      };
    },
  };
  const result = await runReviewMatrix(
    { enabled: true, reviewers: ["a", "b"], use_agent: false, fail_on: ["blocker"], strict: false },
    { a: reviewer, b: reviewer2 },
    "other",
    "/tmp",
    "diff",
    ["acc"],
    deps
  );
  expect(callCount).toBe(2);
  expect(result.usage).toEqual({ inTok: 20, outTok: 10, costUsd: 0.02 });
});
