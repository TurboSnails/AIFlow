import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectRunsToClean, parseBefore, runClean, cleanWorktrees } from "../../src/commands/clean";
import type { WorktreeManagerDeps, WorktreeEntry } from "../../src/worktree/manager";
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

test("parseBefore accepts Nd relative and strict ISO date", () => {
  const now = new Date("2026-07-08T00:00:00.000Z");
  const sevenDaysAgo = parseBefore("7d", now)!;
  expect(sevenDaysAgo.getTime()).toBe(now.getTime() - 7 * 86400_000);
  const iso = parseBefore("2026-07-01T00:00:00.000Z", now)!;
  expect(iso.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  expect(parseBefore("2026-07-01", now)!.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  expect(parseBefore("garbage", now)).toBeUndefined();
  expect(parseBefore("07/01/2026", now)).toBeUndefined();
  expect(parseBefore("July 1, 2026", now)).toBeUndefined();
});

function setMtime(dir: string, mtimeMs: number): void {
  const d = new Date(mtimeMs);
  utimesSync(dir, d, d);
}

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

test("runClean --dry-run aligns the Age column", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-clean-age-"));
  try {
    const now = Date.now();
    const dir = writeRun(cwd, "r1", { pipeline: "demo", stages: [{ id: "s1", status: "done" }], cost: { input_tokens: 0, output_tokens: 0, est_usd: 1.2345 } });
    setMtime(dir, now);
    let out = "";
    const code = runClean(cwd, { status: "done", dryRun: true, write: (s) => { out += s; }, writeErr: () => {} });
    expect(code).toBe(0);
    const lines = out.split("\n");
    const header = lines.find((l) => l.includes("Run") && l.includes("Age"))!;
    const data = lines.find((l) => l.includes("r1"))!;
    expect(header.trimEnd().endsWith("Age")).toBe(true);
    expect(data.trimEnd().endsWith("0s")).toBe(true);
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

test("runClean --before deletes only runs older than the cutoff", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-clean-"));
  try {
    const now = Date.now();
    const oldDir = writeRun(cwd, "old", { stages: [{ id: "s1", status: "done" }] });
    const newDir = writeRun(cwd, "new", { stages: [{ id: "s1", status: "done" }] });
    setMtime(oldDir, now - 2 * 86400_000);
    setMtime(newDir, now - 3600_000);
    const code = runClean(cwd, { before: "1d", yes: true, write: () => {}, writeErr: () => {} });
    expect(code).toBe(0);
    expect(existsSync(join(cwd, ".aiflow", "runs", "old"))).toBe(false);
    expect(existsSync(join(cwd, ".aiflow", "runs", "new"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runClean --keep keeps newest N candidates and deletes the rest", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-clean-"));
  try {
    const now = Date.now();
    const newestDir = writeRun(cwd, "newest", { stages: [{ id: "s1", status: "done" }] });
    const middleDir = writeRun(cwd, "middle", { stages: [{ id: "s1", status: "done" }] });
    const oldestDir = writeRun(cwd, "oldest", { stages: [{ id: "s1", status: "done" }] });
    setMtime(newestDir, now);
    setMtime(middleDir, now - 3600_000);
    setMtime(oldestDir, now - 2 * 3600_000);
    const code = runClean(cwd, { keep: 2, yes: true, write: () => {}, writeErr: () => {} });
    expect(code).toBe(0);
    expect(existsSync(join(cwd, ".aiflow", "runs", "newest"))).toBe(true);
    expect(existsSync(join(cwd, ".aiflow", "runs", "middle"))).toBe(true);
    expect(existsSync(join(cwd, ".aiflow", "runs", "oldest"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runClean refuses to delete in non-TTY without --yes or confirm", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-clean-"));
  const previousIsTty = process.stdin.isTTY;
  process.stdin.isTTY = false;
  try {
    writeRun(cwd, "done1", { stages: [{ id: "s1", status: "done" }] });
    let err = "";
    const code = runClean(cwd, { status: "done", writeErr: (s) => { err += s; }, write: () => {} });
    expect(code).toBe(1);
    expect(err).toContain("refusing to delete without --yes (non-interactive)");
    expect(existsSync(join(cwd, ".aiflow", "runs", "done1"))).toBe(true);
  } finally {
    process.stdin.isTTY = previousIsTty;
    rmSync(cwd, { recursive: true, force: true });
  }
});

// --- cleanWorktrees tests ---

function makeWorktreeDeps(entries: WorktreeEntry[], nowMs: number, mtimeMs: number): WorktreeManagerDeps {
  return {
    runGit: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    listWorktrees: () => Promise.resolve(entries),
    now: () => nowMs,
    statMtime: () => mtimeMs,
  };
}

test("cleanWorktrees removes stale aiflow worktrees", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-clean-wt-"));
  const calls: string[][] = [];
  const deps: WorktreeManagerDeps = {
    ...makeWorktreeDeps(
      [{ path: join(cwd, "repo-aiflow-run1"), branch: "aiflow/run1" }],
      10 * 86400_000,
      0,
    ),
    runGit: (_cwd, args) => {
      calls.push(args);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    },
  };
  try {
    let out = "";
    const code = await cleanWorktrees(cwd, { write: (s) => { out += s; } }, deps);
    expect(code).toBe(0);
    expect(out).toContain("Removed 1 stale worktree(s)");
    expect(calls).toContainEqual(["worktree", "remove", join(cwd, "repo-aiflow-run1")]);
    expect(calls).toContainEqual(["branch", "-D", "aiflow/run1"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cleanWorktrees dry-run lists stale worktrees without removing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-clean-wt-dry-"));
  const deps = makeWorktreeDeps(
    [{ path: join(cwd, "repo-aiflow-run2"), branch: "aiflow/run2" }],
    10 * 86400_000,
    0,
  );
  try {
    let out = "";
    const code = await cleanWorktrees(cwd, { dryRun: true, write: (s) => { out += s; } }, deps);
    expect(code).toBe(0);
    expect(out).toContain("Would remove 1 stale worktree(s)");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cleanWorktrees ignores non-aiflow worktrees", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-clean-wt-ignore-"));
  const deps = makeWorktreeDeps(
    [{ path: join(cwd, "repo-other"), branch: "main" }],
    10 * 86400_000,
    0,
  );
  try {
    let out = "";
    const code = await cleanWorktrees(cwd, { write: (s) => { out += s; } }, deps);
    expect(code).toBe(0);
    expect(out).toContain("Removed 0 stale worktree(s)");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
