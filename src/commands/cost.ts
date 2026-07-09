import { readEvents } from "../events/events";
import { join } from "node:path";
import type { EngineState } from "../engine/state";
import type { AiflowEvent } from "../events/events";
import { listRunIdsByMtimeDesc, loadRun as loadRunState, runsRoot } from "../runs/store";

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

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", gray: "\x1b[90m" } as const;

function paint(code: keyof typeof ANSI, on: boolean, text: string): string {
  return on ? `${ANSI[code]}${text}${ANSI.reset}` : text;
}

function commas(n: number): string {
  return n.toLocaleString("en-US");
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function escapeCsv(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

export function renderRunCostTable(summary: RunCostSummary, opts: { color?: boolean } = {}): string {
  const color = opts.color !== false;
  const lines: string[] = [];
  lines.push(paint("bold", color, `Cost — run ${summary.runId} (pipeline: ${summary.pipeline})`));
  lines.push("");
  if (!summary.breakdownAvailable) {
    lines.push("  Per-stage breakdown unavailable for this run (predates stage_cost events).");
    lines.push(`  Total (run-level): ${usd(summary.runLevelCostUsd)}`);
    return lines.join("\n");
  }
  const stageW = Math.max(14, ...summary.stages.map((s) => s.stage.length));
  const header = `  ${"Stage".padEnd(stageW)}  ${"In tokens".padStart(12)}  ${"Out tokens".padStart(12)}  ${"Cost".padStart(10)}`;
  lines.push(paint("bold", color, header));
  for (const s of summary.stages) {
    lines.push(`  ${s.stage.padEnd(stageW)}  ${commas(s.inTok).padStart(12)}  ${commas(s.outTok).padStart(12)}  ${usd(s.costUsd).padStart(10)}`);
  }
  lines.push(`  ${"-".repeat(stageW + 40)}`);
  lines.push(`  ${"Total".padEnd(stageW)}  ${commas(summary.totalInTok).padStart(12)}  ${commas(summary.totalOutTok).padStart(12)}  ${usd(summary.totalCostUsd).padStart(10)}`);
  if (Math.abs(summary.totalCostUsd - summary.runLevelCostUsd) > 1e-9) {
    lines.push(paint("gray", color, `  (run-level state.cost: ${usd(summary.runLevelCostUsd)})`));
  }
  return lines.join("\n");
}

export function renderAllRunsCostTable(summary: AllRunsCostSummary, opts: { color?: boolean } = {}): string {
  const color = opts.color !== false;
  const lines: string[] = [];
  lines.push(paint("bold", color, "Cost — all runs"));
  lines.push("");
  const runW = Math.max(20, ...summary.rows.map((r) => r.runId.length));
  const pipeW = Math.max(10, ...summary.rows.map((r) => r.pipeline.length));
  const header = `  ${"Run".padEnd(runW)}  ${"Pipeline".padEnd(pipeW)}  ${"In tokens".padStart(12)}  ${"Out tokens".padStart(12)}  ${"Cost".padStart(10)}`;
  lines.push(paint("bold", color, header));
  let anyDegraded = false;
  for (const r of summary.rows) {
    const mark = r.breakdownAvailable ? "" : " *";
    if (!r.breakdownAvailable) anyDegraded = true;
    lines.push(`  ${r.runId.padEnd(runW)}  ${r.pipeline.padEnd(pipeW)}  ${commas(r.totalInTok).padStart(12)}  ${commas(r.totalOutTok).padStart(12)}  ${usd(r.totalCostUsd).padStart(10)}${mark}`);
  }
  lines.push(`  ${"-".repeat(runW + pipeW + 40)}`);
  lines.push(`  ${"Grand total".padEnd(runW)}  ${"".padEnd(pipeW)}  ${commas(summary.grandTotalInTok).padStart(12)}  ${commas(summary.grandTotalOutTok).padStart(12)}  ${usd(summary.grandTotalCostUsd).padStart(10)}`);
  if (anyDegraded) {
    lines.push(paint("gray", color, "  * per-stage breakdown unavailable (predates stage_cost events)"));
  }
  return lines.join("\n");
}

export function renderCostJson(summary: RunCostSummary | AllRunsCostSummary): string {
  return JSON.stringify(summary, null, 2);
}

export function renderRunCostCsv(summary: RunCostSummary): string {
  const lines: string[] = ["stage,in_tok,out_tok,cost_usd"];
  for (const s of summary.stages) {
    lines.push(`${escapeCsv(s.stage)},${s.inTok},${s.outTok},${s.costUsd}`);
  }
  lines.push(`${escapeCsv("total")},${summary.totalInTok},${summary.totalOutTok},${summary.totalCostUsd}`);
  return lines.join("\n") + "\n";
}

export function renderAllRunsCostCsv(summary: AllRunsCostSummary): string {
  const lines: string[] = ["run_id,pipeline,in_tok,out_tok,cost_usd,breakdown_available"];
  for (const r of summary.rows) {
    lines.push(`${escapeCsv(r.runId)},${escapeCsv(r.pipeline)},${r.totalInTok},${r.totalOutTok},${r.totalCostUsd},${r.breakdownAvailable}`);
  }
  return lines.join("\n") + "\n";
}

export interface RunCostOptions {
  runId?: string;
  all?: boolean;
  json?: boolean;
  csv?: boolean;
  color?: boolean;
  write?: (s: string) => void;
  writeErr?: (s: string) => void;
}

interface LoadedRun {
  runId: string;
  state: EngineState;
  events: AiflowEvent[];
}

function loadRun(cwd: string, runId: string): LoadedRun | undefined {
  const loaded = loadRunState(cwd, runId);
  if (!loaded) return undefined;
  return { runId, state: loaded.state, events: readEvents(join(runsRoot(cwd), runId)) };
}

export function runCost(cwd: string, opts: RunCostOptions): number {
  const write = opts.write ?? ((s) => process.stdout.write(s));
  const writeErr = opts.writeErr ?? ((s) => process.stderr.write(s));
  const color = opts.color !== false;

  if (opts.json && opts.csv) {
    writeErr("--json and --csv are mutually exclusive\n");
    return 1;
  }
  if (opts.all && opts.runId) {
    writeErr("--all and --run-id are mutually exclusive\n");
    return 1;
  }

  if (opts.all) {
    const ids = listRunIdsByMtimeDesc(cwd);
    if (ids.length === 0) {
      writeErr(`No runs found in ${runsRoot(cwd)}\n`);
      return 1;
    }
    const loaded = ids.map((id) => loadRun(cwd, id)).filter((r): r is LoadedRun => r !== undefined);
    const summary = summarizeAllRunsCost(loaded);
    if (opts.json) write(renderCostJson(summary) + "\n");
    else if (opts.csv) write(renderAllRunsCostCsv(summary));
    else write(renderAllRunsCostTable(summary, { color }) + "\n");
    return 0;
  }

  let runId = opts.runId;
  if (!runId) {
    const ids = listRunIdsByMtimeDesc(cwd);
    if (ids.length === 0) {
      writeErr(`No runs found in ${runsRoot(cwd)}\n`);
      return 1;
    }
    runId = ids[0];
  }
  const loaded = loadRun(cwd, runId);
  if (!loaded) {
    writeErr(`Run ${runId} not found in ${runsRoot(cwd)}\n`);
    return 1;
  }
  const summary = summarizeRunCost(loaded.runId, loaded.state, loaded.events);
  if (opts.json) write(renderCostJson(summary) + "\n");
  else if (opts.csv) write(renderRunCostCsv(summary));
  else write(renderRunCostTable(summary, { color }) + "\n");
  return 0;
}
