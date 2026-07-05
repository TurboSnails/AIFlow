import { test, expect, describe } from "bun:test";
import { renderRunReport } from "../../src/commands/report";
import type { EngineState } from "../../src/engine/state";
import type { AiflowEvent } from "../../src/events/events";

const STATE: EngineState = {
  run_id: "20260705_192000_a1b2c3",
  pipeline: "ralph-only",
  stages: [
    { id: "develop", status: "done" },
  ],
  cost: { input_tokens: 1234, output_tokens: 567, est_usd: 0.12 },
};

const EVENTS: AiflowEvent[] = [
  { ts: "2026-07-05T19:20:00.000Z", type: "opencode_tool_use", stage: "develop", story: "US-1", tool: "read", summary: "read (completed)" },
  { ts: "2026-07-05T19:20:01.000Z", type: "opencode_step_finish", stage: "develop", in_tok: 100, out_tok: 50, cost_usd: 0.05 },
  { ts: "2026-07-05T19:20:02.000Z", type: "opencode_step_finish", stage: "develop", in_tok: 200, out_tok: 80, cost_usd: 0.07 },
  { ts: "2026-07-05T19:20:03.000Z", type: "gate_result", stage: "develop", story: "US-1", checks: "pass", ai_review: "pass", blockers: 0 },
  { ts: "2026-07-05T19:20:04.000Z", type: "story_result", story: "US-1", result: "pass" },
  { ts: "2026-07-05T19:20:05.000Z", type: "story_result", story: "US-2", result: "fail" },
  { ts: "2026-07-05T19:20:06.000Z", type: "story_result", story: "US-3", result: "suspended" },
];

describe("renderRunReport", () => {
  test("renders the H1 with run_id and pipeline name", () => {
    const out = renderRunReport(STATE, EVENTS, {
      now: new Date("2026-07-05T19:21:30.000Z"),
      startedAt: new Date("2026-07-05T19:20:00.000Z"),
    });
    expect(out).toContain("# Run report — 20260705_192000_a1b2c3");
    expect(out).toContain("Pipeline: `ralph-only`");
  });

  test("includes a stages section listing each stage with its status", () => {
    const out = renderRunReport(STATE, EVENTS, {
      now: new Date("2026-07-05T19:21:30.000Z"),
      startedAt: new Date("2026-07-05T19:20:00.000Z"),
    });
    expect(out).toContain("## Stages");
    expect(out).toContain("| develop |");
    expect(out).toContain("done |");
  });

  test("includes a duration row computed from startedAt → now", () => {
    const out = renderRunReport(STATE, EVENTS, {
      now: new Date("2026-07-05T19:21:30.000Z"),
      startedAt: new Date("2026-07-05T19:20:00.000Z"),
    });
    expect(out).toContain("Duration: 90s");
  });

  test("includes cost summary from state.cost", () => {
    const out = renderRunReport(STATE, EVENTS, {
      now: new Date("2026-07-05T19:21:30.000Z"),
      startedAt: new Date("2026-07-05T19:20:00.000Z"),
    });
    expect(out).toContain("## Cost");
    expect(out).toContain("input tokens: 1234");
    expect(out).toContain("output tokens: 567");
    expect(out).toContain("est_usd: 0.12");
  });

  test("includes an events-by-type breakdown", () => {
    const out = renderRunReport(STATE, EVENTS, {
      now: new Date("2026-07-05T19:21:30.000Z"),
      startedAt: new Date("2026-07-05T19:20:00.000Z"),
    });
    expect(out).toContain("## Events");
    expect(out).toContain("opencode_tool_use: 1");
    expect(out).toContain("opencode_step_finish: 2");
    expect(out).toContain("gate_result: 1");
    expect(out).toContain("story_result: 3");
  });

  test("includes a stories table grouped by result (pass/fail/suspended)", () => {
    const out = renderRunReport(STATE, EVENTS, {
      now: new Date("2026-07-05T19:21:30.000Z"),
      startedAt: new Date("2026-07-05T19:20:00.000Z"),
    });
    expect(out).toContain("## Stories");
    expect(out).toContain("US-1");
    expect(out).toContain("US-2");
    expect(out).toContain("US-3");
    expect(out).toContain("pass (1)");
    expect(out).toContain("fail (1)");
    expect(out).toContain("suspended (1)");
  });

  test("uses UTC ISO timestamps so the report is reproducible across timezones", () => {
    const out = renderRunReport(STATE, EVENTS, {
      now: new Date("2026-07-05T19:21:30.000Z"),
      startedAt: new Date("2026-07-05T19:20:00.000Z"),
    });
    expect(out).toContain("2026-07-05T19:21:30.000Z");
  });
});
