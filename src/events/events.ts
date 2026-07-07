import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RalphLoopStopReason } from "../engine/state";

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

export interface GateResultAiflowEvent {
  ts: string;
  type: "gate_result";
  stage: string;
  story: string;
  checks: "pass" | "fail";
  ai_review: "pass" | "fail" | "skipped";
  blockers: number;
  reason?: "config_tampered";
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

export type AiflowEvent =
  | OpencodeToolUseAiflowEvent
  | OpencodeStepFinishAiflowEvent
  | GateResultAiflowEvent
  | StoryResultAiflowEvent
  | RalphLoopResultAiflowEvent
  | BrainstormResultAiflowEvent
  | SpecResultAiflowEvent
  | PlanResultAiflowEvent
  | HumanGateWaitingAiflowEvent
  | HumanGateRejectedAiflowEvent
  | StoryAutoCleanedAiflowEvent;

function eventsPath(runDir: string): string {
  return join(runDir, "events.jsonl");
}

export function appendEvent(runDir: string, event: AiflowEvent): void {
  appendFileSync(eventsPath(runDir), JSON.stringify(event) + "\n");
}

export function readEvents(runDir: string): AiflowEvent[] {
  const path = eventsPath(runDir);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AiflowEvent);
}
