import { test, expect } from "bun:test";
import { summarizeRunCost, summarizeAllRunsCost } from "../../src/commands/cost";
import type { EngineState } from "../../src/engine/state";
import type { AiflowEvent } from "../../src/events/events";

function stateWith(estUsd: number, pipeline = "full-auto"): EngineState {
  return {
    run_id: "r1",
    pipeline,
    stages: [],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: estUsd },
  };
}

function stageCost(stage: string, inTok: number, outTok: number, costUsd: number): AiflowEvent {
  return { ts: "2026-07-08T00:00:00.000Z", type: "stage_cost", stage, in_tok: inTok, out_tok: outTok, cost_usd: costUsd };
}

test("summarizeRunCost groups stage_cost events by stage and totals them", () => {
  const events: AiflowEvent[] = [
    stageCost("ideate", 12400, 3100, 0.062),
    stageCost("develop", 120000, 45000, 0.95),
  ];
  const s = summarizeRunCost("r1", stateWith(1.012), events);
  expect(s.breakdownAvailable).toBe(true);
  expect(s.stages).toEqual([
    { stage: "ideate", inTok: 12400, outTok: 3100, costUsd: 0.062 },
    { stage: "develop", inTok: 120000, outTok: 45000, costUsd: 0.95 },
  ]);
  expect(s.totalInTok).toBe(132400);
  expect(s.totalOutTok).toBe(48100);
  expect(s.totalCostUsd).toBeCloseTo(1.012, 10);
  expect(s.runLevelCostUsd).toBe(1.012);
  expect(s.pipeline).toBe("full-auto");
});

test("summarizeRunCost accumulates multiple stage_cost events for the same stage into one row", () => {
  const events: AiflowEvent[] = [
    stageCost("develop", 100, 10, 0.1),
    stageCost("develop", 200, 20, 0.2),
  ];
  const s = summarizeRunCost("r1", stateWith(0.3), events);
  expect(s.stages.length).toBe(1);
  expect(s.stages[0]?.stage).toBe("develop");
  expect(s.stages[0]?.inTok).toBe(300);
  expect(s.stages[0]?.outTok).toBe(30);
  expect(s.stages[0]?.costUsd).toBeCloseTo(0.3, 10);
  expect(s.totalCostUsd).toBeCloseTo(0.3, 10);
});

test("summarizeRunCost degrades gracefully for a run with no stage_cost events", () => {
  const s = summarizeRunCost("old-run", stateWith(0.5), [
    { ts: "t", type: "story_result", story: "US-1", result: "pass" },
  ]);
  expect(s.breakdownAvailable).toBe(false);
  expect(s.stages).toEqual([]);
  expect(s.totalCostUsd).toBe(0);
  expect(s.totalInTok).toBe(0);
  expect(s.totalOutTok).toBe(0);
  expect(s.runLevelCostUsd).toBe(0.5);
});

test("summarizeAllRunsCost uses run-level state.cost per row and computes grand totals", () => {
  const runs = [
    { runId: "r2", state: { ...stateWith(2, "p2"), cost: { input_tokens: 20, output_tokens: 8, est_usd: 2 } }, events: [stageCost("develop", 20, 8, 2)] },
    { runId: "r1", state: { ...stateWith(0.5, "p1"), cost: { input_tokens: 10, output_tokens: 4, est_usd: 0.5 } }, events: [] as AiflowEvent[] },
  ];
  const s = summarizeAllRunsCost(runs);
  expect(s.rows).toEqual([
    { runId: "r2", pipeline: "p2", totalInTok: 20, totalOutTok: 8, totalCostUsd: 2, breakdownAvailable: true },
    { runId: "r1", pipeline: "p1", totalInTok: 10, totalOutTok: 4, totalCostUsd: 0.5, breakdownAvailable: false },
  ]);
  expect(s.grandTotalInTok).toBe(30);
  expect(s.grandTotalOutTok).toBe(12);
  expect(s.grandTotalCostUsd).toBeCloseTo(2.5, 10);
});
