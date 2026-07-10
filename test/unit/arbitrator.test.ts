import { test, expect } from "bun:test";
import { runArbitrator } from "../../src/review/arbitrator";
import type { ModelProfile } from "../../src/config/schema";
import type { ReviewOutput } from "../../src/gate/review-schema";

const profile: ModelProfile = {
  channel: "http",
  provider: "p",
  model: "m",
  base_url: "http://x",
  api_key_env: "K",
};

function makeDeps(text: string) {
  return {
    callLlm: async () => ({
      text,
      usage: { inTok: 1, outTok: 1, costUsd: 0 },
    }),
  };
}

const issueSet: ReviewOutput = { summary: "s", issues: [] };

test("returns final verdict fail", async () => {
  const deps = makeDeps(
    JSON.stringify({ summary: "s", verdict: "fail", reason: "r", issues: [] })
  );
  const result = await runArbitrator(profile, "diff", [issueSet], deps);
  expect(result.verdict).toBe("fail");
});

test("returns final verdict pass", async () => {
  const deps = makeDeps(
    JSON.stringify({
      summary: "All concerns addressed",
      verdict: "pass",
      reason: "Issues were cosmetic or already fixed",
      issues: [],
    })
  );
  const result = await runArbitrator(profile, "diff", [issueSet], deps);
  expect(result.verdict).toBe("pass");
});

test("throws when LLM returns invalid JSON", async () => {
  const deps = makeDeps("not-json");
  await expect(runArbitrator(profile, "diff", [issueSet], deps)).rejects.toThrow();
});

test("throws when LLM returns JSON that fails schema validation", async () => {
  const deps = makeDeps(JSON.stringify({ summary: "s", verdict: "maybe" }));
  await expect(runArbitrator(profile, "diff", [issueSet], deps)).rejects.toThrow();
});
