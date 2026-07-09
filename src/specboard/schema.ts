import { z } from "zod";

export const OpenQuestionSchema = z.object({
  id: z.string(),
  topic: z.string(),
  positions: z.record(z.string(), z.string()),
  resolution: z.string().optional(),
  resolved_by: z.string().optional(),
});

export const DecisionSchema = z.object({
  id: z.string(),
  topic: z.string(),
  resolution: z.string(),
  by: z.string(),
});

export const ReviewVerdictEntrySchema = z.object({
  verdicts: z.record(z.string(), z.enum(["pass", "fail", "skipped"])),
  arbitrated: z.boolean(),
  arbitrator: z.string().optional(),
  final: z.enum(["pass", "fail"]),
});

export const SpecBoardSchema = z.object({
  requirement: z.string(),
  artifacts: z.record(z.string(), z.string()),
  spec_hash: z.string().optional(),
  config_hash: z.string().optional(),
  open_questions: z.array(OpenQuestionSchema),
  decisions: z.array(DecisionSchema),
  review_matrix: z.record(z.string(), ReviewVerdictEntrySchema),
});
