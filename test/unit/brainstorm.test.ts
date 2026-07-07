import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBrainstormStage } from "../../src/runners/brainstorm";
import { createBudgetTracker } from "../../src/gate/budget";
import type { BrainstormStageConfig, ModelProfile } from "../../src/config/schema";
import type { StageState } from "../../src/engine/state";

const profiles: Record<string, ModelProfile> = {
  a: { channel: "http", provider: "x", model: "a" },
  b: { channel: "http", provider: "x", model: "b" },
  synth: { channel: "http", provider: "x", model: "synth" },
};

const baseStage: BrainstormStageConfig = {
  id: "ideate",
  type: "brainstorm",
  models: ["a", "b"],
  mode: "independent",
  debate_rounds: 2,
  synthesizer: "synth",
  output: "brainstorm-report.md",
};

const pendingStageState: StageState = { id: "ideate", status: "pending" };

function setupRunDir(): string {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-brainstorm-test-"));
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "requirement.md"), "Add offline cache to the app.");
  return runDir;
}

test("independent mode: both models succeed, synthesis is written, result is pass", async () => {
  const runDir = setupRunDir();
  try {
    const callLlmFanOut = mock(async () => [
      { profile: profiles.a, ok: true, result: { text: "proposal A", usage: { inTok: 10, outTok: 5, costUsd: 0 } } },
      { profile: profiles.b, ok: true, result: { text: "proposal B", usage: { inTok: 10, outTok: 5, costUsd: 0 } } },
    ]);
    const callLlm = mock(async () => ({ text: "synthesis text", usage: { inTok: 20, outTok: 10, costUsd: 0 } }));

    const outcome = await runBrainstormStage(baseStage, pendingStageState, profiles, "/tmp/x", runDir, () => new Date(), undefined, {
      callLlm,
      callLlmFanOut,
    });

    expect(outcome.result).toBe("pass");
    expect(outcome.usage).toEqual({ inTok: 40, outTok: 20, costUsd: 0 });
    const reportPath = join(runDir, "artifacts", "brainstorm-report.md");
    expect(existsSync(reportPath)).toBe(true);
    const content = readFileSync(reportPath, "utf-8");
    expect(content).toContain("synthesis text");
    expect(content).toContain("proposal A");
    expect(content).toContain("proposal B");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("independent mode: fewer than 2 successes fails without calling the synthesizer", async () => {
  const runDir = setupRunDir();
  try {
    const callLlmFanOut = mock(async () => [
      { profile: profiles.a, ok: true, result: { text: "proposal A", usage: { inTok: 10, outTok: 5, costUsd: 0 } } },
      { profile: profiles.b, ok: false, error: "network error" },
    ]);
    const callLlm = mock(async () => ({ text: "unused", usage: { inTok: 0, outTok: 0, costUsd: 0 } }));

    const outcome = await runBrainstormStage(baseStage, pendingStageState, profiles, "/tmp/x", runDir, () => new Date(), undefined, {
      callLlm,
      callLlmFanOut,
    });

    expect(outcome.result).toBe("fail");
    expect(callLlm).not.toHaveBeenCalled();
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("debate mode: runs debate_rounds total fan-out calls before synthesizing", async () => {
  const runDir = setupRunDir();
  const debateStage: BrainstormStageConfig = { ...baseStage, mode: "debate", debate_rounds: 2 };
  try {
    const callLlmFanOut = mock(async () => [
      { profile: profiles.a, ok: true, result: { text: "round text A", usage: { inTok: 1, outTok: 1, costUsd: 0 } } },
      { profile: profiles.b, ok: true, result: { text: "round text B", usage: { inTok: 1, outTok: 1, costUsd: 0 } } },
    ]);
    const callLlm = mock(async () => ({ text: "final synthesis", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));

    const outcome = await runBrainstormStage(debateStage, pendingStageState, profiles, "/tmp/x", runDir, () => new Date(), undefined, {
      callLlm,
      callLlmFanOut,
    });

    expect(outcome.result).toBe("pass");
    expect(callLlmFanOut).toHaveBeenCalledTimes(2); // round 1 (idea) + round 2 (debate); debate_rounds=2 means one extra round
    expect(callLlm).toHaveBeenCalledTimes(1); // synthesizer only
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("debate mode: round 2 prompt for a model excludes its own round-1 text but includes peers'", async () => {
  const runDir = setupRunDir();
  const debateStage: BrainstormStageConfig = { ...baseStage, mode: "debate", debate_rounds: 2 };
  try {
    const round1Result = [
      { profile: profiles.a, ok: true, result: { text: "ROUND1_TEXT_FROM_A", usage: { inTok: 1, outTok: 1, costUsd: 0 } } },
      { profile: profiles.b, ok: true, result: { text: "ROUND1_TEXT_FROM_B", usage: { inTok: 1, outTok: 1, costUsd: 0 } } },
    ];
    const round2Prompts: Record<string, string> = {};

    let callCount = 0;
    // Unlike the mock above, this mock actually invokes promptFn(profile) for each profile,
    // just like the real callLlmFanOut does, so the self-exclusion filter inside
    // runBrainstormStage's debate-round callback actually executes and can be observed.
    const callLlmFanOut = mock(async (fanProfiles: ModelProfile[], promptFn: (profile: ModelProfile) => string) => {
      callCount++;
      if (callCount === 1) {
        for (const p of fanProfiles) promptFn(p);
        return round1Result;
      }
      for (const p of fanProfiles) {
        const prompt = promptFn(p);
        const key = p === profiles.a ? "a" : "b";
        round2Prompts[key] = prompt;
      }
      return [
        { profile: profiles.a, ok: true, result: { text: "ROUND2_TEXT_FROM_A", usage: { inTok: 1, outTok: 1, costUsd: 0 } } },
        { profile: profiles.b, ok: true, result: { text: "ROUND2_TEXT_FROM_B", usage: { inTok: 1, outTok: 1, costUsd: 0 } } },
      ];
    });
    const callLlm = mock(async () => ({ text: "final synthesis", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));

    const outcome = await runBrainstormStage(debateStage, pendingStageState, profiles, "/tmp/x", runDir, () => new Date(), undefined, {
      callLlm,
      callLlmFanOut,
    });

    expect(outcome.result).toBe("pass");
    expect(round2Prompts.a).toBeDefined();
    expect(round2Prompts.b).toBeDefined();
    // Model A's own round-1 output must not appear in A's round-2 prompt.
    expect(round2Prompts.a).not.toContain("ROUND1_TEXT_FROM_A");
    // Model B's round-1 output (the peer) must appear in A's round-2 prompt.
    expect(round2Prompts.a).toContain("ROUND1_TEXT_FROM_B");
    // And symmetrically for B.
    expect(round2Prompts.b).not.toContain("ROUND1_TEXT_FROM_B");
    expect(round2Prompts.b).toContain("ROUND1_TEXT_FROM_A");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("stops after the first fan-out round if it alone exceeds the budget, without starting a debate round", async () => {
  const runDir = setupRunDir();
  try {
    const debateStage: BrainstormStageConfig = { ...baseStage, mode: "debate", debate_rounds: 2 };
    const callLlmFanOut = mock(async (profs: unknown[]) =>
      profs.map((p) => ({ profile: p, ok: true, result: { text: "idea", usage: { inTok: 1, outTok: 1, costUsd: 6 } } }))
    );
    const callLlm = mock(async () => ({ text: "synthesis", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));
    const budget = createBudgetTracker(5, 0);

    const outcome = await runBrainstormStage(
      debateStage,
      { id: "ideate", status: "running" },
      profiles,
      "/tmp/does-not-matter",
      runDir,
      () => new Date(),
      undefined,
      { callLlm, callLlmFanOut },
      budget
    );

    expect(outcome.result).toBe("paused");
    expect(outcome.reason).toBe("budget_exceeded");
    expect(outcome.usage).toEqual({ inTok: 2, outTok: 2, costUsd: 12 });
    expect(callLlm).not.toHaveBeenCalled(); // synthesizer call never happens
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
