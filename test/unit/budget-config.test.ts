import { test, expect } from "bun:test";
import { BudgetConfigSchema } from "../../src/config/schema";

test("BudgetConfigSchema accepts optional warn_at_pct percentages", () => {
  const parsed = BudgetConfigSchema.parse({ max_cost_usd: 10, warn_at_pct: [0.5, 0.8] });
  expect(parsed.warn_at_pct).toEqual([0.5, 0.8]);
});

test("BudgetConfigSchema rejects warn_at_pct values above 1", () => {
  expect(() => BudgetConfigSchema.parse({ max_cost_usd: 10, warn_at_pct: [1.5] })).toThrow();
});

test("BudgetConfigSchema allows omitting warn_at_pct", () => {
  const parsed = BudgetConfigSchema.parse({ max_cost_usd: 10 });
  expect(parsed.warn_at_pct).toBeUndefined();
});
