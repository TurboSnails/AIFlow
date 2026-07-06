import { writeStateAtomic, readState, type EngineState, type StageState, type StageStatus } from "./state";
import { appendEvent, readEvents } from "../events/events";
import { runRalphLoopOnce as realRunRalphLoopOnce, type RalphLoopResult } from "../runners/ralph-loop";
import { runHumanGate, writeHumanGateArtifact, type HumanGateDeps, type HumanGateResult } from "../runners/human-gate";
import { writeRunReport } from "../commands/report";
import type { PipelineConfig, ModelProfile, StageConfig } from "../config/schema";

export interface EngineDeps {
  runRalphLoopOnce: (
    stageConfig: Extract<StageConfig, { type: "ralph_loop" }>,
    profiles: Record<string, ModelProfile>,
    cwd: string,
    runDir: string,
    specExcerpt: string
  ) => Promise<RalphLoopResult>;
  runHumanGate?: (
    stageConfig: Extract<StageConfig, { type: "human_gate" }>,
    ctx: { cwd: string; runDir: string; specExcerpt: string },
    deps?: HumanGateDeps,
  ) => Promise<HumanGateResult>;
  nowFn?: () => Date;
  writeRunReport?: (runDir: string, state: EngineState, now: Date, startedAt: Date) => void;
  humanGateDeps?: HumanGateDeps;
}

const defaultDeps: EngineDeps = {
  runRalphLoopOnce: (stageConfig, profiles, cwd, runDir, specExcerpt) =>
    realRunRalphLoopOnce(stageConfig, profiles, cwd, runDir, specExcerpt),
  runHumanGate,
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

async function executeStage(
  stage: StageConfig,
  idx: number,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  specExcerpt: string,
  deps: EngineDeps,
  signal: AbortSignal | undefined,
): Promise<StageState> {
  if (signal?.aborted) return { id: stage.id, status: "aborted" };

  if (stage.type === "ralph_loop") {
    const result = await deps.runRalphLoopOnce(stage, profiles, cwd, runDir, specExcerpt);
    return { id: stage.id, status: result.result === "pass" ? "done" : result.result === "suspended" ? "suspended" : "failed" };
  }

  if (stage.type === "human_gate") {
    if (!deps.runHumanGate) return { id: stage.id, status: "aborted" };
    const result = await deps.runHumanGate(stage, { cwd, runDir, specExcerpt }, deps.humanGateDeps);
    try {
      await writeHumanGateArtifact(runDir, stage, result);
    } catch {
      // never block engine on artifact errors
    }
    const eventResult: "pass" | "fail" | "aborted" = result.outcome === "done" ? "pass" : result.outcome === "failed" ? "fail" : "aborted";
    appendEvent(runDir, { ts: new Date().toISOString(), type: "stage_result", stage: stage.id, result: eventResult });
    return { id: stage.id, status: result.outcome };
  }

  void idx;
  const unreachable: never = stage;
  throw new Error(`Unhandled stage type: ${JSON.stringify(unreachable)}`);
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

    const next = await executeStage(stage, i, profiles, cwd, runDir, specExcerpt, effectiveDeps, signal);
    state = { ...state, stages: state.stages.map((s, idx) => (idx === i ? next : s)) };
    writeStateAtomic(runDir, state);

    // any failure short-circuits the rest of the pipeline
    if (!TERMINAL_STATUSES.has(next.status) || next.status === "aborted" || next.status === "failed" || next.status === "suspended") {
      break;
    }
  }

  writeReportNow();
  return state;
}

export function createRunId(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const rand = Math.random().toString(16).slice(2, 8);
  return `${stamp}_${rand}`;
}
