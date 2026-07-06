# Multi-Stage Pipeline Runners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let AIFlow pipelines declare and run `brainstorm`/`spec`/`plan`/`human_gate` stages alongside the existing `ralph_loop`, so a full `brainstorm → spec → human_gate → plan → ralph_loop` pipeline can actually execute.

**Architecture:** Replace the engine's single hardcoded `runRalphLoop` dependency with a `StageConfig["type"] → StageRunnerFn` registry; widen the stage config schema to a discriminated union; generalize the reviewer-only LLM client into a reusable `callLlm`/`callLlmFanOut` pair; add four new runner modules plus three CLI surfaces (`--requirement`/`--requirement-file` on `run`, new `approve`/`reject` commands).

**Tech Stack:** TypeScript, Bun, zod, commander (all already in use — no new dependencies).

## Global Constraints

- No new npm dependencies.
- `runRalphLoop`/`runRalphLoopOnce` (`src/runners/ralph-loop.ts`) keep their exact current signatures and behavior — every new task wraps them, never edits them.
- `callReviewer`'s exact signature and behavior (`(profile, prompt, fetchFn?) => Promise<unknown>`) must keep passing `test/unit/llm-client.test.ts`'s existing 5 tests unmodified.
- All new runner tests inject fake dependencies — no test may make a real network call or spawn a real `opencode` process (this repo already hit this exact bug once in `resume.test.ts`; do not repeat it).
- Every task must leave `bun test ./test` fully green before moving to the next task.

---

### Task 1: Widen `StageStatus`/`StageState`/`EngineState`, fix the resulting monitor.ts type error

**Files:**
- Modify: `src/engine/state.ts`
- Modify: `src/commands/monitor.ts:94-104` (`statusColor`'s `map` is a `Record` over the full `StageStatus` union — adding a new union member makes this a compile error until a case is added)
- Test: `test/unit/state.test.ts`

**Interfaces:**
- Produces: `StageStatus` now includes `"waiting_human"`. `StageState` gains `entered_at?: string`. `StageState.reason` widens from `RalphLoopStopReason` to `StageStopReason` (a new exported union `RalphLoopStopReason | "human_gate_timeout" | "human_gate_rejected"`). `EngineState` gains `requirement?: string`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/state.test.ts` (append at the end of the file):

```ts
test("writeStateAtomic then readState round-trips a waiting_human stage with entered_at", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-state-test-"));
  try {
    const state: EngineState = {
      run_id: "r1",
      pipeline: "full-auto",
      requirement: "add offline cache",
      stages: [{ id: "confirm-spec", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" }],
      cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    };
    writeStateAtomic(dir, state);
    const loaded = readState(dir);
    expect(loaded).toEqual(state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/state.test.ts`
Expected: FAIL — TypeScript error, `"waiting_human"` is not assignable to `StageStatus`, and `entered_at`/`requirement` do not exist on their respective types.

- [ ] **Step 3: Widen the types**

In `src/engine/state.ts`, replace lines 1-20 with:

```ts
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export type StageStatus = "pending" | "running" | "done" | "failed" | "aborted" | "suspended" | "waiting_human";

export type RalphLoopStopReason = "max_iterations" | "stall" | "stories_suspended";
export type StageStopReason = RalphLoopStopReason | "human_gate_timeout" | "human_gate_rejected";

export interface StageState {
  id: string;
  status: StageStatus;
  iteration?: number;
  reason?: StageStopReason;
  entered_at?: string;
}

export interface EngineState {
  run_id: string;
  pipeline: string;
  requirement?: string;
  stages: StageState[];
  cost: { input_tokens: number; output_tokens: number; est_usd: number };
}
```

(The rest of the file — `writeStateAtomic`, `readState` — is unchanged.)

- [ ] **Step 4: Fix the now-broken `monitor.ts` exhaustiveness check**

In `src/commands/monitor.ts`, find the `statusColor` function (around line 94) and add the missing case:

```ts
function statusColor(status: EngineState["stages"][number]["status"], on: boolean): string {
  const map: Record<EngineState["stages"][number]["status"], keyof typeof ANSI> = {
    pending: "gray",
    running: "cyan",
    done: "green",
    failed: "red",
    aborted: "yellow",
    suspended: "yellow",
    waiting_human: "yellow",
  };
  return c(map[status], on, status);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/unit/state.test.ts test/unit/monitor.test.ts`
Expected: PASS (all tests in both files).

- [ ] **Step 6: Run the full suite to confirm no other breakage**

Run: `bun test ./test`
Expected: PASS (no regressions — nothing else references `StageStatus` exhaustively).

- [ ] **Step 7: Commit**

```bash
git add src/engine/state.ts src/commands/monitor.ts test/unit/state.test.ts
git commit -m "feat: add waiting_human stage status and entered_at/requirement fields"
```

---

### Task 2: Discriminated-union stage config schema

**Files:**
- Modify: `src/config/schema.ts`
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Produces: `BrainstormStageSchema`/`BrainstormStageConfig`, `SpecStageSchema`/`SpecStageConfig`, `PlanStageSchema`/`PlanStageConfig`, `HumanGateStageSchema`/`HumanGateStageConfig` (all `z.infer` types), and `StageConfigSchema` as a `z.discriminatedUnion("type", [...])` covering all five stage types. `StageConfig` is now a union type.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/config.test.ts` (append at the end of the file):

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/config.test.ts`
Expected: FAIL — `type: "brainstorm"` etc. are rejected because `StageConfigSchema` currently only accepts `ralph_loop`.

- [ ] **Step 3: Add the new schemas and discriminated union**

In `src/config/schema.ts`, replace the final block (from `// Placeholder for future stage types...` through the end of the file) with:

```ts
export const BrainstormStageSchema = z.object({
  id: z.string(),
  type: z.literal("brainstorm"),
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
  model: z.string(),
  output: z.string().default("spec.md"),
});
export type SpecStageConfig = z.infer<typeof SpecStageSchema>;

export const PlanStageSchema = z.object({
  id: z.string(),
  type: z.literal("plan"),
  model: z.string(),
  input: z.string().default("spec.md"),
  output: z.string().default("prd.json"),
});
export type PlanStageConfig = z.infer<typeof PlanStageSchema>;

export const HumanGateStageSchema = z.object({
  id: z.string(),
  type: z.literal("human_gate"),
  prompt: z.string(),
  timeout: z.number().int().positive().optional(),
  on_timeout: z.enum(["approve", "abort"]).default("abort"),
});
export type HumanGateStageConfig = z.infer<typeof HumanGateStageSchema>;

export const StageConfigSchema = z.discriminatedUnion("type", [
  RalphLoopStageSchema,
  BrainstormStageSchema,
  SpecStageSchema,
  PlanStageSchema,
  HumanGateStageSchema,
]);
export type StageConfig = z.infer<typeof StageConfigSchema>;

export const PipelineConfigSchema = z.object({
  name: z.string(),
  stages: z.array(StageConfigSchema).min(1),
});
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/config.test.ts`
Expected: PASS (all tests, including the pre-existing `ralph_loop`-only ones).

- [ ] **Step 5: Run the full suite**

Run: `bun test ./test`
Expected: FAIL at this point in files that reference `StageConfig` as if it were only `RalphLoopStageConfig` (`src/engine/engine.ts`, `src/commands/run.ts`, `test/unit/engine.test.ts`) — this is expected; Task 5 fixes the engine side. Confirm the *only* failures are TypeScript errors in those three files (not new logic failures elsewhere).

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts test/unit/config.test.ts
git commit -m "feat: add brainstorm/spec/plan/human_gate to the stage config schema"
```

---

### Task 3: `PrdSchema` for runtime validation of `plan`'s output

**Files:**
- Modify: `src/prd.ts`
- Test: `test/unit/prd.test.ts`

**Interfaces:**
- Produces: `PrdSchema` (zod), structurally matching the existing `Prd`/`Story` interfaces. Consumed by Task 8 (`plan` runner).

- [ ] **Step 1: Write the failing test**

Add to `test/unit/prd.test.ts` (add `import { z } from "zod"` is not needed; import `PrdSchema` instead):

```ts
import { readPrd, writePrd, selectNextStory, markStoryPassed, recordStoryFailure, PrdSchema, type Prd } from "../../src/prd";
```

(Replace the existing import line at the top of the file with the one above — it's the same import, plus `PrdSchema`.)

Append at the end of the file:

```ts
test("PrdSchema accepts a valid Prd shape", () => {
  const result = PrdSchema.safeParse(samplePrd());
  expect(result.success).toBe(true);
});

test("PrdSchema rejects a story missing required fields", () => {
  const result = PrdSchema.safeParse({ branchName: "x", stories: [{ id: "US-1", title: "t" }] });
  expect(result.success).toBe(false);
});

test("PrdSchema rejects a non-array stories field", () => {
  const result = PrdSchema.safeParse({ branchName: "x", stories: "not-an-array" });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/prd.test.ts`
Expected: FAIL — `PrdSchema` does not exist yet.

- [ ] **Step 3: Add `PrdSchema`**

In `src/prd.ts`, add near the top (after the `import` line, before the existing `Story`/`Prd` interfaces):

```ts
import { z } from "zod";

export const StorySchema = z.object({
  id: z.string(),
  title: z.string(),
  acceptance: z.array(z.string()),
  priority: z.number(),
  passes: z.boolean(),
  fixCount: z.number(),
  suspended: z.boolean().optional(),
});

export const PrdSchema = z.object({
  branchName: z.string(),
  stories: z.array(StorySchema),
});
```

(Leave the existing `Story`/`Prd` interfaces and all functions below unchanged — `PrdSchema` is a separate runtime check, not a replacement.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/prd.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/prd.ts test/unit/prd.test.ts
git commit -m "feat: add PrdSchema for runtime validation of plan-stage output"
```

---

### Task 4: Generalize `src/llm/client.ts`

**Files:**
- Modify: `src/llm/client.ts`
- Test: `test/unit/llm-client.test.ts`

**Interfaces:**
- Produces: `callLlm(opts: LlmCallOptions): Promise<LlmCallResult>`, `callLlmFanOut(profiles, promptFn, opts?): Promise<Array<{profile, ok, result?, error?}>>`. `callReviewer` keeps its exact existing signature and behavior.
- Consumes: `ModelProfile` from `../config/schema` (unchanged).

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/llm-client.test.ts` (keep all 5 existing tests untouched, add these below them):

```ts
import { callLlm, callLlmFanOut } from "../../src/llm/client";

test("callLlm omits response_format when jsonMode is false, includes it when true", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  let capturedBody: any;
  const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  await callLlm({ profile, prompt: "x", jsonMode: false, fetchFn: fakeFetch });
  expect(capturedBody.response_format).toBeUndefined();

  await callLlm({ profile, prompt: "x", jsonMode: true, fetchFn: fakeFetch });
  expect(capturedBody.response_format).toEqual({ type: "json_object" });
});

test("callLlm retries once on a 429 response and succeeds on the second attempt", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    if (calls === 1) return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await callLlm({ profile, prompt: "x", fetchFn: fakeFetch });
  expect(result.text).toBe("ok");
  expect(calls).toBe(2);
});

test("callLlm does not retry on a 401 response", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return new Response("unauthorized", { status: 401 });
  }) as unknown as typeof fetch;

  await expect(callLlm({ profile, prompt: "x", fetchFn: fakeFetch })).rejects.toThrow();
  expect(calls).toBe(1);
});

test("callLlm reads usage from the response body's usage field", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const result = await callLlm({ profile, prompt: "x", fetchFn: fakeFetch });
  expect(result.usage).toEqual({ inTok: 10, outTok: 4, costUsd: 0 });
});

test("callLlmFanOut returns per-profile ok/error without one failure blocking the others", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const profileB: ModelProfile = { ...profile, api_key_env: "MISSING_FANOUT_KEY" };
  delete process.env.MISSING_FANOUT_KEY;
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })) as unknown as typeof fetch;

  const results = await callLlmFanOut([profile, profileB], () => "prompt", { fetchFn: fakeFetch });
  expect(results[0].ok).toBe(true);
  expect(results[0].result?.text).toBe("ok");
  expect(results[1].ok).toBe(false);
  expect(results[1].error).toBeDefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/llm-client.test.ts`
Expected: FAIL — `callLlm`/`callLlmFanOut` do not exist yet.

- [ ] **Step 3: Rewrite `src/llm/client.ts`**

```ts
import type { ModelProfile } from "../config/schema";

export interface LlmCallOptions {
  profile: ModelProfile;
  prompt: string;
  jsonMode?: boolean;
  thinking?: boolean;
  fetchFn?: typeof fetch;
}

export interface LlmCallResult {
  text: string;
  usage: { inTok: number; outTok: number; costUsd: number };
}

export class LlmHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof LlmHttpError) return err.status === 429 || err.status >= 500;
  return true;
}

