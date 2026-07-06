# Ralph Loop 真循环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `ralph_loop` stages from "one story attempt per stage call" into a real loop that keeps working through pending stories until all are done/suspended, `max_iterations` is hit, or `stall_limit` consecutive iterations make no progress — matching 《AIFlow 技术设计文档 v1.0》§6.6.

**Architecture:** A new exported `runRalphLoop` wrapper in `src/runners/ralph-loop.ts` repeatedly calls the existing, untouched `runRalphLoopOnce` (one story, one attempt) until a termination condition fires. `engine.ts` calls `runRalphLoop` instead of `runRalphLoopOnce`; its state-mapping goes from two branches (`pass`/other) to three (`pass`/`aborted`/`suspended`). A new optional `reason` field on `StageState` and a new `ralph_loop_result` event give operators visibility into *why* a stage stopped.

**Tech Stack:** TypeScript + Bun, `bun:test`, zod.

## Global Constraints

- `runRalphLoopOnce`'s existing signature, behavior, and tests in `test/unit/ralph-loop.test.ts` must not change.
- No new `StageStatus` enum values — `suspended` covers all "stopped, not fully done" cases; the new `reason` field disambiguates.
- Defaults: `max_iterations: 10`, `stall_limit: 3` (from design doc §5.2 / tech design doc §5.2).
- Every new/changed file must leave `bunx tsc --noEmit` clean and `bun test` fully green before that task's commit.

---

### Task 1: Config schema — `max_iterations` / `stall_limit`

**Files:**
- Modify: `src/config/schema.ts:33-40`
- Modify: `test/unit/config.test.ts:56-88`

**Interfaces:**
- Produces: `RalphLoopStageConfig` gains `max_iterations: number` (default 10) and `stall_limit: number` (default 3), both positive integers.

- [ ] **Step 1: Write the failing test**

