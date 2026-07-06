import { z } from "zod";

export const ModelProfileSchema = z.object({
  channel: z.enum(["opencode", "http"]),
  provider: z.string(),
  model: z.string(),
  agent: z.string().nullable().optional(),
  variant: z.string().nullable().optional(),
  thinking: z.boolean().optional(),
  dangerously_skip_permissions: z.boolean().optional(),
  base_url: z.string().optional(),
  api_key_env: z.string().optional(),
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const ModelsConfigSchema = z.object({
  profiles: z.record(z.string(), ModelProfileSchema),
});
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

export const ReviewGateConfigSchema = z.object({
  checks: z.array(z.string()),
  ai_review: z.object({
    enabled: z.boolean(),
    model: z.string(),
    fail_on: z.array(z.enum(["blocker", "major", "minor", "nit"])),
    fail_threshold: z.record(z.string(), z.number()).optional(),
    strict: z.boolean().optional(),
  }),
});
export type ReviewGateConfig = z.infer<typeof ReviewGateConfigSchema>;

export const RalphLoopStageSchema = z.object({
  id: z.string(),
  type: z.literal("ralph_loop"),
  model: z.string(),
  per_story_fix_limit: z.number().int().positive().default(3),
  max_iterations: z.number().int().positive().default(10),
  stall_limit: z.number().int().positive().default(3),
  gate: ReviewGateConfigSchema,
});
export type RalphLoopStageConfig = z.infer<typeof RalphLoopStageSchema>;

export const BrainstormStageSchema = z.object({
  id: z.string(),
  type: z.literal("brainstorm"),
  models: z.array(z.string()).min(2),
  mode: z.enum(["independent", "debate"]).default("independent"),
  debate_rounds: z.number().int().positive().default(2),
  synthesizer: z.string(),
  output: z.string().default("brainstorm-report.md"),
});
export type BrainstormStageConfig = z.infer<typeof BrainstormStageSchema>;

export const SpecStageSchema = z.object({
  id: z.string(),
  type: z.literal("spec"),
  model: z.string(),
  output: z.string().default("spec.md"),
});
export type SpecStageConfig = z.infer<typeof SpecStageSchema>;

export const PlanStageSchema = z.object({
  id: z.string(),
  type: z.literal("plan"),
  model: z.string(),
  input: z.string().default("spec.md"),
  output: z.string().default("prd.json"),
});
export type PlanStageConfig = z.infer<typeof PlanStageSchema>;

export const HumanGateStageSchema = z.object({
  id: z.string(),
  type: z.literal("human_gate"),
  prompt: z.string(),
  timeout: z.number().int().positive().optional(),
  on_timeout: z.enum(["approve", "abort"]).default("abort"),
});
export type HumanGateStageConfig = z.infer<typeof HumanGateStageSchema>;

export const StageConfigSchema = z.discriminatedUnion("type", [
  RalphLoopStageSchema,
  BrainstormStageSchema,
  SpecStageSchema,
  PlanStageSchema,
  HumanGateStageSchema,
]);
export type StageConfig = z.infer<typeof StageConfigSchema>;

export const PipelineConfigSchema = z.object({
  name: z.string(),
  stages: z.array(StageConfigSchema).min(1),
});
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
