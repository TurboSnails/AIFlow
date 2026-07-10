import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelsConfig, loadPipelineConfig, loadProjectConfig } from "../../src/config/loader";

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

test("loadPipelineConfig parses a brainstorm stage with defaults applied", () => {
  withTempDir((dir) => {
    const path = join(dir, "full-auto.yaml");
    writeFileSync(
      path,
      `name: full-auto
stages:
  - id: ideate
    type: brainstorm
    models: ["main-dev", "reviewer"]
    synthesizer: main-dev
`
    );
    const config = loadPipelineConfig(path);
    const stage = config.stages[0];
    expect(stage.type).toBe("brainstorm");
    if (stage.type !== "brainstorm") throw new Error("expected a brainstorm stage");
    expect(stage.mode).toBe("independent");
    expect(stage.debate_rounds).toBe(2);
    expect(stage.output).toBe("brainstorm-report.md");
  });
});

test("loadPipelineConfig rejects a brainstorm stage with fewer than 2 models", () => {
  withTempDir((dir) => {
    const path = join(dir, "full-auto.yaml");
    writeFileSync(
      path,
      `name: full-auto
stages:
  - id: ideate
    type: brainstorm
    models: ["main-dev"]
    synthesizer: main-dev
`
    );
    expect(() => loadPipelineConfig(path)).toThrow();
  });
});

test("loadPipelineConfig parses a spec stage with default output", () => {
  withTempDir((dir) => {
    const path = join(dir, "full-auto.yaml");
    writeFileSync(path, `name: full-auto\nstages:\n  - id: spec\n    type: spec\n    model: main-dev\n`);
    const config = loadPipelineConfig(path);
    const stage = config.stages[0];
    expect(stage.type).toBe("spec");
    if (stage.type !== "spec") throw new Error("expected a spec stage");
    expect(stage.output).toBe("spec.md");
  });
});

test("loadPipelineConfig parses a plan stage with default input/output", () => {
  withTempDir((dir) => {
    const path = join(dir, "full-auto.yaml");
    writeFileSync(path, `name: full-auto\nstages:\n  - id: plan\n    type: plan\n    model: main-dev\n`);
    const config = loadPipelineConfig(path);
    const stage = config.stages[0];
    expect(stage.type).toBe("plan");
    if (stage.type !== "plan") throw new Error("expected a plan stage");
    expect(stage.input).toBe("spec.md");
    expect(stage.output).toBe("prd.json");
  });
});

test("loadPipelineConfig parses a human_gate stage; timeout undefined and on_timeout defaults to abort", () => {
  withTempDir((dir) => {
    const path = join(dir, "full-auto.yaml");
    writeFileSync(
      path,
      `name: full-auto\nstages:\n  - id: confirm\n    type: human_gate\n    prompt: "Please confirm spec.md"\n`
    );
    const config = loadPipelineConfig(path);
    const stage = config.stages[0];
    expect(stage.type).toBe("human_gate");
    if (stage.type !== "human_gate") throw new Error("expected a human_gate stage");
    expect(stage.timeout).toBeUndefined();
    expect(stage.on_timeout).toBe("abort");
  });
});

test("loadPipelineConfig rejects an unknown stage type", () => {
  withTempDir((dir) => {
    const path = join(dir, "full-auto.yaml");
    writeFileSync(path, `name: full-auto\nstages:\n  - id: x\n    type: not_a_real_type\n`);
    expect(() => loadPipelineConfig(path)).toThrow();
  });
});

