import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectRunsToClean, parseBefore, runClean } from "../../src/commands/clean";
import type { RunRow } from "../../src/commands/runs";
import type { EngineState } from "../../src/engine/state";

function row(over: Partial<RunRow>): RunRow {
  return { runId: "r", pipeline: "p", status: "done", estUsd: 0, mtimeMs: 1000, active: false, ...over };
}

test("selectRunsToClean never selects active runs", () => {
  const rows = [row({ runId: "a", active: true, status: "done" }), row({ runId: "b", status: "done" })];
  const { toDelete } = selectRunsToClean(rows, { status: "done" });
  expect(toDelete.map((r) => r.runId)).toEqual(["b"]);
});

test("selectRunsToClean never selects non-terminal status even without active flag", () => {
  const rows = [row({ runId: "a", status: "paused" }), row({ runId: "b", status: "done" })];
  const { toDelete } = selectRunsToClean(rows, { status: "done" });
  expect(toDelete.map((r) => r.runId)).toEqual(["b"]);
});

test("selectRunsToClean --status filters to that terminal status", () => {
  const rows = [row({ runId: "a", status: "done" }), row({ runId: "b", status: "failed" })];
  const { toDelete } = selectRunsToClean(rows, { status: "failed" });
  expect(toDelete.map((r) => r.runId)).toEqual(["b"]);
});

test("selectRunsToClean --before keeps only older-than", () => {
  const rows = [row({ runId: "old", mtimeMs: 1000, status: "done" }), row({ runId: "new", mtimeMs: 5000, status: "done" })];
  const { toDelete } = selectRunsToClean(rows, { before: new Date(3000) });
  expect(toDelete.map((r) => r.runId)).toEqual(["old"]);
});

test("selectRunsToClean --keep retains newest N candidates", () => {
  const rows = [
    row({ runId: "a", mtimeMs: 3000, status: "done" }),
    row({ runId: "b", mtimeMs: 2000, status: "done" }),
    row({ runId: "c", mtimeMs: 1000, status: "done" }),
  ];
  const { toDelete, kept } = selectRunsToClean(rows, { keep: 2 });
  expect(kept.map((r) => r.runId)).toEqual(["a", "b"]);
  expect(toDelete.map((r) => r.runId)).toEqual(["c"]);
});

test("selectRunsToClean combines status + before (intersection)", () => {
  const rows = [
    row({ runId: "a", status: "done", mtimeMs: 1000 }),
    row({ runId: "b", status: "failed", mtimeMs: 1000 }),
    row({ runId: "c", status: "done", mtimeMs: 5000 }),
  ];
  const { toDelete } = selectRunsToClean(rows, { status: "done", before: new Date(3000) });
  expect(toDelete.map((r) => r.runId)).toEqual(["a"]);
});

test("parseBefore accepts Nd relative and ISO date", () => {
  const now = new Date("2026-07-08T00:00:00.000Z");
  const sevenDaysAgo = parseBefore("7d", now)!;
  expect(sevenDaysAgo.getTime()).toBe(now.getTime() - 7 * 86400_000);
  const iso = parseBefore("2026-07-01T00:00:00.000Z", now)!;
  expect(iso.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  expect(parseBefore("garbage", now)).toBeUndefined();
});

// --- runClean command-entry tests ---

function writeRun(cwd: string, runId: string, state: Partial<EngineState>): string {
  const dir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const full: EngineState = {
    run_id: runId, pipeline: "p",
    stages: [{ id: "s1", status: "done" }],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    ...state,
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(full));
  return dir;
}

test("runClean with no filters errors and deletes nothing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-clean-"));
  try {
    writeRun(cwd, "r1", {});
    let err = "";
    const code = runClean(cwd, { writeErr: (s) => { err += s; }, write: () => {} });
    expect(code).toBe(1);
    expect(err).toContain("requires at least one");
    expect(existsSync(join(cwd, ".aiflow", "runs", "r1"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runClean --dry-run lists but does not delete", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-clean-"));
  try {
    writeRun(cwd, "r1", { stages: [{ id: "s1", status: "done" }] });
    let out = "";
    const code = runClean(cwd, { status: "done", dryRun: true, write: (s) => { out += s; }, writeErr: () => {} });
    expect(code).toBe(0);
    expect(out.toLowerCase()).toContain("would delete");
    expect(existsSync(join(cwd, ".aiflow", "runs", "r1"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runClean deletes terminal runs on confirm and keeps active ones", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-clean-"));
  try {
    writeRun(cwd, "done1", { stages: [{ id: "s1", status: "done" }] });
    writeRun(cwd, "live1", { stages: [{ id: "s1", status: "running" }] });
    const code = runClean(cwd, { status: "done", confirm: () => true, write: () => {}, writeErr: () => {} });
    expect(code).toBe(0);
    expect(existsSync(join(cwd, ".aiflow", "runs", "done1"))).toBe(false);
    expect(existsSync(join(cwd, ".aiflow", "runs", "live1"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runClean aborts (deletes nothing) when confirm returns false", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-clean-"));
  try {
    writeRun(cwd, "done1", { stages: [{ id: "s1", status: "done" }] });
    const code = runClean(cwd, { status: "done", confirm: () => false, write: () => {}, writeErr: () => {} });
    expect(code).toBe(0);
    expect(existsSync(join(cwd, ".aiflow", "runs", "done1"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runClean rejects an invalid --status value", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-clean-"));
  try {
    writeRun(cwd, "r1", {});
    let err = "";
    const code = runClean(cwd, { status: "paused", writeErr: (s) => { err += s; }, write: () => {} });
    expect(code).toBe(1);
    expect(err.toLowerCase()).toContain("status");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
