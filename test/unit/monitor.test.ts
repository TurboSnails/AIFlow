import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderStatus, readRunSnapshot, watchRun, runStatus, type RunSnapshot } from "../../src/commands/monitor";
import type { EngineState } from "../../src/engine/state";
import type { AiflowEvent } from "../../src/events/events";

const SAMPLE_STATE: EngineState = {
  run_id: "20260705_192000_a1b2c3",
  pipeline: "ralph-only",
  stages: [
    { id: "develop", status: "running", iteration: 3 },
  ],
  cost: { input_tokens: 12345, output_tokens: 6789, est_usd: 0.42 },
};

const SAMPLE_EVENTS: AiflowEvent[] = [
  { ts: "2026-07-05T19:20:01.000Z", type: "opencode_tool_use", stage: "develop", story: "US-1", tool: "read", summary: "read (completed)" },
  { ts: "2026-07-05T19:20:05.000Z", type: "opencode_step_finish", stage: "develop", in_tok: 800, out_tok: 120, cost_usd: 0.05 },
  { ts: "2026-07-05T19:20:06.000Z", type: "gate_result", stage: "develop", story: "US-1", checks: "pass", ai_review: "pass", blockers: 0 },
  { ts: "2026-07-05T19:20:07.000Z", type: "story_result", story: "US-1", result: "pass" },
];

describe("renderStatus", () => {
  test("renders run header (id, pipeline, cost) and stages table", () => {
    const out = renderStatus(SAMPLE_STATE, SAMPLE_EVENTS, { tail: 8, now: new Date("2026-07-05T19:21:00.000Z") });
    expect(out).toContain("run_id:    20260705_192000_a1b2c3");
    expect(out).toContain("pipeline:  ralph-only");
    expect(out).toContain("Stages:");
    expect(out).toContain("develop");
    expect(out).toContain("running");
    expect(out).toContain("12345");
    expect(out).toContain("0.42");
  });

  test("renders the last N events ordered oldest-first", () => {
    const out = renderStatus(SAMPLE_STATE, SAMPLE_EVENTS, { tail: 2, now: new Date("2026-07-05T19:21:00.000Z") });
    expect(out).toContain("US-1");
    expect(out).toContain("PASS");
    expect(out).toContain("blockers=0");
    expect(out).toContain("(2 of 4)");
  });

  test("emits no color codes when color:false is passed", () => {
    const out = renderStatus(SAMPLE_STATE, SAMPLE_EVENTS, { tail: 1, now: new Date(), color: false });
    expect(out).not.toContain("\x1b[");
  });

  test("survives empty events list", () => {
    const out = renderStatus(SAMPLE_STATE, [], { tail: 5, now: new Date("2026-07-05T19:21:00.000Z") });
    expect(out).toContain("Stages:");
    expect(out).toContain("(0 of 0)");
    expect(out).toContain("(none)");
  });
});

describe("readRunSnapshot", () => {
  function setupFixture(state: EngineState, events: AiflowEvent[]): string {
    const cwd = mkdtempSync(join(tmpdir(), "aiflow-mon-"));
    const runDir = join(cwd, ".aiflow", "runs", "run-test");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state));
    if (events.length > 0) {
      writeFileSync(join(runDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
    return cwd;
  }

  test("returns undefined when .aiflow/runs does not exist", () => {
    const cwd = mkdtempSync(join(tmpdir(), "aiflow-mon-empty-"));
    try {
      expect(readRunSnapshot(cwd)).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("reads state + events from disk for the latest run", () => {
    const cwd = setupFixture(SAMPLE_STATE, SAMPLE_EVENTS);
    try {
      const snap = readRunSnapshot(cwd);
      expect(snap).toBeDefined();
      expect(snap!.runId).toBe("run-test");
      expect(snap!.state.pipeline).toBe("ralph-only");
      expect(snap!.events.length).toBe(4);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("watchRun + runStatus", () => {
  function setupFixture(state: EngineState): string {
    const cwd = mkdtempSync(join(tmpdir(), "aiflow-mon-"));
    const runDir = join(cwd, ".aiflow", "runs", "run-watch");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state));
    return cwd;
  }

  test("runStatus exits non-zero when no run exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "aiflow-mon-empty2-"));
    const writes: string[] = [];
    const origStdout = process.stdout.write.bind(process.stdout);
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((s: string) => { writes.push(s); return true; }) as any;
    process.stderr.write = ((s: string) => { writes.push(s); return true; }) as any;
    try {
      const code = runStatus(cwd, { tail: 5 });
      expect(code).toBe(1);
      expect(writes.join("")).toContain("No run found");
    } finally {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("watchRun renders once then aborts when signal is set", async () => {
    const cwd = setupFixture(SAMPLE_STATE);
    const writes: string[] = [];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const snap: RunSnapshot = {
      runId: "run-watch",
      runDir: join(cwd, ".aiflow", "runs", "run-watch"),
      startedAt: new Date(),
      state: SAMPLE_STATE,
      events: [],
    };
    await watchRun(cwd, {
      tail: 5,
      write: (s) => writes.push(s),
      signal: controller.signal,
      intervalMs: 20,
      readSnapshot: () => snap,
    });
    rmSync(cwd, { recursive: true, force: true });
    const joined = writes.join("");
    expect(joined).toContain("\x1b[?25l"); // hide cursor
    expect(joined).toContain("\x1b[2J\x1b[H"); // clear screen
    expect(joined).toContain("20260705_192000_a1b2c3");
    expect(joined).toContain("ralph-only");
  });
});
