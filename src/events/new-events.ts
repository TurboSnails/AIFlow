export interface StageStartAiflowEvent {
  ts: string;
  type: "stage_start";
  stage: string;
}

export interface StageDoneAiflowEvent {
  ts: string;
  type: "stage_done";
  stage: string;
  result: "pass" | "fail" | "suspended" | "paused" | "waiting_human" | "aborted";
}

export interface DebateRoundAiflowEvent {
  ts: string;
  type: "debate_round";
  stage: string;
  round: number;
  resolved: number;
  remaining: number;
}

export interface DebateEndAiflowEvent {
  ts: string;
  type: "debate_end";
  stage: string;
  reason: "converged" | "max_rounds" | "stalled";
  open_questions: number;
}

export interface ReviewVerdictAiflowEvent {
  ts: string;
  type: "review_verdict";
  stage: string;
  story: string;
  reviewers: Record<string, "pass" | "fail" | "skipped">;
  arbitrated: boolean;
  final: "pass" | "fail";
}

export interface ReviewArbitratedAiflowEvent {
  ts: string;
  type: "review_arbitrated";
  stage: string;
  story: string;
  arbitrator: string;
  verdict: "pass" | "fail";
}

export interface GateAnsweredAiflowEvent {
  ts: string;
  type: "gate_answered";
  stage: string;
  by: "cli" | "dashboard";
  action: "approve" | "reject";
}

export interface GateWaitingAiflowEvent {
  ts: string;
  type: "gate_waiting";
  gate: "unresolved_questions";
  stage: string;
  questions: string[];
}

export interface WorktreeAiflowEvent {
  ts: string;
  type: "worktree";
  action: "create" | "commit" | "merge_attempt" | "conflict" | "resolved" | "remove" | "remove_failed" | "error";
  branch: string;
  path: string;
}

export interface MergeConflictUnarbitrableAiflowEvent {
  ts: string;
  type: "merge_conflict_unarbitrable";
  stage: string;
  files: string[];
}

export interface StorySuspendedAiflowEvent {
  ts: string;
  type: "story_suspended";
  story: string;
  reason: "fix_limit" | "stall" | "max_iterations" | "arbitration_escalation";
}

export interface RunAbortedAiflowEvent {
  ts: string;
  type: "run_aborted";
}

export interface LlmRetryAiflowEvent {
  ts: string;
  type: "llm_retry";
  stage: string;
  attempt: number;
  error: string;
}
