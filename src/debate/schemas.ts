import { z } from "zod";

export const DebateDecisionSchema = z.object({
  id: z.string(),
  topic: z.string(),
  resolution: z.string(),
});

export const DebateDisputeSchema = z.object({
  id: z.string(),
  topic: z.string(),
  positions: z.record(z.string(), z.string()),
});

export const ModeratorOutputSchema = z.object({
  resolved: z.array(DebateDecisionSchema),
  remaining_disputes: z.array(DebateDisputeSchema),
});

export type DebateDecision = z.infer<typeof DebateDecisionSchema>;
export type DebateDispute = z.infer<typeof DebateDisputeSchema>;
export type ModeratorOutput = z.infer<typeof ModeratorOutputSchema>;
