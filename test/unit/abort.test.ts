import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAbort } from "../../src/commands/abort";

function makeRunDir(runId: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-abort-"));
  const runDir = join(dir, ".aiflow", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

test("returns no_runs when there are no runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-abort-empty-"));
  try {
    const result = runAbort(dir, {});
    expect(result.status).toBe("no_runs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aborts a running run and emits run_aborted event", () => {
  const runId = "20260101_120000_test";
  const runDir = makeRunDir(runId);
  const dir = runDir.replace(/\.aiflow\/runs\/[^/]+$/, "");
  try {
    const state = {
      run_id: runId,
      pipeline: "dev",
      stages: [
        { id: "ideate", status: "done" },
        { id: "develop", status: "running" },
        { id: "ship", status: "pending" },
      ],
      cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    };
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state));

    const result = runAbort(dir, { runId });

    expect(result.status).toBe("aborted");
    expect(result.runId).toBe(runId);
    const updated = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
    expect(updated.stages.map((s: { status: string }) => s.status)).toEqual(["done", "aborted", "aborted"]);
    const events = readFileSync(join(runDir, "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run_aborted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uses latest run when runId is omitted", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-abort-latest-"));
  try {
    const runDir = join(dir, ".aiflow", "runs", "20260101_120000_latest");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({ run_id: "20260101_120000_latest", pipeline: "dev", stages: [{ id: "s1", status: "running" }], cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 } })
    );

    const result = runAbort(dir, {});

    expect(result.status).toBe("aborted");
    expect(result.runId).toBe("20260101_120000_latest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aborts waiting_human stages", () => {
  const runId = "20260101_120000_wait";
  const runDir = makeRunDir(runId);
  const dir = runDir.replace(/\.aiflow\/runs\/[^/]+$/, "");
  try {
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({
        run_id: runId,
        pipeline: "dev",
        stages: [{ id: "s1", status: "waiting_human" }],
        cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
      })
    );

    const result = runAbort(dir, { runId });

    expect(result.status).toBe("aborted");
    const updated = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
    expect(updated.stages[0].status).toBe("aborted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leaves terminal stages unchanged", () => {
  const runId = "20260101_120000_term";
  const runDir = makeRunDir(runId);
  const dir = runDir.replace(/\.aiflow\/runs\/[^/]+$/, "");
  try {
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({
        run_id: runId,
        pipeline: "dev",
        stages: [
          { id: "done", status: "done" },
          { id: "failed", status: "failed" },
          { id: "aborted", status: "aborted" },
        ],
        cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
      })
    );

    const result = runAbort(dir, { runId });

    expect(result.status).toBe("aborted");
    const updated = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
    expect(updated.stages.map((s: { status: string }) => s.status)).toEqual(["done", "failed", "aborted"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aborts paused stages", () => {
  const runId = "20260101_120000_paused";
  const runDir = makeRunDir(runId);
  const dir = runDir.replace(/\.aiflow\/runs\/[^/]+$/, "");
  try {
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({
        run_id: runId,
        pipeline: "dev",
        stages: [
          { id: "s1", status: "done" },
          { id: "s2", status: "paused" },
        ],
        cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
      })
    );

    const result = runAbort(dir, { runId });

    expect(result.status).toBe("aborted");
    const updated = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
    expect(updated.stages.map((s: { status: string }) => s.status)).toEqual(["done", "aborted"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
