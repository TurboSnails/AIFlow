import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRuns } from "../../src/commands/runs";
import { runClean } from "../../src/commands/clean";
import type { EngineState } from "../../src/engine/state";

function writeRun(cwd: string, runId: string, stages: EngineState["stages"]): string {
  const dir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const state: EngineState = {
    run_id: runId, pipeline: "demo", stages,
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0.1 },
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  return dir;
}

function setMtime(dir: string, daysAgo: number): void {
  const t = new Date(Date.now() - daysAgo * 86400_000);
  utimesSync(dir, t, t);
}

test("runs lists all runs and marks the lock-held one active; clean --status done removes only done runs", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-runs-clean-"));
  try {
    writeRun(cwd, "done1", [{ id: "s1", status: "done" }]);
    writeRun(cwd, "failed1", [{ id: "s1", status: "failed" }]);
    writeRun(cwd, "paused1", [{ id: "s1", status: "paused" }]);
    writeRun(cwd, "suspended1", [{ id: "s1", status: "suspended" }]);
    writeRun(cwd, "locked1", [{ id: "s1", status: "done" }]);
    writeFileSync(
      join(cwd, ".aiflow", "run.lock"),
      JSON.stringify({ pid: 4242, run_id: "locked1", started_at: "2026-07-08T00:00:00.000Z" }),
    );

    // runs: JSON output includes all five, locked1 active
    let out = "";
    const runsCode = runRuns(cwd, { json: true, write: (s) => { out += s; }, writeErr: () => {} });
    expect(runsCode).toBe(0);
    const rows = JSON.parse(out) as Array<{ runId: string; active: boolean; status: string }>;
    expect(rows.map((r) => r.runId).sort()).toEqual(["done1", "failed1", "locked1", "paused1", "suspended1"]);
    expect(rows.find((r) => r.runId === "locked1")!.active).toBe(true);
    expect(rows.find((r) => r.runId === "paused1")!.active).toBe(true); // non-terminal
    expect(rows.find((r) => r.runId === "suspended1")!.status).toBe("suspended");

    // clean --status done --yes: removes done1 only; locked1 (active), suspended1, and others survive
    const cleanCode = runClean(cwd, { status: "done", yes: true, write: () => {}, writeErr: () => {} });
    expect(cleanCode).toBe(0);
    expect(existsSync(join(cwd, ".aiflow", "runs", "done1"))).toBe(false);
    expect(existsSync(join(cwd, ".aiflow", "runs", "locked1"))).toBe(true);
    expect(existsSync(join(cwd, ".aiflow", "runs", "failed1"))).toBe(true);
    expect(existsSync(join(cwd, ".aiflow", "runs", "paused1"))).toBe(true);
    expect(existsSync(join(cwd, ".aiflow", "runs", "suspended1"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("clean --before + --keep keeps the newest N runs among those older than the cutoff", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-runs-clean-keep-"));
  try {
    const old1 = writeRun(cwd, "old1", [{ id: "s1", status: "done" }]);
    const old2 = writeRun(cwd, "old2", [{ id: "s1", status: "done" }]);
    const recent = writeRun(cwd, "recent", [{ id: "s1", status: "done" }]);
    setMtime(old1, 10);
    setMtime(old2, 8);
    setMtime(recent, 1);

    // --before 7d --keep 1: candidates are old1 and old2; keep old2 (newest), delete old1.
    // "recent" is not older than 7d, so it survives regardless of --keep.
    const code = runClean(cwd, { before: "7d", keep: 1, yes: true, write: () => {}, writeErr: () => {} });
    expect(code).toBe(0);
    expect(existsSync(join(cwd, ".aiflow", "runs", "old1"))).toBe(false);
    expect(existsSync(join(cwd, ".aiflow", "runs", "old2"))).toBe(true);
    expect(existsSync(join(cwd, ".aiflow", "runs", "recent"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
