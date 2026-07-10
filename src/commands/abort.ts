import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { listRunIdsByMtimeDesc } from "../runs/store";
import { writeStateAtomic, type EngineState } from "../engine/state";
import { appendEvent } from "../events/events";

export interface AbortResult {
  status: "aborted" | "no_runs";
  runId?: string;
}

export function runAbort(cwd: string, opts: { runId?: string }): AbortResult {
  const runId = opts.runId ?? listRunIdsByMtimeDesc(cwd)[0];
  if (!runId) return { status: "no_runs" };
  const runDir = join(cwd, ".aiflow", "runs", runId);
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) return { status: "no_runs", runId };
  const state = JSON.parse(readFileSync(statePath, "utf-8")) as EngineState;
  state.stages = state.stages.map((s) =>
    (s.status === "running" || s.status === "waiting_human" || s.status === "pending" || s.status === "paused" ? { ...s, status: "aborted" } : s)
  );
  writeStateAtomic(runDir, state);
  appendEvent(runDir, { ts: new Date().toISOString(), type: "run_aborted" });
  return { status: "aborted", runId };
}
