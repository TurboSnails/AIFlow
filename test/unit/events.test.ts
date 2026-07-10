import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEvents, type AiflowEvent } from "../../src/events/events";

test("appendEvent then readEvents round-trips multiple events in order", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-events-test-"));
  try {
    const e1: AiflowEvent = {
      ts: "2026-07-05T00:00:00.000Z",
      type: "opencode_tool_use",
      stage: "develop",
      story: "US-1",
      tool: "write",
      summary: "wrote src/math.ts",
    };
    const e2: AiflowEvent = {
      ts: "2026-07-05T00:00:01.000Z",
      type: "opencode_step_finish",
      stage: "develop",
      in_tok: 100,
      out_tok: 20,
      cost_usd: 0.001,
    };
    const e3: AiflowEvent = {
      ts: "2026-07-05T00:00:02.000Z",
      type: "gate_result",
      stage: "develop",
      story: "US-1",
      checks: "pass",
      ai_review: "pass",
      blockers: 0,
    };
    const e4: AiflowEvent = {
      ts: "2026-07-05T00:00:03.000Z",
      type: "story_result",
      story: "US-1",
      result: "pass",
    };
    appendEvent(dir, e1);
    appendEvent(dir, e2);
    appendEvent(dir, e3);
    appendEvent(dir, e4);
    const events = readEvents(dir);
    expect(events).toEqual([e1, e2, e3, e4]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendEvent then readEvents round-trips a ralph_loop_result event", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-events-test-"));
  try {
    const e: AiflowEvent = {
      ts: "2026-07-06T00:00:00.000Z",
      type: "ralph_loop_result",
      stage: "develop",
      result: "suspended",
      reason: "stall",
      iterations: 3,
      stories_done: 1,
      stories_suspended: 0,
      stories_pending: 2,
    };
    appendEvent(dir, e);
    const events = readEvents(dir);
    expect(events).toEqual([e]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendEvent then readEvents round-trips a stage_cost event", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-events-test-"));
  try {
    const e: AiflowEvent = {
      ts: "2026-07-08T00:00:00.000Z",
      type: "stage_cost",
      stage: "develop",
      in_tok: 1200,
      out_tok: 340,
      cost_usd: 0.0512,
    };
    appendEvent(dir, e);
    const events = readEvents(dir);
    expect(events).toEqual([e]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readEvents returns an empty array when events.jsonl is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-events-missing-"));
  try {
    expect(readEvents(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readEvents skips corrupt lines and keeps valid ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-events-corrupt-"));
  try {
    writeFileSync(
      join(dir, "events.jsonl"),
      '{"ts":"2026-07-05T00:00:00.000Z","type":"story_result","story":"US-1","result":"pass"}\nnot json\n\n{"ts":"2026-07-05T00:00:01.000Z","type":"story_result","story":"US-2","result":"fail"}\n',
    );
    const events = readEvents(dir);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ story: "US-1", result: "pass" });
    expect(events[1]).toMatchObject({ story: "US-2", result: "fail" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("budget_warning event round-trips through appendEvent/readEvents", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-events-test-"));
  try {
    const evt: AiflowEvent = {
      ts: "2026-07-08T00:00:00.000Z",
      type: "budget_warning",
      stage: "build",
      threshold_pct: 0.8,
      spent_usd: 8.5,
      limit_usd: 10,
    };
    appendEvent(dir, evt);
    const read = readEvents(dir);
    expect(read).toEqual([evt]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("can append and read review_verdict event", () => {
  const runDir = mkdtempSync(join(tmpdir(), "evt-"));
  try {
    appendEvent(runDir, {
      ts: new Date().toISOString(),
      type: "review_verdict",
      stage: "develop",
      story: "T1",
      reviewers: { kimi: "fail", ds: "pass" },
      arbitrated: true,
      final: "fail",
    });
    const events = readEvents(runDir);
    expect(events[0].type).toBe("review_verdict");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
