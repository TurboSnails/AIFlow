import { test, expect } from "bun:test";
import { assertCleanIfAutoClean } from "../../src/commands/dirty-guard";
import type { PipelineConfig } from "../../src/config/schema";

function autoCleanPipeline(): PipelineConfig {
  return {
    name: "ralph-only",
    stages: [
      {
        id: "develop",
        type: "ralph_loop",
        model: "main-dev",
        per_story_fix_limit: 3,
        max_iterations: 10,
        stall_limit: 3,
        auto_clean: true,
        gate: { checks: [], ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] } },
      },
    ],
  } as PipelineConfig;
}

function noAutoCleanPipeline(): PipelineConfig {
  const p = autoCleanPipeline();
  (p.stages[0] as { auto_clean: boolean }).auto_clean = false;
  return p;
}

test("throws when an auto_clean ralph_loop pipeline meets a dirty tree", async () => {
  await expect(
    assertCleanIfAutoClean("/some/cwd", autoCleanPipeline(), "ralph-only", async () => false)
  ).rejects.toThrow(/auto_clean enabled on a ralph_loop stage/);
});

test("error message includes the pipeline name and cwd", async () => {
  try {
    await assertCleanIfAutoClean("/my/project", autoCleanPipeline(), "ralph-only", async () => false);
    throw new Error("should have thrown");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).toContain('"ralph-only"');
    expect(msg).toContain("/my/project");
  }
});

test("does not throw when the tree is clean", async () => {
  await expect(
    assertCleanIfAutoClean("/some/cwd", autoCleanPipeline(), "ralph-only", async () => true)
  ).resolves.toBeUndefined();
});

test("does not throw for a pipeline without auto_clean, and never inspects the tree", async () => {
  let inspected = false;
  await assertCleanIfAutoClean("/some/cwd", noAutoCleanPipeline(), "ralph-only", async () => {
    inspected = true;
    return false;
  });
  expect(inspected).toBe(false);
});
