import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpecStage } from "../../src/runners/spec";
import type { SpecStageConfig, ModelProfile } from "../../src/config/schema";
import type { StageState } from "../../src/engine/state";

const profiles: Record<string, ModelProfile> = { "main-dev": { channel: "opencode", provider: "opencode", model: "x" } };
const stageConfig: SpecStageConfig = { id: "spec", type: "spec", model: "main-dev", output: "spec.md" };
const pendingStageState: StageState = { id: "spec", status: "pending" };

test("agent succeeds and writes spec.md: result is pass", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-spec-test-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-spec-test-run-"));
  try {
    writeFileSync(join(cwd, "spec.md"), "# Spec\nwritten by the agent");
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 5, outTok: 2, costUsd: 0 } }));

    const outcome = await runSpecStage(stageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined, {
      runAgentTask,
    });

    expect(outcome.result).toBe("pass");
    expect(outcome.usage).toEqual({ inTok: 5, outTok: 2, costUsd: 0 });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("agent succeeds but spec.md was never written: result is fail", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-spec-test-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-spec-test-run-"));
  try {
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 5, outTok: 2, costUsd: 0 } }));

    const outcome = await runSpecStage(stageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined, {
      runAgentTask,
    });

    expect(outcome.result).toBe("fail");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("agent writes a non-default output filename: result is pass", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-spec-test-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-spec-test-run-"));
  try {
    const customStageConfig: SpecStageConfig = { id: "spec", type: "spec", model: "main-dev", output: "design.md" };
    // Deliberately do NOT write spec.md — only the configured output file.
    writeFileSync(join(cwd, "design.md"), "# Design\nwritten by the agent");
    const runAgentTask = mock(async (task: { prompt: string }) => {
      expect(task.prompt).toContain("design.md");
      expect(task.prompt).not.toContain("spec.md");
      return { ok: true, transcriptPath: "unused", usage: { inTok: 5, outTok: 2, costUsd: 0 } };
    });

    const outcome = await runSpecStage(customStageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined, {
      runAgentTask,
    });

    expect(outcome.result).toBe("pass");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("agent call itself fails: result is fail", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-spec-test-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-spec-test-run-"));
  try {
    writeFileSync(join(cwd, "spec.md"), "irrelevant — agent itself failed");
    const runAgentTask = mock(async () => ({ ok: false, transcriptPath: "unused", usage: { inTok: 5, outTok: 0, costUsd: 0 } }));

    const outcome = await runSpecStage(stageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined, {
      runAgentTask,
    });

    expect(outcome.result).toBe("fail");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