async function withRetry<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function callLlm(opts: LlmCallOptions): Promise<LlmCallResult> {
  const { profile, prompt, jsonMode = false, thinking = false, fetchFn = fetch } = opts;
  if (!profile.api_key_env) throw new Error("Profile has no api_key_env configured");
  const apiKey = process.env[profile.api_key_env];
  if (!apiKey) throw new Error(`Environment variable ${profile.api_key_env} is not set`);
  if (!profile.base_url) throw new Error("Profile has no base_url configured");

  return withRetry(async () => {
    const response = await fetchFn(`${profile.base_url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: profile.model,
        messages: [{ role: "user", content: prompt }],
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        thinking: { type: thinking ? "enabled" : "disabled" },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new LlmHttpError(response.status, `LLM HTTP call failed: ${response.status} ${body}`);
    }

    const data = (await response.json()) as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: data.choices[0].message.content,
      usage: {
        inTok: data.usage?.prompt_tokens ?? 0,
        outTok: data.usage?.completion_tokens ?? 0,
        costUsd: 0,
      },
    };
  }, 3);
}

export async function callLlmFanOut(
  profiles: ModelProfile[],
  promptFn: (profile: ModelProfile) => string,
  opts: { jsonMode?: boolean; thinking?: boolean; fetchFn?: typeof fetch } = {}
): Promise<Array<{ profile: ModelProfile; ok: boolean; result?: LlmCallResult; error?: string }>> {
  const settled = await Promise.allSettled(
    profiles.map((profile) => callLlm({ profile, prompt: promptFn(profile), ...opts }))
  );
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? { profile: profiles[i], ok: true, result: r.value }
      : { profile: profiles[i], ok: false, error: String(r.reason) }
  );
}

export async function callReviewer(
  profile: ModelProfile,
  prompt: string,
  fetchFn: typeof fetch = fetch
): Promise<unknown> {
  const result = await callLlm({ profile, prompt, jsonMode: true, thinking: false, fetchFn });
  return JSON.parse(result.text);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/llm-client.test.ts`
Expected: PASS (all 10 tests — the 5 pre-existing `callReviewer` tests plus the 5 new ones).

- [ ] **Step 5: Run the review-gate tests to confirm zero impact**

Run: `bun test test/unit/review-gate.test.ts`
Expected: PASS (unchanged — that file mocks `callReviewer` directly via `ReviewGateDeps` and never touches the real implementation).

- [ ] **Step 6: Commit**

```bash
git add src/llm/client.ts test/unit/llm-client.test.ts
git commit -m "feat: generalize llm client into callLlm/callLlmFanOut, keep callReviewer as a thin wrapper"
```

---

### Task 5: Engine registry refactor (`StageOutcome`/`StageRunnerFn`/`EngineDeps.runners`)

This is the pivotal task: it changes `runPipelineOnce`'s public signature (drops the now-redundant `specExcerpt` positional parameter — each runner reads its own input files directly from `cwd` instead) and replaces `EngineDeps.runRalphLoop` with a `runners` registry. Every existing caller of `runPipelineOnce`/`EngineDeps` needs a matching update in this same task, or the build won't compile.

**Files:**
- Modify: `src/engine/engine.ts`
- Modify: `src/commands/resume.ts`
- Modify: `src/commands/run.ts`
- Modify: `test/unit/engine.test.ts` (full rewrite of all `runPipelineOnce` call sites)
- Modify: `test/unit/resume.test.ts` (mock shape only)

**Interfaces:**
- Produces: `StageOutcome { result: "pass"|"fail"|"suspended"|"aborted"|"waiting_human", reason?: string, usage?: {...}, entered_at?: string }`; `StageRunnerFn = (stageConfig: StageConfig, stageState: StageState, profiles, cwd, runDir, nowFn: () => Date, signal?: AbortSignal) => Promise<StageOutcome>`; `EngineDeps { runners: Partial<Record<StageConfig["type"], StageRunnerFn>>, nowFn?, writeRunReport? }`; `runPipelineOnce(pipeline, profiles, cwd, runDir, deps?, signal?, opts?)` — **`specExcerpt` parameter removed**.
- Consumes: `runRalphLoop`/`RalphLoopSummary` from `../runners/ralph-loop` (unchanged).

- [ ] **Step 1: Update `test/unit/engine.test.ts` to the new shape (this is the "failing test" for this task)**

Replace the entire contents of `test/unit/engine.test.ts` with:

```ts
import { test, expect, mock, describe } from "bun:test";
import { mkdtempSync, rmSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipelineOnce, createRunId, summarizePipelineOutcome } from "../../src/engine/engine";
import { readState } from "../../src/engine/state";
import type { PipelineConfig, ModelProfile } from "../../src/config/schema";
import type { EngineState } from "../../src/engine/state";

const pipeline: PipelineConfig = {
  name: "ralph-only",
  stages: [
    {
      id: "develop",
      type: "ralph_loop",
      model: "main-dev",
      per_story_fix_limit: 3,
      max_iterations: 10,
      stall_limit: 3,
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
    const ralphLoop = mock(async () => ({ result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, {
      runners: { ralph_loop: ralphLoop },
    });
    expect(state.stages[0].status).toBe("done");
    const persisted = readState(runDir);
    expect(persisted.stages[0].status).toBe("done");
    const reportPath = join(runDir, "run-report.md");
    expect(existsSync(reportPath)).toBe(true);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce writes a run-report.md mentioning each terminal result", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const ralphLoop = mock(async () => ({
      result: "suspended" as const,
      reason: "stories_suspended" as const,
      usage: { inTok: 0, outTok: 0, costUsd: 0 },
    }));
    await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, { runners: { ralph_loop: ralphLoop } });
    appendFileSync(
      join(runDir, "events.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), type: "story_result", story: "US-1", result: "suspended" }) + "\n",
    );
    const state = readState(runDir);
    const events = (await import("../../src/events/events")).readEvents(runDir);
    const { renderRunReport } = await import("../../src/commands/report");
    const report = renderRunReport(state, events, { now: new Date(), startedAt: new Date(Date.now() - 90_000) });
    expect(report).toContain("## Stages");
    expect(report).toContain("develop");
    expect(report).toContain("US-1");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce marks the stage suspended when the runner returns suspended", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const ralphLoop = mock(async () => ({
      result: "suspended" as const,
      reason: "max_iterations" as const,
      usage: { inTok: 0, outTok: 0, costUsd: 0 },
    }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, {
      runners: { ralph_loop: ralphLoop },
    });
    expect(state.stages[0].status).toBe("suspended");
    const persisted = readState(runDir);
    expect(persisted.stages[0].status).toBe("suspended");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce passes the runner's reason through onto state.stages[i].reason", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const ralphLoop = mock(async () => ({
      result: "suspended" as const,
      reason: "stall" as const,
      usage: { inTok: 0, outTok: 0, costUsd: 0 },
    }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, {
      runners: { ralph_loop: ralphLoop },
    });
    expect(state.stages[0].reason).toBe("stall");
    const persisted = readState(runDir);
    expect(persisted.stages[0].reason).toBe("stall");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce aggregates the runner's usage into state.cost", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const ralphLoop = mock(async () => ({
      result: "pass" as const,
      usage: { inTok: 123, outTok: 45, costUsd: 0.0067 },
    }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, {
      runners: { ralph_loop: ralphLoop },
    });
    expect(state.cost).toEqual({ input_tokens: 123, output_tokens: 45, est_usd: 0.0067 });
    const persisted = readState(runDir);
    expect(persisted.cost).toEqual({ input_tokens: 123, output_tokens: 45, est_usd: 0.0067 });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce throws a clear error for a stage type with no registered runner", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    await expect(
      runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, { runners: {} })
    ).rejects.toThrow(/No runner registered for stage type "ralph_loop"/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("summarizePipelineOutcome reports success and exit 0 only when every stage is done", () => {
  const allDone: EngineState = {
    run_id: "r1",
    pipeline: "p",
    stages: [{ id: "a", status: "done" }, { id: "b", status: "done" }],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
  };
  const outcome = summarizePipelineOutcome(allDone);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.line).toContain("a");
  expect(outcome.line).toContain("b");
});

test("summarizePipelineOutcome reports the first non-done stage and exit 1, even if it isn't stages[0]", () => {
  const laterStageFailed: EngineState = {
    run_id: "r1",
    pipeline: "p",
    stages: [{ id: "a", status: "done" }, { id: "b", status: "failed" }],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
  };
  const outcome = summarizePipelineOutcome(laterStageFailed);
  expect(outcome.exitCode).toBe(1);
  expect(outcome.line).toContain("b");
  expect(outcome.line).toContain("failed");
});

test("runPipelineOnce marks the stage aborted when the signal is already aborted", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const controller = new AbortController();
    controller.abort();
    const ralphLoop = mock(async () => ({ result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
    const state = await runPipelineOnce(
      pipeline,
      profiles,
      "/tmp/does-not-matter",
      runDir,
      { runners: { ralph_loop: ralphLoop } },
      controller.signal
    );
    expect(state.stages[0].status).toBe("aborted");
    expect(ralphLoop).not.toHaveBeenCalled();
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

describe("runPipelineOnce resume", () => {
  test("resume re-runs a pending stage by reading the existing state.json", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-resume-"));
    try {
      writeFileSync(
        join(runDir, "state.json"),
        JSON.stringify({
          run_id: runDir.split("/").pop(),
          pipeline: pipeline.name,
          stages: [{ id: "develop", status: "pending" }],
          cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
        }),
      );
      const ralphLoop = mock(async () => ({ result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
      const state = await runPipelineOnce(
        pipeline,
        profiles,
        "/tmp/does-not-matter",
        runDir,
        { runners: { ralph_loop: ralphLoop }, nowFn: () => new Date("2026-07-05T20:00:00.000Z") },
        undefined,
        { resume: true, now: new Date("2026-07-05T20:00:00.000Z") },
      );
      expect(state.stages[0].status).toBe("done");
      expect(ralphLoop).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test("resume is a no-op when the only stage is already terminal (without --force)", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-resume-"));
    try {
      writeFileSync(
        join(runDir, "state.json"),
        JSON.stringify({
          run_id: runDir.split("/").pop(),
          pipeline: pipeline.name,
          stages: [{ id: "develop", status: "failed" }],
          cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
        }),
      );
      const ralphLoop = mock(async () => ({ result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
      const state = await runPipelineOnce(
        pipeline,
        profiles,
        "/tmp/does-not-matter",
        runDir,
        { runners: { ralph_loop: ralphLoop }, nowFn: () => new Date() },
        undefined,
        { resume: true },
      );
      expect(state.stages[0].status).toBe("failed");
      expect(ralphLoop).not.toHaveBeenCalled();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test("resume --force overrides a terminal stage and re-runs it", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-resume-"));
    try {
      writeFileSync(
        join(runDir, "state.json"),
        JSON.stringify({
          run_id: runDir.split("/").pop(),
          pipeline: pipeline.name,
          stages: [{ id: "develop", status: "suspended" }],
          cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
        }),
      );
      const ralphLoop = mock(async () => ({ result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
      const state = await runPipelineOnce(
        pipeline,
        profiles,
        "/tmp/does-not-matter",
        runDir,
        { runners: { ralph_loop: ralphLoop }, nowFn: () => new Date() },
        undefined,
        { resume: true, force: true },
      );
      expect(state.stages[0].status).toBe("done");
      expect(ralphLoop).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test("resume surfaces a clear error when state.json does not exist", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-resume-empty-"));
    try {
      const ralphLoop = mock(async () => ({ result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
      await expect(
        runPipelineOnce(
          pipeline,
          profiles,
          "/tmp/does-not-matter",
          runDir,
          { runners: { ralph_loop: ralphLoop } },
          undefined,
          { resume: true },
        ),
      ).rejects.toThrow(/ENOENT/);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/engine.test.ts`
Expected: FAIL — compile error, `runPipelineOnce` still expects the old 8-positional-arg shape with `runRalphLoop`.

- [ ] **Step 3: Rewrite `src/engine/engine.ts`**

Replace the entire file:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeStateAtomic, readState, type EngineState, type StageState, type StageStatus } from "./state";
import { readEvents } from "../events/events";
import { runRalphLoop as realRunRalphLoop, type RalphLoopStageConfig } from "../runners/ralph-loop";
import { writeRunReport } from "../commands/report";
import type { PipelineConfig, ModelProfile, StageConfig } from "../config/schema";

export interface StageOutcome {
  result: "pass" | "fail" | "suspended" | "aborted" | "waiting_human";
  reason?: string;
  usage?: { inTok: number; outTok: number; costUsd: number };
  entered_at?: string;
}

export type StageRunnerFn = (
  stageConfig: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  signal?: AbortSignal
) => Promise<StageOutcome>;

export interface EngineDeps {
  runners: Partial<Record<StageConfig["type"], StageRunnerFn>>;
  nowFn?: () => Date;
  writeRunReport?: (runDir: string, state: EngineState, now: Date, startedAt: Date) => void;
}

async function adaptRalphLoop(
  stageConfig: StageConfig,
  _stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  _nowFn: () => Date,
  signal?: AbortSignal
): Promise<StageOutcome> {
  const specPath = join(cwd, "spec.md");
  const specExcerpt = existsSync(specPath) ? readFileSync(specPath, "utf-8").slice(0, 4000) : "";
  const summary = await realRunRalphLoop(
    stageConfig as RalphLoopStageConfig,
    profiles,
    cwd,
    runDir,
    specExcerpt,
    undefined,
    signal
  );
  return { result: summary.result, reason: summary.reason, usage: summary.usage };
}

const defaultDeps: EngineDeps = {
  runners: { ralph_loop: adaptRalphLoop },
  nowFn: () => new Date(),
  writeRunReport: (runDir, state, now, startedAt) => {
    const events = readEvents(runDir);
    writeRunReport(runDir, state, events, { now, startedAt });
  },
};

export const TERMINAL_STATUSES: ReadonlySet<StageStatus> = new Set([
  "done",
  "failed",
  "aborted",
  "suspended",
]);

export function isTerminalStatus(s: StageStatus): boolean {
  return TERMINAL_STATUSES.has(s);
}

/** Return index of the first non-terminal stage, or -1 when all stages are terminal. */
export function firstResumeIndex(stages: StageState[]): number {
  for (let i = 0; i < stages.length; i++) {
    if (!TERMINAL_STATUSES.has(stages[i].status)) return i;
  }
  return -1;
}

interface StageExecutionResult {
  state: StageState;
  usage?: { inTok: number; outTok: number; costUsd: number };
}

const STATUS_MAP: Record<StageOutcome["result"], StageStatus> = {
  pass: "done",
  fail: "failed",
  suspended: "suspended",
  aborted: "aborted",
  waiting_human: "waiting_human",
};

async function executeStage(
  stage: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  deps: EngineDeps,
  signal: AbortSignal | undefined,
): Promise<StageExecutionResult> {
  if (signal?.aborted) return { state: { id: stage.id, status: "aborted" } };

  const runner = deps.runners[stage.type];
  if (!runner) throw new Error(`No runner registered for stage type "${stage.type}"`);

  const outcome = await runner(stage, stageState, profiles, cwd, runDir, nowFn, signal);
  const status = STATUS_MAP[outcome.result];
  const entered_at = outcome.entered_at ?? stageState.entered_at;
  return {
    state: { id: stage.id, status, reason: outcome.reason, entered_at },
    usage: outcome.usage,
  };
}

export interface RunPipelineOptions {
  /** When true, load state.json from runDir and resume from the first non-terminal stage. */
  resume?: boolean;
  /** Force re-execution of terminal stages (mutates state.status="pending" before running). */
  force?: boolean;
  now?: Date;
  /** Requirement text for pipelines with a brainstorm/spec stage; stored on the initial state only. */
  requirement?: string;
}

/**
 * Run a multi-stage pipeline sequentially; each stage's own runner (looked up
 * by `stage.type` in `deps.runners`) is responsible for reading whatever
 * input files it needs directly from `cwd` — the engine passes no in-memory
 * context object between stages (everything crosses stage boundaries via
 * files, per the project's file-driven design principle).
 */
export async function runPipelineOnce(
  pipeline: PipelineConfig,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  deps: EngineDeps = defaultDeps,
  signal?: AbortSignal,
  opts: RunPipelineOptions = {}
): Promise<EngineState> {
  const effectiveDeps: EngineDeps = {
    ...defaultDeps,
    ...deps,
    runners: { ...defaultDeps.runners, ...(deps.runners ?? {}) },
  };
  const nowFn = effectiveDeps.nowFn ?? (() => new Date());

  const startedAt = opts.now ?? nowFn();

  let state: EngineState;
  if (opts.resume) {
    state = readState(runDir);
  } else {
    state = {
      run_id: runDir.split("/").pop() ?? "unknown",
      pipeline: pipeline.name,
      requirement: opts.requirement,
      stages: pipeline.stages.map((s) => ({ id: s.id, status: "pending" as StageStatus })),
      cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    };
  }
  writeStateAtomic(runDir, state);

  const writeReportNow = () => {
    if (!effectiveDeps.writeRunReport) return;
    try {
      effectiveDeps.writeRunReport(runDir, state, nowFn(), startedAt);
    } catch {
      // never block engine on report errors
    }
  };

  // On --force, reset every terminal stage so a resume replays the whole pipeline.
  if (opts.force) {
    state = {
      ...state,
      stages: state.stages.map((s) => (TERMINAL_STATUSES.has(s.status) ? { ...s, status: "pending" } : s)),
    };
    writeStateAtomic(runDir, state);
  }

  // Idempotent early-out: a fully terminal pipeline with resume+!force is a no-op.
  const pipelineAllTerminal = state.stages.every((s) => TERMINAL_STATUSES.has(s.status));
  if (opts.resume && pipelineAllTerminal && !opts.force) {
    writeReportNow();
    return state;
  }

  for (let i = 0; i < pipeline.stages.length; i++) {
    if (signal?.aborted) {
      state = { ...state, stages: state.stages.map((s) => (s.status === "pending" || s.status === "running" ? { ...s, status: "aborted" } : s)) };
      writeStateAtomic(runDir, state);
      break;
    }
    const stage = pipeline.stages[i];
    const stageState = state.stages[i];
    if (TERMINAL_STATUSES.has(stageState.status)) continue;

    state = { ...state, stages: state.stages.map((s, idx) => (idx === i ? { ...s, status: "running" } : s)) };
    writeStateAtomic(runDir, state);

    const execResult = await executeStage(stage, stageState, profiles, cwd, runDir, nowFn, effectiveDeps, signal);
    state = {
      ...state,
      stages: state.stages.map((s, idx) => (idx === i ? execResult.state : s)),
      cost: execResult.usage
        ? {
            input_tokens: state.cost.input_tokens + execResult.usage.inTok,
            output_tokens: state.cost.output_tokens + execResult.usage.outTok,
            est_usd: state.cost.est_usd + execResult.usage.costUsd,
          }
        : state.cost,
    };
    writeStateAtomic(runDir, state);

    // any non-"done" outcome (including "waiting_human") short-circuits the rest of the pipeline
    if (execResult.state.status !== "done") {
      break;
    }
  }

  writeReportNow();
  return state;
}

/**
 * Summarize a pipeline's overall outcome across ALL stages, not just the
 * first one — a pipeline with multiple stages is only successful if every
 * stage reached "done"; reporting only stages[0] would hide a later failure.
 */
export function summarizePipelineOutcome(state: EngineState): { line: string; exitCode: number } {
  const blocking = state.stages.find((s) => s.status !== "done");
  if (!blocking) {
    const ids = state.stages.map((s) => s.id).join(", ");
    return { line: `All stages done (${ids})`, exitCode: 0 };
  }
  return { line: `Stage ${blocking.id}: ${blocking.status}`, exitCode: 1 };
}

export function createRunId(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const rand = Math.random().toString(16).slice(2, 8);
  return `${stamp}_${rand}`;
}
```

- [ ] **Step 4: Fix `src/commands/resume.ts`'s call site**

In `src/commands/resume.ts`, replace the `runPipelineOnce(...)` call (currently passing `""` as the 5th positional arg) with:

```ts
  const state = await runPipelineOnce(
    pipelineConfig,
    profiles,
    cwd,
    runDir,
    deps,
    undefined,
    { resume: true, force: opts.force ?? false },
  );
```

(No other changes needed in this file — `runResume`'s own signature, including its `deps?: EngineDeps` parameter, is unaffected.)

- [ ] **Step 5: Update `test/unit/resume.test.ts`'s mock shape**

In `test/unit/resume.test.ts`, replace:

```ts
      const result = await runResume(cwd, { runId }, {
        runRalphLoop: async () => ({
          result: "pass",
          iterations: 1,
          usage: { inTok: 0, outTok: 0, costUsd: 0 },
        }),
      });
```

with:

```ts
      const result = await runResume(cwd, { runId }, {
        runners: {
          ralph_loop: async () => ({
            result: "pass",
            usage: { inTok: 0, outTok: 0, costUsd: 0 },
          }),
        },
      });
```

- [ ] **Step 6: Patch `src/commands/run.ts`'s ralph_loop wiring (minimal — full multi-stage wiring lands in Task 10)**

Replace the entire file with:

```ts
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadModelsConfig, loadPipelineConfig } from "../config/loader";
import { createRunId, runPipelineOnce, type EngineDeps, type StageOutcome } from "../engine/engine";
import { runRalphLoop } from "../runners/ralph-loop";
import { runAgentTask as realRunAgentTask, type AgentTask, type AgentResult } from "../adapters/opencode";
import { runReviewGate as realRunReviewGate } from "../gate/review-gate";
import { runChecks } from "../gate/check-runner";
import { callReviewer as realCallReviewer } from "../llm/client";
import { revParseHead, stageAll, diffCached, commit } from "../git";
import type { EngineState } from "../engine/state";
import type { ModelProfile, RalphLoopStageConfig } from "../config/schema";

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

  const runAgentTask = overrides.runAgentTask ?? realRunAgentTask;
  const reviewerCallFn = overrides.callReviewer ?? realCallReviewer;

  const engineDeps: EngineDeps = {
    runners: {
      ralph_loop: async (stageConfig, _stageState, profiles, runCwd, stageRunDir, _nowFn, signal): Promise<StageOutcome> => {
        const specPath = join(runCwd, "spec.md");
        const specExcerpt = existsSync(specPath) ? readFileSync(specPath, "utf-8").slice(0, 4000) : "";
        const summary = await runRalphLoop(
          stageConfig as RalphLoopStageConfig,
          profiles,
          runCwd,
          stageRunDir,
          specExcerpt,
          {
            runAgentTask,
            runReviewGate: (config, reviewerProfile, gateCwd, diff, acceptance) =>
              realRunReviewGate(config, reviewerProfile, gateCwd, diff, acceptance, {
                runChecks,
                callReviewer: reviewerCallFn,
              }),
            git: { revParseHead, stageAll, diffCached, commit },
          },
          signal
        );
        return { result: summary.result, reason: summary.reason, usage: summary.usage };
      },
    },
  };

  return runPipelineOnce(pipelineConfig, modelsConfig.profiles, cwd, runDir, engineDeps);
}
```

- [ ] **Step 7: Run the full suite**

Run: `bun test ./test`
Expected: PASS — all tests green, including `test/integration/ralph-loop-mocked.test.ts` and `test/integration/fixture-sample-project.test.ts`, which call `runCommand` through its unchanged `RunCommandOverrides` interface.

- [ ] **Step 8: Commit**

```bash
git add src/engine/engine.ts src/commands/resume.ts src/commands/run.ts test/unit/engine.test.ts test/unit/resume.test.ts
git commit -m "refactor: replace EngineDeps.runRalphLoop with a stage-type runner registry"
```

---

### Task 6: `brainstorm` runner

**Files:**
- Create: `src/runners/brainstorm.ts`
- Modify: `src/events/events.ts` (add `BrainstormResultAiflowEvent`)
- Test: `test/unit/brainstorm.test.ts`

**Interfaces:**
- Consumes: `callLlm`/`callLlmFanOut` (Task 4), `BrainstormStageConfig` (Task 2), `StageOutcome` (Task 5).
- Produces: `runBrainstormStage(stageConfig, stageState, profiles, cwd, runDir, nowFn, signal, deps?): Promise<StageOutcome>`, `BrainstormDeps { callLlm, callLlmFanOut }`.

- [ ] **Step 1: Add the new event type**

In `src/events/events.ts`, add after `RalphLoopResultAiflowEvent`:

```ts
export interface BrainstormResultAiflowEvent {
  ts: string;
  type: "brainstorm_result";
  stage: string;
  result: "pass" | "fail";
  successes: number;
}
```

Add `BrainstormResultAiflowEvent` to the `AiflowEvent` union.

- [ ] **Step 2: Write the failing tests**

Create `test/unit/brainstorm.test.ts`:

```ts
import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBrainstormStage } from "../../src/runners/brainstorm";
import type { BrainstormStageConfig, ModelProfile } from "../../src/config/schema";
import type { StageState } from "../../src/engine/state";

