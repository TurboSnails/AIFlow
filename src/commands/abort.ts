import { join } from "node:path";
import { existsSync } from "node:fs";
import { listRunIdsByMtimeDesc } from "../runs/store";
import { readState, writeStateAtomic, type EngineState } from "../engine/state";
import { appendEvent } from "../events/events";
import { acquireRunLock } from "../lock";

export interface AbortResult {
  status: "aborted" | "no_runs";
  runId?: string;
  state?: EngineState;
}

export async function runAbort(cwd: string, opts: { runId?: string }): Promise<AbortResult> {
  const runId = opts.runId ?? listRunIdsByMtimeDesc(cwd)[0];
  if (!runId) return { status: "no_runs" };
  const runDir = join(cwd, ".aiflow", "runs", runId);
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) return { status: "no_runs", runId };
  const lock = await acquireRunLock(cwd, runId);
  try {
    const state = readState(runDir);
    const next: EngineState = {
      ...state,
      stages: state.stages.map((s) =>
        s.status === "running" || s.status === "waiting_human" || s.status === "pending" || s.status === "paused"
          ? { ...s, status: "aborted" as const, reason: "aborted" }
          : s
      ),
    };
    writeStateAtomic(runDir, next);
    appendEvent(runDir, { ts: new Date().toISOString(), type: "run_aborted" });
    return { status: "aborted", runId, state: next };
  } finally {
    lock.release();
  }
}
