import { parse as parseYaml } from "yaml";
import { readFileSync } from "node:fs";
import { ModelsConfigSchema, PipelineConfigSchema, ProjectConfigSchema, type ModelsConfig, type PipelineConfig, type ProjectConfig } from "./schema";

export function loadModelsConfig(path: string): ModelsConfig {
  const raw = parseYaml(readFileSync(path, "utf-8"));
  return ModelsConfigSchema.parse(raw);
}

export function loadPipelineConfig(path: string): PipelineConfig {
  const raw = parseYaml(readFileSync(path, "utf-8"));
  return PipelineConfigSchema.parse(raw);
}

export function loadProjectConfig(path: string): ProjectConfig {
  const raw = parseYaml(readFileSync(path, "utf-8"));
  return ProjectConfigSchema.parse(raw);
}
