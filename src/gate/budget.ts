export interface BudgetTracker {
  limitUsd?: number;
  /** Records a newly-spent amount and returns true if the cumulative total has now reached the limit. */
  record(deltaUsd: number): boolean;
}

export function createBudgetTracker(limitUsd: number | undefined, initialSpentUsd: number): BudgetTracker {
  let spent = initialSpentUsd;
  return {
    limitUsd,
    record(deltaUsd: number): boolean {
      spent += deltaUsd;
      return limitUsd !== undefined && spent >= limitUsd;
    },
  };
}

export const noopBudgetTracker: BudgetTracker = { limitUsd: undefined, record: () => false };
