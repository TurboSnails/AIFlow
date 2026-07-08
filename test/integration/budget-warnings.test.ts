import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipelineOnce } from "../../src/engine/engine";
import { readEvents } from "../../src/events/events";
import { formatBudgetOutcomeLine } from "../../src/commands/budget-outcome";

test("a run that crosses budget thresholds emits warnings and a near/exceeded outcome", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-budget-"));
  try {
    const deps = {
      runners: {
        ralph_loop: async (_stageConfig: unknown, _stageState: unknown, _profiles: unknown, _cwd: string, _runDir: string, _nowFn: unknown, _signal: unknown, budget: any) => {
          budget?.record(8.5);
          return { result: "pass", usage: { inTok: 0, outTok: 0, costUsd: 8.5 } };
        },
      },
      nowFn: () => new Date("2026-07-08T00:00:00.000Z"),
    } as any;
    const pipeline = {
      name: "p",
      budget: { max_cost_usd: 10, warn_at_pct: [0.5, 0.8] },
      stages: [{ id: "build", type: "ralph_loop" }],
    } as any;
    const state = await runPipelineOnce(pipeline, {}, "/tmp", runDir, deps);

    const warnings = readEvents(runDir).filter((e: any) => e.type === "budget_warning");
    expect(warnings.map((w: any) => w.threshold_pct)).toEqual([0.5, 0.8]);

    const line = formatBudgetOutcomeLine(state);
    expect(line).toBe("Budget near limit: $8.5000 / $10.0000 (85%)");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
