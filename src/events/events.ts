import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RalphLoopStopReason } from "../engine/state";
import type {
  DebateRoundAiflowEvent,
  DebateEndAiflowEvent,
  GateAnsweredAiflowEvent,
  LlmRetryAiflowEvent,
  MergeConflictUnarbitrableAiflowEvent,
  ReviewArbitratedAiflowEvent,
  ReviewVerdictAiflowEvent,
  StageDoneAiflowEvent,
  StageStartAiflowEvent,
  StorySuspendedAiflowEvent,
  WorktreeAiflowEvent,
} from "./new-events";

export interface OpencodeToolUseAiflowEvent {
  ts: string;
  type: "opencode_tool_use";
  stage: string;
  story: string;
  tool: string;
  summary: string;
}

export interface OpencodeStepFinishAiflowEvent {
  ts: string;
  type: "opencode_step_finish";
  stage: string;
  in_tok: number;
  out_tok: number;
  cost_usd: number;
}

export interface StageCostAiflowEvent {
  ts: string;
  type: "stage_cost";
  stage: string;
  in_tok: number;
  out_tok: number;
  cost_usd: number;
}

export interface GateResultAiflowEvent {
  ts: string;
  type: "gate_result";
  stage: string;
  story: string;
  checks: "pass" | "fail";
  ai_review: "pass" | "fail" | "skipped";
  blockers: number;
  reason?: "config_tampered" | "spec_tampered" | "config_and_spec_tampered";
}

export interface StoryResultAiflowEvent {
  ts: string;
  type: "story_result";
  story: string;
  result: "pass" | "fail" | "suspended";
}

export interface RalphLoopResultAiflowEvent {
  ts: string;
  type: "ralph_loop_result";
  stage: string;
  result: "pass" | "suspended" | "paused";
  reason?: RalphLoopStopReason;
  iterations: number;
  stories_done: number;
  stories_suspended: number;
  stories_pending: number;
}

export interface BrainstormResultAiflowEvent {
  ts: string;
  type: "brainstorm_result";
  stage: string;
  result: "pass" | "fail";
  successes: number;
}

export interface SpecResultAiflowEvent {
  ts: string;
  type: "spec_result";
  stage: string;
  result: "pass" | "fail";
  spec_hash?: string;
}

export interface PlanResultAiflowEvent {
  ts: string;
  type: "plan_result";
  stage: string;
  result: "pass" | "fail";
}

export interface HumanGateWaitingAiflowEvent {
  ts: string;
  type: "human_gate_waiting";
  stage: string;
  prompt: string;
}

export interface HumanGateRejectedAiflowEvent {
  ts: string;
  type: "human_gate_rejected";
  stage: string;
  reason?: string;
}

export interface StoryAutoCleanedAiflowEvent {
  ts: string;
  type: "story_auto_cleaned";
  story: string;
}

export interface BudgetWarningAiflowEvent {
  ts: string;
  type: "budget_warning";
  stage: string;
  threshold_pct: number;
  spent_usd: number;
  limit_usd: number;
}

export type AiflowEvent =
  | OpencodeToolUseAiflowEvent
  | OpencodeStepFinishAiflowEvent
  | StageCostAiflowEvent
  | GateResultAiflowEvent
  | StoryResultAiflowEvent
  | RalphLoopResultAiflowEvent
  | BrainstormResultAiflowEvent
  | SpecResultAiflowEvent
  | PlanResultAiflowEvent
  | HumanGateWaitingAiflowEvent
  | HumanGateRejectedAiflowEvent
  | StoryAutoCleanedAiflowEvent
  | BudgetWarningAiflowEvent
  | StageStartAiflowEvent
  | StageDoneAiflowEvent
  | DebateRoundAiflowEvent
  | DebateEndAiflowEvent
  | ReviewVerdictAiflowEvent
  | ReviewArbitratedAiflowEvent
  | GateAnsweredAiflowEvent
  | WorktreeAiflowEvent
  | MergeConflictUnarbitrableAiflowEvent
  | StorySuspendedAiflowEvent
  | LlmRetryAiflowEvent;

function eventsPath(runDir: string): string {
  return join(runDir, "events.jsonl");
}

export function appendEvent(runDir: string, event: AiflowEvent): void {
  appendFileSync(eventsPath(runDir), JSON.stringify(event) + "\n");
}

/** Read events.jsonl; skip missing/unreadable files and any corrupt lines. Never throws. */
export function readEvents(runDir: string): AiflowEvent[] {
  const path = eventsPath(runDir);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as AiflowEvent;
        } catch {
          return undefined;
        }
      })
      .filter((e): e is AiflowEvent => e !== undefined);
  } catch {
    return [];
  }
}
