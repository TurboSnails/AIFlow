import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReject } from "../../src/commands/reject";

function setupRun(stages: Array<{ id: string; status: string; entered_at?: string }>): { cwd: string; runId: string; runDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-reject-test-"));
  const runId = "20260706_000000_abc123";
  const runDir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      run_id: runId,
      pipeline: "test-pipeline",
      stages,
      cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    })
  );
  return { cwd, runId, runDir };
}

test("rejects the sole waiting_human stage, marks it aborted, records the reason", () => {
  const { cwd, runId, runDir } = setupRun([{ id: "confirm", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" }]);
  try {
    const result = runReject(cwd, { runId, reason: "spec is wrong" });
    expect(result.status).toBe("rejected");
    expect(result.state!.stages[0]).toEqual({ id: "confirm", status: "aborted", reason: "human_gate_rejected" });
    const events = readFileSync(join(runDir, "events.jsonl"), "utf-8");
    expect(events).toContain("human_gate_rejected");
    expect(events).toContain("spec is wrong");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("errors when no stage is waiting", () => {
  const { cwd, runId } = setupRun([{ id: "confirm", status: "done" }]);
  try {
    const result = runReject(cwd, { runId });
    expect(result.status).toBe("no_waiting_stage");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("errors with no_runs when .aiflow/runs is missing entirely", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-reject-empty-"));
  try {
    const result = runReject(cwd, {});
    expect(result.status).toBe("no_runs");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
