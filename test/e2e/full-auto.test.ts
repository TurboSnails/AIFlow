import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { runCommand } from "../../src/commands/run";
import type { AgentTask, AgentResult } from "../../src/adapters/opencode";
import type { LlmCallResult } from "../../src/llm/client";

function specContent(): string {
  return `---\nspec_id: full-auto-e2e\nversion: 1\nbranch: main\n---\n# Full-auto E2E spec\n\nNo tasks required for this mocked run.\n`;
}

async function setupProject(): Promise<string> {
  const fixture = join(import.meta.dir, "..", "..", "fixtures", "sample-project");
  const cwd = mkdtempSync(join(tmpdir(), "full-auto-e2e-"));
  cpSync(fixture, cwd, { recursive: true });
  await $`git -C ${cwd} init -q`;
  await $`git -C ${cwd} config user.email "test@example.com"`;
  await $`git -C ${cwd} config user.name "Test"`;
  await $`git -C ${cwd} add -A`;
  await $`git -C ${cwd} commit -q -m "initial"`;
  return cwd;
}

function mockRunAgentTask(task: AgentTask): Promise<AgentResult> {
  if (task.prompt.includes("spec.md")) {
    writeFileSync(join(task.cwd, "spec.md"), specContent());
  }
  return Promise.resolve({
    ok: true,
    transcriptPath: "mock",
    usage: { inTok: 10, outTok: 5, costUsd: 0.0001 },
  });
}

function mockCallLlm(): Promise<LlmCallResult> {
  return Promise.resolve({
    text: "Synthesized approach: keep it simple.",
    usage: { inTok: 5, outTok: 5, costUsd: 0.0001 },
  });
}

function mockCallLlmFanOut() {
  return Promise.resolve([
    { profile: {} as import("../../src/config/schema").ModelProfile, ok: true, result: { text: "idea A", usage: { inTok: 1, outTok: 1, costUsd: 0 } } },
    { profile: {} as import("../../src/config/schema").ModelProfile, ok: true, result: { text: "idea B", usage: { inTok: 1, outTok: 1, costUsd: 0 } } },
  ]);
}

test("full-auto pipeline completes with mocks", async () => {
  const cwd = await setupProject();
  try {
    const state = await runCommand(
      cwd,
      "full-auto",
      {
        runAgentTask: mockRunAgentTask,
        callLlm: mockCallLlm,
        callLlmFanOut: mockCallLlmFanOut as typeof import("../../src/llm/client").callLlmFanOut,
      },
      { requirement: "Add a mocked feature" }
    );
    expect(state.stages.every((s) => s.status === "done")).toBe(true);
  } finally {
    await $`rm -rf ${cwd}`;
  }
});
