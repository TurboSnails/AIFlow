import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadPipelineConfig } from "../../src/config/loader";
import { runInit, PIPELINE_TEMPLATE_NAMES } from "../../src/commands/init";
import { loadModelsConfig } from "../../src/config/loader";
import type { PipelineConfig } from "../../src/config/schema";

const TEMPLATES_DIR = join(process.cwd(), "src", "commands", "init-templates");

test("ralph-only.yaml template parses against the real pipeline schema", () => {
  const config = loadPipelineConfig(join(TEMPLATES_DIR, "ralph-only.yaml"));
  expect(config.name).toBe("ralph-only");
  expect(config.stages.map((s) => s.type)).toEqual(["ralph_loop"]);
});

test("superpowers.yaml template parses with the expected stage sequence", () => {
  const config = loadPipelineConfig(join(TEMPLATES_DIR, "superpowers.yaml"));
  expect(config.name).toBe("superpowers");
  expect(config.stages.map((s) => s.type)).toEqual(["brainstorm", "spec", "human_gate", "plan", "ralph_loop"]);
});

test("spec-superflow.yaml template parses with the expected stage sequence", () => {
  const config = loadPipelineConfig(join(TEMPLATES_DIR, "spec-superflow.yaml"));
  expect(config.name).toBe("spec-superflow");
  expect(config.stages.map((s) => s.type)).toEqual(["brainstorm", "spec", "human_gate", "plan", "ralph_loop"]);
});

test("openspec.yaml template parses with the expected stage sequence", () => {
  const config = loadPipelineConfig(join(TEMPLATES_DIR, "openspec.yaml"));
  expect(config.name).toBe("openspec");
  expect(config.stages.map((s) => s.type)).toEqual(["spec", "plan", "ralph_loop"]);
});

test("every profile referenced by a bundled pipeline template exists in the default models.yaml scaffold", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-init-templates-test-"));
  try {
    runInit(dir);
    const modelsConfig = loadModelsConfig(join(dir, ".aiflow", "config", "models.yaml"));
    const knownProfiles = new Set(Object.keys(modelsConfig.profiles));

    function assertStageProfilesKnown(stage: PipelineConfig["stages"][number]) {
      if (stage.type === "ralph_loop" || stage.type === "spec" || stage.type === "plan") {
        expect(knownProfiles.has(stage.model)).toBe(true);
      }
      if (stage.type === "brainstorm") {
        for (const modelName of stage.models) expect(knownProfiles.has(modelName)).toBe(true);
        expect(knownProfiles.has(stage.synthesizer)).toBe(true);
      }
      if (stage.type === "ralph_loop" && stage.gate.ai_review.enabled) {
        expect(knownProfiles.has(stage.gate.ai_review.model!)).toBe(true);
      }
    }

    for (const templateName of PIPELINE_TEMPLATE_NAMES) {
      const pipeline = loadPipelineConfig(join(TEMPLATES_DIR, `${templateName}.yaml`));
      for (const stage of pipeline.stages) assertStageProfilesKnown(stage);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
