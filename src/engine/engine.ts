import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeStateAtomic, readState, type EngineState, type StageState, type StageStatus, type StageStopReason } from "./state";
import { readEvents } from "../events/events";
import { runRalphLoop as realRunRalphLoop } from "../runners/ralph-loop";
import { runBrainstormStage } from "../runners/brainstorm";
import { runSpecStage } from "../runners/spec";
import { runPlanStage } from "../runners/plan";
import { runHumanGateStage } from "../runners/human-gate";
import { writeRunReport } from "../commands/report";
import { createBudgetTracker, type BudgetTracker } from "../gate/budget";
import type { PipelineConfig, ModelProfile, StageConfig, RalphLoopStageConfig } from "../config/schema";
import type { BrainstormStageConfig, SpecStageConfig, PlanStageConfig, HumanGateStageConfig } from "../config/schema";

export interface StageOutcome {
  result: "pass" | "fail" | "suspended" | "paused" | "waiting_human" | "aborted";
  reason?: string;
  usage?: { inTok: number; outTok: number; costUsd: number };
  entered_at?: string;
}

export type StageRunnerFn = (
  stageConfig: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  signal?: AbortSignal,
  budget?: BudgetTracker
) => Promise<StageOutcome>;

export interface EngineDeps {
  runners: Partial<Record<StageConfig["type"], StageRunnerFn>>;
  nowFn?: () => Date;
  writeRunReport?: (runDir: string, state: EngineState, now: Date, startedAt: Date) => void;
}

async function adaptRalphLoop(
  stageConfig: StageConfig,
  _stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  _nowFn: () => Date,
  signal?: AbortSignal,
  budget?: BudgetTracker
): Promise<StageOutcome> {
  const specPath = join(cwd, "spec.md");
  const specExcerpt = existsSync(specPath) ? readFileSync(specPath, "utf-8").slice(0, 4000) : "";
  const summary = await realRunRalphLoop(
    stageConfig as RalphLoopStageConfig,
    profiles,
    cwd,
    runDir,
    specExcerpt,
    undefined,
    signal,
    budget
  );
  return { result: summary.result, reason: summary.reason, usage: summary.usage };
}

async function adaptBrainstorm(
  stageConfig: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  signal?: AbortSignal,
  budget?: BudgetTracker
): Promise<StageOutcome> {
  return runBrainstormStage(stageConfig as BrainstormStageConfig, stageState, profiles, cwd, runDir, nowFn, signal, undefined, budget);
}

async function adaptSpec(
  stageConfig: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  signal?: AbortSignal,
  budget?: BudgetTracker
): Promise<StageOutcome> {
  return runSpecStage(stageConfig as SpecStageConfig, stageState, profiles, cwd, runDir, nowFn, signal, undefined, budget);
}

async function adaptPlan(
  stageConfig: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  signal?: AbortSignal,
  budget?: BudgetTracker
): Promise<StageOutcome> {
  return runPlanStage(stageConfig as PlanStageConfig, stageState, profiles, cwd, runDir, nowFn, signal, undefined, budget);
}

async function adaptHumanGate(
  stageConfig: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  signal?: AbortSignal,
  _budget?: BudgetTracker
): Promise<StageOutcome> {
  return runHumanGateStage(stageConfig as HumanGateStageConfig, stageState, profiles, cwd, runDir, nowFn, signal);
}

const defaultDeps: EngineDeps = {
  runners: {
    ralph_loop: adaptRalphLoop,
    brainstorm: adaptBrainstorm,
    spec: adaptSpec,
    plan: adaptPlan,
    human_gate: adaptHumanGate,
  },
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

const STATUS_MAP: Record<StageOutcome["result"], StageStatus> = {
  pass: "done",
  fail: "failed",
  suspended: "suspended",
  paused: "paused",
  waiting_human: "waiting_human",
  aborted: "aborted",
};

const VALID_STAGE_STOP_REASONS = new Set<string>([
  "max_iterations",
  "stall",
  "stories_suspended",
  "human_gate_timeout",
  "human_gate_rejected",
  "budget_exceeded",
]);

function toStageStopReason(reason: string | undefined): StageStopReason | undefined {
  if (reason === undefined) return undefined;
  return VALID_STAGE_STOP_REASONS.has(reason) ? (reason as StageStopReason) : undefined;
}

async function executeStage(
  stage: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  deps: EngineDeps,
  signal: AbortSignal | undefined,
  budget: BudgetTracker,
): Promise<StageExecutionResult> {
  if (signal?.aborted) return { state: { id: stage.id, status: "paused" } };

  const runner = deps.runners[stage.type];
  if (!runner) throw new Error(`No runner registered for stage type "${stage.type}"`);

  const outcome = await runner(stage, stageState, profiles, cwd, runDir, nowFn, signal, budget);
  const status = STATUS_MAP[outcome.result];
  const entered_at = outcome.entered_at ?? stageState.entered_at;
  return {
    state: { id: stage.id, status, reason: toStageStopReason(outcome.reason), entered_at },
    usage: outcome.usage,
  };
}

export interface RunPipelineOptions {
  /** When true, load state.json from runDir and resume from the first non-terminal stage. */
  resume?: boolean;
  /** Force re-execution of terminal stages (mutates state.status="pending" before running). */
  force?: boolean;
  now?: Date;
  /** Requirement text for pipelines with a brainstorm/spec stage; stored on the initial state only. */
  requirement?: string;
}

/**
 * Run a multi-stage pipeline sequentially; each stage's own runner (looked up
 * by `stage.type` in `deps.runners`) is responsible for reading whatever
 * input files it needs directly from `cwd` — the engine passes no in-memory
 * context object between stages (everything crosses stage boundaries via
 * files, per the project's file-driven design principle).
 */
export async function runPipelineOnce(
  pipeline: PipelineConfig,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  deps: EngineDeps = defaultDeps,
  signal?: AbortSignal,
  opts: RunPipelineOptions = {}
): Promise<EngineState> {
  const effectiveDeps: EngineDeps = {
    ...defaultDeps,
    ...deps,
    runners: { ...defaultDeps.runners, ...(deps.runners ?? {}) },
  };
  const nowFn = effectiveDeps.nowFn ?? (() => new Date());

  const startedAt = opts.now ?? nowFn();

  let state: EngineState;
  if (opts.resume) {
    state = readState(runDir);
  } else {
    state = {
      run_id: runDir.split("/").pop() ?? "unknown",
      pipeline: pipeline.name,
      requirement: opts.requirement,
      stages: pipeline.stages.map((s) => ({ id: s.id, status: "pending" as StageStatus })),
      cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
      ...(pipeline.budget ? { budget: { limit_usd: pipeline.budget.max_cost_usd } } : {}),
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
      state = { ...state, stages: state.stages.map((s) => (s.status === "pending" || s.status === "running" ? { ...s, status: "paused" } : s)) };
      writeStateAtomic(runDir, state);
      break;
    }
    const stage = pipeline.stages[i];
    const stageState = state.stages[i];
    if (TERMINAL_STATUSES.has(stageState.status)) continue;

    state = { ...state, stages: state.stages.map((s, idx) => (idx === i ? { ...s, status: "running" } : s)) };
    writeStateAtomic(runDir, state);

    const budgetTracker = createBudgetTracker(state.budget?.limit_usd, state.cost.est_usd);
    const execResult = await executeStage(stage, stageState, profiles, cwd, runDir, nowFn, effectiveDeps, signal, budgetTracker);
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

    // any non-"done" outcome (including "waiting_human") short-circuits the rest of the pipeline
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
