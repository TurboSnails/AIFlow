import { test, expect } from "bun:test";
import {
  summarizeRunCost,
  summarizeAllRunsCost,
  renderRunCostTable,
  renderAllRunsCostTable,
  renderCostJson,
  renderRunCostCsv,
  renderAllRunsCostCsv,
  runCost,
} from "../../src/commands/cost";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("renderRunCostTable shows per-stage rows, a total row, and the run/pipeline header", () => {
  const s = summarizeRunCost("run-x", stateWith(1.012, "full-auto"), [
    stageCost("ideate", 12400, 3100, 0.062),
    stageCost("develop", 120000, 45000, 0.95),
  ]);
  const out = renderRunCostTable(s, { color: false });
  expect(out).toContain("run-x");
  expect(out).toContain("full-auto");
  expect(out).toContain("ideate");
  expect(out).toContain("develop");
  expect(out).toContain("Total");
  expect(out).toContain("$1.0120");
  // 千位分隔
  expect(out).toContain("120,000");
});

test("renderRunCostTable prints the degraded notice and run-level total when breakdown is unavailable", () => {
  const s = summarizeRunCost("old-run", stateWith(0.5), []);
  const out = renderRunCostTable(s, { color: false });
  expect(out).toContain("Per-stage breakdown unavailable");
  expect(out).toContain("$0.5000");
  expect(out).not.toContain("Total  ");
});

test("renderRunCostTable adds a reconciliation line when stage sum differs from run-level cost", () => {
  const s = summarizeRunCost("run-x", stateWith(2.0), [stageCost("develop", 1, 1, 1.5)]);
  const out = renderRunCostTable(s, { color: false });
  expect(out).toContain("run-level state.cost: $2.0000");
});

test("renderCostJson serializes the RunCostSummary structurally", () => {
  const s = summarizeRunCost("run-x", stateWith(0.062, "p"), [stageCost("ideate", 12400, 3100, 0.062)]);
  const parsed = JSON.parse(renderCostJson(s));
  expect(parsed.runId).toBe("run-x");
  expect(parsed.stages[0]).toEqual({ stage: "ideate", inTok: 12400, outTok: 3100, costUsd: 0.062 });
  expect(parsed.breakdownAvailable).toBe(true);
});

test("renderRunCostCsv emits a header, one row per stage, and a total row without thousands separators", () => {
  const s = summarizeRunCost("run-x", stateWith(1.012), [
    stageCost("ideate", 12400, 3100, 0.062),
    stageCost("develop", 120000, 45000, 0.95),
  ]);
  const csv = renderRunCostCsv(s);
  const lines = csv.trim().split("\n");
  expect(lines[0]).toBe("stage,in_tok,out_tok,cost_usd");
  expect(lines[1]).toBe("ideate,12400,3100,0.062");
  expect(lines[2]).toBe("develop,120000,45000,0.95");
  expect(lines[3]).toBe("total,132400,48100,1.012");
});

test("renderAllRunsCostCsv emits a header and one row per run with breakdown_available", () => {
  const s = summarizeAllRunsCost([
    { runId: "r2", state: { ...stateWith(2, "p2"), cost: { input_tokens: 20, output_tokens: 8, est_usd: 2 } }, events: [stageCost("develop", 20, 8, 2)] },
    { runId: "r1", state: { ...stateWith(0.5, "p1"), cost: { input_tokens: 10, output_tokens: 4, est_usd: 0.5 } }, events: [] },
  ]);
  const csv = renderAllRunsCostCsv(s);
  const lines = csv.trim().split("\n");
  expect(lines[0]).toBe("run_id,pipeline,in_tok,out_tok,cost_usd,breakdown_available");
  expect(lines[1]).toBe("r2,p2,20,8,2,true");
  expect(lines[2]).toBe("r1,p1,10,4,0.5,false");
});

test("renderAllRunsCostTable appends the degraded * after the padded cost so the column stays aligned", () => {
  const s = summarizeAllRunsCost([
    {
      runId: "r2",
      state: { ...stateWith(2, "p2"), cost: { input_tokens: 20, output_tokens: 8, est_usd: 2 } },
      events: [] as AiflowEvent[],
    },
  ]);
  const out = renderAllRunsCostTable(s, { color: false });
  const rows = out.split("\n");
  const dataRow = rows.find((l) => l.includes("r2"))!;
  expect(dataRow).toContain("$2.0000 *");
  // The "*" should be the very last character on the data row.
  expect(dataRow.trimEnd().endsWith("*")).toBe(true);
});

test("renderAllRunsCostTable shows one row per run and a grand total", () => {
  const s = summarizeAllRunsCost([
    { runId: "r2", state: { ...stateWith(2, "p2"), cost: { input_tokens: 20, output_tokens: 8, est_usd: 2 } }, events: [stageCost("develop", 20, 8, 2)] },
  ]);
  const out = renderAllRunsCostTable(s, { color: false });
  expect(out).toContain("r2");
  expect(out).toContain("p2");
  expect(out).toContain("$2.0000");
  expect(out).toContain("Grand total");
});

