import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStateAtomic, readState, type EngineState } from "../../src/engine/state";

test("writeStateAtomic then readState round-trips the exact state", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-state-test-"));
  try {
    const state: EngineState = {
      run_id: "20260705_000000_abc123",
      pipeline: "ralph-only",
      stages: [{ id: "develop", status: "running", iteration: 1 }],
      cost: { input_tokens: 100, output_tokens: 20, est_usd: 0.01 },
    };
    writeStateAtomic(dir, state);
    const loaded = readState(dir);
    expect(loaded).toEqual(state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeStateAtomic leaves no temp file behind on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-state-test-"));
  try {
    const state: EngineState = {
      run_id: "r1",
      pipeline: "ralph-only",
      stages: [],
      cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    };
    writeStateAtomic(dir, state);
    const files = readdirSync(dir);
    expect(files).toEqual(["state.json"]);
    expect(existsSync(join(dir, "state.json.tmp"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeStateAtomic then readState round-trips a stage with a reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-state-test-"));
  try {
    const state: EngineState = {
      run_id: "r1",
      pipeline: "ralph-only",
      stages: [{ id: "develop", status: "suspended", reason: "stall" }],
      cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    };
    writeStateAtomic(dir, state);
    const loaded = readState(dir);
    expect(loaded).toEqual(state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeStateAtomic then readState round-trips a waiting_human stage with entered_at", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-state-test-"));
  try {
    const state: EngineState = {
      run_id: "r1",
      pipeline: "full-auto",
      requirement: "add offline cache",
      stages: [{ id: "confirm-spec", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" }],
      cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    };
    writeStateAtomic(dir, state);
    const loaded = readState(dir);
    expect(loaded).toEqual(state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
