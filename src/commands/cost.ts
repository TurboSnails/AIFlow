import type { EngineState } from "../engine/state";
import type { AiflowEvent } from "../events/events";

export interface StageCost {
  stage: string;
  inTok: number;
  outTok: number;
  costUsd: number;
}

export interface RunCostSummary {
  runId: string;
  pipeline: string;
  stages: StageCost[];
  totalInTok: number;
  totalOutTok: number;
  totalCostUsd: number;
  runLevelCostUsd: number;
  breakdownAvailable: boolean;
}

export interface AllRunsCostRow {
  runId: string;
  pipeline: string;
  totalInTok: number;
  totalOutTok: number;
  totalCostUsd: number;
  breakdownAvailable: boolean;
}

export interface AllRunsCostSummary {
  rows: AllRunsCostRow[];
  grandTotalInTok: number;
  grandTotalOutTok: number;
  grandTotalCostUsd: number;
}

export function summarizeRunCost(runId: string, state: EngineState, events: AiflowEvent[]): RunCostSummary {
  const order: string[] = [];
  const byStage = new Map<string, StageCost>();
  for (const e of events) {
    if (e.type !== "stage_cost") continue;
    let row = byStage.get(e.stage);
    if (!row) {
      row = { stage: e.stage, inTok: 0, outTok: 0, costUsd: 0 };
      byStage.set(e.stage, row);
      order.push(e.stage);
    }
    row.inTok += e.in_tok;
    row.outTok += e.out_tok;
    row.costUsd += e.cost_usd;
  }
  const stages = order.map((s) => byStage.get(s)!);
  const totalInTok = stages.reduce((a, s) => a + s.inTok, 0);
  const totalOutTok = stages.reduce((a, s) => a + s.outTok, 0);
  const totalCostUsd = stages.reduce((a, s) => a + s.costUsd, 0);
  return {
    runId,
    pipeline: state.pipeline,
    stages,
    totalInTok,
    totalOutTok,
    totalCostUsd,
    runLevelCostUsd: state.cost.est_usd,
    breakdownAvailable: stages.length > 0,
  };
}

export function summarizeAllRunsCost(
  runs: { runId: string; state: EngineState; events: AiflowEvent[] }[]
): AllRunsCostSummary {
  const rows: AllRunsCostRow[] = runs.map(({ runId, state, events }) => ({
    runId,
    pipeline: state.pipeline,
    totalInTok: state.cost.input_tokens,
    totalOutTok: state.cost.output_tokens,
    totalCostUsd: state.cost.est_usd,
    breakdownAvailable: events.some((e) => e.type === "stage_cost"),
  }));
  return {
    rows,
    grandTotalInTok: rows.reduce((a, r) => a + r.totalInTok, 0),
    grandTotalOutTok: rows.reduce((a, r) => a + r.totalOutTok, 0),
    grandTotalCostUsd: rows.reduce((a, r) => a + r.totalCostUsd, 0),
  };
}
