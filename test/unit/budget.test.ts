import { test, expect } from "bun:test";
import { createBudgetTracker, noopBudgetTracker } from "../../src/gate/budget";

test("record() returns false while cumulative spend stays under the limit", () => {
  const tracker = createBudgetTracker(10, 0);
  expect(tracker.record(3)).toBe(false);
  expect(tracker.record(4)).toBe(false);
});

test("record() returns true once cumulative spend reaches the limit", () => {
  const tracker = createBudgetTracker(10, 0);
  expect(tracker.record(6)).toBe(false);
  expect(tracker.record(4)).toBe(true);
});

test("record() accounts for spend already made in prior stages via initialSpentUsd", () => {
  const tracker = createBudgetTracker(10, 9);
  expect(tracker.record(1)).toBe(true);
});

test("an undefined limitUsd never reports exceeded regardless of spend", () => {
  const tracker = createBudgetTracker(undefined, 0);
  expect(tracker.record(1_000_000)).toBe(false);
});

test("noopBudgetTracker never reports exceeded", () => {
  expect(noopBudgetTracker.record(1_000_000)).toBe(false);
  expect(noopBudgetTracker.limitUsd).toBeUndefined();
});
