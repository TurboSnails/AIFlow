export interface BudgetTracker {
  limitUsd?: number;
  /** Records a newly-spent amount and returns true once cumulative spend reaches the limit. */
  record(deltaUsd: number): boolean;
  /** Returns (ascending) and clears the warning thresholds newly crossed since the last drain. */
  drainPendingWarnings(): number[];
}

export function createBudgetTracker(
  limitUsd: number | undefined,
  initialSpentUsd: number,
  warnAtPct: number[] = [],
): BudgetTracker {
  let spent = initialSpentUsd;
  const thresholds = [...new Set(warnAtPct)].sort((a, b) => a - b);
  const warned = new Set<number>();
  const pending: number[] = [];

  // Pre-mark thresholds already crossed by the resumed starting spend so a
  // resume does not re-warn for history.
  if (limitUsd !== undefined && limitUsd > 0) {
    const startRatio = spent / limitUsd;
    for (const t of thresholds) {
      if (startRatio >= t) warned.add(t);
    }
  }

  return {
    limitUsd,
    record(deltaUsd: number): boolean {
      spent += deltaUsd;
      if (limitUsd !== undefined && limitUsd > 0) {
        const ratio = spent / limitUsd;
        for (const t of thresholds) {
          if (ratio >= t && !warned.has(t)) {
            warned.add(t);
            pending.push(t);
          }
        }
      }
      return limitUsd !== undefined && spent >= limitUsd;
    },
    drainPendingWarnings(): number[] {
      const out = pending.slice().sort((a, b) => a - b);
      pending.length = 0;
      return out;
    },
  };
}

export const noopBudgetTracker: BudgetTracker = {
  limitUsd: undefined,
  record: () => false,
  drainPendingWarnings: () => [],
};
