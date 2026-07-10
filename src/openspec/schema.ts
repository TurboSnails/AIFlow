import { z } from "zod";

export const OpenSpecMetaSchema = z.object({
  spec_id: z.string(),
  version: z.number().int().positive(),
  branch: z.string(),
  verify_all: z.array(z.string()).default([]),
  depends: z.array(z.string()).default([]),
});

export const OpenSpecTaskSchema = z.object({
  id: z.string(),
  priority: z.number().int(),
  depends: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  title: z.string(),
  acceptance: z.array(z.string()).min(1),
  body: z.string(),
});

export const OpenSpecSchema = z.object({
  meta: OpenSpecMetaSchema,
  body: z.string(),
  tasks: z.array(OpenSpecTaskSchema),
});

export type OpenSpecMeta = z.infer<typeof OpenSpecMetaSchema>;
export type OpenSpecTask = z.infer<typeof OpenSpecTaskSchema>;
export type OpenSpec = z.infer<typeof OpenSpecSchema>;