function makeRun(cwd: string, runId: string, estUsd: number, stageEvents: AiflowEvent[]): void {
  const runDir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const state: EngineState = {
    run_id: runId,
    pipeline: "full-auto",
    stages: [{ id: "develop", status: "done" }],
    cost: { input_tokens: 100, output_tokens: 40, est_usd: estUsd },
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state));
  if (stageEvents.length > 0) {
    writeFileSync(join(runDir, "events.jsonl"), stageEvents.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
}

test("runCost renders the latest run's table by default and returns 0", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-cost-cmd-"));
  try {
    makeRun(cwd, "20260708_100000_aaaaaa", 0.5, [stageCost("develop", 100, 40, 0.5)]);
    let out = "";
    const code = runCost(cwd, { color: false, write: (s) => { out += s; } });
    expect(code).toBe(0);
    expect(out).toContain("develop");
    expect(out).toContain("$0.5000");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runCost --json emits parseable JSON for the run", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-cost-cmd-json-"));
  try {
    makeRun(cwd, "20260708_100000_bbbbbb", 0.5, [stageCost("develop", 100, 40, 0.5)]);
    let out = "";
    const code = runCost(cwd, { json: true, write: (s) => { out += s; } });
    expect(code).toBe(0);
    expect(JSON.parse(out).stages[0].stage).toBe("develop");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runCost --all lists every run with a grand total", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-cost-cmd-all-"));
  try {
    makeRun(cwd, "20260708_100000_run1aa", 0.5, [stageCost("develop", 100, 40, 0.5)]);
    makeRun(cwd, "20260708_110000_run2bb", 1.5, [stageCost("develop", 200, 80, 1.5)]);
    let out = "";
    const code = runCost(cwd, { all: true, color: false, write: (s) => { out += s; } });
    expect(code).toBe(0);
    expect(out).toContain("Grand total");
    expect(out).toContain("$2.0000");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runCost returns 1 and writes an error when there are no runs", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-cost-cmd-empty-"));
  try {
    let err = "";
    const code = runCost(cwd, { write: () => {}, writeErr: (s) => { err += s; } });
    expect(code).toBe(1);
    expect(err).toContain("No runs found");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runCost returns 1 when --json and --csv are combined", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-cost-cmd-x1-"));
  try {
    makeRun(cwd, "20260708_100000_cccccc", 0.5, [stageCost("develop", 100, 40, 0.5)]);
    let err = "";
    const code = runCost(cwd, { json: true, csv: true, write: () => {}, writeErr: (s) => { err += s; } });
    expect(code).toBe(1);
    expect(err).toContain("mutually exclusive");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runCost returns 1 when --all and --run-id are combined", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-cost-cmd-x2-"));
  try {
    makeRun(cwd, "20260708_100000_dddddd", 0.5, [stageCost("develop", 100, 40, 0.5)]);
    let err = "";
    const code = runCost(cwd, { all: true, runId: "20260708_100000_dddddd", write: () => {}, writeErr: (s) => { err += s; } });
    expect(code).toBe(1);
    expect(err).toContain("mutually exclusive");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runCost returns 1 when the requested --run-id does not exist", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-cost-cmd-x3-"));
  try {
    makeRun(cwd, "20260708_100000_eeeeee", 0.5, [stageCost("develop", 100, 40, 0.5)]);
    let err = "";
    const code = runCost(cwd, { runId: "nonexistent", write: () => {}, writeErr: (s) => { err += s; } });
    expect(code).toBe(1);
    expect(err).toContain("not found");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((c === '\n' || c === '\r') && !inQuotes) {
      if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      }
      if (c === '\r' && next === '\n') i++;
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

test("renderRunCostCsv escapes malicious string fields per RFC 4180 and parses back", () => {
  const s = summarizeRunCost(
    "run-x",
    stateWith(3, 'foo, "bar"'),
    [
      stageCost("line1\nline2", 100, 50, 1),
      stageCost("a,b", 200, 100, 2),
    ]
  );
  const csv = renderRunCostCsv(s);
  expect(csv).toContain('"line1\nline2"');
  expect(csv).toContain('"a,b"');
  const rows = parseCsv(csv);
  expect(rows).toEqual([
    ["stage", "in_tok", "out_tok", "cost_usd"],
    ["line1\nline2", "100", "50", "1"],
    ["a,b", "200", "100", "2"],
    ["total", "300", "150", "3"],
  ]);
});

test("renderAllRunsCostCsv escapes malicious string fields per RFC 4180 and parses back", () => {
  const s = summarizeAllRunsCost([
    {
      runId: "run,1",
      state: { ...stateWith(1.5, 'foo "bar"'), cost: { input_tokens: 10, output_tokens: 5, est_usd: 1.5 } },
      events: [] as AiflowEvent[],
    },
  ]);
  const csv = renderAllRunsCostCsv(s);
  expect(csv).toContain('"run,1"');
  expect(csv).toContain('"foo ""bar"""');
  const rows = parseCsv(csv);
  expect(rows).toEqual([
    ["run_id", "pipeline", "in_tok", "out_tok", "cost_usd", "breakdown_available"],
    ["run,1", 'foo "bar"', "10", "5", "1.5", "false"],
  ]);
});
