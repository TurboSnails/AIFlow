# AIFlow CLI First Vertical Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real, working `aiflow` CLI that can run one full Ralph Loop iteration — real OpenCode agent call, real two-layer review gate, real git commit — against a disposable sample project, proving the entire OpenCode-integration risk identified in the design spec.

**Architecture:** A single-package TypeScript/Bun CLI (`commander`-based) with clearly separated modules: config loading (zod), a minimal single-stage Pipeline Engine, an OpenCode Adapter that parses OpenCode's real `--format json` event stream, a two-layer Review Gate (deterministic checks + direct-HTTP AI review), a `ralph_loop` Stage Runner that wires them together, and three CLI commands (`doctor`, `init`, `run`).

**Tech Stack:** TypeScript, Bun 1.3.x runtime + `bun:test` test runner (no separate test framework), `commander` (CLI), `zod` (schema validation), `yaml` (config parsing), `Bun.$` (git shell calls). The `fixtures/sample-project` package is a separate, realistic Node-style project (ESLint + Vitest) — it intentionally does NOT share AIFlow's toolchain, since it's the *target* being developed, not part of AIFlow itself.

**Design spec:** `docs/superpowers/specs/2026-07-05-aiflow-cli-ralph-slice-design.md` — read this first for full rationale. This plan implements it exactly, resolving its three "Open Items" concretely as follows (not deferred further):

- **Open item 1** (exact reviewer model id/base_url): left as literal `REPLACE_ME_VERIFY_VIA_DOCTOR` placeholders in the fixture's `models.yaml` until Task 18, where `aiflow doctor` is used empirically to discover and fill in the real values once a real API key is available. Every other task uses fully concrete code — this is the one deliberately-external unknown, not a shortcut.
- **Open item 2** (`opencode agent create` scripting): resolved by *not* implementing it. The optional `agent` field on a model profile only passes an existing agent name through `--agent <name>`; creating agents is a one-time, out-of-band step the user runs themselves via the real `opencode agent create` command. No task creates agents programmatically.
- **Open item 3** (truncation thresholds): resolved concretely — check-failure output truncated to the last 4000 characters (`MAX_CHECK_OUTPUT_CHARS`), diff fed to AI review truncated to the last 8000 characters (`MAX_DIFF_CHARS`). See Tasks 9 and 12.

## Global Constraints

- Runtime: Bun (installed here: `1.3.12`). No Node-specific tooling (no ts-node, no separate bundler) — Bun runs TypeScript directly.
- Single package, no monorepo. The GUI is a separate future project entirely.
- OpenCode CLI verified at `1.17.11` in this environment; the Adapter must always pass `--format json` and must never pass `--dangerously-skip-permissions` unless a profile explicitly opts in (`dangerously_skip_permissions: true`, default `false`).
- Every Ralph iteration is a **fresh** `opencode run` subprocess call. Never use `--continue` / `--session` / `--fork`.
- For the OpenCode channel, `step_finish.tokens` / `step_finish.cost` from the real event stream are the sole source of usage/cost data — no separate token→USD table for that channel.
- The direct-HTTP (reviewer) channel never reads `~/.local/share/opencode/auth.json`. It requires its own `api_key_env`-named environment variable.
- `state.json` writes must be atomic: write to a temp file, then rename over the target — never a partial write visible on disk.
- Test runner is `bun:test` throughout AIFlow's own test suite (`import { test, expect, mock } from "bun:test"`).
- `prd.json` lives at the target project's root (e.g., `fixtures/sample-project/prd.json`), mutated in place and committed to *that* project's git history alongside code changes — it is not duplicated under `.aiflow/runs/<id>/artifacts/`.

---

## Task 1: Project Scaffold + CLI Skeleton

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/cli.ts`
- Test: `test/unit/cli.test.ts`

**Interfaces:**
- Produces: an executable `bun run src/cli.ts` entry point with three registered (stub) subcommands: `doctor`, `init`, `run --pipeline <name> [--once]`. Later tasks replace the stub bodies.

- [ ] **Step 1: Write the failing test**

Create `test/unit/cli.test.ts`:
```ts
import { test, expect } from "bun:test";

