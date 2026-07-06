import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelsConfig, loadPipelineConfig } from "../../src/config/loader";

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-config-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadModelsConfig parses a valid models.yaml", () => {
  withTempDir((dir) => {
    const path = join(dir, "models.yaml");
    writeFileSync(
      path,
      `profiles:
  main-dev:
    channel: opencode
    provider: opencode
    model: opencode/deepseek-v4-flash-free
  reviewer:
    channel: http
    provider: minimax
    model: some-model
    base_url: https://api.minimaxi.com/v1
    api_key_env: MINIMAX_API_KEY
`
    );
    const config = loadModelsConfig(path);
    expect(config.profiles["main-dev"].channel).toBe("opencode");
    expect(config.profiles["reviewer"].api_key_env).toBe("MINIMAX_API_KEY");
  });
});

test("loadModelsConfig throws on invalid channel value", () => {
  withTempDir((dir) => {
    const path = join(dir, "models.yaml");
    writeFileSync(
      path,
      `profiles:
  bad:
    channel: not-a-real-channel
    provider: x
    model: y
`
    );
    expect(() => loadModelsConfig(path)).toThrow();
  });
});

test("loadPipelineConfig parses a valid ralph-only.yaml and applies max_iterations/stall_limit defaults", () => {
  withTempDir((dir) => {
    const path = join(dir, "ralph-only.yaml");
    writeFileSync(
      path,
      `name: ralph-only
stages:
  - id: develop
    type: ralph_loop
    model: main-dev
    per_story_fix_limit: 3
    gate:
      checks:
        - "npm run lint"
        - "npm run test"
      ai_review:
        enabled: true
        model: reviewer
        fail_on: ["blocker"]
        fail_threshold:
          major: 3
        strict: false
`
    );
    const config = loadPipelineConfig(path);
    expect(config.name).toBe("ralph-only");
    const stage = config.stages[0];
    expect(stage.type).toBe("ralph_loop");
    if (stage.type !== "ralph_loop") throw new Error("expected a ralph_loop stage");
    expect(stage.gate.checks).toEqual(["npm run lint", "npm run test"]);
    expect(stage.gate.ai_review.fail_on).toEqual(["blocker"]);
    expect(stage.max_iterations).toBe(10);
    expect(stage.stall_limit).toBe(3);
  });
});

test("loadPipelineConfig honors explicit max_iterations/stall_limit overrides", () => {
  withTempDir((dir) => {
    const path = join(dir, "ralph-only.yaml");
    writeFileSync(
      path,
      `name: ralph-only
stages:
  - id: develop
    type: ralph_loop
    model: main-dev
    per_story_fix_limit: 3
    max_iterations: 5
    stall_limit: 2
    gate:
      checks: []
      ai_review:
        enabled: false
        model: reviewer
        fail_on: ["blocker"]
`
    );
    const config = loadPipelineConfig(path);
    const stage = config.stages[0];
    if (stage.type !== "ralph_loop") throw new Error("expected a ralph_loop stage");
    expect(stage.max_iterations).toBe(5);
    expect(stage.stall_limit).toBe(2);
  });
});

test("loadPipelineConfig rejects a non-positive max_iterations", () => {
  withTempDir((dir) => {
    const path = join(dir, "ralph-only.yaml");
    writeFileSync(
      path,
      `name: ralph-only
stages:
  - id: develop
    type: ralph_loop
    model: main-dev
    max_iterations: 0
    gate:
      checks: []
      ai_review:
        enabled: false
        model: reviewer
        fail_on: ["blocker"]
`
    );
    expect(() => loadPipelineConfig(path)).toThrow();
  });
});

test("loadPipelineConfig throws when a stage is missing required gate config", () => {
  withTempDir((dir) => {
    const path = join(dir, "bad-pipeline.yaml");
    writeFileSync(
      path,
      `name: broken
stages:
  - id: develop
    type: ralph_loop
    model: main-dev
`
    );
    expect(() => loadPipelineConfig(path)).toThrow();
  });
});
