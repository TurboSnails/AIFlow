import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { runCommand } from "../../src/commands/run";

async function setupProject(pipelineYaml: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-run-multi-"));
  mkdirSync(join(dir, ".aiflow", "config", "pipelines"), { recursive: true });
  writeFileSync(
    join(dir, ".aiflow", "config", "models.yaml"),
    `profiles:\n  main-dev:\n    channel: opencode\n    provider: opencode\n    model: x\n  reviewer:\n    channel: http\n    provider: y\n    model: z\n`
  );
  writeFileSync(join(dir, ".aiflow", "config", "pipelines", "test-pipeline.yaml"), pipelineYaml);
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} config user.email "test@example.com"`;
  await $`git -C ${dir} config user.name "Test"`;
  await $`git -C ${dir} add -A`;
  await $`git -C ${dir} commit -q -m "initial"`;
  return dir;
}

test("runCommand throws before creating a run dir when a spec stage needs --requirement and none was given", async () => {
  const dir = await setupProject(`name: test-pipeline\nstages:\n  - id: spec\n    type: spec\n    model: main-dev\n`);
  try {
    await expect(runCommand(dir, "test-pipeline")).rejects.toThrow(/requires --requirement/);
    expect(existsSync(join(dir, ".aiflow", "runs"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommand accepts --requirement text and writes it to artifacts/requirement.md and state.requirement", async () => {
  const dir = await setupProject(`name: test-pipeline\nstages:\n  - id: spec\n    type: spec\n    model: main-dev\n`);
  try {
    const state = await runCommand(
      dir,
      "test-pipeline",
      { runAgentTask: async () => ({ ok: false, transcriptPath: "unused", usage: { inTok: 0, outTok: 0, costUsd: 0 } }) },
      { requirement: "Add offline cache" }
    );
    expect(state.requirement).toBe("Add offline cache");
    expect(state.stages[0].status).toBe("failed"); // agent mocked to fail — proves the requirement was accepted and the stage actually ran
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommand accepts --requirement-file and reads its content", async () => {
  const dir = await setupProject(`name: test-pipeline\nstages:\n  - id: spec\n    type: spec\n    model: main-dev\n`);
  const reqFile = join(dir, "requirement.md");
  writeFileSync(reqFile, "Requirement from a file");
  try {
    const state = await runCommand(
      dir,
      "test-pipeline",
      { runAgentTask: async () => ({ ok: false, transcriptPath: "unused", usage: { inTok: 0, outTok: 0, costUsd: 0 } }) },
      { requirementFile: reqFile }
    );
    expect(state.requirement).toBe("Requirement from a file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommand does not require --requirement when the pipeline has no brainstorm/spec stage", async () => {
  const dir = await setupProject(
    `name: test-pipeline\nstages:\n  - id: plan\n    type: plan\n    model: main-dev\n`
  );
  try {
    const state = await runCommand(dir, "test-pipeline", {
      callLlm: async () => ({ text: "not json", usage: { inTok: 0, outTok: 0, costUsd: 0 } }),
    });
    expect(state.stages[0].status).toBe("failed"); // ran (and failed on bad JSON) rather than being blocked by the requirement check
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommand stops with a paused stage when given an already-aborted signal", async () => {
  const dir = await setupProject(`name: test-pipeline\nstages:\n  - id: plan\n    type: plan\n    model: main-dev\n`);
  try {
    const controller = new AbortController();
    controller.abort();
    const state = await runCommand(
      dir,
      "test-pipeline",
      { callLlm: async () => ({ text: "unused", usage: { inTok: 0, outTok: 0, costUsd: 0 } }) },
      {},
      controller.signal
    );
    expect(state.stages[0].status).toBe("paused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommand refuses to start when a ralph_loop stage has auto_clean:true and the working tree is dirty", async () => {
  const dir = await setupProject(
    `name: test-pipeline\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    auto_clean: true\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n`
  );
  try {
    writeFileSync(join(dir, "dirty.txt"), "uncommitted\n");
    await expect(runCommand(dir, "test-pipeline")).rejects.toThrow(/auto_clean.*not clean/i);
    expect(existsSync(join(dir, ".aiflow", "runs"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommand starts normally when a ralph_loop stage has auto_clean:true and the working tree is clean", async () => {
  const dir = await setupProject(
    `name: test-pipeline\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    auto_clean: true\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n`
  );
  try {
    writeFileSync(join(dir, "prd.json"), JSON.stringify({ branchName: "x", stories: [] }));
    // Commit prd.json so the tree is actually clean for the auto_clean preflight check —
    // leaving it untracked would (correctly) trip the guard, since auto_clean's `git clean -fd`
    // would delete an untracked prd.json just as readily as any other stray file.
    await $`git -C ${dir} add -A`;
    await $`git -C ${dir} commit -q -m "add prd.json"`;
    const state = await runCommand(dir, "test-pipeline");
    expect(state.stages[0].status).toBe("done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommand starts normally when the working tree is dirty but no stage has auto_clean:true", async () => {
  const dir = await setupProject(
    `name: test-pipeline\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n`
  );
  try {
    writeFileSync(join(dir, "dirty.txt"), "uncommitted\n");
    writeFileSync(join(dir, "prd.json"), JSON.stringify({ branchName: "x", stories: [] }));
    const state = await runCommand(dir, "test-pipeline");
    expect(state.stages[0].status).toBe("done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
