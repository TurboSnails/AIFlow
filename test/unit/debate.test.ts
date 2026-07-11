import { test, expect, mock } from "bun:test";
import { runDebate, runDebateInternal } from "../../src/debate/orchestrator";
import type { ModelProfile } from "../../src/config/schema";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const profiles: Record<string, ModelProfile> = {
  a: { channel: "http", provider: "p", model: "m", base_url: "http://x", api_key_env: "K" },
  b: { channel: "http", provider: "p", model: "m", base_url: "http://x", api_key_env: "K" },
};

function makeProposal(name: string, content: string) {
  return JSON.stringify({
    author: name,
    profile_real: profiles[name].model,
    content_md: content,
    stance_changes: [],
    critiques: [],
  });
}

function makeDeps(overrides: Partial<Parameters<typeof runDebate>[3]> = {}) {
  return {
    callLlmFanOut: mock(async (ps: ModelProfile[]) =>
      ps.map((p) => {
        const name = p === profiles.a ? "a" : "b";
        return {
          profile: p,
          ok: true,
          result: {
            text: makeProposal(name, `proposal from ${name}`),
            usage: { inTok: 1, outTok: 1, costUsd: 0 },
          },
        };
      })
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
      on_unresolved: "ask_human",
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

  expect(result.openQuestions).toHaveLength(0);
  expect(result.decisions).toHaveLength(1);
  expect(result.decisions[0]).toMatchObject({ id: "D0", topic: "t", resolution: "r" });
  expect(result.rounds).toBeGreaterThanOrEqual(1);
  expect(result.report).toBeTruthy();
  expect(result.report).toContain("# Debate Report");
  expect(result.report).toContain("## Decisions");
  expect(result.report).toContain("## Open Questions");
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
      on_unresolved: "ask_human",
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

  await expect(
    runDebate(
      {
        id: "b",
        type: "brainstorm",
        on_unresolved: "ask_human",
        models: ["a", "b"],
        mode: "debate",
        debate_rounds: 2,
        synthesizer: "a",
        output: "report.md",
      },
      "req",
      profiles,
      deps
    )
  ).rejects.toThrow("not valid json");
});

test("round 2 prompt excludes a model's own prior proposal", async () => {
  const round1Texts: Record<string, string> = {
    a: makeProposal("a", "ROUND1_TEXT_FROM_A"),
    b: makeProposal("b", "ROUND1_TEXT_FROM_B"),
  };
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

  await runDebateInternal(
    {
      id: "b",
      type: "brainstorm",
      on_unresolved: "ask_human",
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
  expect(round2Prompts.a).toContain("a: x");
  expect(round2Prompts.a).toContain("b: y");
  expect(round2Prompts.b).not.toContain("ROUND1_TEXT_FROM_B");
  expect(round2Prompts.b).toContain("ROUND1_TEXT_FROM_A");
  expect(round2Prompts.b).toContain("a: x");
  expect(round2Prompts.b).toContain("b: y");
});

test("persists round artifacts with stance_changes and critiques", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-debate-"));
  const deps = makeDeps({
    callLlmFanOut: mock(async (ps: ModelProfile[]) =>
      ps.map((p) => {
        const name = p === profiles.a ? "a" : "b";
        return {
          profile: p,
          ok: true,
          result: {
            text: JSON.stringify({
              author: name,
              profile_real: profiles[name].model,
              content_md: `proposal from ${name}`,
              stance_changes: ["changed approach"],
              critiques: [{ target: name === "a" ? "b" : "a", point: "needs more detail", severity: "major" }],
            }),
            usage: { inTok: 1, outTok: 1, costUsd: 0 },
          },
        };
      })
    ),
  });

  try {
    await runDebate(
      {
        id: "b",
        type: "brainstorm",
        on_unresolved: "ask_human",
        models: ["a", "b"],
        mode: "debate",
        debate_rounds: 2,
        synthesizer: "a",
        output: "report.md",
      },
      "req",
      profiles,
      deps,
      runDir
    );

    const roundPath = join(runDir, "artifacts", "debate", "round-1.json");
    expect(existsSync(roundPath)).toBe(true);
    const round1 = JSON.parse(readFileSync(roundPath, "utf-8"));
    expect(round1.proposals).toHaveLength(2);
    expect(round1.proposals[0].stance_changes).toBeDefined();
    expect(round1.proposals[0].critiques).toBeDefined();
    expect(round1.proposals[0].critiques.length).toBeGreaterThan(0);
    expect(round1.proposals[0].critiques[0].point).toBe("needs more detail");
    expect(round1.proposals[0].critiques[0].severity).toBe("major");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("re-prompts models that produce vague critiques", async () => {
  const rePrompted = new Set<string>();
  let moderatorCalls = 0;

  const deps = makeDeps({
    callLlmFanOut: mock(async (ps: ModelProfile[], promptFn: (p: ModelProfile) => string) => {
      return ps.map((p) => {
        const name = p === profiles.a ? "a" : "b";
        const prompt = promptFn(p);
        if (prompt.includes("missing a severity") || prompt.includes("missing a concrete point")) {
          rePrompted.add(name);
          return {
            profile: p,
            ok: true,
            result: {
              text: JSON.stringify({
                author: name,
                profile_real: profiles[name].model,
                content_md: `proposal from ${name}`,
                stance_changes: [],
                critiques: [{ target: name === "a" ? "b" : "a", point: "concrete point", severity: "major" }],
              }),
              usage: { inTok: 1, outTok: 1, costUsd: 0 },
            },
          };
        }
        if (prompt.includes("Other proposals from this round")) {
          // Round 2 response prompt - return vague critiques.
          return {
            profile: p,
            ok: true,
            result: {
              text: JSON.stringify({
                author: name,
                profile_real: profiles[name].model,
                content_md: `proposal from ${name}`,
                stance_changes: [],
                critiques: [{ target: name === "a" ? "b" : "a", point: "vague" }],
              }),
              usage: { inTok: 1, outTok: 1, costUsd: 0 },
            },
          };
        }
        // Round 1 proposal prompt.
        return {
          profile: p,
          ok: true,
          result: {
            text: JSON.stringify({
              author: name,
              profile_real: profiles[name].model,
              content_md: `proposal from ${name}`,
              stance_changes: [],
              critiques: [],
            }),
            usage: { inTok: 1, outTok: 1, costUsd: 0 },
          },
        };
      });
    }),
    callLlm: mock(async () => {
      moderatorCalls++;
      if (moderatorCalls === 1) {
        return {
          text: JSON.stringify({
            resolved: [],
            remaining_disputes: [{ id: "Q1", topic: "t", positions: { a: "x", b: "y" } }],
          }),
          usage: { inTok: 1, outTok: 1, costUsd: 0 },
        };
      }
      return {
        text: JSON.stringify({
          resolved: [{ id: "D0", topic: "t", resolution: "r" }],
          remaining_disputes: [],
        }),
        usage: { inTok: 1, outTok: 1, costUsd: 0 },
      };
    }),
  });

  await runDebate(
    {
      id: "b",
      type: "brainstorm",
      on_unresolved: "ask_human",
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

  // We expect at least one re-prompt attempt because the round-2 critiques start vague.
  expect(rePrompted.size).toBeGreaterThan(0);
});
