import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runSpecStage } from "../../src/runners/spec";
import { createBudgetTracker } from "../../src/gate/budget";
import { readEvents } from "../../src/events/events";
import { parseOpenSpec, lintOpenSpec } from "../../src/openspec/parser";
import { registerArtifact } from "../../src/specboard/specboard";
import type { SpecStageConfig, ModelProfile } from "../../src/config/schema";
import type { StageState } from "../../src/engine/state";

const profiles: Record<string, ModelProfile> = { "main-dev": { channel: "opencode", provider: "opencode", model: "x" } };
const stageConfig: SpecStageConfig = { id: "spec", type: "spec", model: "main-dev", output: "spec.md" };
const pendingStageState: StageState = { id: "spec", status: "pending" };

const validSpec = `---
spec_id: test-spec
version: 1
branch: main
---
<task id="t1" priority="1">
## Task 1

Acceptance:
- [ ] It works
</task>
`;

test("agent succeeds and writes spec.md: result is pass", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-spec-test-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-spec-test-run-"));
  try {
    writeFileSync(join(cwd, "spec.md"), validSpec);
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
    writeFileSync(join(cwd, "design.md"), validSpec);
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

test("returns paused/budget_exceeded without writing the output file when the agent call exceeds budget", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-spec-budget-test-"));
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-spec-budget-cwd-"));
  try {
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 6 } }));
    const budget = createBudgetTracker(5, 0);

    const outcome = await runSpecStage(
      stageConfig,
      { id: "spec", status: "running" },
      profiles,
      cwd,
      runDir,
      () => new Date(),
      undefined,
      { runAgentTask },
      budget
    );

    expect(outcome.result).toBe("paused");
    expect(outcome.reason).toBe("budget_exceeded");
    expect(outcome.usage).toEqual({ inTok: 1, outTok: 1, costUsd: 6 });
    expect(existsSync(join(cwd, "spec.md"))).toBe(false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("valid spec is parsed, linted, hashed and registered as artifact", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-spec-valid-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-spec-valid-run-"));
  try {
    writeFileSync(join(cwd, "spec.md"), validSpec);
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 5, outTok: 2, costUsd: 0 } }));
    const registerArtifactMock = mock(registerArtifact);
    const expectedHash = createHash("sha256").update(readFileSync(join(cwd, "spec.md"))).digest("hex");

    const outcome = await runSpecStage(stageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined, {
      runAgentTask,
      registerArtifact: registerArtifactMock,
    });

    expect(outcome.result).toBe("pass");
    expect(registerArtifactMock).toHaveBeenCalledWith(runDir, "spec", "spec.md");
    const events = readEvents(runDir);
    const specEvent = events.find((e) => e.type === "spec_result");
    expect(specEvent).toBeDefined();
    expect(specEvent?.type === "spec_result" && specEvent.spec_hash).toBe(expectedHash);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("invalid frontmatter fails parsing and fails the stage", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-spec-parse-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-spec-parse-run-"));
  try {
    writeFileSync(join(cwd, "spec.md"), "No frontmatter here");
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 5, outTok: 2, costUsd: 0 } }));
    const parseOpenSpecMock = mock(parseOpenSpec);
    parseOpenSpecMock.mockImplementation(() => ({ success: false, error: "missing frontmatter" }));
    const registerArtifactMock = mock(registerArtifact);

    const outcome = await runSpecStage(stageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined, {
      runAgentTask,
      parseOpenSpec: parseOpenSpecMock,
      registerArtifact: registerArtifactMock,
    });

    expect(outcome.result).toBe("fail");
    expect(parseOpenSpecMock).toHaveBeenCalled();
    expect(registerArtifactMock).not.toHaveBeenCalled();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("lint errors fail the stage", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-spec-lint-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-spec-lint-run-"));
  try {
    writeFileSync(join(cwd, "spec.md"), validSpec);
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 5, outTok: 2, costUsd: 0 } }));
    const lintOpenSpecMock = mock(lintOpenSpec);
    lintOpenSpecMock.mockImplementation(() => ["task t1 missing acceptance"]);
    const registerArtifactMock = mock(registerArtifact);

    const outcome = await runSpecStage(stageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined, {
      runAgentTask,
      lintOpenSpec: lintOpenSpecMock,
      registerArtifact: registerArtifactMock,
    });

    expect(outcome.result).toBe("fail");
    expect(lintOpenSpecMock).toHaveBeenCalled();
    expect(registerArtifactMock).not.toHaveBeenCalled();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
