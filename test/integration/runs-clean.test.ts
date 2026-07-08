import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRuns } from "../../src/commands/runs";
import { runClean } from "../../src/commands/clean";
import type { EngineState } from "../../src/engine/state";

function writeRun(cwd: string, runId: string, stages: EngineState["stages"]): void {
  const dir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const state: EngineState = {
    run_id: runId, pipeline: "demo", stages,
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0.1 },
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
}

test("runs lists all runs and marks the lock-held one active; clean --status done removes only done runs", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-runs-clean-"));
  try {
    writeRun(cwd, "done1", [{ id: "s1", status: "done" }]);
    writeRun(cwd, "failed1", [{ id: "s1", status: "failed" }]);
    writeRun(cwd, "paused1", [{ id: "s1", status: "paused" }]);
    writeRun(cwd, "locked1", [{ id: "s1", status: "done" }]);
    writeFileSync(
      join(cwd, ".aiflow", "run.lock"),
      JSON.stringify({ pid: 4242, run_id: "locked1", started_at: "2026-07-08T00:00:00.000Z" }),
    );

    // runs: JSON output includes all four, locked1 active
    let out = "";
    const runsCode = runRuns(cwd, { json: true, write: (s) => { out += s; }, writeErr: () => {} });
    expect(runsCode).toBe(0);
    const rows = JSON.parse(out) as Array<{ runId: string; active: boolean; status: string }>;
    expect(rows.map((r) => r.runId).sort()).toEqual(["done1", "failed1", "locked1", "paused1"]);
    expect(rows.find((r) => r.runId === "locked1")!.active).toBe(true);
    expect(rows.find((r) => r.runId === "paused1")!.active).toBe(true); // non-terminal

    // clean --status done --yes: removes done1 only; locked1 (active) and others survive
    const cleanCode = runClean(cwd, { status: "done", yes: true, write: () => {}, writeErr: () => {} });
    expect(cleanCode).toBe(0);
    expect(existsSync(join(cwd, ".aiflow", "runs", "done1"))).toBe(false);
    expect(existsSync(join(cwd, ".aiflow", "runs", "locked1"))).toBe(true);
    expect(existsSync(join(cwd, ".aiflow", "runs", "failed1"))).toBe(true);
    expect(existsSync(join(cwd, ".aiflow", "runs", "paused1"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
