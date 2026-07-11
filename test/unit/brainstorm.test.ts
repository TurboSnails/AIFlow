import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBrainstormStage } from "../../src/runners/brainstorm";
import { createBudgetTracker } from "../../src/gate/budget";
import { readSpecBoard } from "../../src/specboard/specboard";
import { readEvents } from "../../src/events/events";
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
  on_unresolved: "ask_human",
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

function makeProposal(name: string, content: string): string {
  return JSON.stringify({
    author: name,
    profile_real: profiles[name].model,
    content_md: content,
    stance_changes: [],
    critiques: [],
  });
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
    expect(content).toContain("## Comparison Matrix");
    expect(content).toContain("## Recommendation");
    expect(content).toContain("| Model | Key Design | Risks | Workload |");
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

test("debate mode: writes report, registers artifact, and records decisions/open questions", async () => {
  const runDir = setupRunDir();
  const debateStage: BrainstormStageConfig = { ...baseStage, mode: "debate", debate_rounds: 2, output: "debate-report.md" };
  try {
    const callLlmFanOut = mock(async () => [
      { profile: profiles.a, ok: true, result: { text: makeProposal("a", "proposal A"), usage: { inTok: 1, outTok: 1, costUsd: 0 } } },
      { profile: profiles.b, ok: true, result: { text: makeProposal("b", "proposal B"), usage: { inTok: 1, outTok: 1, costUsd: 0 } } },
    ]);
    const callLlm = mock(async () => ({
      text: JSON.stringify({
        resolved: [{ id: "D1", topic: "cache strategy", resolution: "use service worker" }],
        remaining_disputes: [{ id: "Q1", topic: "sync frequency", positions: { a: "hourly", b: "daily" } }],
      }),
      usage: { inTok: 1, outTok: 1, costUsd: 0 },
    }));

    const outcome = await runBrainstormStage(debateStage, pendingStageState, profiles, "/tmp/x", runDir, () => new Date(), undefined, {
      callLlm,
      callLlmFanOut,
    });

    expect(outcome.result).toBe("pass");

    const reportPath = join(runDir, "artifacts", "debate-report.md");
    expect(existsSync(reportPath)).toBe(true);
    const report = readFileSync(reportPath, "utf-8");
    expect(report).toContain("D1");
    expect(report).toContain("Q1");
    expect(report).toContain("## Comparison Matrix");
    expect(report).toContain("## Recommendation");
    expect(report).toContain("| Model | Key Design | Risks | Workload |");

    const board = readSpecBoard(runDir);
    expect(board.artifacts["brainstorm-report"]).toBe("artifacts/debate-report.md");
    expect(board.decisions).toHaveLength(1);
    expect(board.decisions[0]).toMatchObject({ id: "D1", topic: "cache strategy", resolution: "use service worker" });
    expect(board.open_questions).toHaveLength(1);
    expect(board.open_questions[0]).toMatchObject({ id: "Q1", topic: "sync frequency", positions: { a: "hourly", b: "daily" } });

    const events = readEvents(runDir);
    expect(events.some((e) => e.type === "debate_round")).toBe(true);
    expect(events.some((e) => e.type === "debate_end" && e.reason === "stalled")).toBe(true);
    expect(events.some((e) => e.type === "brainstorm_result" && e.result === "pass")).toBe(true);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("stops after the first fan-out round if it alone exceeds the budget, without calling the synthesizer", async () => {
  const runDir = setupRunDir();
  try {
    const debateStage: BrainstormStageConfig = { ...baseStage, mode: "debate", debate_rounds: 2 };
    const callLlmFanOut = mock(async (profs: ModelProfile[]) =>
      profs.map((p) => {
        const name = p === profiles.a ? "a" : "b";
        return { profile: p, ok: true, result: { text: makeProposal(name, "idea"), usage: { inTok: 1, outTok: 1, costUsd: 6 } } };
      })
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
    expect(callLlm).not.toHaveBeenCalled(); // moderator/synthesizer call never happens
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
