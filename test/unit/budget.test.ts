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

test("drainPendingWarnings returns each crossed threshold once, in ascending order", () => {
  const tracker = createBudgetTracker(10, 0, [0.5, 0.8]);
  tracker.record(3); // 30% — none crossed
  expect(tracker.drainPendingWarnings()).toEqual([]);
  tracker.record(3); // 60% — crosses 0.5
  expect(tracker.drainPendingWarnings()).toEqual([0.5]);
  tracker.record(2); // 80% — crosses 0.8
  expect(tracker.drainPendingWarnings()).toEqual([0.8]);
  // drained buffer is now empty
  expect(tracker.drainPendingWarnings()).toEqual([]);
});

test("a single record crossing multiple thresholds drains all of them ascending", () => {
  const tracker = createBudgetTracker(10, 0, [0.5, 0.8]);
  tracker.record(9); // 90% — crosses both 0.5 and 0.8 at once
  expect(tracker.drainPendingWarnings()).toEqual([0.5, 0.8]);
});

test("each threshold warns at most once even across many records", () => {
  const tracker = createBudgetTracker(10, 0, [0.5]);
  tracker.record(6); // crosses 0.5
  expect(tracker.drainPendingWarnings()).toEqual([0.5]);
  tracker.record(1); // still above 0.5, but already warned
  expect(tracker.drainPendingWarnings()).toEqual([]);
});

test("thresholds already crossed by initialSpentUsd are pre-marked and never warn (resume)", () => {
  const tracker = createBudgetTracker(10, 6, [0.5, 0.8]); // 60% already spent
  tracker.record(1); // 70% — 0.5 already passed at init, 0.8 not yet
  expect(tracker.drainPendingWarnings()).toEqual([]);
  tracker.record(1); // 80% — crosses 0.8
  expect(tracker.drainPendingWarnings()).toEqual([0.8]);
});

test("an undefined limitUsd yields no warnings and record stays false", () => {
  const tracker = createBudgetTracker(undefined, 0, [0.5, 0.8]);
  expect(tracker.record(1_000_000)).toBe(false);
  expect(tracker.drainPendingWarnings()).toEqual([]);
});

test("warnAtPct is sorted and de-duplicated", () => {
  const tracker = createBudgetTracker(10, 0, [0.8, 0.5, 0.8]);
  tracker.record(9); // crosses both distinct thresholds
  expect(tracker.drainPendingWarnings()).toEqual([0.5, 0.8]);
});

test("noopBudgetTracker drains empty", () => {
  expect(noopBudgetTracker.drainPendingWarnings()).toEqual([]);
});
