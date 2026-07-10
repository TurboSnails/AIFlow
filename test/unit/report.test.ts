import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRunReport, runReport } from "../../src/commands/report";
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

  test("includes the stage's reason when present, and an empty cell when absent", () => {
    const stateWithReason: EngineState = {
      ...STATE,
      stages: [{ id: "develop", status: "suspended", reason: "stall" }],
    };
    const out = renderRunReport(stateWithReason, EVENTS, {
      now: new Date("2026-07-05T19:21:30.000Z"),
      startedAt: new Date("2026-07-05T19:20:00.000Z"),
    });
    expect(out).toContain("| develop | suspended | stall |");
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
  test("includes review distribution, debate summary, and gate blockers", () => {
    const events: AiflowEvent[] = [
      {
        ts: "2026-07-05T19:20:00.000Z",
        type: "review_verdict",
        stage: "review",
        story: "US-1",
        reviewers: { alice: "pass", bob: "fail" },
        arbitrated: true,
        final: "fail",
      },
      {
        ts: "2026-07-05T19:20:01.000Z",
        type: "review_verdict",
        stage: "review",
        story: "US-2",
        reviewers: { alice: "skipped", bob: "pass" },
        arbitrated: false,
        final: "pass",
      },
      { ts: "2026-07-05T19:20:02.000Z", type: "debate_round", stage: "plan", round: 1, resolved: 1, remaining: 2 },
      { ts: "2026-07-05T19:20:03.000Z", type: "debate_end", stage: "plan", reason: "max_rounds", open_questions: 3 },
      { ts: "2026-07-05T19:20:04.000Z", type: "gate_result", stage: "develop", story: "US-1", checks: "fail", ai_review: "pass", blockers: 2 },
    ];
    const out = renderRunReport(STATE, events, {
      now: new Date("2026-07-05T19:21:30.000Z"),
      startedAt: new Date("2026-07-05T19:20:00.000Z"),
    });
    expect(out).toContain("## Reviews");
    expect(out).toContain("| alice | 1 | 0 | 1 |");
    expect(out).toContain("| bob | 1 | 1 | 0 |");
    expect(out).toContain("## Debates");
    expect(out).toContain("- rounds: 1");
    expect(out).toContain("- open questions: 3");
    expect(out).toContain("## Gate Results");
    expect(out).toContain("- total blockers: 2");
    expect(out).toContain("develop/US-1 (2 blockers)");
  });
});

function writeRun(cwd: string, runId: string, state: Partial<EngineState>): void {
  const runDir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const full: EngineState = {
    run_id: runId,
    pipeline: "demo",
    stages: [{ id: "s1", status: "done" }],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    ...state,
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(full));
}

test("runReport returns no_runs when there are no runs", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-report-empty-"));
  try {
    const result = runReport(cwd, {});
    expect(result.status).toBe("no_runs");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runReport renders a report for the latest run", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-report-latest-"));
  try {
    writeRun(cwd, "20260101_120000_test", {});
    const result = runReport(cwd, {});
    expect(result.status).toBe("ok");
    expect(result.report).toContain("Run report");
    expect(result.report).toContain("20260101_120000_test");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
