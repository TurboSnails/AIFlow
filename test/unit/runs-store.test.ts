import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listRunIdsByMtimeDesc,
  loadRun,
  isRunActive,
  summarizeRunStatus,
} from "../../src/runs/store";
import type { EngineState } from "../../src/engine/state";

function makeState(overrides: Partial<EngineState> = {}): EngineState {
  return {
    run_id: "r",
    pipeline: "p",
    stages: [{ id: "s1", status: "done" }],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    ...overrides,
  };
}

function writeRun(root: string, runId: string, state: EngineState): string {
  const dir = join(root, ".aiflow", "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  return dir;
}

test("listRunIdsByMtimeDesc returns run dirs newest-first; empty when root missing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-store-"));
  try {
    expect(listRunIdsByMtimeDesc(cwd)).toEqual([]);
    writeRun(cwd, "run-a", makeState());
    // ensure run-b has a strictly later mtime
    const dirB = writeRun(cwd, "run-b", makeState());
    const later = Date.now() / 1000 + 5;
    require("node:fs").utimesSync(dirB, later, later);
    expect(listRunIdsByMtimeDesc(cwd)).toEqual(["run-b", "run-a"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadRun reads state + mtime; returns undefined for missing or corrupt state", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-store-"));
  try {
    writeRun(cwd, "good", makeState({ pipeline: "demo" }));
    const loaded = loadRun(cwd, "good");
    expect(loaded?.state.pipeline).toBe("demo");
    expect(typeof loaded?.mtimeMs).toBe("number");

    expect(loadRun(cwd, "missing")).toBeUndefined();

    const badDir = join(cwd, ".aiflow", "runs", "corrupt");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "state.json"), "{ not json");
    expect(loadRun(cwd, "corrupt")).toBeUndefined();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("isRunActive: non-terminal state is active", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-store-"));
  try {
    const state = makeState({ stages: [{ id: "s1", status: "running" }] });
    writeRun(cwd, "r1", state);
    expect(isRunActive(cwd, "r1", state)).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("isRunActive: all-terminal with no lock is inactive", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-store-"));
  try {
    const state = makeState({ stages: [{ id: "s1", status: "done" }] });
    writeRun(cwd, "r1", state);
    expect(isRunActive(cwd, "r1", state)).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("isRunActive: all-terminal but run.lock points to it is active; other run is not", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-store-"));
  try {
    const state = makeState({ stages: [{ id: "s1", status: "done" }] });
    writeRun(cwd, "r1", state);
    writeRun(cwd, "r2", state);
    writeFileSync(
      join(cwd, ".aiflow", "run.lock"),
      JSON.stringify({ pid: 999, run_id: "r1", started_at: "2026-07-08T00:00:00.000Z" }),
    );
    expect(isRunActive(cwd, "r1", state)).toBe(true);
    expect(isRunActive(cwd, "r2", state)).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("summarizeRunStatus tokens", () => {
  expect(summarizeRunStatus(makeState({ stages: [{ id: "a", status: "done" }] }))).toBe("done");
  expect(summarizeRunStatus(makeState({ stages: [{ id: "a", status: "done" }, { id: "b", status: "failed" }] }))).toBe("failed");
  expect(summarizeRunStatus(makeState({ stages: [{ id: "a", status: "done" }, { id: "b", status: "aborted" }] }))).toBe("aborted");
  expect(summarizeRunStatus(makeState({ stages: [{ id: "a", status: "done" }, { id: "b", status: "suspended" }] }))).toBe("suspended");
  expect(summarizeRunStatus(makeState({ stages: [{ id: "a", status: "done" }, { id: "b", status: "paused" }] }))).toBe("paused");
  expect(summarizeRunStatus(makeState({ stages: [{ id: "a", status: "running" }] }))).toBe("running");
  expect(summarizeRunStatus(makeState({ stages: [{ id: "a", status: "pending" }] }))).toBe("pending");
  expect(summarizeRunStatus(makeState({ stages: [{ id: "a", status: "waiting_human" }] }))).toBe("waiting_human");
});
