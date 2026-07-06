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
});
