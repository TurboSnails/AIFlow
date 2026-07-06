import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export type StageStatus = "pending" | "running" | "done" | "failed" | "aborted" | "suspended" | "waiting_human";

export type RalphLoopStopReason = "max_iterations" | "stall" | "stories_suspended";
export type StageStopReason = RalphLoopStopReason | "human_gate_timeout" | "human_gate_rejected";

export interface StageState {
  id: string;
  status: StageStatus;
  iteration?: number;
  reason?: StageStopReason;
  entered_at?: string;
}

export interface EngineState {
  run_id: string;
  pipeline: string;
  requirement?: string;
  stages: StageState[];
  cost: { input_tokens: number; output_tokens: number; est_usd: number };
}

export function writeStateAtomic(runDir: string, state: EngineState): void {
  const finalPath = join(runDir, "state.json");
  const tempPath = join(runDir, "state.json.tmp");
  writeFileSync(tempPath, JSON.stringify(state, null, 2));
  renameSync(tempPath, finalPath);
}

export function readState(runDir: string): EngineState {
  const raw = readFileSync(join(runDir, "state.json"), "utf-8");
  return JSON.parse(raw) as EngineState;
}