const profiles: Record<string, ModelProfile> = {
  a: { channel: "http", provider: "x", model: "a" },
  b: { channel: "http", provider: "x", model: "b" },
  synth: { channel: "http", provider: "x", model: "synth" },
};

const baseStage: BrainstormStageConfig = {
  id: "ideate",
  type: "brainstorm",
  models: ["a", "b"],
  mode: "independent",
  debate_rounds: 2,
  synthesizer: "synth",
  output: "brainstorm-report.md",
};

const pendingStageState: StageState = { id: "ideate", status: "pending" };

function setupRunDir(): string {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-brainstorm-test-"));
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "requirement.md"), "Add offline cache to the app.");
  return runDir;
}

test("independent mode: both models succeed, synthesis is written, result is pass", async () => {
  const runDir = setupRunDir();
  try {
    const callLlmFanOut = mock(async () => [
      { profile: profiles.a, ok: true, result: { text: "proposal A", usage: { inTok: 10, outTok: 5, costUsd: 0 } } },
      { profile: profiles.b, ok: true, result: { text: "proposal B", usage: { inTok: 10, outTok: 5, costUsd: 0 } } },
    ]);
    const callLlm = mock(async () => ({ text: "synthesis text", usage: { inTok: 20, outTok: 10, costUsd: 0 } }));

    const outcome = await runBrainstormStage(baseStage, pendingStageState, profiles, "/tmp/x", runDir, () => new Date(), undefined, {
      callLlm,
      callLlmFanOut,
    });

    expect(outcome.result).toBe("pass");
    expect(outcome.usage).toEqual({ inTok: 50, outTok: 20, costUsd: 0 });
    const reportPath = join(runDir, "artifacts", "brainstorm-report.md");
    expect(existsSync(reportPath)).toBe(true);
    const content = readFileSync(reportPath, "utf-8");
    expect(content).toContain("synthesis text");
    expect(content).toContain("proposal A");
    expect(content).toContain("proposal B");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("independent mode: fewer than 2 successes fails without calling the synthesizer", async () => {
  const runDir = setupRunDir();
  try {
    const callLlmFanOut = mock(async () => [
      { profile: profiles.a, ok: true, result: { text: "proposal A", usage: { inTok: 10, outTok: 5, costUsd: 0 } } },
      { profile: profiles.b, ok: false, error: "network error" },
    ]);
    const callLlm = mock(async () => ({ text: "unused", usage: { inTok: 0, outTok: 0, costUsd: 0 } }));

    const outcome = await runBrainstormStage(baseStage, pendingStageState, profiles, "/tmp/x", runDir, () => new Date(), undefined, {
      callLlm,
      callLlmFanOut,
    });

    expect(outcome.result).toBe("fail");
    expect(callLlm).not.toHaveBeenCalled();
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("debate mode: runs debate_rounds total fan-out calls before synthesizing", async () => {
  const runDir = setupRunDir();
  const debateStage: BrainstormStageConfig = { ...baseStage, mode: "debate", debate_rounds: 2 };
  try {
    const callLlmFanOut = mock(async () => [
      { profile: profiles.a, ok: true, result: { text: "round text A", usage: { inTok: 1, outTok: 1, costUsd: 0 } } },
      { profile: profiles.b, ok: true, result: { text: "round text B", usage: { inTok: 1, outTok: 1, costUsd: 0 } } },
    ]);
    const callLlm = mock(async () => ({ text: "final synthesis", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));

    const outcome = await runBrainstormStage(debateStage, pendingStageState, profiles, "/tmp/x", runDir, () => new Date(), undefined, {
      callLlm,
      callLlmFanOut,
    });

    expect(outcome.result).toBe("pass");
    expect(callLlmFanOut).toHaveBeenCalledTimes(2); // round 1 (idea) + round 2 (debate); debate_rounds=2 means one extra round
    expect(callLlm).toHaveBeenCalledTimes(1); // synthesizer only
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/unit/brainstorm.test.ts`
Expected: FAIL — `src/runners/brainstorm.ts` does not exist yet.

- [ ] **Step 4: Implement `src/runners/brainstorm.ts`**

```ts
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { callLlm, callLlmFanOut, type LlmCallResult } from "../llm/client";
import { appendEvent } from "../events/events";
import type { BrainstormStageConfig, ModelProfile } from "../config/schema";
import type { StageOutcome } from "../engine/engine";
import type { StageState } from "../engine/state";

type FanOutResult = { profile: ModelProfile; ok: boolean; result?: LlmCallResult; error?: string };

export interface BrainstormDeps {
  callLlm: typeof callLlm;
  callLlmFanOut: typeof callLlmFanOut;
}

const defaultDeps: BrainstormDeps = { callLlm, callLlmFanOut };

function sumUsage(rounds: FanOutResult[][], extra?: LlmCallResult) {
  const usage = { inTok: 0, outTok: 0, costUsd: 0 };
  for (const round of rounds) {
    for (const r of round) {
      if (r.ok && r.result) {
        usage.inTok += r.result.usage.inTok;
        usage.outTok += r.result.usage.outTok;
        usage.costUsd += r.result.usage.costUsd;
      }
    }
  }
  if (extra) {
    usage.inTok += extra.usage.inTok;
    usage.outTok += extra.usage.outTok;
    usage.costUsd += extra.usage.costUsd;
  }
  return usage;
}

function renderIdeaPrompt(requirement: string): string {
  return [
    "You are brainstorming an implementation approach for the following requirement.",
    "Produce: a concise solution overview, key design decisions, risks, and a rough effort estimate.",
    "",
    "## Requirement",
    requirement,
  ].join("\n");
}

function renderDebatePrompt(requirement: string, others: string[]): string {
  return [
    renderIdeaPrompt(requirement),
    "",
    "## Other proposals from this round (anonymized)",
    ...others.map((text, i) => `### Model ${i + 1}\n${text}`),
    "",
    "Critique the other proposals and revise your own proposal in response.",
  ].join("\n");
}

function renderSynthesisPrompt(requirement: string, finalRound: FanOutResult[]): string {
  const proposals = finalRound
    .filter((r) => r.ok && r.result)
    .map((r, i) => `### Model ${i + 1}\n${r.result!.text}`)
    .join("\n\n");
  return [
    "Synthesize the following independent proposals into: a comparison matrix, a recommended approach, and a list of open questions.",
    "",
    "## Requirement",
    requirement,
    "",
    "## Proposals",
    proposals,
  ].join("\n");
}

export async function runBrainstormStage(
  stageConfig: BrainstormStageConfig,
  _stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  _nowFn: () => Date,
  _signal: AbortSignal | undefined,
  deps: BrainstormDeps = defaultDeps
): Promise<StageOutcome> {
  const artifactsDir = join(runDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const requirementPath = join(artifactsDir, "requirement.md");
  const requirement = existsSync(requirementPath) ? readFileSync(requirementPath, "utf-8") : "";

  const modelProfiles = stageConfig.models.map((name) => profiles[name]);

  const round1 = await deps.callLlmFanOut(modelProfiles, () => renderIdeaPrompt(requirement));
  const successCount1 = round1.filter((r) => r.ok).length;
  if (successCount1 < 2) {
    appendEvent(runDir, {
      ts: new Date().toISOString(),
      type: "brainstorm_result",
      stage: stageConfig.id,
      result: "fail",
      successes: successCount1,
    });
    return { result: "fail", usage: sumUsage([round1]) };
  }

  const rounds: FanOutResult[][] = [round1];
  let finalRound = round1;

  if (stageConfig.mode === "debate") {
    for (let round = 2; round <= stageConfig.debate_rounds; round++) {
      const previous = finalRound;
      finalRound = await deps.callLlmFanOut(modelProfiles, (profile) => {
        const others = previous.filter((r) => r.profile !== profile && r.ok && r.result).map((r) => r.result!.text);
        return renderDebatePrompt(requirement, others);
      });
      rounds.push(finalRound);
    }
  }

  const synthesizerProfile = profiles[stageConfig.synthesizer];
  const synthesis = await deps.callLlm({
    profile: synthesizerProfile,
    prompt: renderSynthesisPrompt(requirement, finalRound),
    thinking: true,
  });

  const appendix = finalRound
    .map((r, i) => (r.ok && r.result ? `## Model ${i + 1}\n${r.result.text}` : `## Model ${i + 1}\n(failed: ${r.error})`))
    .join("\n\n");
  writeFileSync(join(artifactsDir, stageConfig.output), `${synthesis.text}\n\n---\n\n# Raw proposals\n\n${appendix}\n`);

  appendEvent(runDir, {
    ts: new Date().toISOString(),
    type: "brainstorm_result",
    stage: stageConfig.id,
    result: "pass",
    successes: successCount1,
  });
  return { result: "pass", usage: sumUsage(rounds, synthesis) };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/unit/brainstorm.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 6: Run the full suite**

Run: `bun test ./test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runners/brainstorm.ts src/events/events.ts test/unit/brainstorm.test.ts
git commit -m "feat: add brainstorm stage runner (independent + debate modes)"
```

---

### Task 7: `spec` runner

**Files:**
- Create: `src/runners/spec.ts`
- Modify: `src/events/events.ts` (add `SpecResultAiflowEvent`)
- Test: `test/unit/spec.test.ts`

**Interfaces:**
- Consumes: `runAgentTask`/`AgentTask`/`AgentResult` from `../adapters/opencode` (unchanged), `SpecStageConfig` (Task 2).
- Produces: `runSpecStage(stageConfig, stageState, profiles, cwd, runDir, nowFn, signal, deps?): Promise<StageOutcome>`, `SpecDeps { runAgentTask }`.

- [ ] **Step 1: Add the new event type**

In `src/events/events.ts`, add after `BrainstormResultAiflowEvent`:

```ts
export interface SpecResultAiflowEvent {
  ts: string;
  type: "spec_result";
  stage: string;
  result: "pass" | "fail";
}
```

Add `SpecResultAiflowEvent` to the `AiflowEvent` union.

- [ ] **Step 2: Write the failing tests**

Create `test/unit/spec.test.ts`:

```ts
import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpecStage } from "../../src/runners/spec";
import type { SpecStageConfig, ModelProfile } from "../../src/config/schema";
import type { StageState } from "../../src/engine/state";

const profiles: Record<string, ModelProfile> = { "main-dev": { channel: "opencode", provider: "opencode", model: "x" } };
const stageConfig: SpecStageConfig = { id: "spec", type: "spec", model: "main-dev", output: "spec.md" };
const pendingStageState: StageState = { id: "spec", status: "pending" };

test("agent succeeds and writes spec.md: result is pass", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-spec-test-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-spec-test-run-"));
  try {
    writeFileSync(join(cwd, "spec.md"), "# Spec\nwritten by the agent");
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 5, outTok: 2, costUsd: 0 } }));

    const outcome = await runSpecStage(stageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined, {
      runAgentTask,
    });

    expect(outcome.result).toBe("pass");
    expect(outcome.usage).toEqual({ inTok: 5, outTok: 2, costUsd: 0 });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("agent succeeds but spec.md was never written: result is fail", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-spec-test-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-spec-test-run-"));
  try {
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 5, outTok: 2, costUsd: 0 } }));

    const outcome = await runSpecStage(stageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined, {
      runAgentTask,
    });

    expect(outcome.result).toBe("fail");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("agent call itself fails: result is fail", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-spec-test-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-spec-test-run-"));
  try {
    writeFileSync(join(cwd, "spec.md"), "irrelevant — agent itself failed");
    const runAgentTask = mock(async () => ({ ok: false, transcriptPath: "unused", usage: { inTok: 5, outTok: 0, costUsd: 0 } }));

    const outcome = await runSpecStage(stageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined, {
      runAgentTask,
    });

    expect(outcome.result).toBe("fail");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/unit/spec.test.ts`
Expected: FAIL — `src/runners/spec.ts` does not exist yet.

- [ ] **Step 4: Implement `src/runners/spec.ts`**

```ts
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { runAgentTask as realRunAgentTask, type AgentTask, type AgentResult } from "../adapters/opencode";
import { appendEvent } from "../events/events";
import type { SpecStageConfig, ModelProfile } from "../config/schema";
import type { StageOutcome } from "../engine/engine";
import type { StageState } from "../engine/state";

export interface SpecDeps {
  runAgentTask: (task: AgentTask) => Promise<AgentResult>;
}

const defaultDeps: SpecDeps = { runAgentTask: realRunAgentTask };

function renderSpecPrompt(input: string): string {
  return [
    "Write a spec.md file for the following input, in an existing codebase.",
    "The spec must include clear, verifiable acceptance criteria for a later implementation stage.",
    "Write the file directly to the project root as spec.md. Do not ask for confirmation.",
    "",
    "## Input",
    input,
  ].join("\n");
}

export async function runSpecStage(
  stageConfig: SpecStageConfig,
  _stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  _nowFn: () => Date,
  _signal: AbortSignal | undefined,
  deps: SpecDeps = defaultDeps
): Promise<StageOutcome> {
  const artifactsDir = join(runDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const brainstormPath = join(artifactsDir, "brainstorm-report.md");
  const requirementPath = join(artifactsDir, "requirement.md");
  const input = existsSync(brainstormPath)
    ? readFileSync(brainstormPath, "utf-8")
    : existsSync(requirementPath)
      ? readFileSync(requirementPath, "utf-8")
      : "";

  const profile = profiles[stageConfig.model];
  const agentResult = await deps.runAgentTask({
    profile,
    prompt: renderSpecPrompt(input),
    cwd,
    timeoutMs: 10 * 60 * 1000,
    runDir,
    stage: stageConfig.id,
    story: "spec",
  });

  const outputExists = existsSync(join(cwd, stageConfig.output));
  const result: "pass" | "fail" = agentResult.ok && outputExists ? "pass" : "fail";
  appendEvent(runDir, { ts: new Date().toISOString(), type: "spec_result", stage: stageConfig.id, result });
  return { result, usage: agentResult.usage };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/unit/spec.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 6: Run the full suite**

Run: `bun test ./test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runners/spec.ts src/events/events.ts test/unit/spec.test.ts
git commit -m "feat: add spec stage runner"
```

---

### Task 8: `plan` runner

**Files:**
- Create: `src/runners/plan.ts`
- Modify: `src/events/events.ts` (add `PlanResultAiflowEvent`)
- Test: `test/unit/plan.test.ts`

**Interfaces:**
- Consumes: `callLlm` (Task 4), `PrdSchema` (Task 3), `PlanStageConfig` (Task 2).
- Produces: `runPlanStage(stageConfig, stageState, profiles, cwd, runDir, nowFn, signal, deps?): Promise<StageOutcome>`, `PlanDeps { callLlm }`.

- [ ] **Step 1: Add the new event type**

In `src/events/events.ts`, add after `SpecResultAiflowEvent`:

```ts
export interface PlanResultAiflowEvent {
  ts: string;
  type: "plan_result";
  stage: string;
  result: "pass" | "fail";
}
```

Add `PlanResultAiflowEvent` to the `AiflowEvent` union.

- [ ] **Step 2: Write the failing tests**

Create `test/unit/plan.test.ts`:

```ts
import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlanStage } from "../../src/runners/plan";
import type { PlanStageConfig, ModelProfile } from "../../src/config/schema";
import type { StageState } from "../../src/engine/state";

const profiles: Record<string, ModelProfile> = { "main-dev": { channel: "http", provider: "x", model: "y" } };
const stageConfig: PlanStageConfig = { id: "plan", type: "plan", model: "main-dev", input: "spec.md", output: "prd.json" };
const pendingStageState: StageState = { id: "plan", status: "pending" };

const validPrd = {
  branchName: "feat/x",
  stories: [{ id: "US-1", title: "t", acceptance: ["a"], priority: 1, passes: false, fixCount: 0 }],
};

test("valid JSON on the first attempt: pass, prd.json written", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-plan-test-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-plan-test-run-"));
  try {
    writeFileSync(join(cwd, "spec.md"), "# Spec");
    const callLlm = mock(async () => ({ text: JSON.stringify(validPrd), usage: { inTok: 1, outTok: 1, costUsd: 0 } }));

    const outcome = await runPlanStage(stageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined, { callLlm });

    expect(outcome.result).toBe("pass");
    expect(callLlm).toHaveBeenCalledTimes(1);
    const written = JSON.parse(readFileSync(join(cwd, "prd.json"), "utf-8"));
    expect(written).toEqual(validPrd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("invalid JSON on the first attempt, valid on the retry: pass", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-plan-test-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-plan-test-run-"));
  try {
    writeFileSync(join(cwd, "spec.md"), "# Spec");
    let calls = 0;
    const callLlm = mock(async () => {
      calls += 1;
      if (calls === 1) return { text: "not json at all", usage: { inTok: 1, outTok: 1, costUsd: 0 } };
      return { text: JSON.stringify(validPrd), usage: { inTok: 1, outTok: 1, costUsd: 0 } };
    });

    const outcome = await runPlanStage(stageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined, { callLlm });

    expect(outcome.result).toBe("pass");
    expect(calls).toBe(2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("invalid JSON on both attempts: fail, no prd.json written", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-plan-test-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-plan-test-run-"));
  try {
    writeFileSync(join(cwd, "spec.md"), "# Spec");
    const callLlm = mock(async () => ({ text: "still not json", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));

    const outcome = await runPlanStage(stageConfig, pendingStageState, profiles, cwd, runDir, () => new Date(), undefined, { callLlm });

    expect(outcome.result).toBe("fail");
    expect(callLlm).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/unit/plan.test.ts`
Expected: FAIL — `src/runners/plan.ts` does not exist yet.

- [ ] **Step 4: Implement `src/runners/plan.ts`**

```ts
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { callLlm } from "../llm/client";
import { PrdSchema } from "../prd";
import { appendEvent } from "../events/events";
import type { PlanStageConfig, ModelProfile } from "../config/schema";
import type { StageOutcome } from "../engine/engine";
import type { StageState } from "../engine/state";

export interface PlanDeps {
  callLlm: typeof callLlm;
}

const defaultDeps: PlanDeps = { callLlm };

function renderPlanPrompt(specText: string, priorError?: string): string {
  const lines = [
    "Convert the following spec into a JSON object matching exactly this shape:",
    '{"branchName": string, "stories": [{"id": string, "title": string, "acceptance": string[], "priority": number, "passes": false, "fixCount": 0}]}',
    "Respond with ONLY the JSON object.",
    "",
    "## Spec",
    specText,
  ];
  if (priorError) lines.push("", `Your previous response failed validation: ${priorError}`);
  return lines.join("\n");
}

export async function runPlanStage(
  stageConfig: PlanStageConfig,
  _stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  _nowFn: () => Date,
  _signal: AbortSignal | undefined,
  deps: PlanDeps = defaultDeps
): Promise<StageOutcome> {
  const specPath = join(cwd, stageConfig.input);
  const specText = existsSync(specPath) ? readFileSync(specPath, "utf-8") : "";
  const profile = profiles[stageConfig.model];

  const usage = { inTok: 0, outTok: 0, costUsd: 0 };
  let lastError: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await deps.callLlm({ profile, prompt: renderPlanPrompt(specText, lastError), jsonMode: true });
    usage.inTok += result.usage.inTok;
    usage.outTok += result.usage.outTok;
    usage.costUsd += result.usage.costUsd;

    try {
      const parsed = JSON.parse(result.text);
      const validated = PrdSchema.safeParse(parsed);
      if (validated.success) {
        writeFileSync(join(cwd, stageConfig.output), JSON.stringify(validated.data, null, 2));
        appendEvent(runDir, { ts: new Date().toISOString(), type: "plan_result", stage: stageConfig.id, result: "pass" });
        return { result: "pass", usage };
      }
      lastError = validated.error.message;
    } catch (err) {
      lastError = String(err);
    }
  }

  appendEvent(runDir, { ts: new Date().toISOString(), type: "plan_result", stage: stageConfig.id, result: "fail" });
  return { result: "fail", usage };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/unit/plan.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 6: Run the full suite**

Run: `bun test ./test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runners/plan.ts src/events/events.ts test/unit/plan.test.ts
git commit -m "feat: add plan stage runner"
```

---

### Task 9: `human_gate` runner

**Files:**
- Create: `src/runners/human-gate.ts`
- Modify: `src/events/events.ts` (add `HumanGateWaitingAiflowEvent`)
- Test: `test/unit/human-gate.test.ts`

**Interfaces:**
- Produces: `runHumanGateStage(stageConfig, stageState, profiles, cwd, runDir, nowFn, signal): Promise<StageOutcome>` (no injectable deps — no external calls).

- [ ] **Step 1: Add the new event type**

In `src/events/events.ts`, add after `PlanResultAiflowEvent`:

```ts
export interface HumanGateWaitingAiflowEvent {
  ts: string;
  type: "human_gate_waiting";
  stage: string;
  prompt: string;
}
```

Add `HumanGateWaitingAiflowEvent` to the `AiflowEvent` union.

(The `human_gate_rejected` event type is added in Task 12, alongside the `reject` command that emits it.)

- [ ] **Step 2: Write the failing tests**

Create `test/unit/human-gate.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHumanGateStage } from "../../src/runners/human-gate";
import type { HumanGateStageConfig, ModelProfile } from "../../src/config/schema";
import type { StageState } from "../../src/engine/state";

const profiles: Record<string, ModelProfile> = {};
const pendingStageState: StageState = { id: "confirm", status: "pending" };
const fixedNow = () => new Date("2026-07-06T12:00:00.000Z");

test("first call: enters waiting_human and sets entered_at", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-human-gate-test-"));
  const stageConfig: HumanGateStageConfig = { id: "confirm", type: "human_gate", prompt: "confirm please", on_timeout: "abort" };
  try {
    const outcome = await runHumanGateStage(stageConfig, pendingStageState, profiles, "/tmp/x", runDir, fixedNow, undefined);
    expect(outcome.result).toBe("waiting_human");
    expect(outcome.entered_at).toBe("2026-07-06T12:00:00.000Z");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("second call with no timeout configured: stays waiting_human, does not re-set entered_at", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-human-gate-test-"));
  const stageConfig: HumanGateStageConfig = { id: "confirm", type: "human_gate", prompt: "confirm please", on_timeout: "abort" };
  const waitingState: StageState = { id: "confirm", status: "waiting_human", entered_at: "2026-07-06T11:00:00.000Z" };
  try {
    const outcome = await runHumanGateStage(stageConfig, waitingState, profiles, "/tmp/x", runDir, fixedNow, undefined);
    expect(outcome.result).toBe("waiting_human");
    expect(outcome.entered_at).toBeUndefined();
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("second call, timeout configured but not yet elapsed: stays waiting_human", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-human-gate-test-"));
  const stageConfig: HumanGateStageConfig = { id: "confirm", type: "human_gate", prompt: "x", timeout: 3600, on_timeout: "abort" };
  const waitingState: StageState = { id: "confirm", status: "waiting_human", entered_at: "2026-07-06T11:59:00.000Z" };
  try {
    const outcome = await runHumanGateStage(stageConfig, waitingState, profiles, "/tmp/x", runDir, fixedNow, undefined);
    expect(outcome.result).toBe("waiting_human");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("timeout elapsed with on_timeout=abort: result is aborted with reason", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-human-gate-test-"));
  const stageConfig: HumanGateStageConfig = { id: "confirm", type: "human_gate", prompt: "x", timeout: 60, on_timeout: "abort" };
  const waitingState: StageState = { id: "confirm", status: "waiting_human", entered_at: "2026-07-06T11:00:00.000Z" };
  try {
    const outcome = await runHumanGateStage(stageConfig, waitingState, profiles, "/tmp/x", runDir, fixedNow, undefined);
    expect(outcome.result).toBe("aborted");
    expect(outcome.reason).toBe("human_gate_timeout");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("timeout elapsed with on_timeout=approve: result is pass", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-human-gate-test-"));
  const stageConfig: HumanGateStageConfig = { id: "confirm", type: "human_gate", prompt: "x", timeout: 60, on_timeout: "approve" };
  const waitingState: StageState = { id: "confirm", status: "waiting_human", entered_at: "2026-07-06T11:00:00.000Z" };
  try {
    const outcome = await runHumanGateStage(stageConfig, waitingState, profiles, "/tmp/x", runDir, fixedNow, undefined);
    expect(outcome.result).toBe("pass");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/unit/human-gate.test.ts`
Expected: FAIL — `src/runners/human-gate.ts` does not exist yet.

- [ ] **Step 4: Implement `src/runners/human-gate.ts`**

```ts
import { appendEvent } from "../events/events";
import type { HumanGateStageConfig, ModelProfile } from "../config/schema";
import type { StageOutcome } from "../engine/engine";
import type { StageState } from "../engine/state";

export async function runHumanGateStage(
  stageConfig: HumanGateStageConfig,
  stageState: StageState,
  _profiles: Record<string, ModelProfile>,
  _cwd: string,
  runDir: string,
  nowFn: () => Date,
  _signal: AbortSignal | undefined
): Promise<StageOutcome> {
  if (stageState.entered_at === undefined) {
    appendEvent(runDir, {
      ts: new Date().toISOString(),
      type: "human_gate_waiting",
      stage: stageConfig.id,
      prompt: stageConfig.prompt,
    });
    return { result: "waiting_human", entered_at: nowFn().toISOString() };
  }

  if (stageConfig.timeout === undefined) {
    return { result: "waiting_human" };
  }

  const elapsedMs = nowFn().getTime() - Date.parse(stageState.entered_at);
  if (elapsedMs < stageConfig.timeout * 1000) {
    return { result: "waiting_human" };
  }

  if (stageConfig.on_timeout === "approve") {
    return { result: "pass" };
  }
  return { result: "aborted", reason: "human_gate_timeout" };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/unit/human-gate.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 6: Run the full suite**

Run: `bun test ./test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runners/human-gate.ts src/events/events.ts test/unit/human-gate.test.ts
git commit -m "feat: add human_gate stage runner (async wait + timeout auto-resolution)"
```

---

### Task 10: Register real defaults in `engine.ts`; wire all four new runners into `commands/run.ts`; add `--requirement`/`--requirement-file`

`commands/run.ts` (Task 5) already builds an explicit `ralph_loop` registry entry for every fresh `aiflow run` call. But `commands/resume.ts` and the upcoming `commands/approve.ts` (Task 11) call `runPipelineOnce` with **no** `deps` override at all when invoked from the real CLI (no test injection) — they rely entirely on `engine.ts`'s own `defaultDeps.runners`, which after Task 5 contains only `{ ralph_loop: adaptRalphLoop }`. Left as-is, a real `aiflow resume` or `aiflow approve` on a pipeline with a `plan`/`spec`/`brainstorm`/`human_gate` stage would crash with "No runner registered for stage type ...". This task fixes that by registering real default adapters for all four new stage types directly in `engine.ts`, exactly mirroring how `adaptRalphLoop` already calls `realRunRalphLoop` with `undefined` deps and lets `ralph-loop.ts`'s own internal defaults supply the real `runAgentTask`/`runReviewGate` — each new runner module (Tasks 6-9) already has its own internal `defaultDeps` wired to the real `callLlm`/`callLlmFanOut`/`runAgentTask`, so the engine-level adapter just needs to call the runner with no deps override.

**Files:**
- Modify: `src/engine/engine.ts` (register real default adapters for `brainstorm`/`spec`/`plan`/`human_gate`)
- Modify: `src/commands/run.ts`
- Modify: `src/cli.ts`
- Test: `test/unit/run-multi-stage.test.ts` (new)

**Interfaces:**
- Produces: `runCommand(cwd, pipelineName, overrides?, requirementInput?): Promise<EngineState>` — 4th parameter is new and optional (backward compatible with all existing 2-arg and 3-arg call sites in `test/integration/ralph-loop-mocked.test.ts`).
- Consumes: `runBrainstormStage`, `runSpecStage`, `runPlanStage`, `runHumanGateStage` (Tasks 6-9); `callLlm`, `callLlmFanOut` (Task 4).

- [ ] **Step 1: Register real default adapters in `engine.ts`**

In `src/engine/engine.ts`, add these imports alongside the existing `runRalphLoop` import:

```ts
import { runBrainstormStage } from "../runners/brainstorm";
import { runSpecStage } from "../runners/spec";
import { runPlanStage } from "../runners/plan";
import { runHumanGateStage } from "../runners/human-gate";
import type { BrainstormStageConfig, SpecStageConfig, PlanStageConfig, HumanGateStageConfig } from "../config/schema";
```

Add these four adapter functions right after `adaptRalphLoop`:

```ts
async function adaptBrainstorm(
  stageConfig: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  signal?: AbortSignal
): Promise<StageOutcome> {
  return runBrainstormStage(stageConfig as BrainstormStageConfig, stageState, profiles, cwd, runDir, nowFn, signal);
}

async function adaptSpec(
  stageConfig: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  signal?: AbortSignal
): Promise<StageOutcome> {
  return runSpecStage(stageConfig as SpecStageConfig, stageState, profiles, cwd, runDir, nowFn, signal);
}

async function adaptPlan(
  stageConfig: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  signal?: AbortSignal
): Promise<StageOutcome> {
  return runPlanStage(stageConfig as PlanStageConfig, stageState, profiles, cwd, runDir, nowFn, signal);
}

async function adaptHumanGate(
  stageConfig: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  signal?: AbortSignal
): Promise<StageOutcome> {
  return runHumanGateStage(stageConfig as HumanGateStageConfig, stageState, profiles, cwd, runDir, nowFn, signal);
}
```

Update `defaultDeps` to register all five:

```ts
const defaultDeps: EngineDeps = {
  runners: {
    ralph_loop: adaptRalphLoop,
    brainstorm: adaptBrainstorm,
    spec: adaptSpec,
    plan: adaptPlan,
    human_gate: adaptHumanGate,
  },
  nowFn: () => new Date(),
  writeRunReport: (runDir, state, now, startedAt) => {
    const events = readEvents(runDir);
    writeRunReport(runDir, state, events, { now, startedAt });
  },
};
```

- [ ] **Step 2: Run the full suite to confirm this addition alone doesn't break anything**

Run: `bun test ./test`
Expected: PASS — `commands/run.ts` still explicitly overrides `ralph_loop` per-call, and nothing yet exercises the new defaults directly (that happens via `test/unit/run-multi-stage.test.ts` below and is fully confirmed by Task 13's integration test, where `runApprove` relies on exactly these defaults for the `plan` stage).

- [ ] **Step 3: Write the failing test for `commands/run.ts`'s remaining wiring**

Create `test/unit/run-multi-stage.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { runCommand } from "../../src/commands/run";

async function setupProject(pipelineYaml: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-run-multi-"));
  mkdirSync(join(dir, ".aiflow", "config", "pipelines"), { recursive: true });
  writeFileSync(
    join(dir, ".aiflow", "config", "models.yaml"),
    `profiles:\n  main-dev:\n    channel: opencode\n    provider: opencode\n    model: x\n  reviewer:\n    channel: http\n    provider: y\n    model: z\n`
  );
  writeFileSync(join(dir, ".aiflow", "config", "pipelines", "test-pipeline.yaml"), pipelineYaml);
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} config user.email "test@example.com"`;
  await $`git -C ${dir} config user.name "Test"`;
  await $`git -C ${dir} add -A`;
  await $`git -C ${dir} commit -q -m "initial"`;
  return dir;
}

test("runCommand throws before creating a run dir when a spec stage needs --requirement and none was given", async () => {
  const dir = await setupProject(`name: test-pipeline\nstages:\n  - id: spec\n    type: spec\n    model: main-dev\n`);
  try {
    await expect(runCommand(dir, "test-pipeline")).rejects.toThrow(/requires --requirement/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommand accepts --requirement text and writes it to artifacts/requirement.md and state.requirement", async () => {
  const dir = await setupProject(`name: test-pipeline\nstages:\n  - id: spec\n    type: spec\n    model: main-dev\n`);
  try {
    const state = await runCommand(
      dir,
      "test-pipeline",
      { runAgentTask: async () => ({ ok: false, transcriptPath: "unused", usage: { inTok: 0, outTok: 0, costUsd: 0 } }) },
      { requirement: "Add offline cache" }
    );
    expect(state.requirement).toBe("Add offline cache");
    expect(state.stages[0].status).toBe("failed"); // agent mocked to fail — proves the requirement was accepted and the stage actually ran
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommand accepts --requirement-file and reads its content", async () => {
  const dir = await setupProject(`name: test-pipeline\nstages:\n  - id: spec\n    type: spec\n    model: main-dev\n`);
  const reqFile = join(dir, "requirement.md");
  writeFileSync(reqFile, "Requirement from a file");
  try {
    const state = await runCommand(
      dir,
      "test-pipeline",
      { runAgentTask: async () => ({ ok: false, transcriptPath: "unused", usage: { inTok: 0, outTok: 0, costUsd: 0 } }) },
      { requirementFile: reqFile }
    );
    expect(state.requirement).toBe("Requirement from a file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommand does not require --requirement when the pipeline has no brainstorm/spec stage", async () => {
  const dir = await setupProject(
    `name: test-pipeline\nstages:\n  - id: plan\n    type: plan\n    model: main-dev\n`
  );
  try {
    const state = await runCommand(dir, "test-pipeline", {
      callLlm: async () => ({ text: "not json", usage: { inTok: 0, outTok: 0, costUsd: 0 } }),
    });
    expect(state.stages[0].status).toBe("failed"); // ran (and failed on bad JSON) rather than being blocked by the requirement check
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `bun test test/unit/run-multi-stage.test.ts`
Expected: FAIL — `runCommand` doesn't accept a 4th argument yet, and only knows about `ralph_loop`.

- [ ] **Step 5: Rewrite `src/commands/run.ts`**

```ts
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadModelsConfig, loadPipelineConfig } from "../config/loader";
import { createRunId, runPipelineOnce, type EngineDeps, type StageOutcome } from "../engine/engine";
import { runRalphLoop } from "../runners/ralph-loop";
import { runBrainstormStage } from "../runners/brainstorm";
import { runSpecStage } from "../runners/spec";
import { runPlanStage } from "../runners/plan";
import { runHumanGateStage } from "../runners/human-gate";
import { runAgentTask as realRunAgentTask, type AgentTask, type AgentResult } from "../adapters/opencode";
import { runReviewGate as realRunReviewGate } from "../gate/review-gate";
import { runChecks } from "../gate/check-runner";
import {
  callReviewer as realCallReviewer,
  callLlm as realCallLlm,
  callLlmFanOut as realCallLlmFanOut,
} from "../llm/client";
import { revParseHead, stageAll, diffCached, commit } from "../git";
import type { EngineState } from "../engine/state";
import type {
  ModelProfile,
  RalphLoopStageConfig,
  BrainstormStageConfig,
  SpecStageConfig,
  PlanStageConfig,
} from "../config/schema";

export interface RunCommandOverrides {
  runAgentTask?: (task: AgentTask) => Promise<AgentResult>;
  callReviewer?: (profile: ModelProfile, prompt: string) => Promise<unknown>;
  callLlm?: typeof realCallLlm;
  callLlmFanOut?: typeof realCallLlmFanOut;
}

export interface RequirementInput {
  requirement?: string;
  requirementFile?: string;
}

export async function runCommand(
  cwd: string,
  pipelineName: string,
  overrides: RunCommandOverrides = {},
  requirementInput: RequirementInput = {}
): Promise<EngineState> {
  const modelsConfig = loadModelsConfig(join(cwd, ".aiflow", "config", "models.yaml"));
  const pipelineConfig = loadPipelineConfig(join(cwd, ".aiflow", "config", "pipelines", `${pipelineName}.yaml`));

  const needsRequirement = pipelineConfig.stages.some((s) => s.type === "brainstorm" || s.type === "spec");
  const requirementText = requirementInput.requirementFile
    ? readFileSync(requirementInput.requirementFile, "utf-8")
    : requirementInput.requirement;
  if (needsRequirement && !requirementText) {
    throw new Error(
      `Pipeline "${pipelineName}" requires --requirement or --requirement-file (it contains a brainstorm or spec stage)`
    );
  }

  const runId = createRunId();
  const runDir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(runDir, { recursive: true });

  if (requirementText) {
    const artifactsDir = join(runDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "requirement.md"), requirementText);
  }

  const runAgentTask = overrides.runAgentTask ?? realRunAgentTask;
  const reviewerCallFn = overrides.callReviewer ?? realCallReviewer;
  const callLlmFn = overrides.callLlm ?? realCallLlm;
  const callLlmFanOutFn = overrides.callLlmFanOut ?? realCallLlmFanOut;

  const engineDeps: EngineDeps = {
    runners: {
      ralph_loop: async (stageConfig, _stageState, profiles, runCwd, stageRunDir, _nowFn, signal): Promise<StageOutcome> => {
        const specPath = join(runCwd, "spec.md");
        const specExcerpt = existsSync(specPath) ? readFileSync(specPath, "utf-8").slice(0, 4000) : "";
        const summary = await runRalphLoop(
          stageConfig as RalphLoopStageConfig,
          profiles,
          runCwd,
          stageRunDir,
          specExcerpt,
          {
            runAgentTask,
            runReviewGate: (config, reviewerProfile, gateCwd, diff, acceptance) =>
              realRunReviewGate(config, reviewerProfile, gateCwd, diff, acceptance, {
                runChecks,
                callReviewer: reviewerCallFn,
              }),
            git: { revParseHead, stageAll, diffCached, commit },
          },
          signal
        );
        return { result: summary.result, reason: summary.reason, usage: summary.usage };
      },
      brainstorm: (stageConfig, stageState, profiles, runCwd, stageRunDir, nowFn, signal) =>
        runBrainstormStage(stageConfig as BrainstormStageConfig, stageState, profiles, runCwd, stageRunDir, nowFn, signal, {
          callLlm: callLlmFn,
          callLlmFanOut: callLlmFanOutFn,
        }),
      spec: (stageConfig, stageState, profiles, runCwd, stageRunDir, nowFn, signal) =>
        runSpecStage(stageConfig as SpecStageConfig, stageState, profiles, runCwd, stageRunDir, nowFn, signal, { runAgentTask }),
      plan: (stageConfig, stageState, profiles, runCwd, stageRunDir, nowFn, signal) =>
        runPlanStage(stageConfig as PlanStageConfig, stageState, profiles, runCwd, stageRunDir, nowFn, signal, { callLlm: callLlmFn }),
      human_gate: (stageConfig, stageState, profiles, runCwd, stageRunDir, nowFn, signal) =>
        runHumanGateStage(stageConfig as import("../config/schema").HumanGateStageConfig, stageState, profiles, runCwd, stageRunDir, nowFn, signal),
    },
  };

  return runPipelineOnce(pipelineConfig, modelsConfig.profiles, cwd, runDir, engineDeps, undefined, { requirement: requirementText });
}
```

- [ ] **Step 6: Add `--requirement`/`--requirement-file` to the CLI**

In `src/cli.ts`, replace the `run` command block with:

```ts
program
  .command("run")
  .description("Run a pipeline")
  .requiredOption("--pipeline <name>", "pipeline name to run")
  .option("--once", "run exactly one iteration", false)
  .option("--requirement <text>", "requirement text for pipelines with a brainstorm/spec stage")
  .option("--requirement-file <path>", "path to a file containing the requirement text")
  .action(async (opts: { pipeline: string; once: boolean; requirement?: string; requirementFile?: string }) => {
    if (opts.requirement && opts.requirementFile) {
      console.error("--requirement and --requirement-file are mutually exclusive");
      process.exitCode = 1;
      return;
    }
    const { runCommand } = await import("./commands/run");
    const { summarizePipelineOutcome } = await import("./engine/engine");
    try {
      const state = await runCommand(process.cwd(), opts.pipeline, {}, {
        requirement: opts.requirement,
        requirementFile: opts.requirementFile,
      });
      const outcome = summarizePipelineOutcome(state);
      console.log(outcome.line);
      process.exitCode = outcome.exitCode;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test test/unit/run-multi-stage.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 8: Run the full suite**

Run: `bun test ./test`
Expected: PASS — including `test/integration/ralph-loop-mocked.test.ts` and `test/integration/fixture-sample-project.test.ts` (both call `runCommand` with only 2-3 args, unaffected by the new optional 4th parameter).

- [ ] **Step 9: Commit**

```bash
git add src/engine/engine.ts src/commands/run.ts src/cli.ts test/unit/run-multi-stage.test.ts
git commit -m "feat: wire brainstorm/spec/plan/human_gate runners into run command; add --requirement flags"
```

---

### Task 11: `aiflow approve` command

**Files:**
- Create: `src/commands/approve.ts`
- Modify: `src/cli.ts`
- Test: `test/unit/approve.test.ts`

**Interfaces:**
- Produces: `runApprove(cwd, opts: { runId?, stage? }, deps?: EngineDeps): Promise<ApproveResult>`.
- Consumes: `runPipelineOnce`, `EngineDeps` (Task 5).

- [ ] **Step 1: Write the failing tests**

Create `test/unit/approve.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApprove } from "../../src/commands/approve";

function setupRun(stages: Array<{ id: string; status: string; entered_at?: string }>): { cwd: string; runId: string } {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-approve-test-"));
  const runId = "20260706_000000_abc123";
  const runDir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(cwd, ".aiflow", "config", "pipelines"), { recursive: true });
  writeFileSync(
    join(cwd, ".aiflow", "config", "models.yaml"),
    `profiles:\n  main-dev:\n    channel: opencode\n    provider: opencode\n    model: x\n`
  );
  writeFileSync(
    join(cwd, ".aiflow", "config", "pipelines", "test-pipeline.yaml"),
    `name: test-pipeline\nstages:\n${stages.map((s) => `  - id: ${s.id}\n    type: human_gate\n    prompt: "p"\n`).join("")}`
  );
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      run_id: runId,
      pipeline: "test-pipeline",
      stages,
      cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    })
  );
  return { cwd, runId };
}

test("approves the sole waiting_human stage and continues the pipeline", async () => {
  const { cwd, runId } = setupRun([{ id: "confirm", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" }]);
  try {
    const result = await runApprove(cwd, { runId }, { runners: { human_gate: async () => ({ result: "pass" }) } });
    expect(result.status).toBe("resumed");
    expect(result.state!.stages[0].status).toBe("done");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("errors when no stage is waiting", async () => {
  const { cwd, runId } = setupRun([{ id: "confirm", status: "done" }]);
  try {
    const result = await runApprove(cwd, { runId });
    expect(result.status).toBe("no_waiting_stage");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("errors when --stage names a stage that isn't waiting", async () => {
  const { cwd, runId } = setupRun([{ id: "confirm", status: "done" }]);
  try {
    const result = await runApprove(cwd, { runId, stage: "confirm" });
    expect(result.status).toBe("stage_not_waiting");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("errors with no_runs when .aiflow/runs is missing entirely", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-approve-empty-"));
  try {
    const result = await runApprove(cwd, {});
    expect(result.status).toBe("no_runs");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/approve.test.ts`
Expected: FAIL — `src/commands/approve.ts` does not exist yet.

- [ ] **Step 3: Implement `src/commands/approve.ts`**

```ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadModelsConfig, loadPipelineConfig } from "../config/loader";
import { runPipelineOnce, type EngineDeps } from "../engine/engine";
import { writeStateAtomic, type EngineState } from "../engine/state";

export interface ApproveResult {
  status: "resumed" | "no_runs" | "missing_run_dir" | "no_waiting_stage" | "ambiguous_stage" | "stage_not_waiting";
  state?: EngineState;
  message?: string;
  runId?: string;
}

function pickLatestRun(cwd: string): string | undefined {
  const root = join(cwd, ".aiflow", "runs");
  if (!existsSync(root)) return undefined;
  const entries = readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory());
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs);
  return entries[0];
}

export async function runApprove(
  cwd: string,
  opts: { runId?: string; stage?: string },
  deps?: EngineDeps
): Promise<ApproveResult> {
  const runId = opts.runId ?? pickLatestRun(cwd);
  if (!runId) return { status: "no_runs", message: `No .aiflow/runs found in ${cwd}` };
  const runDir = join(cwd, ".aiflow", "runs", runId);
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) {
    return { status: "missing_run_dir", runId, message: `Run directory ${runDir} exists but has no state.json` };
  }

  const state = JSON.parse(readFileSync(statePath, "utf-8")) as EngineState;
  const waitingStages = state.stages.filter((s) => s.status === "waiting_human");

  let targetIndex: number;
  if (opts.stage) {
    targetIndex = state.stages.findIndex((s) => s.id === opts.stage);
    if (targetIndex === -1 || state.stages[targetIndex].status !== "waiting_human") {
      return { status: "stage_not_waiting", runId, message: `Stage "${opts.stage}" is not awaiting approval` };
    }
  } else {
    if (waitingStages.length === 0) {
      return { status: "no_waiting_stage", runId, message: "No stage is awaiting approval" };
    }
    if (waitingStages.length > 1) {
      return { status: "ambiguous_stage", runId, message: "Multiple stages awaiting approval; use --stage to disambiguate" };
    }
    targetIndex = state.stages.findIndex((s) => s.id === waitingStages[0].id);
  }

  state.stages[targetIndex] = { id: state.stages[targetIndex].id, status: "done" };
  writeStateAtomic(runDir, state);

  const modelsConfig = loadModelsConfig(join(cwd, ".aiflow", "config", "models.yaml"));
  const pipelineConfig = loadPipelineConfig(join(cwd, ".aiflow", "config", "pipelines", `${state.pipeline}.yaml`));

  const resultState = await runPipelineOnce(pipelineConfig, modelsConfig.profiles, cwd, runDir, deps, undefined, { resume: true });

  return { status: "resumed", state: resultState, runId };
}
```

- [ ] **Step 4: Add the `approve` command to the CLI**

In `src/cli.ts`, add after the `resume` command block:

```ts
program
  .command("approve")
  .description("Approve a stage that is waiting for human confirmation (human_gate)")
  .option("--run-id <id>", "target a specific run (defaults to latest)")
  .option("--stage <id>", "target a specific stage (defaults to the sole waiting stage)")
  .action(async (opts: { runId?: string; stage?: string }) => {
    const { runApprove } = await import("./commands/approve");
    const result = await runApprove(process.cwd(), opts);
    if (result.status !== "resumed") {
      console.error(result.message ?? result.status);
      process.exitCode = 1;
      return;
    }
    const { summarizePipelineOutcome } = await import("./engine/engine");
    const outcome = summarizePipelineOutcome(result.state!);
    console.log(`Run ${result.runId}: ${outcome.line}`);
    process.exitCode = outcome.exitCode;
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/unit/approve.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 6: Run the full suite**

Run: `bun test ./test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/commands/approve.ts src/cli.ts test/unit/approve.test.ts
git commit -m "feat: add aiflow approve command for human_gate stages"
```

---

### Task 12: `aiflow reject` command

**Files:**
- Create: `src/commands/reject.ts`
- Modify: `src/cli.ts`
- Modify: `src/events/events.ts` (add `HumanGateRejectedAiflowEvent`)
- Test: `test/unit/reject.test.ts`

**Interfaces:**
- Produces: `runReject(cwd, opts: { runId?, stage?, reason? }): RejectResult` (synchronous — no I/O beyond sync fs calls, no `runPipelineOnce` call).

- [ ] **Step 1: Add the new event type**

In `src/events/events.ts`, add after `HumanGateWaitingAiflowEvent`:

```ts
export interface HumanGateRejectedAiflowEvent {
  ts: string;
  type: "human_gate_rejected";
  stage: string;
  reason?: string;
}
```

Add `HumanGateRejectedAiflowEvent` to the `AiflowEvent` union.

- [ ] **Step 2: Write the failing tests**

Create `test/unit/reject.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReject } from "../../src/commands/reject";

function setupRun(stages: Array<{ id: string; status: string; entered_at?: string }>): { cwd: string; runId: string; runDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-reject-test-"));
  const runId = "20260706_000000_abc123";
  const runDir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      run_id: runId,
      pipeline: "test-pipeline",
      stages,
      cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    })
  );
  return { cwd, runId, runDir };
}

test("rejects the sole waiting_human stage, marks it aborted, records the reason", () => {
  const { cwd, runId, runDir } = setupRun([{ id: "confirm", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" }]);
  try {
    const result = runReject(cwd, { runId, reason: "spec is wrong" });
    expect(result.status).toBe("rejected");
    expect(result.state!.stages[0]).toEqual({ id: "confirm", status: "aborted", reason: "human_gate_rejected" });
    const events = readFileSync(join(runDir, "events.jsonl"), "utf-8");
    expect(events).toContain("human_gate_rejected");
    expect(events).toContain("spec is wrong");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("errors when no stage is waiting", () => {
  const { cwd, runId } = setupRun([{ id: "confirm", status: "done" }]);
  try {
    const result = runReject(cwd, { runId });
    expect(result.status).toBe("no_waiting_stage");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("errors with no_runs when .aiflow/runs is missing entirely", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-reject-empty-"));
  try {
    const result = runReject(cwd, {});
    expect(result.status).toBe("no_runs");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/unit/reject.test.ts`
Expected: FAIL — `src/commands/reject.ts` does not exist yet.

- [ ] **Step 4: Implement `src/commands/reject.ts`**

```ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeStateAtomic, type EngineState } from "../engine/state";
import { appendEvent } from "../events/events";

export interface RejectResult {
  status: "rejected" | "no_runs" | "missing_run_dir" | "no_waiting_stage" | "ambiguous_stage" | "stage_not_waiting";
  state?: EngineState;
  message?: string;
  runId?: string;
}

function pickLatestRun(cwd: string): string | undefined {
  const root = join(cwd, ".aiflow", "runs");
  if (!existsSync(root)) return undefined;
  const entries = readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory());
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs);
  return entries[0];
}

export function runReject(cwd: string, opts: { runId?: string; stage?: string; reason?: string }): RejectResult {
  const runId = opts.runId ?? pickLatestRun(cwd);
  if (!runId) return { status: "no_runs", message: `No .aiflow/runs found in ${cwd}` };
  const runDir = join(cwd, ".aiflow", "runs", runId);
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) {
    return { status: "missing_run_dir", runId, message: `Run directory ${runDir} exists but has no state.json` };
  }

  const state = JSON.parse(readFileSync(statePath, "utf-8")) as EngineState;
  const waitingStages = state.stages.filter((s) => s.status === "waiting_human");

  let targetIndex: number;
  if (opts.stage) {
    targetIndex = state.stages.findIndex((s) => s.id === opts.stage);
    if (targetIndex === -1 || state.stages[targetIndex].status !== "waiting_human") {
      return { status: "stage_not_waiting", runId, message: `Stage "${opts.stage}" is not awaiting approval` };
    }
  } else {
    if (waitingStages.length === 0) {
      return { status: "no_waiting_stage", runId, message: "No stage is awaiting approval" };
    }
    if (waitingStages.length > 1) {
      return { status: "ambiguous_stage", runId, message: "Multiple stages awaiting approval; use --stage to disambiguate" };
    }
    targetIndex = state.stages.findIndex((s) => s.id === waitingStages[0].id);
  }

  const stageId = state.stages[targetIndex].id;
  state.stages[targetIndex] = { id: stageId, status: "aborted", reason: "human_gate_rejected" };
  writeStateAtomic(runDir, state);
  appendEvent(runDir, { ts: new Date().toISOString(), type: "human_gate_rejected", stage: stageId, reason: opts.reason });

  return { status: "rejected", state, runId };
}
```

- [ ] **Step 5: Add the `reject` command to the CLI**

In `src/cli.ts`, add after the `approve` command block:

```ts
program
  .command("reject")
  .description("Reject a stage that is waiting for human confirmation (human_gate); aborts the pipeline")
  .option("--run-id <id>", "target a specific run (defaults to latest)")
  .option("--stage <id>", "target a specific stage (defaults to the sole waiting stage)")
  .option("--reason <text>", "reason recorded in events.jsonl")
  .action(async (opts: { runId?: string; stage?: string; reason?: string }) => {
    const { runReject } = await import("./commands/reject");
    const result = runReject(process.cwd(), opts);
    if (result.status !== "rejected") {
      console.error(result.message ?? result.status);
      process.exitCode = 1;
      return;
    }
    const rejectedStage = result.state!.stages.find((s) => s.status === "aborted");
    console.log(`Run ${result.runId}: stage ${rejectedStage?.id} rejected`);
    process.exitCode = 1;
  });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/unit/reject.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 7: Run the full suite**

Run: `bun test ./test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/commands/reject.ts src/cli.ts src/events/events.ts test/unit/reject.test.ts
git commit -m "feat: add aiflow reject command for human_gate stages"
```

---

### Task 13: Full multi-stage integration test (mocked end to end)

**Files:**
- Create: `test/integration/multi-stage-mocked.test.ts`

**Interfaces:**
- Consumes: `runCommand` (Task 10), `runApprove` (Task 11), `runReject` (Task 12).

- [ ] **Step 1: Write the test**

Create `test/integration/multi-stage-mocked.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { runCommand } from "../../src/commands/run";
import { runApprove } from "../../src/commands/approve";
import { runReject } from "../../src/commands/reject";
import { runPlanStage } from "../../src/runners/plan";
import type { PlanStageConfig } from "../../src/config/schema";

const FULL_PIPELINE = `name: full-auto
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
    prompt: "Please review spec.md"
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
`;

async function setupProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-multi-stage-"));
  mkdirSync(join(dir, ".aiflow", "config", "pipelines"), { recursive: true });
  writeFileSync(
    join(dir, ".aiflow", "config", "models.yaml"),
    `profiles:\n  main-dev:\n    channel: opencode\n    provider: opencode\n    model: x\n  reviewer:\n    channel: http\n    provider: y\n    model: z\n`
  );
  writeFileSync(join(dir, ".aiflow", "config", "pipelines", "full-auto.yaml"), FULL_PIPELINE);
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} config user.email "test@example.com"`;
  await $`git -C ${dir} config user.name "Test"`;
  await $`git -C ${dir} add -A`;
  await $`git -C ${dir} commit -q -m "initial"`;
  return dir;
}

const fakeCallLlm = async (opts: { prompt: string }) => ({
  text: opts.prompt.includes("JSON object")
    ? JSON.stringify({ branchName: "feat/x", stories: [{ id: "US-1", title: "t", acceptance: ["a"], priority: 1, passes: false, fixCount: 0 }] })
    : "a synthesized brainstorm result",
  usage: { inTok: 1, outTok: 1, costUsd: 0 },
});
const fakeCallLlmFanOut = async (profiles: unknown[]) =>
  profiles.map((profile) => ({ profile, ok: true, result: { text: "an idea", usage: { inTok: 1, outTok: 1, costUsd: 0 } } }));
const fakeRunAgentTaskWritingSpec = async (task: { cwd: string }) => {
  writeFileSync(join(task.cwd, "spec.md"), "# Spec\nAcceptance: implement US-1");
  return { ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } };
};

test("full pipeline pauses at human_gate, then approve resumes and runs the remaining stages", async () => {
  const dir = await setupProject();
  try {
    const state = await runCommand(
      dir,
      "full-auto",
      { runAgentTask: fakeRunAgentTaskWritingSpec, callLlm: fakeCallLlm, callLlmFanOut: fakeCallLlmFanOut },
      { requirement: "Add offline cache" }
    );
    expect(state.stages.map((s) => s.status)).toEqual(["done", "done", "waiting_human", "pending", "pending"]);
    expect(existsSync(join(dir, "spec.md"))).toBe(true);

    // approve triggers a resume, which re-enters runPipelineOnce with NO deps of its own in
    // the real CLI path — so it falls back entirely to engine.ts's defaultDeps.runners (Task 10),
    // which for `plan` means the REAL callLlm. Override both `plan` and `ralph_loop` here so this
    // stays a hermetic mocked test — only `human_gate`/`spec`/`brainstorm` are skipped (already done).
    const runId = state.run_id;
    const approveResult = await runApprove(dir, { runId }, {
      runners: {
        plan: (stageConfig, stageState, profiles, cwd2, runDir2, nowFn, signal) =>
          runPlanStage(stageConfig as PlanStageConfig, stageState, profiles, cwd2, runDir2, nowFn, signal, { callLlm: fakeCallLlm }),
        ralph_loop: async () => ({ result: "pass" }),
      },
    });
    expect(approveResult.status).toBe("resumed");
    expect(approveResult.state!.stages.map((s) => s.status)).toEqual(["done", "done", "done", "done", "done"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("full pipeline pauses at human_gate, then reject aborts without running the remaining stages", async () => {
  const dir = await setupProject();
  try {
    const state = await runCommand(
      dir,
      "full-auto",
      { runAgentTask: fakeRunAgentTaskWritingSpec, callLlm: fakeCallLlm, callLlmFanOut: fakeCallLlmFanOut },
      { requirement: "Add offline cache" }
    );
    expect(state.stages[2].status).toBe("waiting_human");

    const rejectResult = runReject(dir, { runId: state.run_id, reason: "not ready" });
    expect(rejectResult.status).toBe("rejected");
    expect(rejectResult.state!.stages[2].status).toBe("aborted");
    expect(rejectResult.state!.stages[3].status).toBe("pending"); // plan never ran
    expect(rejectResult.state!.stages[4].status).toBe("pending"); // develop never ran
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run without --requirement fails before creating any run directory", async () => {
  const dir = await setupProject();
  try {
    await expect(runCommand(dir, "full-auto")).rejects.toThrow(/requires --requirement/);
    expect(existsSync(join(dir, ".aiflow", "runs"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails first for the right reason, then implement-and-fix cycle**

Run: `bun test test/integration/multi-stage-mocked.test.ts`

Since Tasks 6-12 are already implemented by this point in the plan, this test should mostly exercise wiring rather than missing functionality. If it fails, read the failure carefully — it is most likely one of:
- A stage status ordering mismatch (double check the pipeline YAML's stage order against the expected array in the test)
- `approve`'s `deps` not reaching the `ralph_loop` runner (confirm `runApprove` forwards its 3rd `deps` argument into `runPipelineOnce`'s 5th positional argument)

Fix any such issue in the relevant task's file (not by weakening the test).

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test test/integration/multi-stage-mocked.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 4: Run the full suite one final time**

Run: `bun test ./test`
Expected: PASS — every test file in the repository green.

- [ ] **Step 5: Commit**

```bash
git add test/integration/multi-stage-mocked.test.ts
git commit -m "test: add full mocked multi-stage integration test (brainstorm through ralph_loop)"
```

---

## Self-Review Notes

- **Spec coverage:** every design-doc section maps to a task — §3.1 schema → Task 2; §3.2 registry/`StageOutcome` → Task 5; §3.3 file-based data flow → Tasks 5-9 (each runner reads its own files); §3.4 LLM client → Task 4; §3.5-3.8 the four runners → Tasks 6-9; §3.9 CLI → Tasks 10-12; §4 error handling → covered inline in each runner's tests; §5 test plan → one task per listed test file, plus Task 13 for the integration test; §6 edge cases → the `models.length >= 2` schema constraint (Task 2), the `stage_not_waiting`/`ambiguous_stage` approve/reject branches (Tasks 11-12), and the pre-flight `--requirement` check running before `mkdirSync(runDir)` (Task 10) all directly encode edge-case rows from the design doc's table.
- **Corrections made from the design doc during planning** (flagging transparently, as required): (1) `runPipelineOnce`'s `specExcerpt` parameter is removed entirely rather than "moved into `executeStage`" as the design doc's §3.3 prose literally said — the actual `StageRunnerFn` signature in §3.2 never included a context/specExcerpt parameter, so the only coherent implementation has each runner (in practice, just the `ralph_loop` adapter) read `spec.md` itself; this preserves the design's real intent (fresh read per stage execution, no one-time pre-read) without contradicting §3.2. (2) The design doc's §6 edge-case table claims `callReviewer` currently strips markdown code fences before `JSON.parse` — the actual current code (`src/llm/client.ts`) does no such thing; Task 4's `callLlm` matches the real current behavior (plain `JSON.parse`, no fence-stripping) rather than inventing new behavior never asked for. (3) `runPipelineOnce`'s dependency merge changed from a flat `{...defaultDeps, ...deps}` spread to a nested `runners: {...defaultDeps.runners, ...(deps.runners ?? {})}` merge (Task 5) — a flat spread would have silently dropped every default runner except whichever ones a caller explicitly overrides, which would have broken `commands/run.ts`'s pattern of only overriding `ralph_loop`/`spec` while relying on engine defaults for the others.
- **Type consistency:** `StageOutcome`/`StageRunnerFn` (Task 5) are the exact same shape consumed by every runner in Tasks 6-9 and referenced identically in Task 10's wiring. `BrainstormStageConfig`/`SpecStageConfig`/`PlanStageConfig`/`HumanGateStageConfig` (Task 2) are the exact types each runner's first parameter uses (Tasks 6-9) and the exact types Task 10 casts to when registering each runner. `PrdSchema` (Task 3) is the exact schema Task 8's `plan` runner validates against. `EngineDeps`'s `deps?: EngineDeps` parameter added to `runResume` in a prior session is reused unchanged by `runApprove` (Task 11).
- **Placeholder scan:** no `TBD`/`TODO` strings; every code block is complete, runnable code, not a description of code.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-06-multi-stage-pipeline-runners-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
