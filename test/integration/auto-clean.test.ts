import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { runCommand } from "../../src/commands/run";

async function setupProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-auto-clean-"));
  mkdirSync(join(dir, ".aiflow", "config", "pipelines"), { recursive: true });
  writeFileSync(
    join(dir, ".aiflow", "config", "models.yaml"),
    `profiles:\n  main-dev:\n    channel: opencode\n    provider: opencode\n    model: x\n  reviewer:\n    channel: http\n    provider: y\n    model: z\n`
  );
  writeFileSync(
    join(dir, ".aiflow", "config", "pipelines", "test-pipeline.yaml"),
    `name: test-pipeline\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    per_story_fix_limit: 1\n    auto_clean: true\n    gate:\n      checks: ["exit 1"]\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n`
  );
  writeFileSync(join(dir, "prd.json"), JSON.stringify({ branchName: "x", stories: [{ id: "US-1", title: "t", acceptance: [], priority: 1, passes: false, fixCount: 0 }] }));
  writeFileSync(join(dir, "clean.txt"), "original content\n");
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} config user.email "test@example.com"`;
  await $`git -C ${dir} config user.name "Test"`;
  await $`git -C ${dir} add -A`;
  await $`git -C ${dir} commit -q -m "initial"`;
  return dir;
}

test("auto_clean reverts a dirty working tree after a story is suspended", async () => {
  const dir = await setupProject();
  try {
    const fakeAgent = async (task: { cwd: string }) => {
      writeFileSync(join(task.cwd, "clean.txt"), "an agent's failed, uncommitted edit\n");
      return { ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } };
    };

    const state = await runCommand(dir, "test-pipeline", { runAgentTask: fakeAgent });

    expect(state.stages[0].status).toBe("suspended");
    const content = readFileSync(join(dir, "clean.txt"), "utf-8");
    expect(content).toBe("original content\n");
    // Don't assert the whole tree is pristine: the run itself legitimately
    // leaves its own bookkeeping (.aiflow/runs/<id>/...) as new, untracked
    // files after auto_clean runs (events/report are written as the run
    // finalizes, after the mid-loop checkoutClean). What auto_clean promises
    // is that the *agent's* dirty edit to a pre-existing tracked file is
    // reverted, so assert that specifically.
    const status = await $`git -C ${dir} status --porcelain`.text();
    expect(status).not.toContain("clean.txt");
    expect(status).not.toContain("prd.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
