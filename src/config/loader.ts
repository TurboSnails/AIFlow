import { parse as parseYaml } from "yaml";
import { readFileSync } from "node:fs";
import { ModelsConfigSchema, PipelineConfigSchema, ProjectConfigSchema, type ModelsConfig, type PipelineConfig, type ProjectConfig } from "./schema";
import { sanitizeSecrets } from "../commands/report";

export function loadModelsConfig(path: string): ModelsConfig {
  const raw = parseYaml(readFileSync(path, "utf-8"));
  try {
    return ModelsConfigSchema.parse(raw);
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(sanitizeSecrets(err.message));
    }
    throw err;
  }
}

export function loadPipelineConfig(path: string): PipelineConfig {
  const raw = parseYaml(readFileSync(path, "utf-8"));
  return PipelineConfigSchema.parse(raw);
}

export function loadProjectConfig(path: string): ProjectConfig {
  const raw = parseYaml(readFileSync(path, "utf-8"));
  return ProjectConfigSchema.parse(raw);
}