test("loadPipelineConfig parses a pipeline mixing multiple stage types", () => {
  withTempDir((dir) => {
    const path = join(dir, "full-auto.yaml");
    writeFileSync(
      path,
      `name: full-auto
stages:
  - id: ideate
    type: brainstorm
    models: ["main-dev", "reviewer"]
    synthesizer: main-dev
  - id: spec
    type: spec
    model: main-dev
  - id: confirm
    type: human_gate
    prompt: "confirm"
  - id: plan
    type: plan
    model: main-dev
  - id: develop
    type: ralph_loop
    model: main-dev
    per_story_fix_limit: 3
    gate:
      checks: []
      ai_review:
        enabled: false
        model: reviewer
        fail_on: ["blocker"]
`
    );
    const config = loadPipelineConfig(path);
    expect(config.stages.map((s) => s.type)).toEqual(["brainstorm", "spec", "human_gate", "plan", "ralph_loop"]);
  });
});

test("loadModelsConfig parses optional input_cost_per_1m/output_cost_per_1m", () => {
  withTempDir((dir) => {
    const path = join(dir, "models.yaml");
    writeFileSync(
      path,
      `profiles:
  reviewer:
    channel: http
    provider: minimax
    model: some-model
    base_url: https://api.minimaxi.com/v1
    api_key_env: MINIMAX_API_KEY
    input_cost_per_1m: 0.6
    output_cost_per_1m: 2.4
`
    );
    const config = loadModelsConfig(path);
    expect(config.profiles["reviewer"].input_cost_per_1m).toBe(0.6);
    expect(config.profiles["reviewer"].output_cost_per_1m).toBe(2.4);
  });
});

test("loadModelsConfig leaves input_cost_per_1m/output_cost_per_1m undefined when omitted", () => {
  withTempDir((dir) => {
    const path = join(dir, "models.yaml");
    writeFileSync(path, `profiles:\n  main-dev:\n    channel: opencode\n    provider: opencode\n    model: x\n`);
    const config = loadModelsConfig(path);
    expect(config.profiles["main-dev"].input_cost_per_1m).toBeUndefined();
  });
});

test("loadPipelineConfig parses an optional top-level budget.max_cost_usd", () => {
  withTempDir((dir) => {
    const path = join(dir, "ralph-only.yaml");
    writeFileSync(
      path,
      `name: ralph-only
budget:
  max_cost_usd: 20
stages:
  - id: develop
    type: ralph_loop
    model: main-dev
    gate:
      checks: []
      ai_review:
        enabled: false
        model: reviewer
        fail_on: ["blocker"]
`
    );
    const config = loadPipelineConfig(path);
    expect(config.budget?.max_cost_usd).toBe(20);
  });
});

test("loadPipelineConfig leaves budget undefined when omitted", () => {
  withTempDir((dir) => {
    const path = join(dir, "ralph-only.yaml");
    writeFileSync(
      path,
      `name: ralph-only
stages:
  - id: develop
    type: ralph_loop
    model: main-dev
    gate:
      checks: []
      ai_review:
        enabled: false
        model: reviewer
        fail_on: ["blocker"]
`
    );
    const config = loadPipelineConfig(path);
    expect(config.budget).toBeUndefined();
  });
});

test("loads pipeline with autonomy, isolation, and multi-reviewer gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const path = join(dir, "pipeline.yaml");
  writeFileSync(path, `
name: full-auto
autonomy: full
isolation: worktree
budget:
  max_cost_usd: 20
  max_retry_steps: 5
  max_token_cost: 2
stages:
  - id: develop
    type: ralph_loop
    model: main-dev
    gate:
      checks: [echo ok]
      ai_review:
        enabled: true
        reviewers: [kimi, ds]
        fail_on: [blocker]
        fail_threshold:
          major: 3
        strict: false
`);
  const cfg = loadPipelineConfig(path);
  expect(cfg.autonomy).toBe("full");
  expect(cfg.budget?.max_retry_steps).toBe(5);
  expect(cfg.stages[0].gate.ai_review.reviewers).toEqual(["kimi", "ds"]);
});

test("loads project config defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcfg-"));
  const path = join(dir, "project.yaml");
  writeFileSync(path, "{}\n");
  const cfg = loadProjectConfig(path);
  expect(cfg.max_drift_files).toBe(50);
  expect(cfg.dashboard?.port).toBe(8080);
});
