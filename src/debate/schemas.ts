import { z } from "zod";

export const CritiqueSchema = z.object({
  target: z.string(),
  point: z.string(),
  severity: z.enum(["blocker", "major", "minor", "nit"]).optional(),
});

export const RoundProposalSchema = z.object({
  author: z.string(),
  profile_real: z.string(),
  content_md: z.string(),
  stance_changes: z.array(z.string()).default([]),
  critiques: z.array(CritiqueSchema).default([]),
});

export const RoundArtifactSchema = z.object({
  round: z.number().int().positive(),
  proposals: z.array(RoundProposalSchema),
  moderator: z.unknown().optional(),
});

export type Critique = z.infer<typeof CritiqueSchema>;
export type RoundProposal = z.infer<typeof RoundProposalSchema>;
export type RoundArtifact = z.infer<typeof RoundArtifactSchema>;

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
