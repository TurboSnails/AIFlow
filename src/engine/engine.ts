import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeStateAtomic, readState, type EngineState, type StageState, type StageStatus, type StageStopReason } from "./state";
import { readEvents, appendEvent } from "../events/events";
import type { GateWaitingAiflowEvent } from "../events/new-events";
import { runRalphLoop as realRunRalphLoop } from "../runners/ralph-loop";
import { runBrainstormStage } from "../runners/brainstorm";
import { runSpecStage } from "../runners/spec";
import { runPlanStage } from "../runners/plan";
import { runHumanGateStage } from "../runners/human-gate";
import { runShellStage } from "../runners/shell";
import { writeRunReport } from "../commands/report";
import { createBudgetTracker, noopBudgetTracker, type BudgetTracker } from "../gate/budget";
import { shouldPause, type Autonomy, type GatePoint, type PolicyContext } from "../policy/autonomy";
import { readSpecBoard } from "../specboard/specboard";
import type { PipelineConfig, ModelProfile, StageConfig, RalphLoopStageConfig, ShellStageConfig } from "../config/schema";
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
  return runBrainstormStage(stageConfig as BrainstormStageConfig, stageState, profiles, cwd, runDir, nowFn, signal, undefined, budget ?? noopBudgetTracker);
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
  return runSpecStage(stageConfig as SpecStageConfig, stageState, profiles, cwd, runDir, nowFn, signal, undefined, budget ?? noopBudgetTracker);
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
  return runPlanStage(stageConfig as PlanStageConfig, stageState, profiles, cwd, runDir, nowFn, signal, undefined, budget ?? noopBudgetTracker);
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

async function adaptShell(...args: Parameters<StageRunnerFn>) {
  const [stageConfig, stageState, profiles, cwd, runDir, nowFn, signal, budget] = args;
  return runShellStage(stageConfig as ShellStageConfig, stageState, profiles, cwd, runDir, nowFn, signal, budget);
}

const defaultDeps: EngineDeps = {
  runners: {
    ralph_loop: adaptRalphLoop,
    brainstorm: adaptBrainstorm,
    spec: adaptSpec,
    plan: adaptPlan,
    human_gate: adaptHumanGate,
    shell: adaptShell,
  },
  nowFn: () => new Date(),
  writeRunReport: (runDir, state, now, startedAt) => {
    const events = readEvents(runDir);
    writeRunReport(runDir, state, events, { now, startedAt });
  },
};

export function resolvePipelineDefaults(
  pipeline: PipelineConfig,
  overrides?: { autonomy?: Autonomy; isolation?: NonNullable<PipelineConfig["isolation"]> }
): { autonomy: Autonomy; isolation: NonNullable<PipelineConfig["isolation"]> } {
  const autonomy = overrides?.autonomy ?? pipeline.autonomy ?? "gated";
  const isolation = overrides?.isolation ?? pipeline.isolation ?? (autonomy === "full" ? "worktree" : "none");
  return { autonomy, isolation };
}

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
  result: StageOutcome["result"];
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

const GATE_POINTS: Record<StageConfig["type"], GatePoint> = {
  brainstorm: "after_brainstorm",
  spec: "after_spec",
  ralph_loop: "after_story",
  plan: "run_end",
  human_gate: "run_end",
  shell: "run_end",
};

