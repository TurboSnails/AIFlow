import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { runResume } from "../../src/commands/resume";

const FIXTURE_SOURCE = join(process.cwd(), "fixtures", "sample-project");

async function copyFixture(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-resume-"));
  cpSync(FIXTURE_SOURCE, dir, {
    recursive: true,
    filter: (src) => !src.includes(`${FIXTURE_SOURCE}/.git`),
  });
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} config user.email "test@example.com"`;
  await $`git -C ${dir} config user.name "Test"`;
  await $`git -C ${dir} add -A`;
  await $`git -C ${dir} commit -q -m "initial"`;
  return dir;
}

describe("runResume", () => {
  test("returns no_runs when .aiflow/runs is missing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "aiflow-resume-empty-"));
    try {
      const result = await runResume(cwd, {});
      expect(result.status).toBe("no_runs");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("resumes a pending run (state.json present, status pending)", async () => {
    const cwd = await copyFixture();
    try {
      const runId = "20260701_120000_abcd12";
      const runDir = join(cwd, ".aiflow", "runs", runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "state.json"),
        JSON.stringify({
          run_id: runId,
          pipeline: "ralph-only",
          stages: [{ id: "develop", status: "pending" }],
          cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
        }),
      );
      writeFileSync(join(runDir, "prd.json"), JSON.stringify({ branchName: "fix/clamp", stories: [{ id: "US-1", title: "x", acceptance: [], priority: 1, passes: false, fixCount: 0 }] }));
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(
        join(cwd, "src", "math.ts"),
        `export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`,
      );

      // minimal .aiflow/config/pipelines/ralph-only.yaml — we already have ralph-only.yaml in fixture
      // Mock runRalphLoop so this stays a hermetic unit test — no real OpenCode/LLM call.
      const result = await runResume(cwd, { runId }, {
        runners: {
          ralph_loop: async () => ({
            result: "pass",
            usage: { inTok: 0, outTok: 0, costUsd: 0 },
          }),
        },
      });
      expect(result.status).toBe("resumed");
      expect(existsSync(join(runDir, "state.json"))).toBe(true);
      const persisted = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
      expect(["done", "failed", "suspended"]).toContain(persisted.stages[0].status);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  test("runResume stops with a paused stage when given an already-aborted signal", async () => {
    const cwd = await copyFixture();
    try {
      const runId = "20260701_130000_abcd12";
      const runDir = join(cwd, ".aiflow", "runs", runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "state.json"),
        JSON.stringify({
          run_id: runId,
          pipeline: "ralph-only",
          stages: [{ id: "develop", status: "pending" }],
          cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
        }),
      );
      writeFileSync(join(runDir, "prd.json"), JSON.stringify({ branchName: "fix/clamp", stories: [{ id: "US-1", title: "x", acceptance: [], priority: 1, passes: false, fixCount: 0 }] }));
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "src", "math.ts"), `export function clamp(value: number, min: number, max: number): number {\n  return value;\n}\n`);

      const controller = new AbortController();
      controller.abort();
      const result = await runResume(cwd, { runId }, undefined, controller.signal);
      expect(result.status).toBe("resumed");
      expect(result.state!.stages[0].status).toBe("paused");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("resume with --raise-budget overrides state.budget.limit_usd while preserving cost already spent", async () => {
    const cwd = await copyFixture();
    try {
      const runId = "20260701_140000_abcd12";
      const runDir = join(cwd, ".aiflow", "runs", runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "state.json"),
        JSON.stringify({
          run_id: runId,
          pipeline: "ralph-only",
          stages: [{ id: "develop", status: "paused", reason: "budget_exceeded" }],
          cost: { input_tokens: 100, output_tokens: 20, est_usd: 5 },
          budget: { limit_usd: 5 },
        }),
      );
      writeFileSync(join(runDir, "prd.json"), JSON.stringify({ branchName: "fix/clamp", stories: [{ id: "US-1", title: "x", acceptance: [], priority: 1, passes: false, fixCount: 0 }] }));
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(
        join(cwd, "src", "math.ts"),
        `export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`,
      );

      const result = await runResume(
        cwd,
        { runId, pipeline: "ralph-only", raiseBudget: 50 },
        {
          runners: {
            ralph_loop: async () => ({
              result: "pass" as const,
              usage: { inTok: 0, outTok: 0, costUsd: 0 },
            }),
          },
        }
      );
      expect(result.state?.budget).toEqual({ limit_usd: 50 });
      expect(result.state?.cost.est_usd).toBe(5);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  test("resume rejects invalid --raise-budget with a message mentioning --raise-budget", async () => {
    const cwd = await copyFixture();
    try {
      const runId = "20260701_150000_abcd12";
      const runDir = join(cwd, ".aiflow", "runs", runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "state.json"),
        JSON.stringify({
          run_id: runId,
          pipeline: "ralph-only",
          stages: [{ id: "develop", status: "paused", reason: "budget_exceeded" }],
          cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
          budget: { limit_usd: 5 },
        }),
      );
      writeFileSync(join(runDir, "prd.json"), JSON.stringify({ branchName: "fix/clamp", stories: [{ id: "US-1", title: "x", acceptance: [], priority: 1, passes: false, fixCount: 0 }] }));

      await expect(runResume(cwd, { runId, raiseBudget: Number.NaN })).rejects.toThrow(/--raise-budget/);
      await expect(runResume(cwd, { runId, raiseBudget: -10 })).rejects.toThrow(/--raise-budget/);
      await expect(runResume(cwd, { runId, raiseBudget: 0 })).rejects.toThrow(/--raise-budget/);
      await expect(runResume(cwd, { runId, raiseBudget: Number.POSITIVE_INFINITY })).rejects.toThrow(/--raise-budget/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
