import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeStateAtomic, type EngineState } from "../engine/state";
import { appendEvent } from "../events/events";

export interface RejectResult {
  status: "rejected" | "no_runs" | "missing_run_dir" | "no_waiting_stage" | "ambiguous_stage" | "stage_not_waiting";
  state?: EngineState;
  message?: string;
  runId?: string;
}

function pickLatestRun(cwd: string): string | undefined {
  const root = join(cwd, ".aiflow", "runs");
  if (!existsSync(root)) return undefined;
  const entries = readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory());
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs);
  return entries[0];
}

export function runReject(cwd: string, opts: { runId?: string; stage?: string; reason?: string }): RejectResult {
  const runId = opts.runId ?? pickLatestRun(cwd);
  if (!runId) return { status: "no_runs", message: `No .aiflow/runs found in ${cwd}` };
  const runDir = join(cwd, ".aiflow", "runs", runId);
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) {
    return { status: "missing_run_dir", runId, message: `Run directory ${runDir} exists but has no state.json` };
  }

  const state = JSON.parse(readFileSync(statePath, "utf-8")) as EngineState;
  const waitingStages = state.stages.filter((s) => s.status === "waiting_human");

  let targetIndex: number;
  if (opts.stage) {
    targetIndex = state.stages.findIndex((s) => s.id === opts.stage);
    if (targetIndex === -1 || state.stages[targetIndex].status !== "waiting_human") {
      return { status: "stage_not_waiting", runId, message: `Stage "${opts.stage}" is not awaiting approval` };
    }
  } else {
    if (waitingStages.length === 0) {
      return { status: "no_waiting_stage", runId, message: "No stage is awaiting approval" };
    }
    if (waitingStages.length > 1) {
      return { status: "ambiguous_stage", runId, message: "Multiple stages awaiting approval; use --stage to disambiguate" };
    }
    targetIndex = state.stages.findIndex((s) => s.id === waitingStages[0].id);
  }

  const stageId = state.stages[targetIndex].id;
  state.stages[targetIndex] = { id: stageId, status: "aborted", reason: "human_gate_rejected" };
  writeStateAtomic(runDir, state);
  appendEvent(runDir, { ts: new Date().toISOString(), type: "human_gate_rejected", stage: stageId, reason: opts.reason });

  return { status: "rejected", state, runId };
}