const VALID_STAGE_STOP_REASONS = new Set<string>([
  "max_iterations",
  "stall",
  "stories_suspended",
  "human_gate_timeout",
  "human_gate_rejected",
  "budget_exceeded",
  "aborted",
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
  on_unresolved: "ask_human" | "main_dev_decides" = "ask_human",
): Promise<StageExecutionResult> {
  if (signal?.aborted) return { state: { id: stage.id, status: "paused" }, result: "paused" };

  const runner = deps.runners[stage.type];
  if (!runner) throw new Error(`No runner registered for stage type "${stage.type}"`);

  const outcome = await runner(stage, stageState, profiles, cwd, runDir, nowFn, signal, budget);
  const status = STATUS_MAP[outcome.result];
  const entered_at = outcome.entered_at ?? stageState.entered_at;
  return {
    state: { id: stage.id, status, reason: toStageStopReason(outcome.reason), entered_at },
    result: outcome.result,
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
  /** Default policy for unresolved open questions; stage/pipeline config override this. */
  on_unresolved?: "ask_human" | "main_dev_decides";
  /** Runtime worktree context created by the run command; stored on the initial state. */
  worktree?: { path: string; branch: string };
  /** Effective autonomy for the run; if omitted, the pipeline/config defaults are applied. */
  autonomy?: Autonomy;
  /** Effective isolation for the run; if omitted, the pipeline/config defaults are applied. */
  isolation?: NonNullable<PipelineConfig["isolation"]>;
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
    const { autonomy: effectiveAutonomy, isolation: effectiveIsolation } = resolvePipelineDefaults(pipeline, {
      autonomy: opts.autonomy,
      isolation: opts.isolation,
    });
    state = {
      run_id: runDir.split("/").pop() ?? "unknown",
      pipeline: pipeline.name,
      requirement: opts.requirement,
      autonomy: effectiveAutonomy,
      isolation: effectiveIsolation,
      ...(opts.worktree ? { worktree: opts.worktree } : {}),
      stages: pipeline.stages.map((s) => ({ id: s.id, status: "pending" as StageStatus })),
      cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
      ...(pipeline.budget
        ? {
            budget: {
              limit_usd: pipeline.budget.max_cost_usd,
              ...(pipeline.budget.warn_at_pct ? { warn_at_pct: pipeline.budget.warn_at_pct } : {}),
            },
          }
        : {}),
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

    appendEvent(runDir, { ts: nowFn().toISOString(), type: "stage_start", stage: stage.id });

    const budgetTracker = createBudgetTracker(state.budget?.limit_usd, state.cost.est_usd, state.budget?.warn_at_pct);
    const execResult = await executeStage(stage, stageState, profiles, cwd, runDir, nowFn, effectiveDeps, signal, budgetTracker, opts.on_unresolved);
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

    appendEvent(runDir, {
      ts: nowFn().toISOString(),
      type: "stage_done",
      stage: stage.id,
      result: execResult.result,
    });

    // Best-effort: state.cost is already persisted above. A crash between that
    // write and this event append can leave stage_cost events incomplete; the
    // cost command renders a reconciliation line when the sums diverge.
    if (execResult.usage) {
      appendEvent(runDir, {
        ts: nowFn().toISOString(),
        type: "stage_cost",
        stage: stage.id,
        in_tok: execResult.usage.inTok,
        out_tok: execResult.usage.outTok,
        cost_usd: execResult.usage.costUsd,
      });
    }

    // Best-effort: drain any budget warning thresholds this stage's spend crossed.
    // Detection lives in the tracker (pure); the I/O is centralized here next to
    // stage_cost. Each threshold warns at most once per run at COMPLETED-STAGE
    // granularity: the per-stage tracker is pre-seeded from the cumulative
    // state.cost.est_usd, so thresholds crossed in earlier completed stages are
    // pre-marked and not re-warned. A crash mid-stage (after this append but
    // before the next stage's cost is persisted) can re-warn on resume, since
    // est_usd is only persisted at stage boundaries — an accepted limitation.
    for (const thresholdPct of budgetTracker.drainPendingWarnings()) {
      const limitUsd = state.budget?.limit_usd ?? 0;
      appendEvent(runDir, {
        ts: nowFn().toISOString(),
        type: "budget_warning",
        stage: stage.id,
        threshold_pct: thresholdPct,
        spent_usd: state.cost.est_usd,
        limit_usd: limitUsd,
      });
      process.stderr.write(
        `Budget warning: spent $${state.cost.est_usd.toFixed(4)} / $${limitUsd.toFixed(4)} (${Math.round(thresholdPct * 100)}% of limit) at stage ${stage.id}\n`,
      );
    }

    // A completed stage may still need human approval before the engine can
    // proceed to the next stage. If the configured autonomy requires a pause,
    // mark the stage as waiting_human and stop the pipeline here.
    if (execResult.state.status === "done") {
      const effectiveAutonomy: Autonomy = stage.autonomy ?? pipeline.autonomy ?? "gated";
      const effectiveOnUnresolved: "ask_human" | "main_dev_decides" =
        (stage.type === "ralph_loop" ? (stage as RalphLoopStageConfig).on_unresolved : undefined) ??
        (stage.type === "brainstorm" ? (stage as BrainstormStageConfig).on_unresolved : undefined) ??
        pipeline.on_unresolved ??
        opts.on_unresolved ??
        "ask_human";
      const gatePoint: GatePoint = GATE_POINTS[stage.type] ?? "run_end";
      const board = readSpecBoard(runDir);
      const policyCtx: PolicyContext = {
        open_questions_count: board.open_questions.length,
        on_unresolved: effectiveOnUnresolved,
      };
      if (shouldPause(effectiveAutonomy, gatePoint, policyCtx) === "pause") {
        state = {
          ...state,
          stages: state.stages.map((s, idx) => (idx === i ? { ...s, status: "waiting_human", reason: "autonomy_pause" } : s)),
        };
        writeStateAtomic(runDir, state);
        break;
      }
      if (stage.type !== "human_gate" && shouldPause(effectiveAutonomy, "unresolved_questions", policyCtx) === "pause") {
        const now = nowFn();
        state = {
          ...state,
          stages: state.stages.map((s, idx) =>
            idx === i ? { ...s, status: "waiting_human", reason: "autonomy_pause" } : s
          ),
        };
        appendEvent(runDir, {
          ts: now.toISOString(),
          type: "gate_waiting",
          gate: "unresolved_questions",
          stage: pipeline.stages[i].id,
          questions: board.open_questions.map((q) => q.id),
        } as GateWaitingAiflowEvent);
        writeStateAtomic(runDir, state);
        break;
      }
    } else {
      // any non-"done" outcome (including "waiting_human") short-circuits the rest of the pipeline
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
