import { test, expect } from "bun:test";
import { join } from "node:path";
import { loadPipelineConfig } from "../../src/config/loader";

const TEMPLATES_DIR = join(process.cwd(), "src", "commands", "init-templates");

test("ralph-only.yaml template parses against the real pipeline schema", () => {
  const config = loadPipelineConfig(join(TEMPLATES_DIR, "ralph-only.yaml"));
  expect(config.name).toBe("ralph-only");
  expect(config.stages.map((s) => s.type)).toEqual(["ralph_loop"]);
});
