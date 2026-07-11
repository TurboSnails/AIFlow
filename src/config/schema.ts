import { z } from "zod";

export const AutonomySchema = z.enum(["interactive", "gated", "full"]);

export const PriceSchema = z.object({
  in_per_m: z.number().nonnegative(),
  out_per_m: z.number().nonnegative(),
});

export const ModelProfileSchema = z
  .object({
    channel: z.enum(["opencode", "http"]),
    provider: z.string(),
    model: z.string(),
    agent: z.string().nullable().optional(),
    variant: z.string().nullable().optional(),
    thinking: z.boolean().optional(),
    dangerously_skip_permissions: z.boolean().optional(),
    base_url: z.string().optional(),
    api_key_env: z.string().optional(),
    price: PriceSchema.optional(),
    // Compatibility fields; read-time converted to `price` when present.
    input_cost_per_1m: z.number().nonnegative().optional(),
    output_cost_per_1m: z.number().nonnegative().optional(),
  })
  .transform((data) => {
    if (
      !data.price &&
      (data.input_cost_per_1m !== undefined || data.output_cost_per_1m !== undefined)
    ) {
      return {
        ...data,
        price: {
          in_per_m: data.input_cost_per_1m ?? 0,
          out_per_m: data.output_cost_per_1m ?? 0,
        },
      };
    }
    return data;
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
    // M1 compatibility: single-reviewer model reference.
    model: z.string().optional(),
    reviewers: z.array(z.string()).min(1).max(2).optional(),
    fail_on: z.array(z.enum(["blocker", "major", "minor", "nit"])),
    fail_threshold: z.record(z.string(), z.number()).optional(),
    strict: z.boolean().default(false),
  }),
});
export type ReviewGateConfig = z.infer<typeof ReviewGateConfigSchema>;

export const RalphLoopStageSchema = z.object({
  id: z.string(),
  type: z.literal("ralph_loop"),
  model: z.string(),
  autonomy: AutonomySchema.optional(),
  on_unresolved: z.enum(["ask_human", "main_dev_decides"]).optional(),
  per_story_fix_limit: z.number().int().positive().default(3),
  max_iterations: z.number().int().positive().default(10),
  stall_limit: z.number().int().positive().default(3),
  auto_clean: z.boolean().default(false),
  gate: ReviewGateConfigSchema,
});
export type RalphLoopStageConfig = z.infer<typeof RalphLoopStageSchema>;

export const BrainstormStageSchema = z.object({
  id: z.string(),
  type: z.literal("brainstorm"),
  autonomy: AutonomySchema.optional(),
  on_unresolved: z.enum(["ask_human", "main_dev_decides"]).optional(),
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
  autonomy: AutonomySchema.optional(),
  model: z.string(),
  output: z.string().default("spec.md"),
});
export type SpecStageConfig = z.infer<typeof SpecStageSchema>;

export const PlanStageSchema = z.object({
  id: z.string(),
  type: z.literal("plan"),
  autonomy: AutonomySchema.optional(),
  model: z.string(),
  input: z.string().default("spec.md"),
  output: z.string().default("prd.json"),
  max_retry_steps: z.number().int().positive().optional(),
});
export type PlanStageConfig = z.infer<typeof PlanStageSchema>;

export const HumanGateStageSchema = z.object({
  id: z.string(),
  type: z.literal("human_gate"),
  autonomy: AutonomySchema.optional(),
  prompt: z.string(),
  timeout: z.number().int().positive().optional(),
  on_timeout: z.enum(["approve", "abort"]).default("abort"),
});
export type HumanGateStageConfig = z.infer<typeof HumanGateStageSchema>;

export const ShellStageSchema = z.object({
  id: z.string(),
  type: z.literal("shell"),
  autonomy: AutonomySchema.optional(),
  command: z.string(),
  on_failure: z.enum(["fail", "continue"]).default("fail"),
});
export type ShellStageConfig = z.infer<typeof ShellStageSchema>;

export const StageConfigSchema = z.discriminatedUnion("type", [
  RalphLoopStageSchema,
  BrainstormStageSchema,
  SpecStageSchema,
  PlanStageSchema,
  HumanGateStageSchema,
  ShellStageSchema,
]);
export type StageConfig = z.infer<typeof StageConfigSchema>;

export const BudgetConfigSchema = z.object({
  max_cost_usd: z.number().positive(),
  max_retry_steps: z.number().int().positive().default(5),
  max_token_cost: z.number().positive().optional(),
  warn_at_pct: z.array(z.number().positive().max(1)).optional(),
});
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

export const PipelineConfigSchema = z.object({
  name: z.string(),
  autonomy: AutonomySchema.default("gated"),
  on_unresolved: z.enum(["ask_human", "main_dev_decides"]).default("ask_human"),
  isolation: z.enum(["none", "worktree"]).optional(),
  budget: BudgetConfigSchema.optional(),
  stages: z.array(StageConfigSchema).min(1),
});
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;

export const ProjectConfigSchema = z.object({
  max_drift_files: z.number().int().positive().default(50),
  default_checks: z.array(z.string()).optional(),
  on_unresolved: z.enum(["ask_human", "main_dev_decides"]).default("ask_human"),
  dashboard: z
    .object({
      port: z.number().int().positive().default(3000),
      host: z.string().default("127.0.0.1"),
    })
    .default({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
