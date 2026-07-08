import { test, expect } from "bun:test";
import { formatBudgetOutcomeLine } from "../../src/commands/budget-outcome";
import type { EngineState } from "../../src/engine/state";

function stateWith(estUsd: number, budget?: { limit_usd: number; warn_at_pct?: number[] }): EngineState {
  return {
    run_id: "r",
    pipeline: "p",
    stages: [],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: estUsd },
    ...(budget ? { budget } : {}),
  };
}

test("returns exceeded line when spend reaches the limit", () => {
  const line = formatBudgetOutcomeLine(stateWith(10.5, { limit_usd: 10, warn_at_pct: [0.8] }));
  expect(line).toBe("Budget exceeded: $10.5000 / $10.0000");
});

test("returns near-limit line when spend passes the highest warn threshold but stays under limit", () => {
  const line = formatBudgetOutcomeLine(stateWith(8.5, { limit_usd: 10, warn_at_pct: [0.5, 0.8] }));
  expect(line).toBe("Budget near limit: $8.5000 / $10.0000 (85%)");
});

test("returns undefined when spend is below the highest warn threshold", () => {
  expect(formatBudgetOutcomeLine(stateWith(6, { limit_usd: 10, warn_at_pct: [0.8] }))).toBeUndefined();
});

test("returns undefined when there is no budget", () => {
  expect(formatBudgetOutcomeLine(stateWith(100))).toBeUndefined();
});

test("without warn_at_pct only exceeded can appear (no near-limit)", () => {
  expect(formatBudgetOutcomeLine(stateWith(9.9, { limit_usd: 10 }))).toBeUndefined();
  expect(formatBudgetOutcomeLine(stateWith(10, { limit_usd: 10 }))).toBe("Budget exceeded: $10.0000 / $10.0000");
});
