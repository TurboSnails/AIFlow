import { z } from "zod";

export const ReviewIssueSchema = z.object({
  severity: z.enum(["blocker", "major", "minor", "nit"]),
  file: z.string(),
  line: z.number(),
  title: z.string(),
  detail: z.string(),
  suggestion: z.string(),
});

export const ReviewOutputSchema = z.object({
  summary: z.string(),
  issues: z.array(ReviewIssueSchema),
});

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export const ArbitrationOutputSchema = z.object({
  summary: z.string(),
  verdict: z.enum(["pass", "fail"]),
  reason: z.string(),
  issues: z.array(ReviewIssueSchema),
});

export type ArbitrationOutput = z.infer<typeof ArbitrationOutputSchema>;
