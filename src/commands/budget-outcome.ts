import type { EngineState } from "../engine/state";

/**
 * Returns a one-line budget outcome note for a finished run, or undefined when
 * no note applies. "exceeded" when spend reached the limit; "near limit" when
 * spend passed the highest configured warn_at_pct threshold but stayed under
 * the limit. Without warn_at_pct, only "exceeded" is possible.
 */
export function formatBudgetOutcomeLine(state: EngineState): string | undefined {
  const budget = state.budget;
  if (!budget) return undefined;
  const spent = state.cost.est_usd;
  const limit = budget.limit_usd;
  const spentStr = `$${spent.toFixed(4)}`;
  const limitStr = `$${limit.toFixed(4)}`;
  if (spent >= limit) {
    return `Budget exceeded: ${spentStr} / ${limitStr}`;
  }
  const thresholds = budget.warn_at_pct ?? [];
  if (thresholds.length > 0 && limit > 0) {
    const highest = Math.max(...thresholds);
    if (spent >= highest * limit) {
      const pct = Math.round((spent / limit) * 100);
      return `Budget near limit: ${spentStr} / ${limitStr} (${pct}%)`;
    }
  }
  return undefined;
}
