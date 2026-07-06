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
  per_story_fix_limit: z.number().default(3),
  gate: ReviewGateConfigSchema,
});
export type RalphLoopStageConfig = z.infer<typeof RalphLoopStageSchema>;

export const HumanGateStageSchema = z.object({
  id: z.string(),
  type: z.literal("human_gate"),
  prompt: z.string(),
  /** "none" = wait forever until confirmation; "<n>m" = wait N minutes then default_action. */
  timeout: z.string().default("none"),
  /** What to do when timeout fires or stdin returns non-affirmative. */
  default_action: z.enum(["pass", "fail", "abort"]).default("abort"),
});
export type HumanGateStageConfig = z.infer<typeof HumanGateStageSchema>;

export const StageConfigSchema = z.discriminatedUnion("type", [
  RalphLoopStageSchema,
  HumanGateStageSchema,
]);
export type StageConfig = z.infer<typeof StageConfigSchema>;

export const PipelineConfigSchema = z.object({
  name: z.string(),
  stages: z.array(StageConfigSchema).min(1),
});
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;

export type AnyStageConfig = RalphLoopStageConfig | HumanGateStageConfig;