test("cli --help lists doctor, init, run commands", async () => {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--help"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  expect(output).toContain("doctor");
  expect(output).toContain("init");
  expect(output).toContain("run");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/cli.test.ts`
Expected: FAIL — `src/cli.ts` does not exist yet (module/file not found error), or `package.json`/`tsconfig.json` missing causes the spawn to error.

- [ ] **Step 3: Write minimal implementation**

Create `package.json`:
```json
{
  "name": "aiflow",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "cli": "bun run src/cli.ts"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "yaml": "^2.5.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleDetection": "force",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "types": ["bun-types"]
  }
}
```

Create `.gitignore`:
```
node_modules/
.aiflow/runs/
*.log
```

Create `src/cli.ts`:
```ts
#!/usr/bin/env bun
import { Command } from "commander";

const program = new Command();
program.name("aiflow").description("AIFlow pipeline orchestrator CLI").version("0.1.0");

program
  .command("doctor")
  .description("Check environment: OpenCode, reviewer API key, git status")
  .action(async () => {
    console.log("doctor: not implemented yet");
  });

program
  .command("init")
  .description("Generate .aiflow/ config scaffold in the current directory")
  .action(async () => {
    console.log("init: not implemented yet");
  });

program
  .command("run")
  .description("Run a pipeline")
  .requiredOption("--pipeline <name>", "pipeline name to run")
  .option("--once", "run exactly one iteration", false)
  .action(async (opts: { pipeline: string; once: boolean }) => {
    console.log("run: not implemented yet", opts);
  });

program.parseAsync(process.argv);
```

Run `bun install` to fetch dependencies before continuing.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/cli.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json .gitignore src/cli.ts test/unit/cli.test.ts bun.lock
git commit -m "chore: scaffold aiflow CLI project with stub commands"
```

---

## Task 2: Config Schemas + Loader

**Files:**
- Create: `src/config/schema.ts`
- Create: `src/config/loader.ts`
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Produces:
  - `ModelProfileSchema`, `ModelProfile` (type)
  - `ModelsConfigSchema`, `ModelsConfig` (type) — shape `{ profiles: Record<string, ModelProfile> }`
  - `ReviewGateConfigSchema`, `ReviewGateConfig` (type)
  - `RalphLoopStageSchema`, `RalphLoopStageConfig` (type)
  - `PipelineConfigSchema`, `PipelineConfig` (type) — shape `{ name: string; stages: RalphLoopStageConfig[] }`
  - `loadModelsConfig(path: string): ModelsConfig`
  - `loadPipelineConfig(path: string): PipelineConfig`

- [ ] **Step 1: Write the failing test**

Create `test/unit/config.test.ts`:
```ts
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

test("loadPipelineConfig parses a valid ralph-only.yaml", () => {
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
    expect(config.stages[0].type).toBe("ralph_loop");
    expect(config.stages[0].gate.checks).toEqual(["npm run lint", "npm run test"]);
    expect(config.stages[0].gate.ai_review.fail_on).toEqual(["blocker"]);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/config.test.ts`
Expected: FAIL — `src/config/loader.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/config/schema.ts`:
```ts
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

export const PipelineConfigSchema = z.object({
  name: z.string(),
  stages: z.array(RalphLoopStageSchema),
});
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
```

Create `src/config/loader.ts`:
```ts
import { parse as parseYaml } from "yaml";
import { readFileSync } from "node:fs";
import { ModelsConfigSchema, PipelineConfigSchema, type ModelsConfig, type PipelineConfig } from "./schema";

export function loadModelsConfig(path: string): ModelsConfig {
  const raw = parseYaml(readFileSync(path, "utf-8"));
  return ModelsConfigSchema.parse(raw);
}

export function loadPipelineConfig(path: string): PipelineConfig {
  const raw = parseYaml(readFileSync(path, "utf-8"));
  return PipelineConfigSchema.parse(raw);
}
```

Run `bun install` (adds `yaml`, `zod` if not already fetched by Task 1's install).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts src/config/loader.ts test/unit/config.test.ts
git commit -m "feat: add zod schemas and YAML loaders for models/pipeline config"
```

---

## Task 3: state.json Module

**Files:**
- Create: `src/engine/state.ts`
- Test: `test/unit/state.test.ts`

**Interfaces:**
- Produces:
  - `type StageStatus = "pending" | "running" | "done" | "failed" | "aborted"`
  - `interface StageState { id: string; status: StageStatus; iteration?: number }`
  - `interface EngineState { run_id: string; pipeline: string; stages: StageState[]; cost: { input_tokens: number; output_tokens: number; est_usd: number } }`
  - `writeStateAtomic(runDir: string, state: EngineState): void`
  - `readState(runDir: string): EngineState`

- [ ] **Step 1: Write the failing test**

Create `test/unit/state.test.ts`:
```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStateAtomic, readState, type EngineState } from "../../src/engine/state";

test("writeStateAtomic then readState round-trips the exact state", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-state-test-"));
  try {
    const state: EngineState = {
      run_id: "20260705_000000_abc123",
      pipeline: "ralph-only",
      stages: [{ id: "develop", status: "running", iteration: 1 }],
      cost: { input_tokens: 100, output_tokens: 20, est_usd: 0.01 },
    };
    writeStateAtomic(dir, state);
    const loaded = readState(dir);
    expect(loaded).toEqual(state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeStateAtomic leaves no temp file behind on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-state-test-"));
  try {
    const state: EngineState = {
      run_id: "r1",
      pipeline: "ralph-only",
      stages: [],
      cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    };
    writeStateAtomic(dir, state);
    const files = readdirSync(dir);
    expect(files).toEqual(["state.json"]);
    expect(existsSync(join(dir, "state.json.tmp"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/state.test.ts`
Expected: FAIL — `src/engine/state.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/engine/state.ts`:
```ts
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export type StageStatus = "pending" | "running" | "done" | "failed" | "aborted";

export interface StageState {
  id: string;
  status: StageStatus;
  iteration?: number;
}

export interface EngineState {
  run_id: string;
  pipeline: string;
  stages: StageState[];
  cost: { input_tokens: number; output_tokens: number; est_usd: number };
}

export function writeStateAtomic(runDir: string, state: EngineState): void {
  const finalPath = join(runDir, "state.json");
  const tempPath = join(runDir, "state.json.tmp");
  writeFileSync(tempPath, JSON.stringify(state, null, 2));
  renameSync(tempPath, finalPath);
}

export function readState(runDir: string): EngineState {
  const raw = readFileSync(join(runDir, "state.json"), "utf-8");
  return JSON.parse(raw) as EngineState;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/state.ts test/unit/state.test.ts
git commit -m "feat: add atomic state.json read/write module"
```

---

## Task 4: events.jsonl Module

**Files:**
- Create: `src/events/events.ts`
- Test: `test/unit/events.test.ts`

**Interfaces:**
- Produces:
  - `type AiflowEvent = OpencodeToolUseAiflowEvent | OpencodeStepFinishAiflowEvent | GateResultAiflowEvent | StoryResultAiflowEvent` (four variants, discriminated by `type`)
  - `appendEvent(runDir: string, event: AiflowEvent): void`
  - `readEvents(runDir: string): AiflowEvent[]`

- [ ] **Step 1: Write the failing test**

Create `test/unit/events.test.ts`:
```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEvents, type AiflowEvent } from "../../src/events/events";

test("appendEvent then readEvents round-trips multiple events in order", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-events-test-"));
  try {
    const e1: AiflowEvent = {
      ts: "2026-07-05T00:00:00.000Z",
      type: "opencode_tool_use",
      stage: "develop",
      story: "US-1",
      tool: "write",
      summary: "wrote src/math.ts",
    };
    const e2: AiflowEvent = {
      ts: "2026-07-05T00:00:01.000Z",
      type: "opencode_step_finish",
      stage: "develop",
      in_tok: 100,
      out_tok: 20,
      cost_usd: 0.001,
    };
    const e3: AiflowEvent = {
      ts: "2026-07-05T00:00:02.000Z",
      type: "gate_result",
      stage: "develop",
      story: "US-1",
      checks: "pass",
      ai_review: "pass",
      blockers: 0,
    };
    const e4: AiflowEvent = {
      ts: "2026-07-05T00:00:03.000Z",
      type: "story_result",
      story: "US-1",
      result: "pass",
    };
    appendEvent(dir, e1);
    appendEvent(dir, e2);
    appendEvent(dir, e3);
    appendEvent(dir, e4);
    const events = readEvents(dir);
    expect(events).toEqual([e1, e2, e3, e4]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/events.test.ts`
Expected: FAIL — `src/events/events.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/events/events.ts`:
```ts
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface OpencodeToolUseAiflowEvent {
  ts: string;
  type: "opencode_tool_use";
  stage: string;
  story: string;
  tool: string;
  summary: string;
}

export interface OpencodeStepFinishAiflowEvent {
  ts: string;
  type: "opencode_step_finish";
  stage: string;
  in_tok: number;
  out_tok: number;
  cost_usd: number;
}

export interface GateResultAiflowEvent {
  ts: string;
  type: "gate_result";
  stage: string;
  story: string;
  checks: "pass" | "fail";
  ai_review: "pass" | "fail" | "skipped";
  blockers: number;
}

export interface StoryResultAiflowEvent {
  ts: string;
  type: "story_result";
  story: string;
  result: "pass" | "fail" | "suspended";
}

export type AiflowEvent =
  | OpencodeToolUseAiflowEvent
  | OpencodeStepFinishAiflowEvent
  | GateResultAiflowEvent
  | StoryResultAiflowEvent;

function eventsPath(runDir: string): string {
  return join(runDir, "events.jsonl");
}

export function appendEvent(runDir: string, event: AiflowEvent): void {
  appendFileSync(eventsPath(runDir), JSON.stringify(event) + "\n");
}

export function readEvents(runDir: string): AiflowEvent[] {
  const path = eventsPath(runDir);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AiflowEvent);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/events.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/events/events.ts test/unit/events.test.ts
git commit -m "feat: add events.jsonl append/read module with AiflowEvent types"
```

---

## Task 5: prd.json Module

**Files:**
- Create: `src/prd.ts`
- Test: `test/unit/prd.test.ts`

**Interfaces:**
- Produces:
  - `interface Story { id: string; title: string; acceptance: string[]; priority: number; passes: boolean; fixCount: number; suspended?: boolean }`
  - `interface Prd { branchName: string; stories: Story[] }`
  - `readPrd(path: string): Prd`
  - `writePrd(path: string, prd: Prd): void`
  - `selectNextStory(prd: Prd): Story | null`
  - `markStoryPassed(prd: Prd, storyId: string): Prd`
  - `recordStoryFailure(prd: Prd, storyId: string, fixLimit: number): Prd`

- [ ] **Step 1: Write the failing test**

Create `test/unit/prd.test.ts`:
```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrd, writePrd, selectNextStory, markStoryPassed, recordStoryFailure, type Prd } from "../../src/prd";

function samplePrd(): Prd {
  return {
    branchName: "feat/us-1",
    stories: [
      { id: "US-1", title: "First", acceptance: ["a"], priority: 1, passes: false, fixCount: 0 },
      { id: "US-2", title: "Second", acceptance: ["b"], priority: 2, passes: false, fixCount: 0 },
    ],
  };
}

test("writePrd then readPrd round-trips exactly", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-prd-test-"));
  try {
    const path = join(dir, "prd.json");
    const prd = samplePrd();
    writePrd(path, prd);
    expect(readPrd(path)).toEqual(prd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectNextStory returns the lowest-priority story where passes is false and not suspended", () => {
  const prd = samplePrd();
  const next = selectNextStory(prd);
  expect(next?.id).toBe("US-1");
});

test("selectNextStory skips suspended stories", () => {
  const prd = samplePrd();
  prd.stories[0].suspended = true;
  const next = selectNextStory(prd);
  expect(next?.id).toBe("US-2");
});

test("selectNextStory returns null when all stories pass or are suspended", () => {
  const prd = samplePrd();
  prd.stories[0].passes = true;
  prd.stories[1].suspended = true;
  expect(selectNextStory(prd)).toBeNull();
});

test("markStoryPassed sets passes=true for the matching story only", () => {
  const prd = samplePrd();
  const updated = markStoryPassed(prd, "US-1");
  expect(updated.stories.find((s) => s.id === "US-1")?.passes).toBe(true);
  expect(updated.stories.find((s) => s.id === "US-2")?.passes).toBe(false);
});

test("recordStoryFailure increments fixCount and does not suspend below the limit", () => {
  const prd = samplePrd();
  const updated = recordStoryFailure(prd, "US-1", 3);
  const story = updated.stories.find((s) => s.id === "US-1")!;
  expect(story.fixCount).toBe(1);
  expect(story.suspended).toBeFalsy();
});

test("recordStoryFailure suspends the story once fixCount exceeds the limit", () => {
  let prd = samplePrd();
  prd.stories[0].fixCount = 3;
  prd = recordStoryFailure(prd, "US-1", 3);
  const story = prd.stories.find((s) => s.id === "US-1")!;
  expect(story.fixCount).toBe(4);
  expect(story.suspended).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/prd.test.ts`
Expected: FAIL — `src/prd.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/prd.ts`:
```ts
import { readFileSync, writeFileSync } from "node:fs";

export interface Story {
  id: string;
  title: string;
  acceptance: string[];
  priority: number;
  passes: boolean;
  fixCount: number;
  suspended?: boolean;
}

export interface Prd {
  branchName: string;
  stories: Story[];
}

export function readPrd(path: string): Prd {
  return JSON.parse(readFileSync(path, "utf-8")) as Prd;
}

export function writePrd(path: string, prd: Prd): void {
  writeFileSync(path, JSON.stringify(prd, null, 2));
}

export function selectNextStory(prd: Prd): Story | null {
  const candidates = prd.stories.filter((s) => !s.passes && !s.suspended);
  if (candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => a.priority - b.priority)[0];
}

export function markStoryPassed(prd: Prd, storyId: string): Prd {
  return {
    ...prd,
    stories: prd.stories.map((s) => (s.id === storyId ? { ...s, passes: true } : s)),
  };
}

export function recordStoryFailure(prd: Prd, storyId: string, fixLimit: number): Prd {
  return {
    ...prd,
    stories: prd.stories.map((s) => {
      if (s.id !== storyId) return s;
      const fixCount = s.fixCount + 1;
      return { ...s, fixCount, suspended: fixCount > fixLimit };
    }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/prd.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/prd.ts test/unit/prd.test.ts
git commit -m "feat: add prd.json read/write and story selection/mutation helpers"
```

---

## Task 6: Git Helper Module

**Files:**
- Create: `src/git.ts`
- Test: `test/unit/git.test.ts`

**Interfaces:**
- Produces:
  - `revParseHead(cwd: string): Promise<string>`
  - `stageAll(cwd: string): Promise<void>`
  - `diffCached(cwd: string): Promise<string>`
  - `commit(cwd: string, message: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `test/unit/git.test.ts`:
```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { revParseHead, stageAll, diffCached, commit } from "../../src/git";

async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-git-test-"));
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} config user.email "test@example.com"`;
  await $`git -C ${dir} config user.name "Test"`;
  writeFileSync(join(dir, "a.txt"), "hello\n");
  await $`git -C ${dir} add -A`;
  await $`git -C ${dir} commit -q -m "initial"`;
  return dir;
}

test("revParseHead returns the current HEAD sha", async () => {
  const dir = await makeTempRepo();
  try {
    const sha = await revParseHead(dir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stageAll + diffCached shows staged changes including new files", async () => {
  const dir = await makeTempRepo();
  try {
    writeFileSync(join(dir, "b.txt"), "new file\n");
    await stageAll(dir);
    const diff = await diffCached(dir);
    expect(diff).toContain("b.txt");
    expect(diff).toContain("new file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit creates a new commit with the given message on top of HEAD", async () => {
  const dir = await makeTempRepo();
  try {
    const before = await revParseHead(dir);
    writeFileSync(join(dir, "c.txt"), "content\n");
    await stageAll(dir);
    await commit(dir, "feat: add c.txt");
    const after = await revParseHead(dir);
    expect(after).not.toBe(before);
    const log = await $`git -C ${dir} log -1 --pretty=%s`.text();
    expect(log.trim()).toBe("feat: add c.txt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/git.test.ts`
Expected: FAIL — `src/git.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/git.ts`:
```ts
import { $ } from "bun";

export async function revParseHead(cwd: string): Promise<string> {
  const out = await $`git -C ${cwd} rev-parse HEAD`.text();
  return out.trim();
}

export async function stageAll(cwd: string): Promise<void> {
  await $`git -C ${cwd} add -A`.quiet();
}

export async function diffCached(cwd: string): Promise<string> {
  const out = await $`git -C ${cwd} diff --cached`.text();
  return out;
}

export async function commit(cwd: string, message: string): Promise<void> {
  await $`git -C ${cwd} commit -q -m ${message}`.quiet();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/git.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/git.ts test/unit/git.test.ts
git commit -m "feat: add git helper module (revParseHead/stageAll/diffCached/commit)"
```

---

## Task 7: OpenCode Event Line Parser

**Files:**
- Create: `src/adapters/opencode-events.ts`
- Test: `test/unit/opencode-events.test.ts`

**Interfaces:**
- Produces:
  - `type OpenCodeEvent = OpenCodeStepStartEvent | OpenCodeToolUseEvent | OpenCodeTextEvent | OpenCodeStepFinishEvent`
  - `parseOpenCodeLine(line: string): OpenCodeEvent | null`

**Note:** the test fixtures below are the *actual, real* JSONL lines captured while designing this feature (see design spec §3), not invented data.

- [ ] **Step 1: Write the failing test**

Create `test/unit/opencode-events.test.ts`:
```ts
import { test, expect } from "bun:test";
import { parseOpenCodeLine } from "../../src/adapters/opencode-events";

const REAL_STEP_START =
  '{"type":"step_start","timestamp":1783257123977,"sessionID":"ses_0cd97c097ffe0FYqm59S7Wj1CI","part":{"id":"prt_f32684c86001IFK9DKDvJ7cE4w","messageID":"msg_f32683fc4001Z6gjRkK2vEk15A","sessionID":"ses_0cd97c097ffe0FYqm59S7Wj1CI","type":"step-start"}}';

const REAL_TEXT =
  '{"type":"text","timestamp":1783257125253,"sessionID":"ses_0cd97c097ffe0FYqm59S7Wj1CI","part":{"id":"prt_f3268516c001v16hO64vxT3YQZ","messageID":"msg_f32683fc4001Z6gjRkK2vEk15A","sessionID":"ses_0cd97c097ffe0FYqm59S7Wj1CI","type":"text","text":"pong","time":{"start":1783257125228,"end":1783257125242}}}';

const REAL_TOOL_USE =
  '{"type":"tool_use","timestamp":1783257167043,"sessionID":"ses_0cd971fbcffeG5lm0AtSMqH9Rp","part":{"type":"tool","tool":"write","callID":"call_00_9EgATVv6DXFurYzQjn7p6510","state":{"status":"completed","input":{"filePath":"/tmp/hello.txt","content":"hello world"},"output":"Wrote file successfully.","metadata":{},"time":{"start":1783257167035,"end":1783257167042}},"id":"prt_f3268f2b1001mL2ZQkGyl6zwkG","sessionID":"ses_0cd971fbcffeG5lm0AtSMqH9Rp","messageID":"msg_f3268e09b0012aqRuHOHkKwHq3"}}';

const REAL_STEP_FINISH =
  '{"type":"step_finish","timestamp":1783257125253,"sessionID":"ses_0cd97c097ffe0FYqm59S7Wj1CI","part":{"id":"prt_f3268517e001b13UN3rBBDnE7v","reason":"stop","messageID":"msg_f32683fc4001Z6gjRkK2vEk15A","sessionID":"ses_0cd97c097ffe0FYqm59S7Wj1CI","type":"step-finish","tokens":{"total":10889,"input":10859,"output":3,"reasoning":27,"cache":{"write":0,"read":0}},"cost":0}}';

test("parses a real step_start line", () => {
  const event = parseOpenCodeLine(REAL_STEP_START);
  expect(event?.type).toBe("step_start");
});

test("parses a real text line and exposes the text content", () => {
  const event = parseOpenCodeLine(REAL_TEXT);
  expect(event?.type).toBe("text");
  if (event?.type === "text") {
    expect(event.part.text).toBe("pong");
  }
});

test("parses a real tool_use line and exposes tool name and status", () => {
  const event = parseOpenCodeLine(REAL_TOOL_USE);
  expect(event?.type).toBe("tool_use");
  if (event?.type === "tool_use") {
    expect(event.part.tool).toBe("write");
    expect(event.part.state.status).toBe("completed");
  }
});

test("parses a real step_finish line and exposes tokens and cost", () => {
  const event = parseOpenCodeLine(REAL_STEP_FINISH);
  expect(event?.type).toBe("step_finish");
  if (event?.type === "step_finish") {
    expect(event.part.tokens.input).toBe(10859);
    expect(event.part.tokens.output).toBe(3);
    expect(event.part.cost).toBe(0);
  }
});

test("returns null for a blank line", () => {
  expect(parseOpenCodeLine("")).toBeNull();
  expect(parseOpenCodeLine("   ")).toBeNull();
});

test("returns null for an unparseable non-JSON line", () => {
  expect(parseOpenCodeLine("not json at all")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/opencode-events.test.ts`
Expected: FAIL — `src/adapters/opencode-events.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/adapters/opencode-events.ts`:
```ts
export interface OpenCodeStepStartEvent {
  type: "step_start";
  timestamp: number;
  sessionID: string;
  part: unknown;
}

export interface OpenCodeToolUseEvent {
  type: "tool_use";
  timestamp: number;
  sessionID: string;
  part: {
    type: "tool";
    tool: string;
    callID: string;
    state: { status: string; input: unknown; output: unknown };
  };
}

export interface OpenCodeTextEvent {
  type: "text";
  timestamp: number;
  sessionID: string;
  part: { type: "text"; text: string };
}

export interface OpenCodeStepFinishEvent {
  type: "step_finish";
  timestamp: number;
  sessionID: string;
  part: {
    type: "step-finish";
    reason: string;
    tokens: { total: number; input: number; output: number; reasoning: number; cache: { write: number; read: number } };
    cost: number;
  };
}

export type OpenCodeEvent =
  | OpenCodeStepStartEvent
  | OpenCodeToolUseEvent
  | OpenCodeTextEvent
  | OpenCodeStepFinishEvent;

export function parseOpenCodeLine(line: string): OpenCodeEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || !("type" in raw)) return null;
  const type = (raw as { type: unknown }).type;
  if (type === "step_start" || type === "tool_use" || type === "text" || type === "step_finish") {
    return raw as OpenCodeEvent;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/opencode-events.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/opencode-events.ts test/unit/opencode-events.test.ts
git commit -m "feat: add OpenCode JSONL event line parser (real-schema-verified)"
```

---

## Task 8: OpenCode Adapter (Subprocess Wrapper)

**Files:**
- Create: `src/adapters/opencode.ts`
- Test: `test/unit/opencode-adapter.test.ts`

**Interfaces:**
- Consumes: `parseOpenCodeLine` from Task 7; `ModelProfile` from Task 2; `appendEvent`, `AiflowEvent` from Task 4.
- Produces:
  - `interface AgentTask { profile: ModelProfile; prompt: string; cwd: string; timeoutMs: number; runDir: string; stage: string; story: string }`
  - `interface AgentResult { ok: boolean; transcriptPath: string; usage: { inTok: number; outTok: number; costUsd: number } }`
  - `type SpawnFn = (cmd: string[], opts: { cwd: string; signal?: AbortSignal }) => { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill: () => void }`
  - `runAgentTask(task: AgentTask, spawnFn?: SpawnFn): Promise<AgentResult>`

- [ ] **Step 1: Write the failing test**

Create `test/unit/opencode-adapter.test.ts`:
```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentTask, type AgentTask } from "../../src/adapters/opencode";
import { readEvents } from "../../src/events/events";

function fakeStdoutStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + "\n"));
      }
      controller.close();
    },
  });
}

function baseTask(runDir: string): AgentTask {
  return {
    profile: { channel: "opencode", provider: "opencode", model: "opencode/deepseek-v4-flash-free" },
    prompt: "do something",
    cwd: "/tmp/does-not-matter-for-this-test",
    timeoutMs: 5000,
    runDir,
    stage: "develop",
    story: "US-1",
  };
}

test("runAgentTask parses a real event stream, writes events.jsonl, and reports usage", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-adapter-test-"));
  try {
    const lines = [
      '{"type":"step_start","timestamp":1,"sessionID":"s1","part":{}}',
      '{"type":"tool_use","timestamp":2,"sessionID":"s1","part":{"type":"tool","tool":"write","callID":"c1","state":{"status":"completed","input":{"filePath":"src/math.ts"},"output":"Wrote file successfully."}}}',
      '{"type":"step_finish","timestamp":3,"sessionID":"s1","part":{"type":"step-finish","reason":"stop","tokens":{"total":130,"input":110,"output":20,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0.002}}',
    ];
    const fakeSpawn = () => ({
      stdout: fakeStdoutStream(lines),
      exited: Promise.resolve(0),
      kill: () => {},
    });

    const result = await runAgentTask(baseTask(runDir), fakeSpawn);

    expect(result.ok).toBe(true);
    expect(result.usage.inTok).toBe(110);
    expect(result.usage.outTok).toBe(20);
    expect(result.usage.costUsd).toBe(0.002);

    const events = readEvents(runDir);
    const toolUseEvents = events.filter((e) => e.type === "opencode_tool_use");
    expect(toolUseEvents.length).toBe(1);
    expect((toolUseEvents[0] as any).tool).toBe("write");
    const finishEvents = events.filter((e) => e.type === "opencode_step_finish");
    expect(finishEvents.length).toBe(1);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runAgentTask returns ok:false when the subprocess exits non-zero", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-adapter-test-"));
  try {
    const fakeSpawn = () => ({
      stdout: fakeStdoutStream([]),
      exited: Promise.resolve(1),
      kill: () => {},
    });
    const result = await runAgentTask(baseTask(runDir), fakeSpawn);
    expect(result.ok).toBe(false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/opencode-adapter.test.ts`
Expected: FAIL — `src/adapters/opencode.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/adapters/opencode.ts`:
```ts
import { join } from "node:path";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import type { ModelProfile } from "../config/schema";
import { parseOpenCodeLine } from "./opencode-events";
import { appendEvent } from "../events/events";

export interface AgentTask {
  profile: ModelProfile;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  runDir: string;
  stage: string;
  story: string;
}

export interface AgentResult {
  ok: boolean;
  transcriptPath: string;
  usage: { inTok: number; outTok: number; costUsd: number };
}

export type SpawnFn = (
  cmd: string[],
  opts: { cwd: string; signal?: AbortSignal }
) => { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill: () => void };

const defaultSpawn: SpawnFn = (cmd, opts) => {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", signal: opts.signal });
  return { stdout: proc.stdout, exited: proc.exited, kill: () => proc.kill() };
};

function buildArgs(task: AgentTask): string[] {
  const args = ["opencode", "run", task.prompt, "--format", "json", "--dir", task.cwd];
  if (task.profile.agent) {
    args.push("--agent", task.profile.agent);
  } else {
    args.push("--model", `${task.profile.provider}/${task.profile.model}`);
  }
  if (task.profile.variant) args.push("--variant", task.profile.variant);
  if (task.profile.thinking) args.push("--thinking");
  if (task.profile.dangerously_skip_permissions) args.push("--dangerously-skip-permissions");
  return args;
}

export async function runAgentTask(task: AgentTask, spawnFn: SpawnFn = defaultSpawn): Promise<AgentResult> {
  const artifactsDir = join(task.runDir, "artifacts", "opencode");
  mkdirSync(artifactsDir, { recursive: true });
  const callId = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const transcriptPath = join(artifactsDir, `${callId}.jsonl`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), task.timeoutMs);

  const proc = spawnFn(buildArgs(task), { cwd: task.cwd, signal: controller.signal });

  let inTok = 0;
  let outTok = 0;
  let costUsd = 0;

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        appendFileSync(transcriptPath, line + "\n");
        const event = parseOpenCodeLine(line);
        if (!event) continue;
        if (event.type === "tool_use") {
          appendEvent(task.runDir, {
            ts: new Date().toISOString(),
            type: "opencode_tool_use",
            stage: task.stage,
            story: task.story,
            tool: event.part.tool,
            summary: `${event.part.tool} (${event.part.state.status})`,
          });
        } else if (event.type === "step_finish") {
          inTok += event.part.tokens.input;
          outTok += event.part.tokens.output;
          costUsd += event.part.cost;
          appendEvent(task.runDir, {
            ts: new Date().toISOString(),
            type: "opencode_step_finish",
            stage: task.stage,
            in_tok: event.part.tokens.input,
            out_tok: event.part.tokens.output,
            cost_usd: event.part.cost,
          });
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  const exitCode = await proc.exited;
  return {
    ok: exitCode === 0,
    transcriptPath,
    usage: { inTok, outTok, costUsd },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/opencode-adapter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/opencode.ts test/unit/opencode-adapter.test.ts
git commit -m "feat: add OpenCode Adapter with streamed event parsing and injectable spawn"
```

---

## Task 9: Check Runner

**Files:**
- Create: `src/gate/check-runner.ts`
- Test: `test/unit/check-runner.test.ts`

**Interfaces:**
- Produces:
  - `interface CheckResult { pass: boolean; failedCommand?: string; output: string }`
  - `runChecks(commands: string[], cwd: string): Promise<CheckResult>`
  - `MAX_CHECK_OUTPUT_CHARS = 4000` (exported constant)

- [ ] **Step 1: Write the failing test**

Create `test/unit/check-runner.test.ts`:
```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks } from "../../src/gate/check-runner";

test("runChecks passes when all commands exit 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-checks-test-"));
  try {
    const result = await runChecks(["true", "true"], dir);
    expect(result.pass).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runChecks stops at the first failing command and reports it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-checks-test-"));
  try {
    const result = await runChecks(["echo first-ok", "false", "echo should-not-run"], dir);
    expect(result.pass).toBe(false);
    expect(result.failedCommand).toBe("false");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runChecks truncates very long failure output to the last MAX_CHECK_OUTPUT_CHARS characters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-checks-test-"));
  try {
    const result = await runChecks(["node -e \"process.stdout.write('x'.repeat(10000)); process.exit(1)\""], dir);
    expect(result.pass).toBe(false);
    expect(result.output.length).toBeLessThanOrEqual(4000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/check-runner.test.ts`
Expected: FAIL — `src/gate/check-runner.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/gate/check-runner.ts`:
```ts
export const MAX_CHECK_OUTPUT_CHARS = 4000;

export interface CheckResult {
  pass: boolean;
  failedCommand?: string;
  output: string;
}

export async function runChecks(commands: string[], cwd: string): Promise<CheckResult> {
  for (const command of commands) {
    const proc = Bun.spawn(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      const combined = (stdout + stderr).slice(-MAX_CHECK_OUTPUT_CHARS);
      return { pass: false, failedCommand: command, output: combined };
    }
  }
  return { pass: true, output: "" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/check-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/gate/check-runner.ts test/unit/check-runner.test.ts
git commit -m "feat: add deterministic Check Runner with truncated failure output"
```

---

## Task 10: Review Schema + LLM Client

**Files:**
- Create: `src/gate/review-schema.ts`
- Create: `src/llm/client.ts`
- Test: `test/unit/llm-client.test.ts`

**Interfaces:**
- Consumes: `ModelProfile` from Task 2.
- Produces:
  - `ReviewIssueSchema`, `ReviewOutputSchema`, `ReviewOutput` (type) in `review-schema.ts`
  - `callReviewer(profile: ModelProfile, prompt: string, fetchFn?: typeof fetch): Promise<unknown>` in `llm/client.ts` — returns the parsed (but not yet zod-validated) JSON body of the model's response; throws on HTTP error or missing API key.

- [ ] **Step 1: Write the failing test**

Create `test/unit/llm-client.test.ts`:
```ts
import { test, expect } from "bun:test";
import { callReviewer } from "../../src/llm/client";
import type { ModelProfile } from "../../src/config/schema";

const profile: ModelProfile = {
  channel: "http",
  provider: "minimax",
  model: "some-model",
  base_url: "https://example.invalid/v1",
  api_key_env: "TEST_REVIEWER_KEY",
};

test("callReviewer sends an OpenAI-compatible chat completion request and returns parsed JSON content", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe("https://example.invalid/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("some-model");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer fake-key-value");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ summary: "ok", issues: [] }) } }],
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const result = await callReviewer(profile, "review this diff", fakeFetch);
  expect(result).toEqual({ summary: "ok", issues: [] });
});

test("callReviewer throws when the API key env var is not set", async () => {
  delete process.env.MISSING_KEY_VAR;
  const badProfile: ModelProfile = { ...profile, api_key_env: "MISSING_KEY_VAR" };
  await expect(callReviewer(badProfile, "x", (async () => new Response("{}")) as typeof fetch)).rejects.toThrow();
});

test("callReviewer throws when the HTTP response is not ok", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const fakeFetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  await expect(callReviewer(profile, "x", fakeFetch)).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/llm-client.test.ts`
Expected: FAIL — `src/llm/client.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/gate/review-schema.ts`:
```ts
import { z } from "zod";

export const ReviewIssueSchema = z.object({
  severity: z.enum(["blocker", "major", "minor", "nit"]),
  file: z.string(),
  line: z.number(),
  title: z.string(),
  detail: z.string(),
  suggestion: z.string(),
});

export const ReviewOutputSchema = z.object({
  summary: z.string(),
  issues: z.array(ReviewIssueSchema),
});

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;
```

Create `src/llm/client.ts`:
```ts
import type { ModelProfile } from "../config/schema";

export async function callReviewer(
  profile: ModelProfile,
  prompt: string,
  fetchFn: typeof fetch = fetch
): Promise<unknown> {
  if (!profile.api_key_env) {
    throw new Error(`Profile has no api_key_env configured`);
  }
  const apiKey = process.env[profile.api_key_env];
  if (!apiKey) {
    throw new Error(`Environment variable ${profile.api_key_env} is not set`);
  }
  if (!profile.base_url) {
    throw new Error(`Profile has no base_url configured`);
  }

  const response = await fetchFn(`${profile.base_url}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: profile.model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Reviewer HTTP call failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as { choices: { message: { content: string } }[] };
  return JSON.parse(data.choices[0].message.content);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/llm-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/gate/review-schema.ts src/llm/client.ts test/unit/llm-client.test.ts
git commit -m "feat: add review output zod schema and direct-HTTP LLM client"
```

---

## Task 11: Review Gate

**Files:**
- Create: `src/gate/review-gate.ts`
- Test: `test/unit/review-gate.test.ts`

**Interfaces:**
- Consumes: `runChecks`, `CheckResult` from Task 9; `callReviewer` from Task 10; `ReviewOutputSchema`, `ReviewOutput` from Task 10; `ReviewGateConfig`, `ModelProfile` from Task 2.
- Produces:
  - `interface ReviewGateOutcome { checks: "pass" | "fail"; aiReview: "pass" | "fail" | "skipped"; blockers: number; checkOutput?: string; reviewOutput?: ReviewOutput }`
  - `interface ReviewGateDeps { runChecks: typeof runChecks; callReviewer: (profile: ModelProfile, prompt: string) => Promise<unknown> }`
  - `MAX_DIFF_CHARS = 8000` (exported constant)
  - `buildReviewPrompt(diff: string, acceptance: string[]): string`
  - `runReviewGate(config: ReviewGateConfig, reviewerProfile: ModelProfile, cwd: string, diff: string, storyAcceptance: string[], deps: ReviewGateDeps): Promise<ReviewGateOutcome>`

- [ ] **Step 1: Write the failing test**

Create `test/unit/review-gate.test.ts`:
```ts
import { test, expect, mock } from "bun:test";
import { runReviewGate } from "../../src/gate/review-gate";
import type { ReviewGateConfig, ModelProfile } from "../../src/config/schema";

const reviewerProfile: ModelProfile = {
  channel: "http",
  provider: "minimax",
  model: "some-model",
  base_url: "https://example.invalid/v1",
  api_key_env: "TEST_KEY",
};

const baseConfig: ReviewGateConfig = {
  checks: ["npm run lint"],
  ai_review: { enabled: true, model: "reviewer", fail_on: ["blocker"], fail_threshold: { major: 3 }, strict: false },
};

test("checks failing skips AI review entirely", async () => {
  const runChecks = mock(async () => ({ pass: false, failedCommand: "npm run lint", output: "lint error" }));
  const callReviewer = mock(async () => ({ summary: "unused", issues: [] }));
  const outcome = await runReviewGate(baseConfig, reviewerProfile, "/tmp/x", "diff", ["accept"], {
    runChecks,
    callReviewer,
  });
  expect(outcome.checks).toBe("fail");
  expect(outcome.aiReview).toBe("skipped");
  expect(callReviewer).not.toHaveBeenCalled();
});

test("checks passing and AI review returning no fail_on-severity issues passes the gate", async () => {
  const runChecks = mock(async () => ({ pass: true, output: "" }));
  const callReviewer = mock(async () => ({
    summary: "looks fine",
    issues: [{ severity: "minor", file: "a.ts", line: 1, title: "t", detail: "d", suggestion: "s" }],
  }));
  const outcome = await runReviewGate(baseConfig, reviewerProfile, "/tmp/x", "diff", ["accept"], {
    runChecks,
    callReviewer,
  });
  expect(outcome.checks).toBe("pass");
  expect(outcome.aiReview).toBe("pass");
  expect(outcome.blockers).toBe(0);
});

test("checks passing but AI review returning a blocker fails the gate", async () => {
  const runChecks = mock(async () => ({ pass: true, output: "" }));
  const callReviewer = mock(async () => ({
    summary: "found a problem",
    issues: [{ severity: "blocker", file: "a.ts", line: 1, title: "t", detail: "d", suggestion: "s" }],
  }));
  const outcome = await runReviewGate(baseConfig, reviewerProfile, "/tmp/x", "diff", ["accept"], {
    runChecks,
    callReviewer,
  });
  expect(outcome.aiReview).toBe("fail");
  expect(outcome.blockers).toBe(1);
});

test("checks passing and AI review parse failure with strict:false falls back to pass after one retry", async () => {
  const runChecks = mock(async () => ({ pass: true, output: "" }));
  let callCount = 0;
  const callReviewer = mock(async () => {
    callCount++;
    return { not: "valid shape" };
  });
  const outcome = await runReviewGate(baseConfig, reviewerProfile, "/tmp/x", "diff", ["accept"], {
    runChecks,
    callReviewer,
  });
  expect(callCount).toBe(2);
  expect(outcome.aiReview).toBe("pass");
});

test("checks passing and AI review parse failure with strict:true fails the gate after one retry", async () => {
  const runChecks = mock(async () => ({ pass: true, output: "" }));
  const callReviewer = mock(async () => ({ not: "valid shape" }));
  const strictConfig: ReviewGateConfig = { ...baseConfig, ai_review: { ...baseConfig.ai_review, strict: true } };
  const outcome = await runReviewGate(strictConfig, reviewerProfile, "/tmp/x", "diff", ["accept"], {
    runChecks,
    callReviewer,
  });
  expect(outcome.aiReview).toBe("fail");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/review-gate.test.ts`
Expected: FAIL — `src/gate/review-gate.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/gate/review-gate.ts`:
```ts
import { runChecks as realRunChecks, type CheckResult } from "./check-runner";
import { callReviewer as realCallReviewer } from "../llm/client";
import { ReviewOutputSchema, type ReviewOutput } from "./review-schema";
import type { ReviewGateConfig, ModelProfile } from "../config/schema";

export const MAX_DIFF_CHARS = 8000;

export interface ReviewGateOutcome {
  checks: "pass" | "fail";
  aiReview: "pass" | "fail" | "skipped";
  blockers: number;
  checkOutput?: string;
  reviewOutput?: ReviewOutput;
}

export interface ReviewGateDeps {
  runChecks: (commands: string[], cwd: string) => Promise<CheckResult>;
  callReviewer: (profile: ModelProfile, prompt: string) => Promise<unknown>;
}

const defaultDeps: ReviewGateDeps = { runChecks: realRunChecks, callReviewer: realCallReviewer };

export function buildReviewPrompt(diff: string, acceptance: string[]): string {
  const truncatedDiff = diff.slice(-MAX_DIFF_CHARS);
  return [
    "Review the following git diff against the story's acceptance criteria.",
    "Respond with ONLY a JSON object matching this shape:",
    '{"summary": string, "issues": [{"severity": "blocker"|"major"|"minor"|"nit", "file": string, "line": number, "title": string, "detail": string, "suggestion": string}]}',
    "",
    "Acceptance criteria:",
    ...acceptance.map((a) => `- ${a}`),
    "",
    "Diff:",
    truncatedDiff,
  ].join("\n");
}

function countBlockers(review: ReviewOutput, failOn: string[]): number {
  return review.issues.filter((issue) => failOn.includes(issue.severity)).length;
}

function exceedsThreshold(review: ReviewOutput, threshold: Record<string, number> | undefined): boolean {
  if (!threshold) return false;
  for (const [severity, limit] of Object.entries(threshold)) {
    const count = review.issues.filter((i) => i.severity === severity).length;
    if (count >= limit) return true;
  }
  return false;
}

export async function runReviewGate(
  config: ReviewGateConfig,
  reviewerProfile: ModelProfile,
  cwd: string,
  diff: string,
  storyAcceptance: string[],
  deps: ReviewGateDeps = defaultDeps
): Promise<ReviewGateOutcome> {
  const checkResult = await deps.runChecks(config.checks, cwd);
  if (!checkResult.pass) {
    return { checks: "fail", aiReview: "skipped", blockers: 0, checkOutput: checkResult.output };
  }

  if (!config.ai_review.enabled) {
    return { checks: "pass", aiReview: "skipped", blockers: 0 };
  }

  const prompt = buildReviewPrompt(diff, storyAcceptance);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await deps.callReviewer(
        reviewerProfile,
        attempt === 0 ? prompt : `${prompt}\n\nYour previous response failed to parse as the required JSON shape: ${String(lastError)}`
      );
      const parsed = ReviewOutputSchema.safeParse(raw);
      if (parsed.success) {
        const blockers = countBlockers(parsed.data, config.ai_review.fail_on);
        const overThreshold = exceedsThreshold(parsed.data, config.ai_review.fail_threshold);
        const aiReview = blockers > 0 || overThreshold ? "fail" : "pass";
        return { checks: "pass", aiReview, blockers, reviewOutput: parsed.data };
      }
      lastError = parsed.error;
    } catch (err) {
      lastError = err;
    }
  }

  return { checks: "pass", aiReview: config.ai_review.strict ? "fail" : "pass", blockers: config.ai_review.strict ? 1 : 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/review-gate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/gate/review-gate.ts test/unit/review-gate.test.ts
git commit -m "feat: add two-layer Review Gate (deterministic checks + AI review judgment)"
```

---

## Task 12: Ralph Loop Stage Runner

**Files:**
- Create: `src/runners/ralph-loop.ts`
- Test: `test/unit/ralph-loop.test.ts`

**Interfaces:**
- Consumes: `readPrd`/`writePrd`/`selectNextStory`/`markStoryPassed`/`recordStoryFailure`/`Prd`/`Story` from Task 5; `revParseHead`/`stageAll`/`diffCached`/`commit` from Task 6; `runAgentTask`, `AgentTask`, `AgentResult` from Task 8; `runReviewGate`, `ReviewGateOutcome` from Task 11; `appendEvent` from Task 4; `RalphLoopStageConfig`, `ModelProfile` from Task 2.
- Produces:
  - `interface RalphLoopDeps { runAgentTask: (task: AgentTask) => Promise<AgentResult>; runReviewGate: typeof runReviewGate; git: { revParseHead: typeof revParseHead; stageAll: typeof stageAll; diffCached: typeof diffCached; commit: typeof commit } }`
  - `interface RalphLoopResult { storyId: string; result: "pass" | "fail" | "suspended" }`
  - `renderPrompt(story: Story, specExcerpt: string, progressTail: string, fixListContent: string): string`
  - `runRalphLoopOnce(stageConfig: RalphLoopStageConfig, profiles: Record<string, ModelProfile>, cwd: string, runDir: string, specExcerpt: string, deps: RalphLoopDeps): Promise<RalphLoopResult>`

- [ ] **Step 1: Write the failing test**

Create `test/unit/ralph-loop.test.ts`:
```ts
import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRalphLoopOnce } from "../../src/runners/ralph-loop";
import { writePrd, readPrd, type Prd } from "../../src/prd";
import type { RalphLoopStageConfig, ModelProfile } from "../../src/config/schema";

function samplePrd(): Prd {
  return {
    branchName: "feat/us-1",
    stories: [{ id: "US-1", title: "Implement clamp", acceptance: ["clamps correctly"], priority: 1, passes: false, fixCount: 0 }],
  };
}

const stageConfig: RalphLoopStageConfig = {
  id: "develop",
  type: "ralph_loop",
  model: "main-dev",
  per_story_fix_limit: 3,
  gate: {
    checks: ["true"],
    ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] },
  },
};

const profiles: Record<string, ModelProfile> = {
  "main-dev": { channel: "opencode", provider: "opencode", model: "opencode/deepseek-v4-flash-free" },
  reviewer: { channel: "http", provider: "minimax", model: "x" },
};

function makeFixtureDirs() {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-ralph-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-ralph-run-"));
  writePrd(join(cwd, "prd.json"), samplePrd());
  return { cwd, runDir };
}

test("a passing gate marks the story passed, commits, and writes progress.md", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const runAgentTask = mock(async () => ({
      ok: true,
      transcriptPath: "unused",
      usage: { inTok: 10, outTok: 5, costUsd: 0.001 },
    }));
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = {
      revParseHead: mock(async () => "abc123"),
      stageAll: mock(async () => {}),
      diffCached: mock(async () => "diff content"),
      commit: mock(async () => {}),
    };

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
    });

    expect(result).toEqual({ storyId: "US-1", result: "pass" });
    expect(git.commit).toHaveBeenCalledTimes(1);
    const prd = readPrd(join(cwd, "prd.json"));
    expect(prd.stories[0].passes).toBe(true);
    expect(existsSync(join(runDir, "artifacts", "progress.md"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a failing gate records fix_list.md, increments fixCount, and does not commit", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const runAgentTask = mock(async () => ({
      ok: true,
      transcriptPath: "unused",
      usage: { inTok: 10, outTok: 5, costUsd: 0.001 },
    }));
    const runReviewGate = mock(async () => ({
      checks: "fail" as const,
      aiReview: "skipped" as const,
      blockers: 0,
      checkOutput: "lint failed: missing semicolon",
    }));
    const git = {
      revParseHead: mock(async () => "abc123"),
      stageAll: mock(async () => {}),
      diffCached: mock(async () => "diff content"),
      commit: mock(async () => {}),
    };

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
    });

    expect(result).toEqual({ storyId: "US-1", result: "fail" });
    expect(git.commit).not.toHaveBeenCalled();
    const prd = readPrd(join(cwd, "prd.json"));
    expect(prd.stories[0].passes).toBe(false);
    expect(prd.stories[0].fixCount).toBe(1);
    const fixList = readFileSync(join(runDir, "artifacts", "fix_list.md"), "utf-8");
    expect(fixList).toContain("missing semicolon");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an agent task that fails (ok:false) is treated as a failed iteration without calling the review gate", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const runAgentTask = mock(async () => ({
      ok: false,
      transcriptPath: "unused",
      usage: { inTok: 0, outTok: 0, costUsd: 0 },
    }));
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = {
      revParseHead: mock(async () => "abc123"),
      stageAll: mock(async () => {}),
      diffCached: mock(async () => ""),
      commit: mock(async () => {}),
    };

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
    });

    expect(result).toEqual({ storyId: "US-1", result: "fail" });
    expect(runReviewGate).not.toHaveBeenCalled();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/ralph-loop.test.ts`
Expected: FAIL — `src/runners/ralph-loop.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/runners/ralph-loop.ts`:
```ts
import { join } from "node:path";
import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { readPrd, writePrd, selectNextStory, markStoryPassed, recordStoryFailure, type Story } from "../prd";
import { runAgentTask as realRunAgentTask, type AgentTask, type AgentResult } from "../adapters/opencode";
import { runReviewGate as realRunReviewGate, type ReviewGateOutcome } from "../gate/review-gate";
import { revParseHead, stageAll, diffCached, commit } from "../git";
import { appendEvent } from "../events/events";
import type { RalphLoopStageConfig, ModelProfile } from "../config/schema";

export interface RalphLoopDeps {
  runAgentTask: (task: AgentTask) => Promise<AgentResult>;
  runReviewGate: (
    config: RalphLoopStageConfig["gate"],
    reviewerProfile: ModelProfile,
    cwd: string,
    diff: string,
    acceptance: string[]
  ) => Promise<ReviewGateOutcome>;
  git: {
    revParseHead: typeof revParseHead;
    stageAll: typeof stageAll;
    diffCached: typeof diffCached;
    commit: typeof commit;
  };
}

export interface RalphLoopResult {
  storyId: string;
  result: "pass" | "fail" | "suspended";
}

const defaultDeps: RalphLoopDeps = {
  runAgentTask: realRunAgentTask,
  runReviewGate: (config, reviewerProfile, cwd, diff, acceptance) =>
    realRunReviewGate(config, reviewerProfile, cwd, diff, acceptance),
  git: { revParseHead, stageAll, diffCached, commit },
};

export function renderPrompt(story: Story, specExcerpt: string, progressTail: string, fixListContent: string): string {
  return [
    "You are implementing one story in an existing codebase.",
    "",
    `## Story ${story.id}: ${story.title}`,
    "Acceptance criteria:",
    ...story.acceptance.map((a) => `- ${a}`),
    "",
    "## Spec excerpt",
    specExcerpt,
    "",
    progressTail ? `## Recent progress\n${progressTail}` : "",
    fixListContent ? `## Previous review feedback to address\n${fixListContent}` : "",
    "",
    "Make the necessary code changes directly in the working directory. Do not ask for confirmation.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function readTail(path: string, maxChars: number): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8");
  return content.slice(-maxChars);
}

export async function runRalphLoopOnce(
  stageConfig: RalphLoopStageConfig,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  specExcerpt: string,
  deps: RalphLoopDeps = defaultDeps
): Promise<RalphLoopResult> {
  const artifactsDir = join(runDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const progressPath = join(artifactsDir, "progress.md");
  const fixListPath = join(artifactsDir, "fix_list.md");

  const prdPath = join(cwd, "prd.json");
  const prd = readPrd(prdPath);
  const story = selectNextStory(prd);
  if (!story) {
    throw new Error("No pending story found in prd.json");
  }

  const mainDevProfile = profiles[stageConfig.model];
  const reviewerProfile = profiles[stageConfig.gate.ai_review.model];

  const progressTail = readTail(progressPath, 4000);
  const fixListContent = readTail(fixListPath, 4000);
  const prompt = renderPrompt(story, specExcerpt, progressTail, fixListContent);

  await deps.git.revParseHead(cwd);

  const agentResult = await deps.runAgentTask({
    profile: mainDevProfile,
    prompt,
    cwd,
    timeoutMs: 10 * 60 * 1000,
    runDir,
    stage: stageConfig.id,
    story: story.id,
  });

  if (!agentResult.ok) {
    const updatedPrd = recordStoryFailure(prd, story.id, stageConfig.per_story_fix_limit);
    writePrd(prdPath, updatedPrd);
    appendFileSync(fixListPath, `\n## ${story.id} (agent call failed)\nOpenCode agent invocation did not complete successfully.\n`);
    appendEvent(runDir, { ts: new Date().toISOString(), type: "story_result", story: story.id, result: "fail" });
    return { storyId: story.id, result: "fail" };
  }

  await deps.git.stageAll(cwd);
  const diff = await deps.git.diffCached(cwd);

  const gateOutcome = await deps.runReviewGate(stageConfig.gate, reviewerProfile, cwd, diff, story.acceptance);

  appendEvent(runDir, {
    ts: new Date().toISOString(),
    type: "gate_result",
    stage: stageConfig.id,
    story: story.id,
    checks: gateOutcome.checks,
    ai_review: gateOutcome.aiReview,
    blockers: gateOutcome.blockers,
  });

  const gatePassed = gateOutcome.checks === "pass" && gateOutcome.aiReview !== "fail";

  if (gatePassed) {
    const updatedPrd = markStoryPassed(prd, story.id);
    writePrd(prdPath, updatedPrd);
    await deps.git.stageAll(cwd);
    await deps.git.commit(cwd, `feat(${story.id}): ${story.title}`);
    appendFileSync(progressPath, `\n## ${story.id}\n${story.title} — passed checks and AI review.\n`);
    appendEvent(runDir, { ts: new Date().toISOString(), type: "story_result", story: story.id, result: "pass" });
    return { storyId: story.id, result: "pass" };
  }

  const updatedPrd = recordStoryFailure(prd, story.id, stageConfig.per_story_fix_limit);
  writePrd(prdPath, updatedPrd);
  const failureNote =
    gateOutcome.checks === "fail"
      ? `## ${story.id} (round ${updatedPrd.stories.find((s) => s.id === story.id)!.fixCount})\nDeterministic checks failed:\n${gateOutcome.checkOutput ?? ""}\n`
      : `## ${story.id} (round ${updatedPrd.stories.find((s) => s.id === story.id)!.fixCount})\nAI review flagged ${gateOutcome.blockers} blocking issue(s).\n`;
  appendFileSync(fixListPath, `\n${failureNote}`);

  const suspended = updatedPrd.stories.find((s) => s.id === story.id)!.suspended === true;
  const result = suspended ? "suspended" : "fail";
  appendEvent(runDir, { ts: new Date().toISOString(), type: "story_result", story: story.id, result });
  return { storyId: story.id, result };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/ralph-loop.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runners/ralph-loop.ts test/unit/ralph-loop.test.ts
git commit -m "feat: add ralph_loop Stage Runner (single story, single iteration)"
```

---

## Task 13: Pipeline Engine (Minimal, Single-Stage)

**Files:**
- Create: `src/engine/engine.ts`
- Test: `test/unit/engine.test.ts`

**Interfaces:**
- Consumes: `writeStateAtomic`, `EngineState`, `StageStatus` from Task 3; `runRalphLoopOnce`, `RalphLoopResult` from Task 12; `PipelineConfig`, `ModelProfile` from Task 2.
- Produces:
  - `interface EngineDeps { runRalphLoopOnce: typeof runRalphLoopOnce }`
  - `createRunId(): string`
  - `runPipelineOnce(pipeline: PipelineConfig, profiles: Record<string, ModelProfile>, cwd: string, runDir: string, specExcerpt: string, deps: EngineDeps, signal?: AbortSignal): Promise<EngineState>`

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine.test.ts`:
```ts
import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipelineOnce, createRunId } from "../../src/engine/engine";
import { readState } from "../../src/engine/state";
import type { PipelineConfig, ModelProfile } from "../../src/config/schema";

const pipeline: PipelineConfig = {
  name: "ralph-only",
  stages: [
    {
      id: "develop",
      type: "ralph_loop",
      model: "main-dev",
      per_story_fix_limit: 3,
      gate: { checks: [], ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] } },
    },
  ],
};

const profiles: Record<string, ModelProfile> = {
  "main-dev": { channel: "opencode", provider: "opencode", model: "x" },
  reviewer: { channel: "http", provider: "minimax", model: "y" },
};

test("createRunId returns a non-empty, filesystem-safe string", () => {
  const id = createRunId();
  expect(id.length).toBeGreaterThan(0);
  expect(id).toMatch(/^[a-zA-Z0-9_]+$/);
});

test("runPipelineOnce marks the stage done and writes final state.json on success", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const runRalphLoopOnce = mock(async () => ({ storyId: "US-1", result: "pass" as const }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, "spec", {
      runRalphLoopOnce,
    });
    expect(state.stages[0].status).toBe("done");
    const persisted = readState(runDir);
    expect(persisted.stages[0].status).toBe("done");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce marks the stage failed when the runner returns fail", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const runRalphLoopOnce = mock(async () => ({ storyId: "US-1", result: "fail" as const }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, "spec", {
      runRalphLoopOnce,
    });
    expect(state.stages[0].status).toBe("failed");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce marks the stage aborted when the signal is already aborted", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const controller = new AbortController();
    controller.abort();
    const runRalphLoopOnce = mock(async () => ({ storyId: "US-1", result: "pass" as const }));
    const state = await runPipelineOnce(
      pipeline,
      profiles,
      "/tmp/does-not-matter",
      runDir,
      "spec",
      { runRalphLoopOnce },
      controller.signal
    );
    expect(state.stages[0].status).toBe("aborted");
    expect(runRalphLoopOnce).not.toHaveBeenCalled();
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/engine.test.ts`
Expected: FAIL — `src/engine/engine.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/engine/engine.ts`:
```ts
import { writeStateAtomic, type EngineState } from "./state";
import { runRalphLoopOnce as realRunRalphLoopOnce, type RalphLoopResult } from "../runners/ralph-loop";
import type { PipelineConfig, ModelProfile } from "../config/schema";

export interface EngineDeps {
  runRalphLoopOnce: (
    stageConfig: PipelineConfig["stages"][number],
    profiles: Record<string, ModelProfile>,
    cwd: string,
    runDir: string,
    specExcerpt: string
  ) => Promise<RalphLoopResult>;
}

const defaultDeps: EngineDeps = {
  runRalphLoopOnce: (stageConfig, profiles, cwd, runDir, specExcerpt) =>
    realRunRalphLoopOnce(stageConfig, profiles, cwd, runDir, specExcerpt),
};

export function createRunId(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const rand = Math.random().toString(16).slice(2, 8);
  return `${stamp}_${rand}`;
}

export async function runPipelineOnce(
  pipeline: PipelineConfig,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  specExcerpt: string,
  deps: EngineDeps = defaultDeps,
  signal?: AbortSignal
): Promise<EngineState> {
  const stage = pipeline.stages[0];
  let state: EngineState = {
    run_id: runDir.split("/").pop() ?? "unknown",
    pipeline: pipeline.name,
    stages: [{ id: stage.id, status: "pending" }],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
  };
  writeStateAtomic(runDir, state);

  if (signal?.aborted) {
    state = { ...state, stages: [{ id: stage.id, status: "aborted" }] };
    writeStateAtomic(runDir, state);
    return state;
  }

  state = { ...state, stages: [{ id: stage.id, status: "running" }] };
  writeStateAtomic(runDir, state);

  const result = await deps.runRalphLoopOnce(stage, profiles, cwd, runDir, specExcerpt);

  const finalStatus = result.result === "pass" ? "done" : "failed";
  state = { ...state, stages: [{ id: stage.id, status: finalStatus }] };
  writeStateAtomic(runDir, state);
  return state;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/engine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/engine.ts test/unit/engine.test.ts
git commit -m "feat: add minimal single-stage Pipeline Engine with abort handling"
```

---

## Task 14: fixtures/sample-project

**Files:**
- Create: `fixtures/sample-project/package.json`
- Create: `fixtures/sample-project/eslint.config.js`
- Create: `fixtures/sample-project/src/math.ts`
- Create: `fixtures/sample-project/test/math.test.ts`
- Create: `fixtures/sample-project/spec.md`
- Create: `fixtures/sample-project/prd.json`
- Create: `fixtures/sample-project/.aiflow/config/models.yaml`
- Create: `fixtures/sample-project/.aiflow/config/pipelines/ralph-only.yaml`
- Create: `fixtures/sample-project/.aiflow/config/project.yaml`
- Test: `test/unit/fixture-sample-project.test.ts`

**Interfaces:**
- Produces: a disposable, git-initialized sample project on disk that AIFlow's integration tests (Tasks 17–18) point at. Not consumed programmatically by AIFlow's own `src/` code.

- [ ] **Step 1: Write the failing test**

This task's "test" is a validation script confirming the fixture's own checks genuinely fail on the initial code (so later tasks can rely on that), and that the fixture is a real, independent git repo. Create `test/unit/fixture-sample-project.test.ts`:
```ts
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const FIXTURE_DIR = join(process.cwd(), "fixtures", "sample-project");

test("fixture files exist", () => {
  expect(existsSync(join(FIXTURE_DIR, "package.json"))).toBe(true);
  expect(existsSync(join(FIXTURE_DIR, "src", "math.ts"))).toBe(true);
  expect(existsSync(join(FIXTURE_DIR, "test", "math.test.ts"))).toBe(true);
  expect(existsSync(join(FIXTURE_DIR, "spec.md"))).toBe(true);
  expect(existsSync(join(FIXTURE_DIR, "prd.json"))).toBe(true);
  expect(existsSync(join(FIXTURE_DIR, ".aiflow", "config", "models.yaml"))).toBe(true);
  expect(existsSync(join(FIXTURE_DIR, ".aiflow", "config", "pipelines", "ralph-only.yaml"))).toBe(true);
});

test("fixture is its own independent git repository", async () => {
  const out = await $`git -C ${FIXTURE_DIR} rev-parse --is-inside-work-tree`.text();
  expect(out.trim()).toBe("true");
});

test("fixture's initial code genuinely fails npm test (clamp is not yet implemented)", async () => {
  await $`cd ${FIXTURE_DIR} && npm install --silent`.quiet();
  const proc = Bun.spawn(["npm", "run", "test"], { cwd: FIXTURE_DIR, stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  expect(exitCode).not.toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/fixture-sample-project.test.ts`
Expected: FAIL — fixture files/directory do not exist.

- [ ] **Step 3: Write minimal implementation**

Create `fixtures/sample-project/package.json`:
```json
{
  "name": "aiflow-sample-project",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "lint": "eslint .",
    "test": "vitest run"
  },
  "devDependencies": {
    "eslint": "^9.9.0",
    "vitest": "^2.0.5",
    "typescript": "^5.5.4",
    "@typescript-eslint/parser": "^8.3.0",
    "@typescript-eslint/eslint-plugin": "^8.3.0"
  }
}
```

Create `fixtures/sample-project/eslint.config.js`:
```js
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsParser },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "@typescript-eslint/no-unused-vars": "error",
      "no-undef": "off",
    },
  },
];
```

Create `fixtures/sample-project/src/math.ts`:
```ts
export function clamp(value: number, min: number, max: number): number {
  // TODO: implement clamping to [min, max]
  return value;
}
```

Create `fixtures/sample-project/test/math.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { clamp } from "../src/math";

describe("clamp", () => {
  it("returns the value unchanged when it is within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it("clamps to min when the value is below range", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });
  it("clamps to max when the value is above range", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
});
```

Create `fixtures/sample-project/spec.md`:
```md
# Sample Project Spec

## US-1: Implement clamp(value, min, max)

`src/math.ts` exports a `clamp` function that currently always returns the
input value unchanged. Implement it so that:

- if `value` is less than `min`, return `min`
- if `value` is greater than `max`, return `max`
- otherwise, return `value`

Acceptance is verified by `test/math.test.ts`.
```

Create `fixtures/sample-project/prd.json`:
```json
{
  "branchName": "feat/us-1-clamp",
  "stories": [
    {
      "id": "US-1",
      "title": "Implement clamp(value, min, max)",
      "acceptance": [
        "clamp returns the value unchanged when it is within [min, max]",
        "clamp returns min when value is below min",
        "clamp returns max when value is above max"
      ],
      "priority": 1,
      "passes": false,
      "fixCount": 0
    }
  ]
}
```

Create `fixtures/sample-project/.aiflow/config/models.yaml`:
```yaml
profiles:
  main-dev:
    channel: opencode
    provider: opencode
    model: opencode/deepseek-v4-flash-free
  reviewer:
    channel: http
    provider: minimax
    model: REPLACE_ME_VERIFY_VIA_DOCTOR
    base_url: REPLACE_ME_VERIFY_VIA_DOCTOR
    api_key_env: MINIMAX_API_KEY
```

Create `fixtures/sample-project/.aiflow/config/pipelines/ralph-only.yaml`:
```yaml
name: ralph-only
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
```

Create `fixtures/sample-project/.aiflow/config/project.yaml`:
```yaml
{}
```

Initialize the fixture as its own git repo and install dependencies:
```bash
cd fixtures/sample-project
git init -q
git config user.email "fixture@example.com"
git config user.name "AIFlow Fixture"
npm install
git add -A
git commit -q -m "initial fixture state (clamp not yet implemented)"
cd ../..
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/fixture-sample-project.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add fixtures/sample-project test/unit/fixture-sample-project.test.ts
git commit -m "test: add fixtures/sample-project disposable validation target"
```

Note: `fixtures/sample-project/.git` is a nested git repository intentionally — it is committed to AIFlow's own repo as a plain directory tree (not a submodule), so `git -C fixtures/sample-project ...` operates on it independently. If your git tooling warns about a nested `.git` directory, that is expected; do not add it as a submodule.

---

## Task 15: `aiflow doctor` Command

**Files:**
- Create: `src/commands/doctor.ts`
- Modify: `src/cli.ts`
- Test: `test/unit/doctor.test.ts`

**Interfaces:**
- Consumes: `callReviewer` from Task 10; `ModelsConfig`, `ModelProfile` from Task 2.
- Produces:
  - `interface DoctorReport { openCodeVersion: string | null; gitOk: boolean; reviewerKeyPresent: boolean; reviewerReachable: boolean | null; reviewerError?: string }`
  - `interface DoctorDeps { checkOpenCodeVersion: () => Promise<string | null>; checkGitRepo: (cwd: string) => Promise<boolean>; callReviewer: (profile: ModelProfile, prompt: string) => Promise<unknown> }`
  - `runDoctorChecks(cwd: string, reviewerProfile: ModelProfile | undefined, deps: DoctorDeps): Promise<DoctorReport>`

- [ ] **Step 1: Write the failing test**

Create `test/unit/doctor.test.ts`:
```ts
import { test, expect, mock } from "bun:test";
import { runDoctorChecks } from "../../src/commands/doctor";
import type { ModelProfile } from "../../src/config/schema";

const reviewerProfile: ModelProfile = {
  channel: "http",
  provider: "minimax",
  model: "some-model",
  base_url: "https://example.invalid/v1",
  api_key_env: "TEST_DOCTOR_KEY",
};

test("reports a full success when opencode is present, git repo is valid, and reviewer key works", async () => {
  process.env.TEST_DOCTOR_KEY = "present";
  const deps = {
    checkOpenCodeVersion: mock(async () => "1.17.11"),
    checkGitRepo: mock(async () => true),
    callReviewer: mock(async () => ({ summary: "pong", issues: [] })),
  };
  const report = await runDoctorChecks("/tmp/whatever", reviewerProfile, deps);
  expect(report.openCodeVersion).toBe("1.17.11");
  expect(report.gitOk).toBe(true);
  expect(report.reviewerKeyPresent).toBe(true);
  expect(report.reviewerReachable).toBe(true);
});

test("reports opencode missing when the version check returns null", async () => {
  const deps = {
    checkOpenCodeVersion: mock(async () => null),
    checkGitRepo: mock(async () => true),
    callReviewer: mock(async () => ({})),
  };
  const report = await runDoctorChecks("/tmp/whatever", reviewerProfile, deps);
  expect(report.openCodeVersion).toBeNull();
});

test("reports reviewer key missing without attempting a network call", async () => {
  delete process.env.UNSET_DOCTOR_KEY;
  const profileWithMissingKey: ModelProfile = { ...reviewerProfile, api_key_env: "UNSET_DOCTOR_KEY" };
  const callReviewer = mock(async () => ({}));
  const deps = {
    checkOpenCodeVersion: mock(async () => "1.17.11"),
    checkGitRepo: mock(async () => true),
    callReviewer,
  };
  const report = await runDoctorChecks("/tmp/whatever", profileWithMissingKey, deps);
  expect(report.reviewerKeyPresent).toBe(false);
  expect(report.reviewerReachable).toBeNull();
  expect(callReviewer).not.toHaveBeenCalled();
});

test("reports reviewer unreachable with the error message when the ping call throws", async () => {
  process.env.TEST_DOCTOR_KEY = "present";
  const deps = {
    checkOpenCodeVersion: mock(async () => "1.17.11"),
    checkGitRepo: mock(async () => true),
    callReviewer: mock(async () => {
      throw new Error("401 unauthorized");
    }),
  };
  const report = await runDoctorChecks("/tmp/whatever", reviewerProfile, deps);
  expect(report.reviewerReachable).toBe(false);
  expect(report.reviewerError).toContain("401 unauthorized");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/doctor.test.ts`
Expected: FAIL — `src/commands/doctor.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/commands/doctor.ts`:
```ts
import { callReviewer as realCallReviewer } from "../llm/client";
import type { ModelProfile } from "../config/schema";

export interface DoctorReport {
  openCodeVersion: string | null;
  gitOk: boolean;
  reviewerKeyPresent: boolean;
  reviewerReachable: boolean | null;
  reviewerError?: string;
}

export interface DoctorDeps {
  checkOpenCodeVersion: () => Promise<string | null>;
  checkGitRepo: (cwd: string) => Promise<boolean>;
  callReviewer: (profile: ModelProfile, prompt: string) => Promise<unknown>;
}

export async function checkOpenCodeVersionReal(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["opencode", "--version"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    return output.trim();
  } catch {
    return null;
  }
}

export async function checkGitRepoReal(cwd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return exitCode === 0 && output.trim() === "true";
  } catch {
    return false;
  }
}

const defaultDeps: DoctorDeps = {
  checkOpenCodeVersion: checkOpenCodeVersionReal,
  checkGitRepo: checkGitRepoReal,
  callReviewer: realCallReviewer,
};

export async function runDoctorChecks(
  cwd: string,
  reviewerProfile: ModelProfile | undefined,
  deps: DoctorDeps = defaultDeps
): Promise<DoctorReport> {
  const openCodeVersion = await deps.checkOpenCodeVersion();
  const gitOk = await deps.checkGitRepo(cwd);

  const reviewerKeyPresent = Boolean(
    reviewerProfile?.api_key_env && process.env[reviewerProfile.api_key_env]
  );

  if (!reviewerProfile || !reviewerKeyPresent) {
    return { openCodeVersion, gitOk, reviewerKeyPresent, reviewerReachable: null };
  }

  try {
    await deps.callReviewer(reviewerProfile, 'Respond with only this JSON: {"summary":"pong","issues":[]}');
    return { openCodeVersion, gitOk, reviewerKeyPresent, reviewerReachable: true };
  } catch (err) {
    return {
      openCodeVersion,
      gitOk,
      reviewerKeyPresent,
      reviewerReachable: false,
      reviewerError: err instanceof Error ? err.message : String(err),
    };
  }
}
```

Modify `src/cli.ts` — replace the `doctor` command's stub action:
```ts
program
  .command("doctor")
  .description("Check environment: OpenCode, reviewer API key, git status")
  .action(async () => {
    const { runDoctorChecks } = await import("./commands/doctor");
    const { loadModelsConfig } = await import("./config/loader");
    const { join } = await import("node:path");

    let reviewerProfile;
    try {
      const config = loadModelsConfig(join(process.cwd(), ".aiflow", "config", "models.yaml"));
      reviewerProfile = config.profiles["reviewer"];
    } catch {
      reviewerProfile = undefined;
    }

    const report = await runDoctorChecks(process.cwd(), reviewerProfile);
    console.log(`OpenCode version: ${report.openCodeVersion ?? "NOT FOUND"}`);
    console.log(`Git repo: ${report.gitOk ? "ok" : "NOT a git repository"}`);
    console.log(`Reviewer API key present: ${report.reviewerKeyPresent}`);
    console.log(`Reviewer reachable: ${report.reviewerReachable ?? "skipped (no key)"}`);
    if (report.reviewerError) console.log(`Reviewer error: ${report.reviewerError}`);

    const fatal = !report.openCodeVersion || !report.gitOk;
    process.exitCode = fatal ? 1 : 0;
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/doctor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/doctor.ts src/cli.ts test/unit/doctor.test.ts
git commit -m "feat: implement aiflow doctor (opencode/git/reviewer connectivity checks)"
```

---

## Task 16: `aiflow init` Command

**Files:**
- Create: `src/commands/init.ts`
- Modify: `src/cli.ts`
- Test: `test/unit/init.test.ts`

**Interfaces:**
- Produces:
  - `interface InitResult { created: boolean; reason?: string }`
  - `runInit(cwd: string): InitResult`

- [ ] **Step 1: Write the failing test**

Create `test/unit/init.test.ts`:
```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/commands/init";

test("runInit creates the .aiflow/config scaffold with default files", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-init-test-"));
  try {
    const result = runInit(dir);
    expect(result.created).toBe(true);
    expect(existsSync(join(dir, ".aiflow", "config", "models.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".aiflow", "config", "pipelines", "ralph-only.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".aiflow", "config", "project.yaml"))).toBe(true);
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".aiflow/runs/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runInit appends to an existing .gitignore instead of overwriting it", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-init-test-"));
  try {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    runInit(dir);
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain(".aiflow/runs/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runInit refuses to overwrite an existing .aiflow/config directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-init-test-"));
  try {
    mkdirSync(join(dir, ".aiflow", "config"), { recursive: true });
    writeFileSync(join(dir, ".aiflow", "config", "models.yaml"), "profiles: { custom: true }\n");

    const result = runInit(dir);

    expect(result.created).toBe(false);
    expect(result.reason).toContain("already exists");
    const content = readFileSync(join(dir, ".aiflow", "config", "models.yaml"), "utf-8");
    expect(content).toBe("profiles: { custom: true }\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/init.test.ts`
Expected: FAIL — `src/commands/init.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/commands/init.ts`:
```ts
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export interface InitResult {
  created: boolean;
  reason?: string;
}

const MODELS_YAML_TEMPLATE = `profiles:
  main-dev:
    channel: opencode
    provider: opencode
    model: opencode/deepseek-v4-flash-free
  reviewer:
    channel: http
    provider: minimax
    model: REPLACE_ME_VERIFY_VIA_DOCTOR
    base_url: REPLACE_ME_VERIFY_VIA_DOCTOR
    api_key_env: MINIMAX_API_KEY
`;

const RALPH_ONLY_YAML_TEMPLATE = `name: ralph-only
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
`;

const PROJECT_YAML_TEMPLATE = `{}
`;

export function runInit(cwd: string): InitResult {
  const configDir = join(cwd, ".aiflow", "config");
  if (existsSync(configDir)) {
    return { created: false, reason: ".aiflow/config already exists; refusing to overwrite" };
  }

  mkdirSync(join(configDir, "pipelines"), { recursive: true });
  writeFileSync(join(configDir, "models.yaml"), MODELS_YAML_TEMPLATE);
  writeFileSync(join(configDir, "pipelines", "ralph-only.yaml"), RALPH_ONLY_YAML_TEMPLATE);
  writeFileSync(join(configDir, "project.yaml"), PROJECT_YAML_TEMPLATE);

  const gitignorePath = join(cwd, ".gitignore");
  const ignoreLine = ".aiflow/runs/";
  if (existsSync(gitignorePath)) {
    const existing = readFileSync(gitignorePath, "utf-8");
    if (!existing.includes(ignoreLine)) {
      appendFileSync(gitignorePath, `\n${ignoreLine}\n`);
    }
  } else {
    writeFileSync(gitignorePath, `${ignoreLine}\n`);
  }

  return { created: true };
}
```

Modify `src/cli.ts` — replace the `init` command's stub action:
```ts
program
  .command("init")
  .description("Generate .aiflow/ config scaffold in the current directory")
  .action(async () => {
    const { runInit } = await import("./commands/init");
    const result = runInit(process.cwd());
    if (result.created) {
      console.log("Created .aiflow/config scaffold.");
    } else {
      console.log(`Skipped: ${result.reason}`);
      process.exitCode = 1;
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/init.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/init.ts src/cli.ts test/unit/init.test.ts
git commit -m "feat: implement aiflow init (non-destructive .aiflow/ scaffold generator)"
```

---

## Task 17: `aiflow run` Command + Mocked Integration Test

**Files:**
- Create: `src/commands/run.ts`
- Modify: `src/cli.ts`
- Test: `test/integration/ralph-loop-mocked.test.ts`

**Interfaces:**
- Consumes: `loadModelsConfig`, `loadPipelineConfig` from Task 2; `createRunId`, `runPipelineOnce`, `EngineDeps` from Task 13; `runRalphLoopOnce`, `RalphLoopDeps` from Task 12; everything each of those already consumes.
- Produces:
  - `runCommand(cwd: string, pipelineName: string, runnerDeps?: Partial<import("../runners/ralph-loop").RalphLoopDeps>): Promise<import("../engine/state").EngineState>`

- [ ] **Step 1: Write the failing test**

Create `test/integration/ralph-loop-mocked.test.ts`. This test copies the real `fixtures/sample-project` into a fresh temp directory for each scenario, uses a **mocked** OpenCode adapter (so no real agent call happens) but **real** Check Runner (real `npm run lint`/`npm run test` against whatever is on disk), and a **mocked** reviewer call — directly exercising both the checks-fail and checks-pass paths end to end through the real `run` command wiring:
```ts
import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { runCommand } from "../../src/commands/run";

const FIXTURE_SOURCE = join(process.cwd(), "fixtures", "sample-project");

async function copyFixture(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-run-integration-"));
  cpSync(FIXTURE_SOURCE, dir, { recursive: true, filter: (src) => !src.includes(`${FIXTURE_SOURCE}/.git`) });
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} config user.email "test@example.com"`;
  await $`git -C ${dir} config user.name "Test"`;
  await $`git -C ${dir} add -A`;
  await $`git -C ${dir} commit -q -m "initial"`;
  return dir;
}

test("run command: checks fail on the initial broken fixture, story stays unpassed, no commit made", async () => {
  const dir = await copyFixture();
  try {
    const fakeAgent = mock(async () => ({
      ok: true,
      transcriptPath: "unused",
      usage: { inTok: 1, outTok: 1, costUsd: 0 },
    }));
    const state = await runCommand(dir, "ralph-only", { runAgentTask: fakeAgent });
    expect(state.stages[0].status).toBe("failed");
    const prd = JSON.parse(readFileSync(join(dir, "prd.json"), "utf-8"));
    expect(prd.stories[0].passes).toBe(false);
    expect(prd.stories[0].fixCount).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run command: checks pass and AI review passes when the fix is applied and review is mocked to approve", async () => {
  const dir = await copyFixture();
  try {
    writeFileSync(
      join(dir, "src", "math.ts"),
      `export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`
    );
    const fakeAgent = mock(async () => ({
      ok: true,
      transcriptPath: "unused",
      usage: { inTok: 1, outTok: 1, costUsd: 0 },
    }));
    const fakeReviewer = mock(async () => ({ summary: "looks good", issues: [] }));
    const state = await runCommand(dir, "ralph-only", { runAgentTask: fakeAgent, callReviewer: fakeReviewer });
    expect(state.stages[0].status).toBe("done");
    const prd = JSON.parse(readFileSync(join(dir, "prd.json"), "utf-8"));
    expect(prd.stories[0].passes).toBe(true);
    const log = await $`git -C ${dir} log -1 --pretty=%s`.text();
    expect(log.trim()).toContain("US-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run command: checks pass but AI review returns a blocker, story stays unpassed", async () => {
  const dir = await copyFixture();
  try {
    writeFileSync(
      join(dir, "src", "math.ts"),
      `export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`
    );
    const fakeAgent = mock(async () => ({
      ok: true,
      transcriptPath: "unused",
      usage: { inTok: 1, outTok: 1, costUsd: 0 },
    }));
    const fakeReviewer = mock(async () => ({
      summary: "missing input validation",
      issues: [{ severity: "blocker", file: "src/math.ts", line: 1, title: "t", detail: "d", suggestion: "s" }],
    }));
    const state = await runCommand(dir, "ralph-only", { runAgentTask: fakeAgent, callReviewer: fakeReviewer });
    expect(state.stages[0].status).toBe("failed");
    const prd = JSON.parse(readFileSync(join(dir, "prd.json"), "utf-8"));
    expect(prd.stories[0].passes).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/integration/ralph-loop-mocked.test.ts`
Expected: FAIL — `src/commands/run.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/commands/run.ts`:
```ts
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadModelsConfig, loadPipelineConfig } from "../config/loader";
import { createRunId, runPipelineOnce } from "../engine/engine";
import { runRalphLoopOnce } from "../runners/ralph-loop";
import { runAgentTask as realRunAgentTask, type AgentTask, type AgentResult } from "../adapters/opencode";
import { runReviewGate as realRunReviewGate } from "../gate/review-gate";
import { runChecks } from "../gate/check-runner";
import { callReviewer as realCallReviewer } from "../llm/client";
import { revParseHead, stageAll, diffCached, commit } from "../git";
import type { EngineState } from "../engine/state";
import type { ModelProfile, PipelineConfig } from "../config/schema";

export interface RunCommandOverrides {
  runAgentTask?: (task: AgentTask) => Promise<AgentResult>;
  callReviewer?: (profile: ModelProfile, prompt: string) => Promise<unknown>;
}

export async function runCommand(
  cwd: string,
  pipelineName: string,
  overrides: RunCommandOverrides = {}
): Promise<EngineState> {
  const modelsConfig = loadModelsConfig(join(cwd, ".aiflow", "config", "models.yaml"));
  const pipelineConfig = loadPipelineConfig(join(cwd, ".aiflow", "config", "pipelines", `${pipelineName}.yaml`));

  const runId = createRunId();
  const runDir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(runDir, { recursive: true });

  const specPath = join(cwd, "spec.md");
  const specExcerpt = existsSync(specPath) ? readFileSync(specPath, "utf-8").slice(0, 4000) : "";

  const runAgentTask = overrides.runAgentTask ?? realRunAgentTask;
  const reviewerCallFn = overrides.callReviewer ?? realCallReviewer;

  const engineDeps = {
    runRalphLoopOnce: (
      stageConfig: PipelineConfig["stages"][number],
      profiles: Record<string, ModelProfile>,
      runCwd: string,
      stageRunDir: string,
      spec: string
    ) =>
      runRalphLoopOnce(stageConfig, profiles, runCwd, stageRunDir, spec, {
        runAgentTask,
        runReviewGate: (config, reviewerProfile, gateCwd, diff, acceptance) =>
          realRunReviewGate(config, reviewerProfile, gateCwd, diff, acceptance, {
            runChecks,
            callReviewer: reviewerCallFn,
          }),
        git: { revParseHead, stageAll, diffCached, commit },
      }),
  };

  return runPipelineOnce(pipelineConfig, modelsConfig.profiles, cwd, runDir, specExcerpt, engineDeps);
}
```

Modify `src/cli.ts` — replace the `run` command's stub action:
```ts
program
  .command("run")
  .description("Run a pipeline")
  .requiredOption("--pipeline <name>", "pipeline name to run")
  .option("--once", "run exactly one iteration", false)
  .action(async (opts: { pipeline: string; once: boolean }) => {
    const { runCommand } = await import("./commands/run");
    const state = await runCommand(process.cwd(), opts.pipeline);
    console.log(`Stage ${state.stages[0].id}: ${state.stages[0].status}`);
    process.exitCode = state.stages[0].status === "done" ? 0 : 1;
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/integration/ralph-loop-mocked.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/run.ts src/cli.ts test/integration/ralph-loop-mocked.test.ts
git commit -m "feat: implement aiflow run --pipeline ralph-only --once with mocked integration coverage"
```

---

## Task 18: Real End-to-End Verification (Manual, Not CI)

**Files:**
- Modify: `fixtures/sample-project/.aiflow/config/models.yaml`
- Create: `test/integration/ralph-loop-real.test.ts`

**Interfaces:**
- Consumes: `runCommand` from Task 17; `runDoctorChecks` from Task 15.
- Produces: no new production code — this task validates the whole slice against real services and resolves Open Item 1 from the design spec with real values.

This task requires a real MiniMax or Moonshot/Kimi API key. Do not fabricate the model id or base URL — discover them empirically as described below.

- [ ] **Step 1: Obtain and export the reviewer API key**

Ask the user to export their real key, e.g.:
```bash
export MINIMAX_API_KEY="<the real key>"
```
Do not print or log the key value anywhere.

- [ ] **Step 2: Use `aiflow doctor` to discover the correct reviewer model id and base_url**

Run, from `fixtures/sample-project`:
```bash
cd fixtures/sample-project
bun run ../../src/cli.ts doctor
```
Expected initial output: `Reviewer reachable: false` with an error mentioning an invalid URL or 404, because `models.yaml` still has `REPLACE_ME_VERIFY_VIA_DOCTOR` placeholders. Consult MiniMax's (or Moonshot's) current API documentation for the real `base_url` (typically an OpenAI-compatible `.../v1` root) and a real chat-capable model id, update `fixtures/sample-project/.aiflow/config/models.yaml`'s `reviewer` profile with the real values, and re-run `aiflow doctor` until it reports `Reviewer reachable: true`.

- [ ] **Step 3: Write the real end-to-end test**

Create `test/integration/ralph-loop-real.test.ts`:
```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { runCommand } from "../../src/commands/run";

const FIXTURE_SOURCE = join(process.cwd(), "fixtures", "sample-project");
const hasReviewerKey = Boolean(process.env.MINIMAX_API_KEY);

test.skipIf(!hasReviewerKey)(
  "real end-to-end: aiflow run against fixtures/sample-project with real OpenCode + real reviewer",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiflow-real-e2e-"));
    try {
      cpSync(FIXTURE_SOURCE, dir, { recursive: true, filter: (src) => !src.includes(`${FIXTURE_SOURCE}/.git`) });
      await $`git -C ${dir} init -q`;
      await $`git -C ${dir} config user.email "test@example.com"`;
      await $`git -C ${dir} config user.name "Test"`;
      await $`git -C ${dir} add -A`;
      await $`git -C ${dir} commit -q -m "initial"`;
      await $`cd ${dir} && npm install --silent`.quiet();

      const state = await runCommand(dir, "ralph-only");

      expect(["done", "failed"]).toContain(state.stages[0].status);

      const eventsPath = join(dir, ".aiflow", "runs");
      expect(await $`ls ${eventsPath}`.text()).not.toBe("");

      if (state.stages[0].status === "done") {
        const prd = JSON.parse(readFileSync(join(dir, "prd.json"), "utf-8"));
        expect(prd.stories[0].passes).toBe(true);
        const log = await $`git -C ${dir} log -1 --pretty=%s`.text();
        expect(log.trim()).toContain("US-1");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000
);
```

- [ ] **Step 4: Run the real test and inspect the results**

Run: `MINIMAX_API_KEY="<key>" bun test test/integration/ralph-loop-real.test.ts`
Expected: PASS (test passes whether the gate itself ends in `done` or `failed` — the assertion is that the whole pipeline executes without crashing and produces real artifacts). Manually inspect `.aiflow/runs/<run_id>/events.jsonl` and `.aiflow/runs/<run_id>/artifacts/opencode/*.jsonl` in the temp dir (printed by the test framework on failure, or add a temporary `console.log(dir)` before the `finally` block while running manually) to confirm real OpenCode events and a real reviewer JSON response were captured.

If the stage status is `failed`, read `fixtures/sample-project`'s copied `prd.json`/`fix_list.md` in the temp dir to understand why (e.g., the real OpenCode model didn't fix `clamp` correctly, or the real reviewer flagged a genuine issue) — this is valuable real signal, not a bug in AIFlow itself, and does not block completing this task.

- [ ] **Step 5: Commit**

```bash
git add fixtures/sample-project/.aiflow/config/models.yaml test/integration/ralph-loop-real.test.ts
git commit -m "test: add real end-to-end verification against live OpenCode + reviewer API (resolves design open item 1)"
```

---

## Self-Review Notes

- **Spec coverage:** `doctor` (Task 15), `init` (Task 16), Pipeline Engine (Task 13), OpenCode Adapter (Tasks 7–8), `ralph_loop` Runner (Task 12), two-layer Review Gate (Tasks 9–11), minimal LLM Client (Task 10), `fixtures/sample-project` (Task 14), CLI surface (Tasks 1, 15–17), real end-to-end validation (Task 18) — every section of the design spec has a corresponding task.
- **Type consistency:** `AgentTask`/`AgentResult` (Task 8) are reused verbatim by Task 12 and Task 17; `ReviewGateOutcome`/`ReviewGateDeps` (Task 11) reused by Task 12; `RalphLoopDeps`/`RalphLoopResult` (Task 12) reused by Task 13 and Task 17; `EngineState`/`StageStatus` (Task 3) reused by Task 13 and Task 17's assertions. Confirmed no renamed duplicates across tasks.
- **Placeholder scan:** the only literal placeholder strings (`REPLACE_ME_VERIFY_VIA_DOCTOR`) are intentional, user-facing config template values pointing at Task 18's real-world verification step — not unfinished plan content.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-05-aiflow-cli-ralph-slice-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