Replace the `"loadPipelineConfig parses a valid ralph-only.yaml"` test in `test/unit/config.test.ts` (lines 56-88) with:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/config.test.ts`
Expected: FAIL — `stage.max_iterations` is `undefined`, not `10` (property doesn't exist on the schema yet).

- [ ] **Step 3: Implement the schema change**

In `src/config/schema.ts`, replace lines 33-40:

```ts
export const RalphLoopStageSchema = z.object({
  id: z.string(),
  type: z.literal("ralph_loop"),
  model: z.string(),
  per_story_fix_limit: z.number().int().positive().default(3),
  max_iterations: z.number().int().positive().default(10),
  stall_limit: z.number().int().positive().default(3),
  gate: ReviewGateConfigSchema,
});
export type RalphLoopStageConfig = z.infer<typeof RalphLoopStageSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/config.test.ts`
Expected: PASS (all tests in the file, including the 3 above)

- [ ] **Step 5: Typecheck and commit**

Run: `bunx tsc --noEmit`
Expected: no errors

```bash
git add src/config/schema.ts test/unit/config.test.ts
git commit -m "feat: add max_iterations/stall_limit to ralph_loop stage config"
```

---

### Task 2: `StageState.reason` field

**Files:**
- Modify: `src/engine/state.ts`
- Modify: `test/unit/state.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RalphLoopStopReason` type (`"max_iterations" | "stall" | "stories_suspended"`), `StageState.reason?: RalphLoopStopReason`. Later tasks (`ralph-loop.ts`, `events.ts`, `engine.ts`) import `RalphLoopStopReason` from `./state` (or `../engine/state`).

- [ ] **Step 1: Write the failing test**

Add to `test/unit/state.test.ts` (after the existing two tests):

```ts
test("writeStateAtomic then readState round-trips a stage with a reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-state-test-"));
  try {
    const state: EngineState = {
      run_id: "r1",
      pipeline: "ralph-only",
      stages: [{ id: "develop", status: "suspended", reason: "stall" }],
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
Expected: FAIL with a TypeScript error — `reason` does not exist on type `StageState`.

- [ ] **Step 3: Implement the type change**

In `src/engine/state.ts`, replace line 4-10:

```ts
export type StageStatus = "pending" | "running" | "done" | "failed" | "aborted" | "suspended";

export type RalphLoopStopReason = "max_iterations" | "stall" | "stories_suspended";

export interface StageState {
  id: string;
  status: StageStatus;
  iteration?: number;
  reason?: RalphLoopStopReason;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/state.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Typecheck and commit**

Run: `bunx tsc --noEmit`
Expected: no errors

```bash
git add src/engine/state.ts test/unit/state.test.ts
git commit -m "feat: add optional reason field to StageState for ralph_loop stop diagnostics"
```

---

### Task 3: `ralph_loop_result` event type

**Files:**
- Modify: `src/events/events.ts`
- Modify: `test/unit/events.test.ts`

**Interfaces:**
- Consumes: `RalphLoopStopReason` from `../engine/state` (Task 2).
- Produces: `RalphLoopResultAiflowEvent`, added to the `AiflowEvent` union. Later consumed by `ralph-loop.ts` (emits it) and `monitor.ts` (renders it).

- [ ] **Step 1: Write the failing test**

Add to `test/unit/events.test.ts` (after the existing test):

```ts
test("appendEvent then readEvents round-trips a ralph_loop_result event", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-events-test-"));
  try {
    const e: AiflowEvent = {
      ts: "2026-07-06T00:00:00.000Z",
      type: "ralph_loop_result",
      stage: "develop",
      result: "suspended",
      reason: "stall",
      iterations: 3,
      stories_done: 1,
      stories_suspended: 0,
      stories_pending: 2,
    };
    appendEvent(dir, e);
    const events = readEvents(dir);
    expect(events).toEqual([e]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/events.test.ts`
Expected: FAIL with a TypeScript error — object literal has a `type` value `"ralph_loop_result"` not assignable to `AiflowEvent`.

- [ ] **Step 3: Implement the event type**

In `src/events/events.ts`, add after the `StoryResultAiflowEvent` interface (after line 37) and update the union:

```ts
import type { RalphLoopStopReason } from "../engine/state";

export interface RalphLoopResultAiflowEvent {
  ts: string;
  type: "ralph_loop_result";
  stage: string;
  result: "pass" | "suspended" | "aborted";
  reason?: RalphLoopStopReason;
  iterations: number;
  stories_done: number;
  stories_suspended: number;
  stories_pending: number;
}

export type AiflowEvent =
  | OpencodeToolUseAiflowEvent
  | OpencodeStepFinishAiflowEvent
  | GateResultAiflowEvent
  | StoryResultAiflowEvent
  | RalphLoopResultAiflowEvent;
```

(Add the `import` line at the top of the file, alongside the existing `node:fs`/`node:path` imports.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/events.test.ts`
Expected: PASS (both tests)

- [ ] **Step 5: Typecheck and commit**

Run: `bunx tsc --noEmit`
Expected: no errors (note: `src/commands/monitor.ts`'s `describeEvent` switch does NOT yet handle the new case — this is addressed in Task 6, and TypeScript won't error today since there's no `noImplicitReturns`/exhaustiveness check configured; confirm this with the tsc run and proceed)

```bash
git add src/events/events.ts test/unit/events.test.ts
git commit -m "feat: add ralph_loop_result event type"
```

---

### Task 4: `runRalphLoop` — the core loop

**Files:**
- Modify: `src/runners/ralph-loop.ts`
- Modify: `test/unit/ralph-loop.test.ts`

**Interfaces:**
- Consumes: `RalphLoopStopReason` from `../engine/state` (Task 2); `RalphLoopResultAiflowEvent` via `appendEvent` (Task 3); existing `runRalphLoopOnce`, `RalphLoopDeps`, `defaultDeps` (unchanged).
- Produces: `RalphLoopSummary` (`{ result: "pass" | "suspended" | "aborted"; reason?: RalphLoopStopReason; iterations: number; usage: { inTok: number; outTok: number; costUsd: number } }`) and `runRalphLoop(stageConfig, profiles, cwd, runDir, specExcerpt, deps?, signal?): Promise<RalphLoopSummary>`. Task 5 (`engine.ts`) and Task 8 (`run.ts`) call this.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/ralph-loop.test.ts`, after the existing imports add:

```ts
import { readEvents } from "../../src/events/events";
import { runRalphLoop } from "../../src/runners/ralph-loop";
```

Add a second-story fixture helper (after `samplePrd`):

```ts
function twoStoryPrd(): Prd {
  return {
    branchName: "feat/two-stories",
    stories: [
      { id: "US-1", title: "First", acceptance: ["a"], priority: 1, passes: false, fixCount: 0 },
      { id: "US-2", title: "Second", acceptance: ["b"], priority: 2, passes: false, fixCount: 0 },
    ],
  };
}

function makeFixtureDirsWith(prd: Prd) {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-ralph-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-ralph-run-"));
  writePrd(join(cwd, "prd.json"), prd);
  return { cwd, runDir };
}

function loopStageConfig(overrides: Partial<RalphLoopStageConfig> = {}): RalphLoopStageConfig {
  return {
    id: "develop",
    type: "ralph_loop",
    model: "main-dev",
    per_story_fix_limit: 3,
    max_iterations: 10,
    stall_limit: 3,
    gate: { checks: ["true"], ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] } },
    ...overrides,
  };
}

function alwaysOkAgent(usage = { inTok: 10, outTok: 5, costUsd: 0.001 }) {
  return mock(async () => ({ ok: true, transcriptPath: "unused", usage }));
}

function fixedGit() {
  return {
    revParseHead: mock(async () => "abc123"),
    stageAll: mock(async () => {}),
    diffCached: mock(async () => "diff content"),
    commit: mock(async () => {}),
  };
}
```

Now the test cases:

```ts
test("runRalphLoop: all stories pass in sequence returns pass with no reason", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(twoStoryPrd());
  try {
    const runAgentTask = alwaysOkAgent();
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();

    const summary = await runRalphLoop(loopStageConfig(), profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
    });

    expect(summary.result).toBe("pass");
    expect(summary.reason).toBeUndefined();
    expect(summary.iterations).toBe(2);
    expect(summary.usage).toEqual({ inTok: 20, outTok: 10, costUsd: 0.002 });

    const prd = readPrd(join(cwd, "prd.json"));
    expect(prd.stories[0].passes).toBe(true);
    expect(prd.stories[1].passes).toBe(true);

    const events = readEvents(runDir);
    const loopEvent = events.find((e) => e.type === "ralph_loop_result");
    expect(loopEvent).toMatchObject({
      result: "pass",
      iterations: 2,
      stories_done: 2,
      stories_suspended: 0,
      stories_pending: 0,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: usage accumulates precisely across iterations with differing per-call values", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(twoStoryPrd());
  try {
    let call = 0;
    const runAgentTask = mock(async () => {
      call += 1;
      const usages = [
        { inTok: 5, outTok: 2, costUsd: 0.01 },
        { inTok: 7, outTok: 3, costUsd: 0.02 },
      ];
      return { ok: true, transcriptPath: "unused", usage: usages[call - 1] };
    });
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();

    const summary = await runRalphLoop(loopStageConfig(), profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
    });

    expect(summary.iterations).toBe(2);
    expect(summary.usage).toEqual({ inTok: 12, outTok: 5, costUsd: 0.03 });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: a story that exceeds per_story_fix_limit is skipped, the other story still completes, overall result is suspended/stories_suspended", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(twoStoryPrd());
  try {
    let call = 0;
    const runReviewGate = mock(async () => {
      call += 1;
      if (call <= 3) return { checks: "fail" as const, aiReview: "skipped" as const, blockers: 0, checkOutput: "still broken" };
      return { checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 };
    });
    const runAgentTask = alwaysOkAgent();
    const git = fixedGit();

    const summary = await runRalphLoop(
      loopStageConfig({ per_story_fix_limit: 2, stall_limit: 10, max_iterations: 10 }),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate, git }
    );

    expect(summary.result).toBe("suspended");
    expect(summary.reason).toBe("stories_suspended");
    expect(summary.iterations).toBe(4);

    const prd = readPrd(join(cwd, "prd.json"));
    const us1 = prd.stories.find((s) => s.id === "US-1")!;
    const us2 = prd.stories.find((s) => s.id === "US-2")!;
    expect(us1.suspended).toBe(true);
    expect(us1.passes).toBe(false);
    expect(us2.passes).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: stall_limit stops the loop before per_story_fix_limit when configured tighter", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(samplePrd());
  try {
    const runAgentTask = alwaysOkAgent();
    const runReviewGate = mock(async () => ({ checks: "fail" as const, aiReview: "skipped" as const, blockers: 0, checkOutput: "nope" }));
    const git = fixedGit();

    const summary = await runRalphLoop(
      loopStageConfig({ per_story_fix_limit: 100, stall_limit: 2, max_iterations: 100 }),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate, git }
    );

    expect(summary.result).toBe("suspended");
    expect(summary.reason).toBe("stall");
    expect(summary.iterations).toBe(2);

    const prd = readPrd(join(cwd, "prd.json"));
    expect(prd.stories[0].fixCount).toBe(2);
    expect(prd.stories[0].suspended).toBeFalsy();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: max_iterations stops the loop when neither stall_limit nor per_story_fix_limit has fired", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(samplePrd());
  try {
    const runAgentTask = alwaysOkAgent();
    const runReviewGate = mock(async () => ({ checks: "fail" as const, aiReview: "skipped" as const, blockers: 0, checkOutput: "nope" }));
    const git = fixedGit();

    const summary = await runRalphLoop(
      loopStageConfig({ per_story_fix_limit: 100, stall_limit: 100, max_iterations: 3 }),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate, git }
    );

    expect(summary.result).toBe("suspended");
    expect(summary.reason).toBe("max_iterations");
    expect(summary.iterations).toBe(3);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: an empty prd (no stories) returns pass immediately without calling the agent", async () => {
  const { cwd, runDir } = makeFixtureDirsWith({ branchName: "empty", stories: [] });
  try {
    const runAgentTask = alwaysOkAgent();
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();

    const summary = await runRalphLoop(loopStageConfig(), profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
    });

    expect(summary.result).toBe("pass");
    expect(summary.iterations).toBe(0);
    expect(summary.usage).toEqual({ inTok: 0, outTok: 0, costUsd: 0 });
    expect(runAgentTask).not.toHaveBeenCalled();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: an already-aborted signal returns aborted immediately without calling the agent", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(samplePrd());
  try {
    const controller = new AbortController();
    controller.abort();
    const runAgentTask = alwaysOkAgent();
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();

    const summary = await runRalphLoop(
      loopStageConfig(),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate, git },
      controller.signal
    );

    expect(summary.result).toBe("aborted");
    expect(summary.iterations).toBe(0);
    expect(runAgentTask).not.toHaveBeenCalled();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: a signal aborted mid-run stops before the next iteration's agent call", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(samplePrd());
  try {
    const controller = new AbortController();
    let calls = 0;
    const runAgentTask = mock(async () => {
      calls += 1;
      if (calls === 2) controller.abort();
      return { ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } };
    });
    const runReviewGate = mock(async () => ({ checks: "fail" as const, aiReview: "skipped" as const, blockers: 0, checkOutput: "nope" }));
    const git = fixedGit();

    const summary = await runRalphLoop(
      loopStageConfig({ per_story_fix_limit: 100, stall_limit: 100, max_iterations: 100 }),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate, git },
      controller.signal
    );

    expect(summary.result).toBe("aborted");
    expect(summary.iterations).toBe(2);
    expect(calls).toBe(2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

Finally, add the resumability test (this exercises §3.6 of the design doc — calling `runRalphLoop` a second time against the same `cwd`/`prd.json`, which is exactly what `aiflow resume --force` does at the engine level):

```ts
test("runRalphLoop: a second call against the same cwd resumes — already-done/in-progress work isn't repeated", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(twoStoryPrd());
  try {
    const git = fixedGit();
    const runAgentTask = alwaysOkAgent();

    // First "run": US-1 fails its only allotted attempt, hits max_iterations=1 before US-2 is ever touched.
    const failingGate = mock(async () => ({ checks: "fail" as const, aiReview: "skipped" as const, blockers: 0, checkOutput: "nope" }));
    const first = await runRalphLoop(
      loopStageConfig({ max_iterations: 1, stall_limit: 100, per_story_fix_limit: 100 }),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate: failingGate, git }
    );
    expect(first.result).toBe("suspended");
    expect(first.reason).toBe("max_iterations");
    const afterFirst = readPrd(join(cwd, "prd.json"));
    expect(afterFirst.stories[0].passes).toBe(false);
    expect(afterFirst.stories[0].fixCount).toBe(1);
    expect(afterFirst.stories[1].fixCount).toBe(0);

    // "Resume": a second runRalphLoop call against the same cwd, now with a gate that passes.
    const passingGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const second = await runRalphLoop(
      loopStageConfig({ max_iterations: 10, stall_limit: 3, per_story_fix_limit: 3 }),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate: passingGate, git }
    );
    expect(second.result).toBe("pass");
    expect(second.iterations).toBe(2); // US-1 (still pending from before) + US-2, not US-1 redone from scratch

    const afterSecond = readPrd(join(cwd, "prd.json"));
    expect(afterSecond.stories[0].passes).toBe(true);
    expect(afterSecond.stories[1].passes).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

Also add `type Prd` to the source file's `../prd` import (it does not currently import the `Prd` type — see Step 3 below). Note `test/unit/ralph-loop.test.ts` already imports `type Prd` from `../../src/prd`, so no import change is needed on the test side.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/ralph-loop.test.ts`
Expected: FAIL — `runRalphLoop is not a function` / import error.

- [ ] **Step 3: Implement `runRalphLoop`**

In `src/runners/ralph-loop.ts`:
1. Change the import line for `../prd` (line 3) to include `type Prd`:

```ts
import { readPrd, writePrd, selectNextStory, markStoryPassed, recordStoryFailure, type Story, type Prd } from "../prd";
```

2. Add `type RalphLoopStopReason` to the schema-adjacent import — add a new import line right after the existing imports (after line 8):

```ts
import type { RalphLoopStopReason } from "../engine/state";
```

3. At the end of the file (after `runRalphLoopOnce`'s closing brace), add:

```ts
export interface RalphLoopSummary {
  result: "pass" | "suspended" | "aborted";
  reason?: RalphLoopStopReason;
  iterations: number;
  usage: { inTok: number; outTok: number; costUsd: number };
}

function countStories(prd: Prd): { done: number; suspended: number; pending: number } {
  let done = 0;
  let suspended = 0;
  let pending = 0;
  for (const s of prd.stories) {
    if (s.passes) done += 1;
    else if (s.suspended) suspended += 1;
    else pending += 1;
  }
  return { done, suspended, pending };
}

function emitLoopResult(
  runDir: string,
  stageId: string,
  prd: Prd,
  outcome: { result: RalphLoopSummary["result"]; reason?: RalphLoopStopReason; iterations: number }
): void {
  const counts = countStories(prd);
  appendEvent(runDir, {
    ts: new Date().toISOString(),
    type: "ralph_loop_result",
    stage: stageId,
    result: outcome.result,
    reason: outcome.reason,
    iterations: outcome.iterations,
    stories_done: counts.done,
    stories_suspended: counts.suspended,
    stories_pending: counts.pending,
  });
}

function finalizeOutcome(
  prd: Prd,
  iterations: number,
  usage: RalphLoopSummary["usage"]
): RalphLoopSummary {
  const anySuspended = prd.stories.some((s) => s.suspended === true);
  return {
    result: anySuspended ? "suspended" : "pass",
    reason: anySuspended ? "stories_suspended" : undefined,
    iterations,
    usage,
  };
}

/**
 * Repeatedly runs runRalphLoopOnce until every story is done/suspended,
 * max_iterations is reached, or stall_limit consecutive iterations make
 * no progress (technical design doc §6.6).
 */
export async function runRalphLoop(
  stageConfig: RalphLoopStageConfig,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  specExcerpt: string,
  deps: RalphLoopDeps = defaultDeps,
  signal?: AbortSignal
): Promise<RalphLoopSummary> {
  const usage = { inTok: 0, outTok: 0, costUsd: 0 };
  let iterations = 0;
  let stallCount = 0;
  const prdPath = join(cwd, "prd.json");

  while (true) {
    const prd = readPrd(prdPath);

    if (signal?.aborted) {
      const outcome: RalphLoopSummary = { result: "aborted", iterations, usage };
      emitLoopResult(runDir, stageConfig.id, prd, outcome);
      return outcome;
    }

    if (selectNextStory(prd) === null) {
      const outcome = finalizeOutcome(prd, iterations, usage);
      emitLoopResult(runDir, stageConfig.id, prd, outcome);
      return outcome;
    }

    iterations += 1;
    const suspendedBefore = countStories(prd).suspended;

    const onceResult = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, specExcerpt, deps);
    usage.inTok += onceResult.usage.inTok;
    usage.outTok += onceResult.usage.outTok;
    usage.costUsd += onceResult.usage.costUsd;

    const prdAfter = readPrd(prdPath);

    if (selectNextStory(prdAfter) === null) {
      const outcome = finalizeOutcome(prdAfter, iterations, usage);
      emitLoopResult(runDir, stageConfig.id, prdAfter, outcome);
      return outcome;
    }

    if (iterations >= stageConfig.max_iterations) {
      const outcome: RalphLoopSummary = { result: "suspended", reason: "max_iterations", iterations, usage };
      emitLoopResult(runDir, stageConfig.id, prdAfter, outcome);
      return outcome;
    }

    const suspendedAfter = countStories(prdAfter).suspended;
    const progressed = onceResult.result === "pass" || suspendedAfter > suspendedBefore;
    stallCount = progressed ? 0 : stallCount + 1;

    if (stallCount >= stageConfig.stall_limit) {
      const outcome: RalphLoopSummary = { result: "suspended", reason: "stall", iterations, usage };
      emitLoopResult(runDir, stageConfig.id, prdAfter, outcome);
      return outcome;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/ralph-loop.test.ts`
Expected: PASS (all tests, old and new — 12 total)

- [ ] **Step 5: Typecheck and commit**

Run: `bunx tsc --noEmit`
Expected: no errors

```bash
git add src/runners/ralph-loop.ts test/unit/ralph-loop.test.ts
git commit -m "feat: add runRalphLoop — multi-story/multi-iteration loop wrapper"
```

---

### Task 5: `engine.ts` — wire in `runRalphLoop`

**Files:**
- Modify: `src/engine/engine.ts`
- Modify: `test/unit/engine.test.ts` (full rewrite of the file — see complete content below)

**Interfaces:**
- Consumes: `runRalphLoop`, `RalphLoopSummary` from `../runners/ralph-loop` (Task 4).
- Produces: `EngineDeps.runRalphLoop` (renamed from `runRalphLoopOnce`), consumed by Task 8 (`run.ts`).

- [ ] **Step 1: Replace the test file**

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
    const runRalphLoop = mock(async () => ({ result: "pass" as const, iterations: 1, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, "spec", {
      runRalphLoop,
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
    const runRalphLoop = mock(async () => ({
      result: "suspended" as const,
      reason: "stories_suspended" as const,
      iterations: 1,
      usage: { inTok: 0, outTok: 0, costUsd: 0 },
    }));
    await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, "spec", {
      runRalphLoop,
    });
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
    const runRalphLoop = mock(async () => ({
      result: "suspended" as const,
      reason: "max_iterations" as const,
      iterations: 10,
      usage: { inTok: 0, outTok: 0, costUsd: 0 },
    }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, "spec", {
      runRalphLoop,
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
    const runRalphLoop = mock(async () => ({
      result: "suspended" as const,
      reason: "stall" as const,
      iterations: 4,
      usage: { inTok: 0, outTok: 0, costUsd: 0 },
    }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, "spec", {
      runRalphLoop,
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
    const runRalphLoop = mock(async () => ({
      result: "pass" as const,
      iterations: 3,
      usage: { inTok: 123, outTok: 45, costUsd: 0.0067 },
    }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, "spec", {
      runRalphLoop,
    });
    expect(state.cost).toEqual({ input_tokens: 123, output_tokens: 45, est_usd: 0.0067 });
    const persisted = readState(runDir);
    expect(persisted.cost).toEqual({ input_tokens: 123, output_tokens: 45, est_usd: 0.0067 });
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
    const runRalphLoop = mock(async () => ({ result: "pass" as const, iterations: 0, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
    const state = await runPipelineOnce(
      pipeline,
      profiles,
      "/tmp/does-not-matter",
      runDir,
      "spec",
      { runRalphLoop },
      controller.signal
    );
    expect(state.stages[0].status).toBe("aborted");
    expect(runRalphLoop).not.toHaveBeenCalled();
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
      const runRalphLoop = mock(async () => ({ result: "pass" as const, iterations: 1, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
      const state = await runPipelineOnce(
        pipeline,
        profiles,
        "/tmp/does-not-matter",
        runDir,
        "spec",
        { runRalphLoop, nowFn: () => new Date("2026-07-05T20:00:00.000Z") },
        undefined,
        { resume: true, now: new Date("2026-07-05T20:00:00.000Z") },
      );
      expect(state.stages[0].status).toBe("done");
      expect(runRalphLoop).toHaveBeenCalledTimes(1);
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
      const runRalphLoop = mock(async () => ({ result: "pass" as const, iterations: 1, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
      const state = await runPipelineOnce(
        pipeline,
        profiles,
        "/tmp/does-not-matter",
        runDir,
        "spec",
        { runRalphLoop, nowFn: () => new Date() },
        undefined,
        { resume: true },
      );
      expect(state.stages[0].status).toBe("failed");
      expect(runRalphLoop).not.toHaveBeenCalled();
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
      const runRalphLoop = mock(async () => ({ result: "pass" as const, iterations: 1, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
      const state = await runPipelineOnce(
        pipeline,
        profiles,
        "/tmp/does-not-matter",
        runDir,
        "spec",
        { runRalphLoop, nowFn: () => new Date() },
        undefined,
        { resume: true, force: true },
      );
      expect(state.stages[0].status).toBe("done");
      expect(runRalphLoop).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test("resume surfaces a clear error when state.json does not exist", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-resume-empty-"));
    try {
      const runRalphLoop = mock(async () => ({ result: "pass" as const, iterations: 1, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
      await expect(
        runPipelineOnce(
          pipeline,
          profiles,
          "/tmp/does-not-matter",
          runDir,
          "spec",
          { runRalphLoop },
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

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/engine.test.ts`
Expected: FAIL — `engine.ts`'s `EngineDeps` doesn't have a `runRalphLoop` field yet (TypeScript error) / mocks aren't wired to anything.

- [ ] **Step 3: Update `engine.ts`**

Replace `src/engine/engine.ts` lines 1-67 with:

```ts
import { writeStateAtomic, readState, type EngineState, type StageState, type StageStatus } from "./state";
import { readEvents } from "../events/events";
import { runRalphLoop as realRunRalphLoop, type RalphLoopSummary } from "../runners/ralph-loop";
import { writeRunReport } from "../commands/report";
import type { PipelineConfig, ModelProfile, StageConfig } from "../config/schema";

export interface EngineDeps {
  runRalphLoop: (
    stageConfig: StageConfig,
    profiles: Record<string, ModelProfile>,
    cwd: string,
    runDir: string,
    specExcerpt: string,
    signal?: AbortSignal
  ) => Promise<RalphLoopSummary>;
  nowFn?: () => Date;
  writeRunReport?: (runDir: string, state: EngineState, now: Date, startedAt: Date) => void;
}

const defaultDeps: EngineDeps = {
  runRalphLoop: (stageConfig, profiles, cwd, runDir, specExcerpt, signal) =>
    realRunRalphLoop(stageConfig, profiles, cwd, runDir, specExcerpt, undefined, signal),
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

async function executeStage(
  stage: StageConfig,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  specExcerpt: string,
  deps: EngineDeps,
  signal: AbortSignal | undefined,
): Promise<StageExecutionResult> {
  if (signal?.aborted) return { state: { id: stage.id, status: "aborted" } };

  const result = await deps.runRalphLoop(stage, profiles, cwd, runDir, specExcerpt, signal);
  const status: StageStatus =
    result.result === "pass" ? "done" : result.result === "aborted" ? "aborted" : "suspended";
  return { state: { id: stage.id, status, reason: result.reason }, usage: result.usage };
}
```

Leave the rest of the file (`RunPipelineOptions`, `runPipelineOnce`, `summarizePipelineOutcome`, `createRunId`) unchanged — they already call `executeStage(...)` and aggregate `execResult.usage`/`execResult.state` generically, with no reference to the old field name.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/engine.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Typecheck and commit**

Run: `bunx tsc --noEmit`
Expected: errors remain in `src/commands/run.ts` (still references the old `runRalphLoopOnce` field name/import) — this is expected and fixed in Task 8. Confirm the *only* remaining errors are in `src/commands/run.ts`.

```bash
git add src/engine/engine.ts test/unit/engine.test.ts
git commit -m "feat: engine.ts calls runRalphLoop, three-way status mapping incl. aborted, threads reason"
```

---

### Task 6: `run-report.md` — reason column

**Files:**
- Modify: `src/commands/report.ts:49-55`
- Modify: `test/unit/report.test.ts`

**Interfaces:**
- Consumes: `StageState.reason` (Task 2).

- [ ] **Step 1: Write the failing test**

Add to `test/unit/report.test.ts` (after the existing `"includes a stages section..."` test):

```ts
test("includes the stage's reason when present, and an empty cell when absent", () => {
  const stateWithReason: EngineState = {
    ...STATE,
    stages: [{ id: "develop", status: "suspended", reason: "stall" }],
  };
  const out = renderRunReport(stateWithReason, EVENTS, {
    now: new Date("2026-07-05T19:21:30.000Z"),
    startedAt: new Date("2026-07-05T19:20:00.000Z"),
  });
  expect(out).toContain("| develop | suspended | stall |");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/report.test.ts`
Expected: FAIL — current row format is `| develop | suspended |` with no third column.

- [ ] **Step 3: Implement the report change**

In `src/commands/report.ts`, replace lines 49-55:

```ts
  lines.push("## Stages");
  lines.push("");
  lines.push("| id | status | reason |");
  lines.push("| --- | --- | --- |");
  for (const s of state.stages) {
    lines.push(`| ${s.id} | ${s.status} | ${s.reason ?? ""} |`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/report.test.ts`
Expected: PASS (all tests, including the pre-existing `"| develop |"` / `"done |"` assertions — the new empty third cell doesn't break substring matches)

- [ ] **Step 5: Typecheck and commit**

Run: `bunx tsc --noEmit`
Expected: no new errors introduced by this file (run.ts errors from Task 5 still pending, unrelated to this task)

```bash
git add src/commands/report.ts test/unit/report.test.ts
git commit -m "feat: render stage stop reason in run-report.md"
```

---

### Task 7: `monitor.ts` — render `ralph_loop_result` events

**Files:**
- Modify: `src/commands/monitor.ts:147-165`
- Modify: `test/unit/monitor.test.ts`

**Interfaces:**
- Consumes: `RalphLoopResultAiflowEvent` (Task 3).

- [ ] **Step 1: Write the failing test**

Add to `test/unit/monitor.test.ts`, inside the `describe("renderStatus", ...)` block:

```ts
  test("renders a ralph_loop_result event with its reason and story counts", () => {
    const events: AiflowEvent[] = [
      {
        ts: "2026-07-05T19:20:08.000Z",
        type: "ralph_loop_result",
        stage: "develop",
        result: "suspended",
        reason: "stall",
        iterations: 3,
        stories_done: 0,
        stories_suspended: 0,
        stories_pending: 1,
      },
    ];
    const out = renderStatus(SAMPLE_STATE, events, { tail: 8, now: new Date("2026-07-05T19:21:00.000Z"), color: false });
    expect(out).toContain("stall");
    expect(out).toContain("iterations=3");
    expect(out).toContain("done=0 suspended=0 pending=1");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/monitor.test.ts`
Expected: FAIL — TypeScript error (`describeEvent`'s switch has no case for `"ralph_loop_result"`, so the object literal isn't a valid `AiflowEvent` per the exhaustive union — actually it IS a valid `AiflowEvent` per its type definition; the failure here is the rendered output not containing the expected substrings because `describeEvent` returns `undefined` for the unhandled case, which is then interpolated into the joined output as the string `"undefined"`)

- [ ] **Step 3: Implement the monitor change**

In `src/commands/monitor.ts`, replace the `describeEvent` function (lines 147-165):

```ts
function describeEvent(evt: AiflowEvent, color: boolean, now: Date): string {
  switch (evt.type) {
    case "opencode_tool_use":
      return `${formatTime(evt.ts, now)}  ${c("blue", color, "tool")}     ${evt.stage}/${evt.story}  ${evt.tool} — ${evt.summary}`;
    case "opencode_step_finish":
      return `${formatTime(evt.ts, now)}  ${c("blue", color, "step")}     ${evt.stage}  in=${evt.in_tok} out=${evt.out_tok} $${evt.cost_usd.toFixed(4)}`;
    case "gate_result": {
      const checksTag = evt.checks === "pass" ? c("green", color, "pass") : c("red", color, "fail");
      const reviewTag =
        evt.ai_review === "pass" ? c("green", color, "pass") : evt.ai_review === "skipped" ? c("gray", color, "skip") : c("red", color, "fail");
      return `${formatTime(evt.ts, now)}  ${c("blue", color, "gate")}     ${evt.stage}/${evt.story}  checks=${checksTag} review=${reviewTag} blockers=${evt.blockers}`;
    }
    case "story_result": {
      const tag =
        evt.result === "pass" ? c("green", color, "PASS") : evt.result === "fail" ? c("red", color, "FAIL") : c("yellow", color, "SUSPEND");
      return `${formatTime(evt.ts, now)}  ${c("blue", color, "story")}    ${evt.story}  ${tag}`;
    }
    case "ralph_loop_result": {
      const tag =
        evt.result === "pass" ? c("green", color, "PASS") : evt.result === "aborted" ? c("gray", color, "ABORT") : c("yellow", color, "SUSPEND");
      const reasonSuffix = evt.reason ? ` ${evt.reason}` : "";
      return `${formatTime(evt.ts, now)}  ${c("blue", color, "loop")}     ${evt.stage}  ${tag}${reasonSuffix}  iterations=${evt.iterations} done=${evt.stories_done} suspended=${evt.stories_suspended} pending=${evt.stories_pending}`;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/monitor.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Typecheck and commit**

Run: `bunx tsc --noEmit`
Expected: no new errors introduced by this file

```bash
git add src/commands/monitor.ts test/unit/monitor.test.ts
git commit -m "feat: render ralph_loop_result events in aiflow status/watch"
```

---

### Task 8: Wire the real CLI path — `run.ts` + fix the now-stale integration test assertions

**Files:**
- Modify: `src/commands/run.ts`
- Modify: `test/integration/ralph-loop-mocked.test.ts`

**Interfaces:**
- Consumes: `runRalphLoop` from `../runners/ralph-loop` (Task 4).

This is the task that makes `aiflow run` actually use the new loop instead of a single iteration. It also fixes two integration tests whose fixture (`fixtures/sample-project`, a single-story PRD, default `per_story_fix_limit: 3`, and now-defaulted `max_iterations: 10`/`stall_limit: 3`) now runs 3 iterations before giving up (hitting `stall_limit`) instead of 1 (previously mapped straight to `"failed"`, which is no longer a reachable `ralph_loop` outcome).

- [ ] **Step 1: Update `run.ts`**

Replace `src/commands/run.ts` in full:

```ts
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadModelsConfig, loadPipelineConfig } from "../config/loader";
import { createRunId, runPipelineOnce } from "../engine/engine";
import { runRalphLoop } from "../runners/ralph-loop";
import { runAgentTask as realRunAgentTask, type AgentTask, type AgentResult } from "../adapters/opencode";
import { runReviewGate as realRunReviewGate } from "../gate/review-gate";
import { runChecks } from "../gate/check-runner";
import { callReviewer as realCallReviewer } from "../llm/client";
import { revParseHead, stageAll, diffCached, commit } from "../git";
import type { EngineState } from "../engine/state";
import type { ModelProfile, StageConfig } from "../config/schema";

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
    runRalphLoop: (
      stageConfig: Extract<StageConfig, { type: "ralph_loop" }>,
      profiles: Record<string, ModelProfile>,
      runCwd: string,
      stageRunDir: string,
      spec: string,
      signal?: AbortSignal
    ) =>
      runRalphLoop(
        stageConfig,
        profiles,
        runCwd,
        stageRunDir,
        spec,
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
      ),
  };

  return runPipelineOnce(pipelineConfig, modelsConfig.profiles, cwd, runDir, specExcerpt, engineDeps);
}
```

- [ ] **Step 2: Update the two now-stale integration tests**

In `test/integration/ralph-loop-mocked.test.ts`, replace the first test (`"run command: checks fail on the initial broken fixture, story stays unpassed, no commit made"`, lines 21-37):

```ts
test("run command: checks fail on the initial broken fixture, loop retries until stall_limit, story stays unpassed", async () => {
  const dir = await copyFixture();
  try {
    const fakeAgent = mock(async () => ({
      ok: true,
      transcriptPath: "unused",
      usage: { inTok: 1, outTok: 1, costUsd: 0 },
    }));
    const state = await runCommand(dir, "ralph-only", { runAgentTask: fakeAgent });
    expect(state.stages[0].status).toBe("suspended");
    expect(state.stages[0].reason).toBe("stall");
    expect(state.cost).toEqual({ input_tokens: 3, output_tokens: 3, est_usd: 0 });
    const prd = JSON.parse(readFileSync(join(dir, "prd.json"), "utf-8"));
    expect(prd.stories[0].passes).toBe(false);
    expect(prd.stories[0].fixCount).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Replace the third test (`"run command: checks pass but AI review returns a blocker, story stays unpassed"`, lines 68-96):

```ts
test("run command: checks pass but AI review returns a blocker every time, loop retries until stall_limit, story stays unpassed", async () => {
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
    expect(state.stages[0].status).toBe("suspended");
    expect(state.stages[0].reason).toBe("stall");
    const prd = JSON.parse(readFileSync(join(dir, "prd.json"), "utf-8"));
    expect(prd.stories[0].passes).toBe(false);
    expect(prd.stories[0].fixCount).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Leave the second test (`"run command: checks pass and AI review passes..."`) untouched — it already succeeds on the story's first iteration, so `selectNextStory` finds nothing pending immediately afterward and the stage still ends `"done"` with no behavior change.

- [ ] **Step 3: Run the integration tests to verify they pass**

Run: `bun test test/integration/ralph-loop-mocked.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 4: Run the full suite and typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors (this was the last file referencing the old `runRalphLoopOnce`-as-`EngineDeps`-field wiring)

Run: `bun test ./test`
Expected: ALL tests pass (unit + integration; the live-API `ralph-loop-real.test.ts` file skips itself when `MINIMAX_API_KEY` is unset, same as before)

- [ ] **Step 5: Commit**

```bash
git add src/commands/run.ts test/integration/ralph-loop-mocked.test.ts
git commit -m "feat: wire aiflow run through runRalphLoop; update integration tests for true-loop stall behavior"
```

---

### Task 9: Docs + final verification

**Files:**
- Modify: `README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the pipeline config example in `README.md`**

In the `.aiflow/config/pipelines/<name>.yaml` section (the prose paragraph right after the `models.yaml` code block, around line 87), add a short note. Find this line:

```
`.aiflow/config/pipelines/<name>.yaml` declares the stages. The bundled `ralph-only` pipeline is a one-stage loop suitable for dev iteration; richer pipelines (`full-auto`, `spec-only`) are planned for v1.1.
```

Replace it with:

```
`.aiflow/config/pipelines/<name>.yaml` declares the stages. The bundled `ralph-only` pipeline is a one-stage loop suitable for dev iteration; richer pipelines (`full-auto`, `spec-only`) are planned for v1.1.

A `ralph_loop` stage keeps selecting the highest-priority pending story from `prd.json` and retrying until every story is done or suspended, until `max_iterations` (default 10) is reached, or until `stall_limit` (default 3) consecutive iterations make no progress. A story that fails more than `per_story_fix_limit` (default 3) times is marked `suspended` in `prd.json` and skipped in favor of the next pending story — it does not stop the whole stage. When a stage stops without finishing every story, `state.json`'s `stages[i].reason` (and the corresponding `ralph_loop_result` event in `events.jsonl`) records why: `"max_iterations"`, `"stall"`, or `"stories_suspended"`.
```

- [ ] **Step 2: Update the Per-run artifacts table**

In the `state.json` row of the artifacts table (around line 101), the description doesn't need a change since `reason` is a small, self-explanatory addition to an already-described file. Skip.

- [ ] **Step 3: Update the Status section**

Around line 159-164, in the `## Status` section, the note "Everything in the design spec outside that scope (multi-stage pipelines, brainstorm, human_gate, resume, full e2e with brainstorm) is not yet implemented" is stale now that `ralph_loop` is a true multi-iteration loop (not multi-*stage*, so this doesn't need correction — multi-stage pipelines are still out of scope, only multi-*iteration within one stage* changed). Skip — no edit needed here; this line remains accurate.

- [ ] **Step 4: Run the full verification suite**

Run: `bunx tsc --noEmit`
Expected: no errors

Run: `bun test ./test`
Expected: ALL tests pass

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document ralph_loop true-loop behavior (max_iterations/stall_limit/reason)"
```

---

## Post-plan notes (not tasks — informational)

- `aiflow run` still has no SIGINT/AbortController wiring in `src/cli.ts` (only `aiflow watch` does). `runRalphLoop`'s new `signal` parameter is fully plumbed through `engine.ts` and `run.ts` and is exercised by tests, but nothing constructs a real `AbortController` tied to `process.once("SIGINT", ...)` for the `run` command today. That gap pre-dates this plan and is out of scope here; wiring it up is a natural, small follow-up.
- Budget tracking/auto-pause (`budget.max_cost_usd`) remains explicitly out of scope per the design doc §2 and §6.
