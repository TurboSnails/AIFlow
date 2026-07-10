import { test, expect, mock } from "bun:test";
import { runDebate } from "../../src/debate/orchestrator";
import type { ModelProfile } from "../../src/config/schema";

const profiles: Record<string, ModelProfile> = {
  a: { channel: "http", provider: "p", model: "m", base_url: "http://x", api_key_env: "K" },
  b: { channel: "http", provider: "p", model: "m", base_url: "http://x", api_key_env: "K" },
};

function makeDeps(overrides: Partial<Parameters<typeof runDebate>[3]> = {}) {
  return {
    callLlmFanOut: mock(async (ps: ModelProfile[]) =>
      ps.map((p) => ({
        profile: p,
        ok: true,
        result: { text: "proposal", usage: { inTok: 1, outTok: 1, costUsd: 0 } },
      }))
    ),
    callLlm: mock(async () => ({
      text: JSON.stringify({
        resolved: [{ id: "D0", topic: "t", resolution: "r" }],
        remaining_disputes: [],
      }),
      usage: { inTok: 1, outTok: 1, costUsd: 0 },
    })),
    ...overrides,
  };
}

test("debate converges in two rounds", async () => {
  const deps = makeDeps();
  const result = await runDebate(
    {
      id: "b",
      type: "brainstorm",
      models: ["a", "b"],
      mode: "debate",
      debate_rounds: 2,
      synthesizer: "a",
      output: "report.md",
    },
    "req",
    profiles,
    deps
  );

  expect(result.result).toBe("pass");
  expect(result.openQuestions).toHaveLength(0);
  expect(result.decisions).toHaveLength(1);
  expect(result.decisions[0]).toMatchObject({ id: "D0", topic: "t", resolution: "r" });
  expect(result.rounds).toBeGreaterThanOrEqual(1);
  expect(result.report).toBeTruthy();
});

test("debate stops early when disputes diverge", async () => {
  const deps = makeDeps({
    callLlm: mock(async () => ({
      text: JSON.stringify({
        resolved: [],
        remaining_disputes: [{ id: "Q1", topic: "t", positions: { a: "x", b: "y" } }],
      }),
      usage: { inTok: 1, outTok: 1, costUsd: 0 },
    })),
  });

  const result = await runDebate(
    {
      id: "b",
      type: "brainstorm",
      models: ["a", "b"],
      mode: "debate",
      debate_rounds: 3,
      synthesizer: "a",
      output: "report.md",
    },
    "req",
    profiles,
    deps
  );

  expect(result.result).toBe("pass");
  expect(result.openQuestions).toHaveLength(1);
  expect(result.openQuestions[0]).toMatchObject({ id: "Q1", topic: "t", positions: { a: "x", b: "y" } });
  expect(result.decisions).toHaveLength(0);
  expect(result.rounds).toBe(2); // round 1 + stalled round 2
});

test("invalid moderator output fails the stage instead of reporting convergence", async () => {
  const deps = makeDeps({
    callLlm: mock(async () => ({
      text: "not valid json",
      usage: { inTok: 1, outTok: 1, costUsd: 0 },
    })),
  });

  const result = await runDebate(
    {
      id: "b",
      type: "brainstorm",
      models: ["a", "b"],
      mode: "debate",
      debate_rounds: 2,
      synthesizer: "a",
      output: "report.md",
    },
    "req",
    profiles,
    deps
  );

  expect(result.result).toBe("fail");
  expect(result.report).toContain("not valid json");
});

test("round 2 prompt excludes a model's own prior proposal", async () => {
  const round1Texts: Record<string, string> = { a: "ROUND1_TEXT_FROM_A", b: "ROUND1_TEXT_FROM_B" };
  const round2Prompts: Record<string, string> = {};

  const deps = makeDeps({
    callLlmFanOut: mock(async (ps: ModelProfile[], promptFn: (p: ModelProfile) => string) => {
      const byName = ps.map((p) => {
        const name = p === profiles.a ? "a" : "b";
        return { name, prompt: promptFn(p) };
      });
      // If this is round 2, the promptFn will be renderResponsePrompt.
      for (const { name, prompt } of byName) {
        if (prompt.includes("Other proposals from this round")) {
          round2Prompts[name] = prompt;
        }
      }
      return ps.map((p) => {
        const name = p === profiles.a ? "a" : "b";
        return {
          profile: p,
          ok: true,
          result: { text: round1Texts[name], usage: { inTok: 1, outTok: 1, costUsd: 0 } },
        };
      });
    }),
    callLlm: mock(async () => ({
      text: JSON.stringify({
        resolved: [],
        remaining_disputes: [{ id: "Q1", topic: "t", positions: { a: "x", b: "y" } }],
      }),
      usage: { inTok: 1, outTok: 1, costUsd: 0 },
    })),
  });

  await runDebate(
    {
      id: "b",
      type: "brainstorm",
      models: ["a", "b"],
      mode: "debate",
      debate_rounds: 2,
      synthesizer: "a",
      output: "report.md",
    },
    "req",
    profiles,
    deps
  );

  expect(round2Prompts.a).toBeDefined();
  expect(round2Prompts.b).toBeDefined();
  expect(round2Prompts.a).not.toContain("ROUND1_TEXT_FROM_A");
  expect(round2Prompts.a).toContain("ROUND1_TEXT_FROM_B");
  expect(round2Prompts.b).not.toContain("ROUND1_TEXT_FROM_B");
  expect(round2Prompts.b).toContain("ROUND1_TEXT_FROM_A");
});
