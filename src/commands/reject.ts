import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listRunIdsByMtimeDesc } from "../runs/store";
import { writeStateAtomic, type EngineState } from "../engine/state";
import { appendEvent } from "../events/events";

export interface RejectResult {
  status: "rejected" | "no_runs" | "missing_run_dir" | "no_waiting_stage" | "ambiguous_stage" | "stage_not_waiting";
  state?: EngineState;
  message?: string;
  runId?: string;
}

export function runReject(cwd: string, opts: { runId?: string; stage?: string; reason?: string }): RejectResult {
  const runId = opts.runId ?? listRunIdsByMtimeDesc(cwd)[0];
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
  appendEvent(runDir, { ts: new Date().toISOString(), type: "gate_answered", stage: stageId, by: "cli", action: "reject" });

  return { status: "rejected", state, runId };
}
