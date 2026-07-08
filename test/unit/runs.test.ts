import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunRows, renderRunsTable, renderRunsJson, renderRunsCsv, runRuns } from "../../src/commands/runs";
import type { EngineState } from "../../src/engine/state";

function writeRun(cwd: string, runId: string, state: Partial<EngineState>): void {
  const dir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const full: EngineState = {
    run_id: runId,
    pipeline: "p",
    stages: [{ id: "s1", status: "done" }],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    ...state,
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(full));
}

test("buildRunRows skips corrupt state and fills fields", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-runs-"));
  try {
    writeRun(cwd, "r1", { pipeline: "demo", cost: { input_tokens: 0, output_tokens: 0, est_usd: 1.5 } });
    const badDir = join(cwd, ".aiflow", "runs", "bad");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "state.json"), "{ broken");
    const rows = buildRunRows(cwd);
    expect(rows.map((r) => r.runId)).toEqual(["r1"]);
    expect(rows[0]).toMatchObject({ pipeline: "demo", status: "done", estUsd: 1.5, active: false });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("renderRunsTable marks active runs with * and includes a footnote", () => {
  const rows = [
    { runId: "r1", pipeline: "p", status: "running", estUsd: 0.5, mtimeMs: Date.now(), active: true },
    { runId: "r2", pipeline: "p", status: "done", estUsd: 0.25, mtimeMs: Date.now(), active: false },
  ];
  const out = renderRunsTable(rows, Date.now(), { color: false });
  expect(out).toContain("r1");
  expect(out).toContain("*");
  expect(out.toLowerCase()).toContain("active");
});

test("renderRunsCsv escapes commas per RFC 4180", () => {
  const rows = [{ runId: "r1", pipeline: "a,b", status: "done", estUsd: 1, mtimeMs: 1234, active: false }];
  const csv = renderRunsCsv(rows);
  const lines = csv.trim().split("\n");
  expect(lines[0]).toBe("run_id,pipeline,status,est_usd,mtime_ms,active");
  expect(lines[1]).toBe('r1,"a,b",done,1,1234,false');
});

test("renderRunsJson emits the row array", () => {
  const rows = [{ runId: "r1", pipeline: "p", status: "done", estUsd: 1, mtimeMs: 1234, active: false }];
  expect(JSON.parse(renderRunsJson(rows))).toEqual(rows);
});

test("runRuns returns 1 and errors when there are no runs", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-runs-"));
  try {
    let err = "";
    const code = runRuns(cwd, { writeErr: (s) => { err += s; }, write: () => {} });
    expect(code).toBe(1);
    expect(err).toContain("No runs found");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runRuns rejects --json with --csv", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-runs-"));
  try {
    let err = "";
    const code = runRuns(cwd, { json: true, csv: true, writeErr: (s) => { err += s; }, write: () => {} });
    expect(code).toBe(1);
    expect(err).toContain("mutually exclusive");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
