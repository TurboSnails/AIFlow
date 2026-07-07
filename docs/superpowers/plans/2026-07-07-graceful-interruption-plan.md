# Graceful Interruption and Auto-Clean Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `aiflow run`/`resume`/`approve` graceful Ctrl+C handling (a new non-terminal `paused` status) and give `ralph_loop` an opt-in `auto_clean` that reverts the working tree to HEAD when a story is suspended — both named in the original technical design doc (§7, §6.6) but never implemented.

**Architecture:** Rename the existing signal-triggered `"aborted"` result (introduced by an earlier plan, `ralph-loop-true-loop`) to `"paused"` throughout the stack, since it was always semantically "pause for later," not "terminate" — `"aborted"` is kept for its other, genuinely-terminal use (`aiflow reject`, `human_gate` timeout). Then wire the existing `AbortController`/SIGINT pattern (already used by `watch`) into `run`/`resume`/`approve`. `auto_clean` is a new opt-in boolean on `ralph_loop` stages, guarded by a pre-flight dirty-workspace check.

**Tech Stack:** TypeScript, Bun, zod, git (all already in use — no new dependencies).

## Global Constraints

- No new npm dependencies.
- Every task must leave `bun test ./test` fully green.
- `"aborted"` keeps its existing terminal meaning for `aiflow reject` and `human_gate`'s `on_timeout: abort` — do not touch those code paths or their tests (`src/commands/reject.ts`, `test/unit/reject.test.ts`, `src/runners/human-gate.ts`, `test/unit/human-gate.test.ts`, the reject-related assertions in `test/integration/multi-stage-mocked.test.ts`).
- The new `paused` status must NOT be added to `TERMINAL_STATUSES` in `src/engine/engine.ts` — same treatment as `waiting_human`.
- `auto_clean` defaults to `false` — zero behavior change for any existing pipeline YAML that doesn't set it.
- The pre-flight dirty-workspace check only applies to a fresh `aiflow run`, never to `aiflow resume`/`aiflow approve` (they may legitimately continue into an already-dirty tree from earlier work in the same run).

---

### Task 1: Rename the signal-triggered `"aborted"` result to `"paused"`

This is a pure rename of an existing, already-shipped, already-tested code path — not new functionality. It touches 4 production files and 2 existing test files whose assertions currently expect the old name. All four production files must change together (they share one TypeScript union type across module boundaries); if you change only some of them, the project will not compile.

**Files:**
- Modify: `src/engine/state.ts`
- Modify: `src/engine/engine.ts`
- Modify: `src/runners/ralph-loop.ts`
- Modify: `src/events/events.ts`
- Modify: `test/unit/ralph-loop.test.ts`
- Modify: `test/unit/engine.test.ts`
- Test: `test/unit/state.test.ts` (new test, no existing tests need changing)

**Interfaces:**
- Produces: `StageStatus` gains `"paused"` (not in `TERMINAL_STATUSES`). `RalphLoopSummary.result` is `"pass" | "suspended" | "paused"` (was `"...| "aborted"`). `StageOutcome.result` is `"pass" | "fail" | "suspended" | "paused" | "waiting_human"` (was `"...| "aborted" |..."`). `RalphLoopResultAiflowEvent.result` is `"pass" | "suspended" | "paused"`.

- [ ] **Step 1: Update `src/engine/state.ts`**

Change line 4 from:
```ts
export type StageStatus = "pending" | "running" | "done" | "failed" | "aborted" | "suspended" | "waiting_human";
```
to:
```ts
export type StageStatus = "pending" | "running" | "done" | "failed" | "aborted" | "suspended" | "waiting_human" | "paused";
```

- [ ] **Step 2: Write the failing test for `paused` round-tripping**

Append to `test/unit/state.test.ts`:

```ts
test("writeStateAtomic then readState round-trips a paused stage", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-state-test-"));
  try {
    const state: EngineState = {
      run_id: "r1",
      pipeline: "ralph-only",
      stages: [{ id: "develop", status: "paused" }],
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

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/unit/state.test.ts`
Expected: FAIL — TypeScript rejects `"paused"` as an invalid `StageStatus` (this won't happen since you already applied Step 1 — reorder if you want a true RED: apply Step 2 first, confirm the compile error, then apply Step 1). Either order is fine; the point is confirming the test exercises the new value.

- [ ] **Step 4: Update `src/runners/ralph-loop.ts`**

Change the `RalphLoopSummary` interface (currently lines 155-160):
```ts
export interface RalphLoopSummary {
  result: "pass" | "suspended" | "paused";
  reason?: RalphLoopStopReason;
  iterations: number;
  usage: { inTok: number; outTok: number; costUsd: number };
}
```

In `runRalphLoop`'s signal check (currently lines 230-234):
```ts
    if (signal?.aborted) {
      const outcome: RalphLoopSummary = { result: "paused", iterations, usage };
      emitLoopResult(runDir, stageConfig.id, prd, outcome);
      return outcome;
    }
```

- [ ] **Step 5: Update `src/events/events.ts`**

Change `RalphLoopResultAiflowEvent`'s `result` field (currently line 44) from:
```ts
  result: "pass" | "suspended" | "aborted";
```
to:
```ts
  result: "pass" | "suspended" | "paused";
```

- [ ] **Step 6: Update `src/engine/engine.ts`**

Change `StageOutcome.result` (currently line 15) from:
```ts
  result: "pass" | "fail" | "suspended" | "aborted" | "waiting_human";
```
to:
```ts
  result: "pass" | "fail" | "suspended" | "paused" | "waiting_human";
```

Change `STATUS_MAP` (currently lines 147-153) from:
```ts
const STATUS_MAP: Record<StageOutcome["result"], StageStatus> = {
  pass: "done",
  fail: "failed",
  suspended: "suspended",
  aborted: "aborted",
  waiting_human: "waiting_human",
};
```
to:
```ts
const STATUS_MAP: Record<StageOutcome["result"], StageStatus> = {
  pass: "done",
  fail: "failed",
  suspended: "suspended",
  paused: "paused",
  waiting_human: "waiting_human",
};
```

Change `executeStage`'s pre-check (currently line 178) from:
```ts
  if (signal?.aborted) return { state: { id: stage.id, status: "aborted" } };
```
to:
```ts
  if (signal?.aborted) return { state: { id: stage.id, status: "paused" } };
```

Change `runPipelineOnce`'s loop-level abort branch (currently lines 267-268) from:
```ts
    if (signal?.aborted) {
      state = { ...state, stages: state.stages.map((s) => (s.status === "pending" || s.status === "running" ? { ...s, status: "aborted" } : s)) };
      writeStateAtomic(runDir, state);
      break;
    }
```
to:
```ts
    if (signal?.aborted) {
      state = { ...state, stages: state.stages.map((s) => (s.status === "pending" || s.status === "running" ? { ...s, status: "paused" } : s)) };
      writeStateAtomic(runDir, state);
      break;
    }
```

`TERMINAL_STATUSES` (lines 123-128) is NOT changed — leave it exactly as `["done", "failed", "aborted", "suspended"]`. `"paused"`, like `"waiting_human"`, is intentionally absent.

- [ ] **Step 7: Update the two existing `ralph-loop.test.ts` assertions**

In `test/unit/ralph-loop.test.ts`, change line 388 from:
```ts
    expect(summary.result).toBe("aborted");
```
to:
```ts
    expect(summary.result).toBe("paused");
```

And change line 420 from:
```ts
    expect(summary.result).toBe("aborted");
```
to:
```ts
    expect(summary.result).toBe("paused");
```

(Both are inside tests already named `"runRalphLoop: an already-aborted signal returns aborted immediately..."` and `"runRalphLoop: a signal aborted mid-run stops before the next iteration's agent call"` — leave the test names alone, only the assertion values change. Renaming the test titles is optional polish, not required.)

- [ ] **Step 8: Update the existing `engine.test.ts` assertion**

In `test/unit/engine.test.ts`, change line 235 from:
```ts
    expect(state.stages[0].status).toBe("aborted");
```
to:
```ts
    expect(state.stages[0].status).toBe("paused");
```

- [ ] **Step 9: Add a test proving `paused` is resumable without `--force`**

Append to `test/unit/engine.test.ts`:

```ts
test("runPipelineOnce resumes a paused stage without --force (paused is not terminal)", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-resume-"));
  try {
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({
        run_id: runDir.split("/").pop(),
        pipeline: pipeline.name,
        stages: [{ id: "develop", status: "paused" }],
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
    expect(state.stages[0].status).toBe("done");
    expect(ralphLoop).toHaveBeenCalledTimes(1);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

This test lives in the `describe("runPipelineOnce resume", ...)` block alongside the other resume tests — add it there, following the existing pattern (e.g. right after the `"resume is a no-op when the only stage is already terminal"` test).

- [ ] **Step 10: Run the full suite**

Run: `bun test ./test`
Expected: PASS — every test, including the 3 you updated and the 2 you added.

- [ ] **Step 11: Commit**

```bash
git add src/engine/state.ts src/engine/engine.ts src/runners/ralph-loop.ts src/events/events.ts test/unit/state.test.ts test/unit/ralph-loop.test.ts test/unit/engine.test.ts
git commit -m "refactor: rename signal-triggered aborted result to paused (non-terminal, resumable without --force)"
```

---

### Task 2: Wire SIGINT into `aiflow run`/`resume`/`approve`

**Files:**
- Modify: `src/commands/run.ts`
- Modify: `src/commands/resume.ts`
- Modify: `src/commands/approve.ts`
- Modify: `src/cli.ts`
- Test: `test/unit/run-multi-stage.test.ts`
- Test: `test/unit/resume.test.ts`
- Test: `test/unit/approve.test.ts`

**Interfaces:**
- Consumes: `StageStatus` including `"paused"` (Task 1).
- Produces: `runCommand(cwd, pipelineName, overrides?, requirementInput?, signal?: AbortSignal): Promise<EngineState>`. `runResume(cwd, opts, deps?, signal?: AbortSignal): Promise<ResumeResult>`. `runApprove(cwd, opts, deps?, signal?: AbortSignal): Promise<ApproveResult>`. All three add `signal` as their LAST parameter (backward compatible with every existing call site, which only ever supplies the earlier parameters).

- [ ] **Step 1: Write the failing test for `runCommand`**

Append to `test/unit/run-multi-stage.test.ts`:

```ts
test("runCommand stops with a paused stage when given an already-aborted signal", async () => {
  const dir = await setupProject(`name: test-pipeline\nstages:\n  - id: plan\n    type: plan\n    model: main-dev\n`);
  try {
    const controller = new AbortController();
    controller.abort();
    const state = await runCommand(
      dir,
      "test-pipeline",
      { callLlm: async () => ({ text: "unused", usage: { inTok: 0, outTok: 0, costUsd: 0 } }) },
      {},
      controller.signal
    );
    expect(state.stages[0].status).toBe("paused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/run-multi-stage.test.ts`
Expected: FAIL — `runCommand` doesn't accept a 5th `signal` argument yet (TypeScript error / extra argument ignored at runtime, so the pipeline would actually run instead of stopping).

- [ ] **Step 3: Add the `signal` parameter to `runCommand`**

In `src/commands/run.ts`, change the function signature (currently lines 40-45):
```ts
export async function runCommand(
  cwd: string,
  pipelineName: string,
  overrides: RunCommandOverrides = {},
  requirementInput: RequirementInput = {},
  signal?: AbortSignal
): Promise<EngineState> {
```

Change the final `runPipelineOnce` call (currently line 112) from:
```ts
  return runPipelineOnce(pipelineConfig, modelsConfig.profiles, cwd, runDir, engineDeps, undefined, { requirement: requirementText });
```
to:
```ts
  return runPipelineOnce(pipelineConfig, modelsConfig.profiles, cwd, runDir, engineDeps, signal, { requirement: requirementText });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/run-multi-stage.test.ts`
Expected: PASS (all tests in the file, including the new one).

- [ ] **Step 5: Write the failing test for `runResume`**

Append to `test/unit/resume.test.ts` (inside the `describe("runResume", ...)` block, or as a standalone `test(...)` if the file has no describe block — check the file first):

```ts
test("runResume stops with a paused stage when given an already-aborted signal", async () => {
  const cwd = await copyFixture();
  try {
    const runId = "20260701_130000_abcd12";
    const runDir = join(cwd, ".aiflow", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({
        run_id: runId,
        pipeline: "ralph-only",
        stages: [{ id: "develop", status: "pending" }],
        cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
      }),
    );
    writeFileSync(join(runDir, "prd.json"), JSON.stringify({ branchName: "fix/clamp", stories: [{ id: "US-1", title: "x", acceptance: [], priority: 1, passes: false, fixCount: 0 }] }));
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "math.ts"), `export function clamp(value: number, min: number, max: number): number {\n  return value;\n}\n`);

    const controller = new AbortController();
    controller.abort();
    const result = await runResume(cwd, { runId }, undefined, controller.signal);
    expect(result.status).toBe("resumed");
    expect(result.state!.stages[0].status).toBe("paused");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

Check the existing `copyFixture` helper and imports at the top of `test/unit/resume.test.ts` before adding this — reuse what's already there (`mkdtempSync`/`mkdirSync`/`writeFileSync`/`rmSync`/`join` should already be imported).

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test test/unit/resume.test.ts`
Expected: FAIL — `runResume` doesn't accept a 4th `signal` argument yet.

- [ ] **Step 7: Add the `signal` parameter to `runResume`**

In `src/commands/resume.ts`, change the function signature (currently lines 24-28):
```ts
export async function runResume(
  cwd: string,
  opts: { runId?: string; pipeline?: string; force?: boolean },
  deps?: EngineDeps,
  signal?: AbortSignal
): Promise<ResumeResult> {
```

Change the `runPipelineOnce` call (currently lines 44-52) from:
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
to:
```ts
  const state = await runPipelineOnce(
    pipelineConfig,
    profiles,
    cwd,
    runDir,
    deps,
    signal,
    { resume: true, force: opts.force ?? false },
  );
```

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test test/unit/resume.test.ts`
Expected: PASS (all tests).

- [ ] **Step 9: Write the failing test for `runApprove`**

Append to `test/unit/approve.test.ts`:

```ts
test("runApprove stops with a paused downstream stage when given an already-aborted signal", async () => {
  const { cwd, runId } = setupRun([
    { id: "confirm", status: "waiting_human", entered_at: "2026-07-06T10:00:00.000Z" },
    { id: "develop", status: "pending" },
  ]);
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await runApprove(cwd, { runId }, { runners: {} }, controller.signal);
    expect(result.status).toBe("resumed");
    expect(result.state!.stages[1].status).toBe("paused");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

Check `test/unit/approve.test.ts`'s existing `setupRun` helper signature before adding this — it should already support multi-stage arrays (it's used by the ambiguous-stage test). If `setupRun`'s pipeline-YAML generation only emits `human_gate`-typed stages for every entry in the array (check its implementation), adjust this test's second stage to also be a `human_gate` stage instead of implying a `ralph_loop`/`develop` stage that the helper can't generate — the point of this test is only to prove the `signal` plumbing reaches `runPipelineOnce`, not to exercise a real `ralph_loop`.

- [ ] **Step 10: Run test to verify it fails**

Run: `bun test test/unit/approve.test.ts`
Expected: FAIL — `runApprove` doesn't accept a 4th `signal` argument yet.

- [ ] **Step 11: Add the `signal` parameter to `runApprove`**

In `src/commands/approve.ts`, change the function signature (currently lines 23-27):
```ts
export async function runApprove(
  cwd: string,
  opts: { runId?: string; stage?: string },
  deps?: EngineDeps,
  signal?: AbortSignal
): Promise<ApproveResult> {
```

Change the `runPipelineOnce` call (currently line 61) from:
```ts
  const resultState = await runPipelineOnce(pipelineConfig, modelsConfig.profiles, cwd, runDir, deps, undefined, { resume: true });
```
to:
```ts
  const resultState = await runPipelineOnce(pipelineConfig, modelsConfig.profiles, cwd, runDir, deps, signal, { resume: true });
```

- [ ] **Step 12: Run test to verify it passes**

Run: `bun test test/unit/approve.test.ts`
Expected: PASS (all tests).

- [ ] **Step 13: Wire SIGINT in `src/cli.ts` for `run`, `resume`, and `approve`**

Replace the `run` command block (currently lines 48-75) with:

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
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);
    try {
      const state = await runCommand(
        process.cwd(),
        opts.pipeline,
        {},
        { requirement: opts.requirement, requirementFile: opts.requirementFile },
        controller.signal
      );
      const outcome = summarizePipelineOutcome(state);
      console.log(outcome.line);
      process.exitCode = outcome.exitCode;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  });
```

Replace the `resume` command block (currently lines 77-99) with:

```ts
program
  .command("resume")
  .description("Resume an in-flight or previously-aborted run (reads state.json)")
  .option("--run-id <id>", "resume a specific run (defaults to latest)")
  .option("--pipeline <name>", "override the pipeline name read from state.json")
  .option("--force", "re-execute stages that already reached a terminal state", false)
  .action(async (opts: { runId?: string; pipeline?: string; force: boolean }) => {
    const { runResume } = await import("./commands/resume");
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);
    try {
      const result = await runResume(
        process.cwd(),
        { runId: opts.runId, pipeline: opts.pipeline, force: opts.force },
        undefined,
        controller.signal
      );
      if (result.status === "no_runs" || result.status === "missing_run_dir") {
        console.error(result.message ?? "");
        process.exitCode = 1;
        return;
      }
      const { summarizePipelineOutcome } = await import("./engine/engine");
      const outcome = summarizePipelineOutcome(result.state!);
      console.log(`Run ${result.runId}: ${outcome.line}`);
      process.exitCode = outcome.exitCode;
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  });
```

Replace the `approve` command block (currently lines 101-118) with:

```ts
program
  .command("approve")
  .description("Approve a stage that is waiting for human confirmation (human_gate)")
  .option("--run-id <id>", "target a specific run (defaults to latest)")
  .option("--stage <id>", "target a specific stage (defaults to the sole waiting stage)")
  .action(async (opts: { runId?: string; stage?: string }) => {
    const { runApprove } = await import("./commands/approve");
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);
    try {
      const result = await runApprove(process.cwd(), opts, undefined, controller.signal);
      if (result.status !== "resumed") {
        console.error(result.message ?? result.status);
        process.exitCode = 1;
        return;
      }
      const { summarizePipelineOutcome } = await import("./engine/engine");
      const outcome = summarizePipelineOutcome(result.state!);
      console.log(`Run ${result.runId}: ${outcome.line}`);
      process.exitCode = outcome.exitCode;
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  });
```

- [ ] **Step 14: Run the full suite**

Run: `bun test ./test`
Expected: PASS.

- [ ] **Step 15: Commit**

```bash
git add src/commands/run.ts src/commands/resume.ts src/commands/approve.ts src/cli.ts test/unit/run-multi-stage.test.ts test/unit/resume.test.ts test/unit/approve.test.ts
git commit -m "feat: wire SIGINT into aiflow run/resume/approve for graceful pause"
```

---

### Task 3: `ralph_loop`'s `auto_clean` option

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/git.ts`
- Modify: `src/events/events.ts`
- Modify: `src/runners/ralph-loop.ts`
- Test: `test/unit/git.test.ts`
- Test: `test/unit/ralph-loop.test.ts`

**Interfaces:**
- Produces: `RalphLoopStageConfig` gains `auto_clean: boolean` (default `false`). `git.ts` gains `isClean(cwd: string): Promise<boolean>` and `checkoutClean(cwd: string): Promise<void>`. `events.ts` gains `StoryAutoCleanedAiflowEvent { ts, type: "story_auto_cleaned", story: string }`. `RalphLoopDeps.git` gains `checkoutClean`.

- [ ] **Step 1: Add the `auto_clean` schema field**

In `src/config/schema.ts`, change `RalphLoopStageSchema` (currently lines 33-41) from:
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
```
to:
```ts
export const RalphLoopStageSchema = z.object({
  id: z.string(),
  type: z.literal("ralph_loop"),
  model: z.string(),
  per_story_fix_limit: z.number().int().positive().default(3),
  max_iterations: z.number().int().positive().default(10),
  stall_limit: z.number().int().positive().default(3),
  auto_clean: z.boolean().default(false),
  gate: ReviewGateConfigSchema,
});
```

- [ ] **Step 2: Write the failing tests for `isClean`/`checkoutClean`**

Append to `test/unit/git.test.ts` (reuse the existing `makeTempRepo` helper already defined at the top of the file):

```ts
test("isClean returns true for a freshly-committed repo and false after an edit", async () => {
  const dir = await makeTempRepo();
  try {
    expect(await isClean(dir)).toBe(true);
    writeFileSync(join(dir, "a.txt"), "changed\n");
    expect(await isClean(dir)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isClean returns false when there's an untracked file", async () => {
  const dir = await makeTempRepo();
  try {
    writeFileSync(join(dir, "untracked.txt"), "new\n");
    expect(await isClean(dir)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkoutClean discards a modification to a tracked file", async () => {
  const dir = await makeTempRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "changed\n");
    await checkoutClean(dir);
    expect(await isClean(dir)).toBe(true);
    const content = await Bun.file(join(dir, "a.txt")).text();
    expect(content).toBe("hello\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkoutClean removes an untracked file", async () => {
  const dir = await makeTempRepo();
  try {
    writeFileSync(join(dir, "untracked.txt"), "new\n");
    await checkoutClean(dir);
    expect(await isClean(dir)).toBe(true);
    expect(await Bun.file(join(dir, "untracked.txt")).exists()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Also update the file's import line (currently `import { revParseHead, stageAll, diffCached, commit } from "../../src/git";`) to add the two new functions:
```ts
import { revParseHead, stageAll, diffCached, commit, isClean, checkoutClean } from "../../src/git";
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/unit/git.test.ts`
Expected: FAIL — `isClean`/`checkoutClean` don't exist yet.

- [ ] **Step 4: Implement `isClean`/`checkoutClean` in `src/git.ts`**

Append to `src/git.ts`:

```ts
export async function isClean(cwd: string): Promise<boolean> {
  const out = await $`git -C ${cwd} status --porcelain`.text();
  return out.trim().length === 0;
}

export async function checkoutClean(cwd: string): Promise<void> {
  await $`git -C ${cwd} checkout -- .`.quiet();
  await $`git -C ${cwd} clean -fd`.quiet();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/unit/git.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Add the new event type**

In `src/events/events.ts`, add after `HumanGateRejectedAiflowEvent` (currently ending at line 86):

```ts
export interface StoryAutoCleanedAiflowEvent {
  ts: string;
  type: "story_auto_cleaned";
  story: string;
}
```

Add `StoryAutoCleanedAiflowEvent` to the `AiflowEvent` union (currently lines 88-98).

- [ ] **Step 7: Write the failing tests for auto-clean behavior in `runRalphLoop`**

Append to `test/unit/ralph-loop.test.ts`. First, check the top of the file for the existing `loopStageConfig(...)` helper (used throughout the file to build a `RalphLoopStageConfig`) and `fixedGit()` helper (used to build a fake `RalphLoopDeps["git"]`) — this test extends both:

```ts
test("runRalphLoop: auto_clean:true calls checkoutClean and emits story_auto_cleaned when a story is suspended", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(samplePrd());
  try {
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));
    const runReviewGate = mock(async () => ({ checks: "fail" as const, aiReview: "skipped" as const, blockers: 0, checkOutput: "nope" }));
    const checkoutClean = mock(async () => {});
    const git = { ...fixedGit(), checkoutClean };

    await runRalphLoop(
      loopStageConfig({ per_story_fix_limit: 1, auto_clean: true }),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate, git }
    );

    expect(checkoutClean).toHaveBeenCalledWith(cwd);
    const events = readEvents(runDir);
    expect(events.some((e) => e.type === "story_auto_cleaned")).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop: auto_clean:false (default) never calls checkoutClean even when a story is suspended", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(samplePrd());
  try {
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));
    const runReviewGate = mock(async () => ({ checks: "fail" as const, aiReview: "skipped" as const, blockers: 0, checkOutput: "nope" }));
    const checkoutClean = mock(async () => {});
    const git = { ...fixedGit(), checkoutClean };

    await runRalphLoop(
      loopStageConfig({ per_story_fix_limit: 1 }),
      profiles,
      cwd,
      runDir,
      "spec excerpt",
      { runAgentTask, runReviewGate, git }
    );

    expect(checkoutClean).not.toHaveBeenCalled();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

You will need to import `readEvents` from `"../../src/events/events"` at the top of the file if it isn't already imported — check first.

If `loopStageConfig(...)`'s helper signature doesn't accept an `auto_clean` field (it's a test-local factory function that likely spreads an object of defaults with overrides), open it and confirm it just spreads `{ ...defaults, ...overrides }` — if so, no change is needed there, `auto_clean: true` will pass through automatically. If it explicitly lists every field, add `auto_clean: false` to its defaults.

Similarly, if `fixedGit()`'s return type doesn't structurally allow adding a `checkoutClean` key via spread (e.g. if `RalphLoopDeps` isn't updated yet — which is expected, that's the next step), this test will fail to compile until Step 8 is done. That's expected RED behavior for this step.

- [ ] **Step 8: Run tests to verify they fail**

Run: `bun test test/unit/ralph-loop.test.ts`
Expected: FAIL — `RalphLoopDeps.git` doesn't have `checkoutClean` yet (compile error), and `runRalphLoop` doesn't implement any auto-clean behavior yet.

- [ ] **Step 9: Add `checkoutClean` to `RalphLoopDeps` and implement the auto-clean trigger**

In `src/runners/ralph-loop.ts`, update the import line (currently line 6):
```ts
import { revParseHead, stageAll, diffCached, commit, checkoutClean } from "../git";
```

Update the `RalphLoopDeps` interface's `git` field (currently lines 20-25):
```ts
  git: {
    revParseHead: typeof revParseHead;
    stageAll: typeof stageAll;
    diffCached: typeof diffCached;
    commit: typeof commit;
    checkoutClean: typeof checkoutClean;
  };
```

Update `defaultDeps` (currently line 38):
```ts
  git: { revParseHead, stageAll, diffCached, commit, checkoutClean },
```

In `runRalphLoop`'s loop body, right after the `suspendedAfter`/`progressed` computation (currently lines 264-266):
```ts
    const suspendedAfter = countStories(prdAfter).suspended;

    if (suspendedAfter > suspendedBefore && stageConfig.auto_clean) {
      await deps.git.checkoutClean(cwd);
      appendEvent(runDir, { ts: new Date().toISOString(), type: "story_auto_cleaned", story: onceResult.storyId });
    }

    const progressed = onceResult.result === "pass" || suspendedAfter > suspendedBefore;
    stallCount = progressed ? 0 : stallCount + 1;
```

(This inserts the new block between the existing `suspendedAfter` line and the existing `progressed` line — the `progressed` line itself is unchanged, just moved down one line to sit after the new block.)

- [ ] **Step 10: Run tests to verify they pass**

Run: `bun test test/unit/ralph-loop.test.ts`
Expected: PASS (all tests, including the 2 new ones).

- [ ] **Step 11: Also update `src/commands/run.ts`'s `ralph_loop` wiring**

`commands/run.ts` builds its own `git: { revParseHead, stageAll, diffCached, commit }` object (currently line 92) for the real (non-test) `RalphLoopDeps` — this now needs `checkoutClean` too, or the real CLI path won't type-check. Change:
```ts
            git: { revParseHead, stageAll, diffCached, commit },
```
to:
```ts
            git: { revParseHead, stageAll, diffCached, commit, checkoutClean },
```
And update the import line (currently line 18):
```ts
import { revParseHead, stageAll, diffCached, commit, checkoutClean } from "../git";
```

- [ ] **Step 12: Run the full suite**

Run: `bun test ./test`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add src/config/schema.ts src/git.ts src/events/events.ts src/runners/ralph-loop.ts src/commands/run.ts test/unit/git.test.ts test/unit/ralph-loop.test.ts
git commit -m "feat: add ralph_loop auto_clean option (revert working tree to HEAD when a story is suspended)"
```

---

### Task 4: Pre-flight dirty-workspace safety check in `commands/run.ts`

**Files:**
- Modify: `src/commands/run.ts`
- Test: `test/unit/run-multi-stage.test.ts`

**Interfaces:**
- Consumes: `isClean` from `../git` (Task 3), `RalphLoopStageConfig["auto_clean"]` (Task 3).

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/run-multi-stage.test.ts`. These tests need a real git repo with a dirty/clean working tree, so they build their own project directory rather than using `setupProject` (which doesn't give you control over post-init dirtiness in a way that's easy to layer on) — reuse the same manual pattern already used by `setupProject` internally:

```ts
test("runCommand refuses to start when a ralph_loop stage has auto_clean:true and the working tree is dirty", async () => {
  const dir = await setupProject(
    `name: test-pipeline\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    auto_clean: true\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n`
  );
  try {
    writeFileSync(join(dir, "dirty.txt"), "uncommitted\n");
    await expect(runCommand(dir, "test-pipeline")).rejects.toThrow(/auto_clean.*not clean/i);
    expect(existsSync(join(dir, ".aiflow", "runs"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommand starts normally when a ralph_loop stage has auto_clean:true and the working tree is clean", async () => {
  const dir = await setupProject(
    `name: test-pipeline\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    auto_clean: true\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n`
  );
  try {
    writeFileSync(join(dir, "prd.json"), JSON.stringify({ branchName: "x", stories: [] }));
    const state = await runCommand(dir, "test-pipeline");
    expect(state.stages[0].status).toBe("done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommand starts normally when the working tree is dirty but no stage has auto_clean:true", async () => {
  const dir = await setupProject(
    `name: test-pipeline\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n`
  );
  try {
    writeFileSync(join(dir, "dirty.txt"), "uncommitted\n");
    writeFileSync(join(dir, "prd.json"), JSON.stringify({ branchName: "x", stories: [] }));
    const state = await runCommand(dir, "test-pipeline");
    expect(state.stages[0].status).toBe("done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Note the second and third tests rely on an empty `prd.json` (`stories: []`) so `runRalphLoop` returns `"pass"` immediately with zero real agent/git calls — the same trick used in an earlier plan's engine tests to keep a real (non-mocked) `ralph_loop` run hermetic and fast.

- [ ] **Step 2: Run tests to verify the first one fails**

Run: `bun test test/unit/run-multi-stage.test.ts`
Expected: the first new test FAILS (no pre-flight check exists yet, so `runCommand` proceeds instead of throwing); the second and third should already PASS (nothing blocks them yet) — confirm this is indeed the case before moving on, since it tells you the RED you're fixing is specifically "doesn't refuse when it should," not something else.

- [ ] **Step 3: Add the pre-flight check**

In `src/commands/run.ts`, add the import (extend the existing `import { revParseHead, stageAll, diffCached, commit, checkoutClean } from "../git";` line from Task 3, Step 11):
```ts
import { revParseHead, stageAll, diffCached, commit, checkoutClean, isClean } from "../git";
```

Add the check right after the existing `--requirement` pre-flight block (currently ending at line 57, before `const runId = createRunId();`):
```ts
  const hasAutoClean = pipelineConfig.stages.some((s) => s.type === "ralph_loop" && s.auto_clean);
  if (hasAutoClean && !(await isClean(cwd))) {
    throw new Error(
      `Pipeline "${pipelineName}" has auto_clean enabled on a ralph_loop stage, but the working tree at ${cwd} is not clean. Commit or stash your changes before running (auto_clean cannot distinguish your uncommitted work from a failed agent attempt).`
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/run-multi-stage.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run the full suite**

Run: `bun test ./test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/run.ts test/unit/run-multi-stage.test.ts
git commit -m "feat: refuse to start a run when auto_clean is enabled and the working tree isn't clean"
```

---

### Task 5: End-to-end integration test for `auto_clean`

**Files:**
- Create: `test/integration/auto-clean.test.ts`

**Interfaces:**
- Consumes: `runCommand` (Task 4), `auto_clean` config field (Task 3).

- [ ] **Step 1: Write the test**

Create `test/integration/auto-clean.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { runCommand } from "../../src/commands/run";

async function setupProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-auto-clean-"));
  mkdirSync(join(dir, ".aiflow", "config", "pipelines"), { recursive: true });
  writeFileSync(
    join(dir, ".aiflow", "config", "models.yaml"),
    `profiles:\n  main-dev:\n    channel: opencode\n    provider: opencode\n    model: x\n  reviewer:\n    channel: http\n    provider: y\n    model: z\n`
  );
  writeFileSync(
    join(dir, ".aiflow", "config", "pipelines", "test-pipeline.yaml"),
    `name: test-pipeline\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    per_story_fix_limit: 1\n    auto_clean: true\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n`
  );
  writeFileSync(join(dir, "prd.json"), JSON.stringify({ branchName: "x", stories: [{ id: "US-1", title: "t", acceptance: [], priority: 1, passes: false, fixCount: 0 }] }));
  writeFileSync(join(dir, "clean.txt"), "original content\n");
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} config user.email "test@example.com"`;
  await $`git -C ${dir} config user.name "Test"`;
  await $`git -C ${dir} add -A`;
  await $`git -C ${dir} commit -q -m "initial"`;
  return dir;
}

test("auto_clean reverts a dirty working tree after a story is suspended", async () => {
  const dir = await setupProject();
  try {
    const fakeAgent = async (task: { cwd: string }) => {
      writeFileSync(join(task.cwd, "clean.txt"), "an agent's failed, uncommitted edit\n");
      return { ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } };
    };

    const state = await runCommand(dir, "test-pipeline", { runAgentTask: fakeAgent });

    expect(state.stages[0].status).toBe("suspended");
    const content = readFileSync(join(dir, "clean.txt"), "utf-8");
    expect(content).toBe("original content\n");
    const status = await $`git -C ${dir} status --porcelain`.text();
    expect(status.trim()).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Here `per_story_fix_limit: 1` means the story checks always fail (`gate.checks: []`, `ai_review.enabled: false` means the deterministic+AI gate always evaluates to "checks pass, no AI review" — wait: an empty `checks` array trivially passes; the actual failure driver needs to be the review gate. Re-read `src/gate/review-gate.ts` before finalizing this test: if `checks: []` always passes and `ai_review.enabled: false` always skips, the gate will ALWAYS pass and the story will never fail/suspend. Fix the pipeline YAML above to make the gate genuinely fail every time — the simplest way is a `checks: ["exit 1"]` command, which is a real shell command that always exits non-zero:
```
gate:\n      checks: ["exit 1"]\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n
```
Use this corrected checks list instead of the empty array shown in Step 1's YAML above.

- [ ] **Step 2: Run test to verify it fails first for the right reason, then fix**

Run: `bun test test/integration/auto-clean.test.ts`

If it fails because the story didn't actually get suspended (status isn't `"suspended"`), that confirms the gate-always-passes bug described above — apply the `checks: ["exit 1"]` fix from Step 1 and re-run. Once the story genuinely gets suspended, the test should assert the interesting behavior (working tree reverted).

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test test/integration/auto-clean.test.ts`
Expected: PASS.

- [ ] **Step 4: Run the full suite one final time**

Run: `bun test ./test`
Expected: PASS — every test file in the repository green.

- [ ] **Step 5: Commit**

```bash
git add test/integration/auto-clean.test.ts
git commit -m "test: add end-to-end integration test for ralph_loop auto_clean"
```

---

## Self-Review Notes

- **Spec coverage:** design doc §3.1 (`paused` status) → Task 1. §3.2 (SIGINT in run/resume/approve) → Task 2. §3.3 (`auto_clean` schema + git helpers + trigger) → Task 3. §3.3's safety valve → Task 4. §5's end-to-end scenario → Task 5. §4's error-handling table rows are each covered: SIGINT→paused (Task 2), suspended+auto_clean→checkoutClean (Task 3), dirty+auto_clean→refuse (Task 4).
- **Placeholder scan:** no TBD/TODO; the one spot with inline reasoning-before-code (Task 5's gate-config correction) still ends in complete, exact code to use — not a vague instruction.
- **Type consistency:** `RalphLoopSummary.result`/`StageOutcome.result`/`RalphLoopResultAiflowEvent.result`/`StageStatus` all gain `"paused"` in the same task (Task 1) so no task ever sees a half-renamed union. `RalphLoopDeps.git.checkoutClean`/`git.ts`'s exported `checkoutClean` (Task 3) match by name and signature (`(cwd: string) => Promise<void>`) everywhere they're referenced, including `commands/run.ts`'s wiring (Task 3, Step 11).
- **Cross-task risk called out explicitly for the implementer:** Task 1 modifies `test/unit/ralph-loop.test.ts` and `test/unit/engine.test.ts`, both files already covered by prior plans' reviews — the task brief is explicit that this is a required, in-scope rename, not scope creep, so an implementer (or reviewer) doesn't mistake it for touching unrelated, already-approved code without justification.
