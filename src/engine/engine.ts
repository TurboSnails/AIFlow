import { writeStateAtomic, readState, type EngineState, type StageState, type StageStatus } from "./state";
import { readEvents } from "../events/events";
import { runRalphLoopOnce as realRunRalphLoopOnce, type RalphLoopResult } from "../runners/ralph-loop";
import { writeRunReport } from "../commands/report";
import type { PipelineConfig, ModelProfile, StageConfig } from "../config/schema";

export interface EngineDeps {
  runRalphLoopOnce: (
    stageConfig: StageConfig,
    profiles: Record<string, ModelProfile>,
    cwd: string,
    runDir: string,
    specExcerpt: string
  ) => Promise<RalphLoopResult>;
  nowFn?: () => Date;
  writeRunReport?: (runDir: string, state: EngineState, now: Date, startedAt: Date) => void;
}

const defaultDeps: EngineDeps = {
  runRalphLoopOnce: (stageConfig, profiles, cwd, runDir, specExcerpt) =>
    realRunRalphLoopOnce(stageConfig, profiles, cwd, runDir, specExcerpt),
  nowFn: () => new Date(),
  writeRunReport: (runDir, state, now, startedAt) => {
    const events = readEvents(runDir);
    writeRunReport(runDir, state, events, { now, startedAt });
  },
};

export const TERMINAL_STATUSES: ReadonlySet<StageStatus> = new Set([
  "done",
  "failed",
  "aborted",
  "suspended",
]);

export function isTerminalStatus(s: StageStatus): boolean {
  return TERMINAL_STATUSES.has(s);
}

/** Return index of the first non-terminal stage, or -1 when all stages are terminal. */
export function firstResumeIndex(stages: StageState[]): number {
  for (let i = 0; i < stages.length; i++) {
    if (!TERMINAL_STATUSES.has(stages[i].status)) return i;
  }
  return -1;
}

interface StageExecutionResult {
  state: StageState;
  usage?: { inTok: number; outTok: number; costUsd: number };
}

async function executeStage(
  stage: StageConfig,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  specExcerpt: string,
  deps: EngineDeps,
  signal: AbortSignal | undefined,
): Promise<StageExecutionResult> {
  if (signal?.aborted) return { state: { id: stage.id, status: "aborted" } };

  const result = await deps.runRalphLoopOnce(stage, profiles, cwd, runDir, specExcerpt);
  const status: StageStatus = result.result === "pass" ? "done" : result.result === "suspended" ? "suspended" : "failed";
  return { state: { id: stage.id, status }, usage: result.usage };
}

export interface RunPipelineOptions {
  /** When true, load state.json from runDir and resume from the first non-terminal stage. */
  resume?: boolean;
  /** Force re-execution of terminal stages (mutates state.status="pending" before running). */
  force?: boolean;
  now?: Date;
}

/**
 * Run a multi-stage pipeline sequentially; for the v1 slice we keep each
 * stage independent (no shared iteration budget across stages).
 */
export async function runPipelineOnce(
  pipeline: PipelineConfig,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  specExcerpt: string,
  deps: EngineDeps = defaultDeps,
  signal?: AbortSignal,
  opts: RunPipelineOptions = {}
): Promise<EngineState> {
  const effectiveDeps: EngineDeps = { ...defaultDeps, ...deps };
  const nowFn = effectiveDeps.nowFn ?? (() => new Date());

  const startedAt = opts.now ?? nowFn();

  let state: EngineState;
  if (opts.resume) {
    state = readState(runDir);
  } else {
    state = {
      run_id: runDir.split("/").pop() ?? "unknown",
      pipeline: pipeline.name,
      stages: pipeline.stages.map((s) => ({ id: s.id, status: "pending" as StageStatus })),
      cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    };
  }
  writeStateAtomic(runDir, state);

  const writeReportNow = () => {
    if (!effectiveDeps.writeRunReport) return;
    try {
      effectiveDeps.writeRunReport(runDir, state, nowFn(), startedAt);
    } catch {
      // never block engine on report errors
    }
  };

  // On --force, reset every terminal stage so a resume replays the whole pipeline.
  if (opts.force) {
    state = {
      ...state,
      stages: state.stages.map((s) => (TERMINAL_STATUSES.has(s.status) ? { ...s, status: "pending" } : s)),
    };
    writeStateAtomic(runDir, state);
  }

  // Idempotent early-out: a fully terminal pipeline with resume+!force is a no-op.
  const pipelineAllTerminal = state.stages.every((s) => TERMINAL_STATUSES.has(s.status));
  if (opts.resume && pipelineAllTerminal && !opts.force) {
    writeReportNow();
    return state;
  }

  for (let i = 0; i < pipeline.stages.length; i++) {
    if (signal?.aborted) {
      state = { ...state, stages: state.stages.map((s) => (s.status === "pending" || s.status === "running" ? { ...s, status: "aborted" } : s)) };
      writeStateAtomic(runDir, state);
      break;
    }
    const stage = pipeline.stages[i];
    const stageState = state.stages[i];
    if (TERMINAL_STATUSES.has(stageState.status)) continue;

    state = { ...state, stages: state.stages.map((s, idx) => (idx === i ? { ...s, status: "running" } : s)) };
    writeStateAtomic(runDir, state);

    const execResult = await executeStage(stage, profiles, cwd, runDir, specExcerpt, effectiveDeps, signal);
    state = {
      ...state,
      stages: state.stages.map((s, idx) => (idx === i ? execResult.state : s)),
      cost: execResult.usage
        ? {
            input_tokens: state.cost.input_tokens + execResult.usage.inTok,
            output_tokens: state.cost.output_tokens + execResult.usage.outTok,
            est_usd: state.cost.est_usd + execResult.usage.costUsd,
          }
        : state.cost,
    };
    writeStateAtomic(runDir, state);

    // any non-"done" outcome short-circuits the rest of the pipeline
    if (execResult.state.status !== "done") {
      break;
    }
  }

  writeReportNow();
  return state;
}

/**
 * Summarize a pipeline's overall outcome across ALL stages, not just the
 * first one — a pipeline with multiple stages is only successful if every
 * stage reached "done"; reporting only stages[0] would hide a later failure.
 */
export function summarizePipelineOutcome(state: EngineState): { line: string; exitCode: number } {
  const blocking = state.stages.find((s) => s.status !== "done");
  if (!blocking) {
    const ids = state.stages.map((s) => s.id).join(", ");
    return { line: `All stages done (${ids})`, exitCode: 0 };
  }
  return { line: `Stage ${blocking.id}: ${blocking.status}`, exitCode: 1 };
}

export function createRunId(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const rand = Math.random().toString(16).slice(2, 8);
  return `${stamp}_${rand}`;
}
