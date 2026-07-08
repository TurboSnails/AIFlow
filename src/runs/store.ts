import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EngineState } from "../engine/state";
import { TERMINAL_STATUSES } from "../engine/engine";

export interface LoadedRun {
  runId: string;
  state: EngineState;
  mtimeMs: number;
}

export function runsRoot(cwd: string): string {
  return join(cwd, ".aiflow", "runs");
}

/** List run dirs under .aiflow/runs newest-first; stat each dir once; [] when root missing. */
export function listRunIdsByMtimeDesc(cwd: string): string[] {
  const root = runsRoot(cwd);
  if (!existsSync(root)) return [];
  const entries = readdirSync(root)
    .map((id) => ({ id, stat: statSync(join(root, id)) }))
    .filter((e) => e.stat.isDirectory());
  entries.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return entries.map((e) => e.id);
}

/** Read a run's state.json + dir mtime; undefined when missing or corrupt (never throws). */
export function loadRun(cwd: string, runId: string): LoadedRun | undefined {
  const runDir = join(runsRoot(cwd), runId);
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) return undefined;
  let state: EngineState;
  try {
    state = JSON.parse(readFileSync(statePath, "utf-8")) as EngineState;
  } catch {
    return undefined;
  }
  const mtimeMs = statSync(runDir).mtimeMs;
  return { runId, state, mtimeMs };
}

/** Read the run.lock's run_id, or undefined when absent/unreadable. Local read-only
 *  helper — does not depend on lock.ts internals (avoids coupling to concurrency logic). */
function lockedRunId(cwd: string): string | undefined {
  const lockPath = join(cwd, ".aiflow", "run.lock");
  if (!existsSync(lockPath)) return undefined;
  try {
    const info = JSON.parse(readFileSync(lockPath, "utf-8")) as { run_id?: string };
    return info.run_id;
  } catch {
    return undefined;
  }
}

/** Active when the state has any non-terminal stage OR run.lock points to this run. */
export function isRunActive(cwd: string, runId: string, state: EngineState): boolean {
  const hasNonTerminal = state.stages.some((s) => !TERMINAL_STATUSES.has(s.status));
  if (hasNonTerminal) return true;
  return lockedRunId(cwd) === runId;
}

/** Compact overall status token for list views. */
export function summarizeRunStatus(state: EngineState): string {
  const firstNonTerminal = state.stages.find((s) => !TERMINAL_STATUSES.has(s.status));
  if (firstNonTerminal) return firstNonTerminal.status;
  if (state.stages.some((s) => s.status === "failed")) return "failed";
  if (state.stages.some((s) => s.status === "aborted")) return "aborted";
  if (state.stages.some((s) => s.status === "suspended")) return "suspended";
  return "done";
}
