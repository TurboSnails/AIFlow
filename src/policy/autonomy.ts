export type Autonomy = "interactive" | "gated" | "full";

export type GatePoint =
  | "after_brainstorm"
  | "after_spec"
  | "unresolved_questions"
  | "review_dispute_exceeded"
  | "after_story"
  | "run_end"
  | "merge_conflict_unarbitrable";

export interface PolicyContext {
  on_unresolved?: "ask_human" | "main_dev_decides";
  open_questions_count?: number;
}

export function shouldPause(autonomy: Autonomy, point: GatePoint, ctx: PolicyContext): "pause" | "proceed" {
  if (point === "unresolved_questions" && (ctx.open_questions_count ?? 0) > 0) {
    return ctx.on_unresolved === "main_dev_decides" ? "proceed" : "pause";
  }
  if (point === "merge_conflict_unarbitrable") return "pause";
  if (autonomy === "interactive") {
    if (["after_brainstorm", "after_spec", "after_story"].includes(point)) return "pause";
    if (point === "review_dispute_exceeded") return "pause";
  }
  if (autonomy === "gated") {
    if (["after_brainstorm", "after_spec"].includes(point)) return "pause";
    if (point === "review_dispute_exceeded") return "pause";
  }
  return "proceed";
}
