# Run 安全加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three P0 safety mechanisms to AIFlow's run lifecycle — a concurrency lock, a real-cost-backed budget circuit breaker, and a `ralph_loop` config-tamper check — per `docs/superpowers/specs/2026-07-07-run-safety-hardening-design.md`.

**Architecture:** Each mechanism is a small standalone module (`src/lock.ts`, `src/config/config-hash.ts`, `src/gate/budget.ts`) wired into the existing file-driven engine at well-defined seams: the lock wraps four CLI commands, the budget tracker is threaded through `StageRunnerFn` as one extra optional argument (defaulting to a no-op), and the tamper check is embedded directly in `runRalphLoopOnce`'s existing per-iteration flow.

**Tech Stack:** Bun (TypeScript), zod, bun:test, existing `git` CLI wrapper (`src/git.ts`), no new dependencies.

## Global Constraints

- No new npm dependencies — everything uses Bun/Node built-ins (`node:crypto`, `node:fs`) already used elsewhere in the codebase.
- Every new/changed function keeps the codebase's existing dependency-injection convention: `deps: XDeps = defaultDeps` as the last-but-one parameter, real implementation wired in `src/commands/run.ts`.
- New optional parameters are always appended at the end of existing positional signatures, with a safe default, so every existing test call site keeps compiling and passing unmodified unless a task explicitly says to edit that test file.
- All new code follows the existing file-driven, no-new-abstractions style: no classes except where the codebase already uses one pattern (none needed here — everything is plain functions/interfaces, matching `src/git.ts`, `src/prd.ts`, etc.).
- Run `bun test ./test` after every task; it must stay green before moving to the next task.

---

### Task 1: Concurrency lock module

**Files:**
- Create: `src/lock.ts`
- Test: `test/unit/lock.test.ts`

**Interfaces:**
- Produces: `acquireRunLock(cwd: string, runId: string, opts?: AcquireLockOptions): Promise<RunLock>`, `RunLock { release(): void }`, `LockWaitAbortedError`. Later tasks (Task 2) import these directly.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/lock.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, LockWaitAbortedError } from "../../src/lock";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "aiflow-lock-test-"));
}

test("acquireRunLock creates the lock file and release() removes it", async () => {
  const dir = tmpProject();
  try {
    const lock = await acquireRunLock(dir, "run-1");
    const lockPath = join(dir, ".aiflow", "run.lock");
    expect(existsSync(lockPath)).toBe(true);
    const info = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(info.run_id).toBe("run-1");
    expect(info.pid).toBe(process.pid);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunLock reclaims a stale lock left by a dead pid without waiting", async () => {
  const dir = tmpProject();
  try {
    const first = await acquireRunLock(dir, "run-old", { isPidAliveFn: () => false });
    // Don't release() — simulate a crash that left the lock file behind.
    void first;
    let reclaimedInfo: { pid: number; run_id: string } | undefined;
    const second = await acquireRunLock(dir, "run-new", {
      isPidAliveFn: () => false,
      onStaleReclaimed: (info) => { reclaimedInfo = info; },
    });
    expect(reclaimedInfo?.run_id).toBe("run-old");
    second.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunLock polls and waits while the pid is alive, then succeeds once released", async () => {
  const dir = tmpProject();
  try {
    const held = await acquireRunLock(dir, "run-holder", { isPidAliveFn: () => true });
    let sleeps = 0;
    const waiter = acquireRunLock(dir, "run-waiter", {
      isPidAliveFn: () => true,
      pollMs: 5,
      sleepFn: async (ms) => {
        sleeps += 1;
        if (sleeps === 2) held.release();
        return new Promise((resolve) => setTimeout(resolve, ms));
      },
    });
    const lock = await waiter;
    expect(sleeps).toBeGreaterThanOrEqual(2);
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunLock throws LockWaitAbortedError when the signal aborts while waiting", async () => {
  const dir = tmpProject();
  try {
    const held = await acquireRunLock(dir, "run-holder", { isPidAliveFn: () => true });
    const controller = new AbortController();
    let firstSleep = true;
    const promise = acquireRunLock(dir, "run-waiter", {
      isPidAliveFn: () => true,
      signal: controller.signal,
      sleepFn: async () => {
        if (firstSleep) {
          firstSleep = false;
          controller.abort();
        }
      },
    });
    await expect(promise).rejects.toThrow(LockWaitAbortedError);
    held.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("onWaiting fires exactly once even across multiple poll iterations", async () => {
  const dir = tmpProject();
  try {
    const held = await acquireRunLock(dir, "run-holder", { isPidAliveFn: () => true });
    let waitingCalls = 0;
    let sleeps = 0;
    const waiter = acquireRunLock(dir, "run-waiter", {
      isPidAliveFn: () => true,
      onWaiting: () => { waitingCalls += 1; },
      sleepFn: async () => {
        sleeps += 1;
        if (sleeps === 3) held.release();
      },
    });
    const lock = await waiter;
    expect(waitingCalls).toBe(1);
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/lock.test.ts`
Expected: FAIL — `Cannot find module '../../src/lock'`

- [ ] **Step 3: Implement `src/lock.ts`**

```typescript
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LockInfo {
  pid: number;
  run_id: string;
  started_at: string;
}

export interface RunLock {
  release(): void;
}

export class LockWaitAbortedError extends Error {
  constructor() {
    super("Aborted while waiting for run lock");
  }
}

export interface AcquireLockOptions {
  signal?: AbortSignal;
  pollMs?: number;
  onWaiting?: (info: LockInfo) => void;
  onStaleReclaimed?: (info: LockInfo) => void;
  sleepFn?: (ms: number) => Promise<void>;
  isPidAliveFn?: (pid: number) => boolean;
}

function lockPath(cwd: string): string {
  return join(cwd, ".aiflow", "run.lock");
}

function isPidAliveReal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function acquireRunLock(
  cwd: string,
  runId: string,
  opts: AcquireLockOptions = {}
): Promise<RunLock> {
  const {
    signal,
    pollMs = 1000,
    onWaiting,
    onStaleReclaimed,
    sleepFn = defaultSleep,
    isPidAliveFn = isPidAliveReal,
  } = opts;
  const path = lockPath(cwd);
  mkdirSync(join(cwd, ".aiflow"), { recursive: true });

  let announced = false;
  while (true) {
    if (signal?.aborted) throw new LockWaitAbortedError();

    const info: LockInfo = { pid: process.pid, run_id: runId, started_at: new Date().toISOString() };
    try {
      writeFileSync(path, JSON.stringify(info), { flag: "wx" });
      return {
        release: () => {
          try {
            unlinkSync(path);
          } catch {
            // already gone (released twice, or reclaimed by someone else) — fine.
          }
        },
      };
    } catch (err) {
      const code = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
      if (code !== "EEXIST") throw err;
    }

    if (!existsSync(path)) continue; // raced with a concurrent release; retry immediately
    const existing = JSON.parse(readFileSync(path, "utf-8")) as LockInfo;
    if (!isPidAliveFn(existing.pid)) {
      onStaleReclaimed?.(existing);
      try {
        unlinkSync(path);
      } catch {
        // another process reclaimed it first — loop around and try again
      }
      continue;
    }

    if (!announced) {
      onWaiting?.(existing);
      announced = true;
    }
    await sleepFn(pollMs);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/lock.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lock.ts test/unit/lock.test.ts
git commit -m "feat: add run lock module with stale-pid reclaim and blocking wait"
```

---

### Task 2: Wire the lock into `run`/`resume`/`approve`/`reject`

**Files:**
- Modify: `src/cli.ts`
- Test: `test/unit/cli.test.ts` (read current contents first — extend, don't replace)

**Interfaces:**
- Consumes: `acquireRunLock`, `RunLock`, `LockWaitAbortedError` from Task 1 (`src/lock.ts`).

- [ ] **Step 1: Read the current `cli.ts` test file to match its existing style**

Run: `cat test/unit/cli.test.ts`

(This file likely spawns the CLI as a subprocess or imports `program` — match whatever pattern is already there before adding new tests. If it spawns a subprocess with `Bun.spawn(["bun", "src/cli.ts", ...])`, write the new tests the same way, in a temp dir with a minimal `.aiflow/config` scaffold.)

- [ ] **Step 2: Write the failing test**

Append to `test/unit/cli.test.ts` (adjust the harness call to match the file's existing subprocess-invocation helper — call it `runCli` below as a placeholder for whatever helper name the file already exports/uses internally):

```typescript
test("aiflow run refuses immediately is not required — a stale lock is reclaimed and the run proceeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-cli-lock-test-"));
  try {
    mkdirSync(join(dir, ".aiflow", "config", "pipelines"), { recursive: true });
    writeFileSync(
      join(dir, ".aiflow", "config", "models.yaml"),
      "profiles:\n  main-dev:\n    channel: opencode\n    provider: x\n    model: y\n  reviewer:\n    channel: http\n    provider: y\n    model: z\n"
    );
    writeFileSync(
      join(dir, ".aiflow", "config", "pipelines", "ralph-only.yaml"),
      'name: ralph-only\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    per_story_fix_limit: 3\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n'
    );
    writeFileSync(join(dir, "prd.json"), JSON.stringify({ branchName: "x", stories: [] }));
    await $`git -C ${dir} init -q`;
    await $`git -C ${dir} config user.email "test@example.com"`;
    await $`git -C ${dir} config user.name "Test"`;
    await $`git -C ${dir} add -A`;
    await $`git -C ${dir} commit -q -m "initial"`;

    // A lock file left behind by pid 1 (guaranteed to exist on any POSIX box,
    // but never equal to this test process's own pid) simulates a crash.
    mkdirSync(join(dir, ".aiflow"), { recursive: true });
    writeFileSync(
      join(dir, ".aiflow", "run.lock"),
      JSON.stringify({ pid: 999999999, run_id: "stale-run", started_at: new Date().toISOString() })
    );

    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "..", "src", "cli.ts"), "run", "--pipeline", "ralph-only"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(stderr).toContain("stale");
    expect(exitCode).toBe(0);
    expect(existsSync(join(dir, ".aiflow", "run.lock"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Add the needed imports at the top of `test/unit/cli.test.ts` if not already present: `mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync` from `"node:fs"`, `tmpdir` from `"node:os"`, `join` from `"node:path"`, `$` from `"bun"`.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/unit/cli.test.ts -t "stale lock is reclaimed"`
Expected: FAIL — no `run.lock` handling exists yet, so the stale file is left untouched (or the run proceeds without the "stale" message).

- [ ] **Step 4: Wire the lock into `src/cli.ts`**

Modify each of the four action handlers. Show the full new `run` handler (the other three follow the identical pattern — see Step 4b/4c/4d):

```typescript
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
    const { summarizePipelineOutcome, createRunId } = await import("./engine/engine");
    const { acquireRunLock, LockWaitAbortedError } = await import("./lock");
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);
    const runId = createRunId();
    let lock;
    try {
      lock = await acquireRunLock(process.cwd(), runId, {
        signal: controller.signal,
        onWaiting: (info) => console.error(`Waiting: run ${info.run_id} in progress (pid ${info.pid}), queued...`),
        onStaleReclaimed: (info) => console.error(`Reclaimed stale lock left by pid ${info.pid} (process no longer running).`),
      });
    } catch (err) {
      if (err instanceof LockWaitAbortedError) {
        process.exitCode = 1;
        return;
      }
      throw err;
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
    process.once("SIGINT", onSigint);
    try {
      const state = await runCommand(
        process.cwd(),
        opts.pipeline,
        {},
        { requirement: opts.requirement, requirementFile: opts.requirementFile },
        controller.signal,
        runId
      );
      const outcome = summarizePipelineOutcome(state);
      console.log(outcome.line);
      process.exitCode = outcome.exitCode;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      lock.release();
      process.removeListener("SIGINT", onSigint);
    }
  });
```

Note: `runCommand` gains a 6th, optional `runId` parameter here — that's implemented in Task 12 (Step 4 there updates `runCommand`'s signature and default). Until Task 12 lands, pass it anyway; TypeScript will only complain if `runCommand`'s signature doesn't yet accept it, so **do this task's cli.ts edit and Task 12's `run.ts` edit together if `bun test`/`tsc` complains about the extra argument** — the two are listed as separate tasks for review-sizing, not because they can ship independently. If you hit that ordering issue, do Task 12's Step 4 (`runCommand` signature) first, then return here.

Apply the same lock-wrap pattern to `resume`, `approve`, and `reject`:

```typescript
program
  .command("resume")
  .description("Resume an in-flight or previously-aborted run (reads state.json)")
  .option("--run-id <id>", "resume a specific run (defaults to latest)")
  .option("--pipeline <name>", "override the pipeline name read from state.json")
  .option("--force", "re-execute stages that already reached a terminal state", false)
  .option("--raise-budget <n>", "raise the pipeline's budget.max_cost_usd to this value before resuming", (v) => Number(v))
  .action(async (opts: { runId?: string; pipeline?: string; force: boolean; raiseBudget?: number }) => {
    const { runResume } = await import("./commands/resume");
    const { acquireRunLock, LockWaitAbortedError } = await import("./lock");
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    let lock;
    process.once("SIGINT", onSigint);
    try {
      lock = await acquireRunLock(process.cwd(), opts.runId ?? "pending-resume", {
        signal: controller.signal,
        onWaiting: (info) => console.error(`Waiting: run ${info.run_id} in progress (pid ${info.pid}), queued...`),
        onStaleReclaimed: (info) => console.error(`Reclaimed stale lock left by pid ${info.pid} (process no longer running).`),
      });
    } catch (err) {
      if (err instanceof LockWaitAbortedError) {
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    try {
      const result = await runResume(
        process.cwd(),
        { runId: opts.runId, pipeline: opts.pipeline, force: opts.force, raiseBudget: opts.raiseBudget },
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
      lock.release();
      process.removeListener("SIGINT", onSigint);
    }
  });

program
  .command("approve")
  .description("Approve a stage that is waiting for human confirmation (human_gate)")
  .option("--run-id <id>", "target a specific run (defaults to latest)")
  .option("--stage <id>", "target a specific stage (defaults to the sole waiting stage)")
  .action(async (opts: { runId?: string; stage?: string }) => {
    const { runApprove } = await import("./commands/approve");
    const { acquireRunLock, LockWaitAbortedError } = await import("./lock");
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    let lock;
    process.once("SIGINT", onSigint);
    try {
      lock = await acquireRunLock(process.cwd(), opts.runId ?? "pending-approve", {
        signal: controller.signal,
        onWaiting: (info) => console.error(`Waiting: run ${info.run_id} in progress (pid ${info.pid}), queued...`),
        onStaleReclaimed: (info) => console.error(`Reclaimed stale lock left by pid ${info.pid} (process no longer running).`),
      });
    } catch (err) {
      if (err instanceof LockWaitAbortedError) {
        process.exitCode = 1;
        return;
      }
      throw err;
    }
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
      lock.release();
      process.removeListener("SIGINT", onSigint);
    }
  });

program
  .command("reject")
  .description("Reject a stage that is waiting for human confirmation (human_gate); aborts the pipeline")
  .option("--run-id <id>", "target a specific run (defaults to latest)")
  .option("--stage <id>", "target a specific stage (defaults to the sole waiting stage)")
  .option("--reason <text>", "reason recorded in events.jsonl")
  .action(async (opts: { runId?: string; stage?: string; reason?: string }) => {
    const { runReject } = await import("./commands/reject");
    const { acquireRunLock, LockWaitAbortedError } = await import("./lock");
    let lock;
    try {
      lock = await acquireRunLock(process.cwd(), opts.runId ?? "pending-reject", {
        onWaiting: (info) => console.error(`Waiting: run ${info.run_id} in progress (pid ${info.pid}), queued...`),
        onStaleReclaimed: (info) => console.error(`Reclaimed stale lock left by pid ${info.pid} (process no longer running).`),
      });
    } catch (err) {
      if (err instanceof LockWaitAbortedError) {
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    try {
      const result = runReject(process.cwd(), opts);
      if (result.status !== "rejected") {
        console.error(result.message ?? result.status);
        process.exitCode = 1;
        return;
      }
      const rejectedStage = result.state!.stages.find((s) => s.status === "aborted");
      console.log(`Run ${result.runId}: stage ${rejectedStage?.id} rejected`);
      process.exitCode = 1;
    } finally {
      lock.release();
    }
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/unit/cli.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full suite to catch any signature mismatch with `runCommand`/`runResume`**

Run: `bun test ./test`
Expected: Compile error naming `runCommand`'s or `runResume`'s missing `runId`/`raiseBudget` parameter is acceptable at this point — note it and resolve when Task 12 lands (see the note in Step 4). Everything else must stay green.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts test/unit/cli.test.ts
git commit -m "feat: acquire a run lock before run/resume/approve/reject"
```

---

### Task 3: Config hash module

**Files:**
- Create: `src/config/config-hash.ts`
- Test: `test/unit/config-hash.test.ts`

**Interfaces:**
- Produces: `hashConfigDir(cwd: string): string`. Consumed by Task 5 (`ralph-loop.ts`).

- [ ] **Step 1: Write the failing tests**

Create `test/unit/config-hash.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashConfigDir } from "../../src/config/config-hash";

function projectWithConfig(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-confighash-"));
  mkdirSync(join(dir, ".aiflow", "config", "pipelines"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, ".aiflow", "config", rel), content);
  }
  return dir;
}

test("hashConfigDir returns the same hash for unchanged content across two calls", () => {
  const dir = projectWithConfig({ "models.yaml": "profiles:\n  a: {}\n" });
  try {
    expect(hashConfigDir(dir)).toBe(hashConfigDir(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hashConfigDir changes when a file's content changes", () => {
  const dir = projectWithConfig({ "models.yaml": "profiles:\n  a: {}\n" });
  try {
    const before = hashConfigDir(dir);
    writeFileSync(join(dir, ".aiflow", "config", "models.yaml"), "profiles:\n  a: { changed: true }\n");
    expect(hashConfigDir(dir)).not.toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hashConfigDir changes when a nested file is added", () => {
  const dir = projectWithConfig({ "models.yaml": "profiles: {}\n" });
  try {
    const before = hashConfigDir(dir);
    writeFileSync(join(dir, ".aiflow", "config", "pipelines", "new.yaml"), "name: new\nstages: []\n");
    expect(hashConfigDir(dir)).not.toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hashConfigDir is stable regardless of filesystem directory-listing order", () => {
  const dirA = projectWithConfig({ "a.yaml": "1", "b.yaml": "2" });
  const dirB = projectWithConfig({ "b.yaml": "2", "a.yaml": "1" });
  try {
    expect(hashConfigDir(dirA)).toBe(hashConfigDir(dirB));
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/config-hash.test.ts`
Expected: FAIL — `Cannot find module '../../src/config/config-hash'`

- [ ] **Step 3: Implement `src/config/config-hash.ts`**

```typescript
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

/** Deterministic content hash of everything under `<cwd>/.aiflow/config/`, order-independent. */
export function hashConfigDir(cwd: string): string {
  const configDir = join(cwd, ".aiflow", "config");
  const files = listFilesRecursive(configDir).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(configDir, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/config-hash.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/config/config-hash.ts test/unit/config-hash.test.ts
git commit -m "feat: add deterministic .aiflow/config content hash helper"
```

---

### Task 4: `git.ts`: add `checkoutConfigOnly`

**Files:**
- Modify: `src/git.ts`
- Test: `test/unit/git.test.ts`

**Interfaces:**
- Produces: `checkoutConfigOnly(cwd: string): Promise<void>`. Consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/git.test.ts` (add `checkoutConfigOnly` to the existing import line at the top):

```typescript
test("checkoutConfigOnly restores .aiflow/config to HEAD without touching other tracked files", async () => {
  const dir = await makeTempRepo();
  try {
    mkdirSync(join(dir, ".aiflow", "config"), { recursive: true });
    writeFileSync(join(dir, ".aiflow", "config", "models.yaml"), "profiles: {}\n");
    await $`git -C ${dir} add -A`;
    await $`git -C ${dir} commit -q -m "add config"`;

    writeFileSync(join(dir, ".aiflow", "config", "models.yaml"), "profiles:\n  tampered: true\n");
    writeFileSync(join(dir, "a.txt"), "also changed\n");

    await checkoutConfigOnly(dir);

    const configContent = await Bun.file(join(dir, ".aiflow", "config", "models.yaml")).text();
    expect(configContent).toBe("profiles: {}\n");
    const aContent = await Bun.file(join(dir, "a.txt")).text();
    expect(aContent).toBe("also changed\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/git.test.ts -t "checkoutConfigOnly"`
Expected: FAIL — `checkoutConfigOnly is not a function` (or a TypeScript error naming the missing export)

- [ ] **Step 3: Add `checkoutConfigOnly` to `src/git.ts`**

Append to `src/git.ts` (keep existing exports untouched):

```typescript
export async function checkoutConfigOnly(cwd: string): Promise<void> {
  await $`git -C ${cwd} checkout HEAD -- .aiflow/config`.quiet();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/git.test.ts`
Expected: PASS (all existing + 1 new test)

- [ ] **Step 5: Commit**

```bash
git add src/git.ts test/unit/git.test.ts
git commit -m "feat: add checkoutConfigOnly for reverting .aiflow/config in isolation"
```

---

### Task 5: Wire config tamper-check into `ralph_loop`

**Files:**
- Modify: `src/runners/ralph-loop.ts`
- Modify: `src/events/events.ts` (extend `GateResultAiflowEvent`)
- Test: `test/unit/ralph-loop.test.ts`

**Interfaces:**
- Consumes: `hashConfigDir` (Task 3), `checkoutConfigOnly` (Task 4).
- Produces: `RalphLoopDeps.git` gains `checkoutConfigOnly`; `RalphLoopDeps` gains `hashConfigDir: (cwd: string) => string` (both injectable, defaulting to the real implementations, matching every other dependency in this file).

- [ ] **Step 1: Write the failing test**

Append to `test/unit/ralph-loop.test.ts`:

```typescript
test("a config file changed by the agent mid-iteration fails the gate, reverts the config, and does not call the review gate", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    let hashCall = 0;
    const hashConfigDir = mock(() => {
      hashCall += 1;
      return hashCall === 1 ? "hash-before" : "hash-after-different";
    });
    const checkoutConfigOnly = mock(async () => {});
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = { ...fixedGit(), checkoutConfigOnly };

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir,
    });

    expect(result.result).toBe("fail");
    expect(runReviewGate).not.toHaveBeenCalled();
    expect(checkoutConfigOnly).toHaveBeenCalledWith(cwd);
    const prd = readPrd(join(cwd, "prd.json"));
    expect(prd.stories[0].fixCount).toBe(1);
    const fixList = readFileSync(join(runDir, "artifacts", "fix_list.md"), "utf-8");
    expect(fixList).toContain("配置文件");
    const events = readEvents(runDir);
    const gateEvent = events.find((e) => e.type === "gate_result");
    expect(gateEvent).toMatchObject({ checks: "fail", reason: "config_tampered" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("unchanged config hash before/after does not revert config or skip the review gate", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const hashConfigDir = mock(() => "same-hash-always");
    const checkoutConfigOnly = mock(async () => {});
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = { ...fixedGit(), checkoutConfigOnly };

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir,
    });

    expect(result.result).toBe("pass");
    expect(runReviewGate).toHaveBeenCalledTimes(1);
    expect(checkoutConfigOnly).not.toHaveBeenCalled();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/ralph-loop.test.ts -t "config"`
Expected: FAIL — `runRalphLoopOnce`'s deps object has no `hashConfigDir` field yet (TypeScript error) and the behavior doesn't exist.

- [ ] **Step 3: Extend `GateResultAiflowEvent` in `src/events/events.ts`**

Change:

```typescript
export interface GateResultAiflowEvent {
  ts: string;
  type: "gate_result";
  stage: string;
  story: string;
  checks: "pass" | "fail";
  ai_review: "pass" | "fail" | "skipped";
  blockers: number;
}
```

to:

```typescript
export interface GateResultAiflowEvent {
  ts: string;
  type: "gate_result";
  stage: string;
  story: string;
  checks: "pass" | "fail";
  ai_review: "pass" | "fail" | "skipped";
  blockers: number;
  reason?: "config_tampered";
}
```

- [ ] **Step 4: Wire the tamper check into `src/runners/ralph-loop.ts`**

Add the import at the top:

```typescript
import { hashConfigDir as realHashConfigDir } from "../config/config-hash";
import { revParseHead, stageAll, diffCached, commit, checkoutClean, checkoutConfigOnly } from "../git";
```

(This replaces the existing `import { revParseHead, stageAll, diffCached, commit, checkoutClean } from "../git";` line — add `checkoutConfigOnly` to it.)

Extend `RalphLoopDeps`:

```typescript
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
    checkoutClean: typeof checkoutClean;
    checkoutConfigOnly: typeof checkoutConfigOnly;
  };
  hashConfigDir: (cwd: string) => string;
}
```

Update `defaultDeps`:

```typescript
const defaultDeps: RalphLoopDeps = {
  runAgentTask: realRunAgentTask,
  runReviewGate: (config, reviewerProfile, cwd, diff, acceptance) =>
    realRunReviewGate(config, reviewerProfile, cwd, diff, acceptance),
  git: { revParseHead, stageAll, diffCached, commit, checkoutClean, checkoutConfigOnly },
  hashConfigDir: realHashConfigDir,
};
```

In `runRalphLoopOnce`, insert the hash-before capture right before the agent call and the check right after it, replacing:

```typescript
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
```

with:

```typescript
  await deps.git.revParseHead(cwd);
  const configHashBefore = deps.hashConfigDir(cwd);

  const agentResult = await deps.runAgentTask({
    profile: mainDevProfile,
    prompt,
    cwd,
    timeoutMs: 10 * 60 * 1000,
    runDir,
    stage: stageConfig.id,
    story: story.id,
  });

  if (agentResult.ok && deps.hashConfigDir(cwd) !== configHashBefore) {
    await deps.git.checkoutConfigOnly(cwd);
    const updatedPrd = recordStoryFailure(prd, story.id, stageConfig.per_story_fix_limit);
    writePrd(prdPath, updatedPrd);
    appendFileSync(
      fixListPath,
      `\n## ${story.id} (round ${updatedPrd.stories.find((s) => s.id === story.id)!.fixCount})\n检测到 \`.aiflow/config/\` 在本轮被修改，已自动恢复并记为门禁失败。\n`
    );
    appendEvent(runDir, {
      ts: new Date().toISOString(),
      type: "gate_result",
      stage: stageConfig.id,
      story: story.id,
      checks: "fail",
      ai_review: "skipped",
      blockers: 0,
      reason: "config_tampered",
    });
    const suspended = updatedPrd.stories.find((s) => s.id === story.id)!.suspended === true;
    const result = suspended ? "suspended" : "fail";
    appendEvent(runDir, { ts: new Date().toISOString(), type: "story_result", story: story.id, result });
    return { storyId: story.id, result, usage: agentResult.usage };
  }

  if (!agentResult.ok) {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/unit/ralph-loop.test.ts`
Expected: PASS (all existing tests + 2 new ones — existing tests are unaffected because `fixedGit()` in the test file needs `checkoutConfigOnly` added to stay type-compatible; see Step 5b)

- [ ] **Step 5b: Update the `fixedGit()` test helper**

In `test/unit/ralph-loop.test.ts`, change:

```typescript
function fixedGit() {
  return {
    revParseHead: mock(async () => "abc123"),
    stageAll: mock(async () => {}),
    diffCached: mock(async () => "diff content"),
    commit: mock(async () => {}),
    checkoutClean: mock(async () => {}),
  };
}
```

to:

```typescript
function fixedGit() {
  return {
    revParseHead: mock(async () => "abc123"),
    stageAll: mock(async () => {}),
    diffCached: mock(async () => "diff content"),
    commit: mock(async () => {}),
    checkoutClean: mock(async () => {}),
    checkoutConfigOnly: mock(async () => {}),
  };
}
```

Also add `checkoutConfigOnly: mock(async () => {})` to every inline `git = { revParseHead: ..., ... }` object literal in this file that doesn't use `fixedGit()` (the three tests in Step 1 of Task 1's neighbor file — actually in this file: the "a passing gate...", "a failing gate...", and "an agent task that fails..." tests each construct `git` inline). Add the field to each of those three object literals too.

- [ ] **Step 6: Run the full test suite**

Run: `bun test ./test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/runners/ralph-loop.ts src/events/events.ts test/unit/ralph-loop.test.ts
git commit -m "feat: fail the gate and revert .aiflow/config when ralph_loop's agent modifies it"
```

---

### Task 6: Schema additions — pricing fields and `budget`

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/engine/state.ts`
- Test: `test/unit/config.test.ts`
- Test: `test/unit/state.test.ts`

**Interfaces:**
- Produces: `ModelProfileSchema` gains `input_cost_per_1m?: number`, `output_cost_per_1m?: number`. `PipelineConfigSchema` gains `budget?: { max_cost_usd: number }`. `EngineState` gains `budget?: { limit_usd: number }`. `StageStopReason`/`RalphLoopStopReason` gain `"budget_exceeded"`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/config.test.ts`:

```typescript
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
```

Append to `test/unit/state.test.ts`:

```typescript
test("writeStateAtomic then readState round-trips a budget field", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-state-test-"));
  try {
    const state: EngineState = {
      run_id: "r1",
      pipeline: "ralph-only",
      stages: [],
      cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
      budget: { limit_usd: 20 },
    };
    writeStateAtomic(dir, state);
    const loaded = readState(dir);
    expect(loaded).toEqual(state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeStateAtomic then readState round-trips a stage with reason budget_exceeded", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-state-test-"));
  try {
    const state: EngineState = {
      run_id: "r1",
      pipeline: "ralph-only",
      stages: [{ id: "develop", status: "paused", reason: "budget_exceeded" }],
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

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/config.test.ts test/unit/state.test.ts`
Expected: FAIL — zod strips/rejects unknown fields depending on schema strictness, and TypeScript rejects `reason: "budget_exceeded"` / `budget: {...}` as not assignable.

- [ ] **Step 3: Update `src/config/schema.ts`**

Change `ModelProfileSchema`:

```typescript
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
  input_cost_per_1m: z.number().nonnegative().optional(),
  output_cost_per_1m: z.number().nonnegative().optional(),
});
```

Change `PipelineConfigSchema`:

```typescript
export const BudgetConfigSchema = z.object({
  max_cost_usd: z.number().positive(),
});
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

export const PipelineConfigSchema = z.object({
  name: z.string(),
  budget: BudgetConfigSchema.optional(),
  stages: z.array(StageConfigSchema).min(1),
});
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
```

- [ ] **Step 4: Update `src/engine/state.ts`**

Change:

```typescript
export type RalphLoopStopReason = "max_iterations" | "stall" | "stories_suspended";
export type StageStopReason = RalphLoopStopReason | "human_gate_timeout" | "human_gate_rejected";
```

to:

```typescript
export type RalphLoopStopReason = "max_iterations" | "stall" | "stories_suspended" | "budget_exceeded";
export type StageStopReason = RalphLoopStopReason | "human_gate_timeout" | "human_gate_rejected";
```

Change `EngineState`:

```typescript
export interface EngineState {
  run_id: string;
  pipeline: string;
  requirement?: string;
  stages: StageState[];
  cost: { input_tokens: number; output_tokens: number; est_usd: number };
  budget?: { limit_usd: number };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/unit/config.test.ts test/unit/state.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `bun test ./test`
Expected: PASS (also check `src/engine/engine.ts`'s `VALID_STAGE_STOP_REASONS` set — it's a plain runtime `Set<string>`, not derived from the type, so it does NOT need editing yet; Task 9 adds `"budget_exceeded"` to it when it's actually produced.)

- [ ] **Step 7: Commit**

```bash
git add src/config/schema.ts src/engine/state.ts test/unit/config.test.ts test/unit/state.test.ts
git commit -m "feat: add budget config/state fields and budget_exceeded stop reason"
```

---

### Task 7: Real HTTP cost accounting (`llm/client.ts`, `review-gate.ts`, `doctor.ts`)

**Files:**
- Modify: `src/llm/client.ts`
- Modify: `src/gate/review-gate.ts`
- Modify: `src/commands/doctor.ts`
- Test: `test/unit/llm-client.test.ts`
- Test: `test/unit/review-gate.test.ts`
- Test: `test/unit/doctor.test.ts`

**Interfaces:**
- Produces: `callLlm` computes real `costUsd` from `profile.input_cost_per_1m`/`output_cost_per_1m`. `callReviewer` now returns `Promise<{ data: unknown; usage: LlmCallResult["usage"] }>` instead of `Promise<unknown>`. `ReviewGateOutcome` gains `usage?: { inTok: number; outTok: number; costUsd: number }`.
- Consumes: `ModelProfile.input_cost_per_1m`/`output_cost_per_1m` from Task 6.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/llm-client.test.ts`:

```typescript
test("callLlm computes real costUsd from input_cost_per_1m/output_cost_per_1m when configured", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const pricedProfile: ModelProfile = { ...profile, input_cost_per_1m: 1, output_cost_per_1m: 2 };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 } }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const result = await callLlm({ profile: pricedProfile, prompt: "x", fetchFn: fakeFetch });
  // 1_000_000 tok @ $1/1M = $1.00; 500_000 tok @ $2/1M = $1.00; total $2.00
  expect(result.usage.costUsd).toBeCloseTo(2, 5);
});

test("callLlm leaves costUsd at 0 when no pricing is configured on the profile", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const result = await callLlm({ profile, prompt: "x", fetchFn: fakeFetch });
  expect(result.usage.costUsd).toBe(0);
});

test("callReviewer returns both the parsed JSON payload and usage", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ summary: "ok", issues: [] }) } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const result = await callReviewer(profile, "review this diff", fakeFetch);
  expect(result.data).toEqual({ summary: "ok", issues: [] });
  expect(result.usage).toEqual({ inTok: 5, outTok: 2, costUsd: 0 });
});
```

Update the existing `"callReviewer sends an OpenAI-compatible chat completion request and returns parsed JSON content"` test's final assertion from:

```typescript
  const result = await callReviewer(profile, "review this diff", fakeFetch);
  expect(result).toEqual({ summary: "ok", issues: [] });
```

to:

```typescript
  const result = await callReviewer(profile, "review this diff", fakeFetch);
  expect(result.data).toEqual({ summary: "ok", issues: [] });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/llm-client.test.ts`
Expected: FAIL — `costUsd` stays 0 regardless of pricing, and `callReviewer`'s return shape doesn't have `.data`/`.usage`.

- [ ] **Step 3: Update `src/llm/client.ts`**

Change the cost computation inside `callLlm`'s `withRetry` callback — replace:

```typescript
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
```

with:

```typescript
    const data = (await response.json()) as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const inTok = data.usage?.prompt_tokens ?? 0;
    const outTok = data.usage?.completion_tokens ?? 0;
    const costUsd =
      profile.input_cost_per_1m !== undefined && profile.output_cost_per_1m !== undefined
        ? (inTok / 1_000_000) * profile.input_cost_per_1m + (outTok / 1_000_000) * profile.output_cost_per_1m
        : 0;
    return {
      text: data.choices[0].message.content,
      usage: { inTok, outTok, costUsd },
    };
```

Change `callReviewer`'s signature and body — replace:

```typescript
export async function callReviewer(
  profile: ModelProfile,
  prompt: string,
  fetchFn: typeof fetch = fetch
): Promise<unknown> {
  const result = await callLlm({ profile, prompt, jsonMode: true, thinking: false, fetchFn });
  return JSON.parse(result.text);
}
```

with:

```typescript
export interface ReviewerCallResult {
  data: unknown;
  usage: LlmCallResult["usage"];
}

export async function callReviewer(
  profile: ModelProfile,
  prompt: string,
  fetchFn: typeof fetch = fetch
): Promise<ReviewerCallResult> {
  const result = await callLlm({ profile, prompt, jsonMode: true, thinking: false, fetchFn });
  return { data: JSON.parse(result.text), usage: result.usage };
}
```

- [ ] **Step 4: Update `src/gate/review-gate.ts`**

Change the `ReviewGateDeps` interface and `ReviewGateOutcome`:

```typescript
export interface ReviewGateOutcome {
  checks: "pass" | "fail";
  aiReview: "pass" | "fail" | "skipped";
  blockers: number;
  checkOutput?: string;
  reviewOutput?: ReviewOutput;
  usage?: { inTok: number; outTok: number; costUsd: number };
}

export interface ReviewGateDeps {
  runChecks: (commands: string[], cwd: string) => Promise<CheckResult>;
  callReviewer: (profile: ModelProfile, prompt: string) => Promise<{ data: unknown; usage: { inTok: number; outTok: number; costUsd: number } }>;
}
```

Update the retry loop in `runReviewGate` — replace:

```typescript
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
```

with:

```typescript
  const prompt = buildReviewPrompt(diff, storyAcceptance);
  let lastError: unknown;
  const usage = { inTok: 0, outTok: 0, costUsd: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data: raw, usage: callUsage } = await deps.callReviewer(
        reviewerProfile,
        attempt === 0 ? prompt : `${prompt}\n\nYour previous response failed to parse as the required JSON shape: ${String(lastError)}`
      );
      usage.inTok += callUsage.inTok;
      usage.outTok += callUsage.outTok;
      usage.costUsd += callUsage.costUsd;
      const parsed = ReviewOutputSchema.safeParse(raw);
      if (parsed.success) {
        const blockers = countBlockers(parsed.data, config.ai_review.fail_on);
        const overThreshold = exceedsThreshold(parsed.data, config.ai_review.fail_threshold);
        const aiReview = blockers > 0 || overThreshold ? "fail" : "pass";
        return { checks: "pass", aiReview, blockers, reviewOutput: parsed.data, usage };
      }
      lastError = parsed.error;
    } catch (err) {
      lastError = err;
    }
  }

  return {
    checks: "pass",
    aiReview: config.ai_review.strict ? "fail" : "pass",
    blockers: config.ai_review.strict ? 1 : 0,
    usage,
  };
```

- [ ] **Step 5: Update `test/unit/review-gate.test.ts`'s five `callReviewer` mocks**

Each `mock(async () => ({ summary: ..., issues: [...] }))` must be wrapped as `mock(async () => ({ data: { summary: ..., issues: [...] }, usage: { inTok: 0, outTok: 0, costUsd: 0 } }))`. For example, change:

```typescript
  const callReviewer = mock(async () => ({ summary: "unused", issues: [] }));
```

to:

```typescript
  const callReviewer = mock(async () => ({ data: { summary: "unused", issues: [] }, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
```

Apply the same wrapping to the other four mocks in that file (`"looks fine"` with a minor issue, `"found a problem"` with a blocker, and the two `{ not: "valid shape" }` parse-failure mocks — those become `{ data: { not: "valid shape" }, usage: { inTok: 0, outTok: 0, costUsd: 0 } }`).

- [ ] **Step 6: Update `src/commands/doctor.ts`'s `DoctorDeps` type**

Change:

```typescript
export interface DoctorDeps {
  checkOpenCodeVersion: () => Promise<string | null>;
  checkGitRepo: (cwd: string) => Promise<boolean>;
  callReviewer: (profile: ModelProfile, prompt: string) => Promise<unknown>;
}
```

to:

```typescript
export interface DoctorDeps {
  checkOpenCodeVersion: () => Promise<string | null>;
  checkGitRepo: (cwd: string) => Promise<boolean>;
  callReviewer: (profile: ModelProfile, prompt: string) => Promise<{ data: unknown; usage: { inTok: number; outTok: number; costUsd: number } }>;
}
```

(`runDoctorChecks`'s body doesn't inspect the return value, so no other change is needed there.)

- [ ] **Step 7: Update `test/unit/doctor.test.ts`'s four `callReviewer` mocks**

Wrap each, e.g. change:

```typescript
    callReviewer: mock(async () => ({ summary: "pong", issues: [] })),
```

to:

```typescript
    callReviewer: mock(async () => ({ data: { summary: "pong", issues: [] }, usage: { inTok: 0, outTok: 0, costUsd: 0 } })),
```

and the two `mock(async () => ({}))` to `mock(async () => ({ data: {}, usage: { inTok: 0, outTok: 0, costUsd: 0 } }))`. The throwing mock (`throw new Error("401 unauthorized")`) is unaffected.

- [ ] **Step 8: Run the full suite**

Run: `bun test ./test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/llm/client.ts src/gate/review-gate.ts src/commands/doctor.ts test/unit/llm-client.test.ts test/unit/review-gate.test.ts test/unit/doctor.test.ts
git commit -m "feat: compute real HTTP-channel cost and propagate reviewer usage through the gate"
```

---

### Task 8: Budget tracker module

**Files:**
- Create: `src/gate/budget.ts`
- Test: `test/unit/budget.test.ts`

**Interfaces:**
- Produces: `createBudgetTracker(limitUsd: number | undefined, initialSpentUsd: number): BudgetTracker`, `noopBudgetTracker: BudgetTracker`, `interface BudgetTracker { limitUsd?: number; record(deltaUsd: number): boolean }`. Consumed by Task 9 (engine.ts) and Task 10/11 (runners).

- [ ] **Step 1: Write the failing tests**

Create `test/unit/budget.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { createBudgetTracker, noopBudgetTracker } from "../../src/gate/budget";

test("record() returns false while cumulative spend stays under the limit", () => {
  const tracker = createBudgetTracker(10, 0);
  expect(tracker.record(3)).toBe(false);
  expect(tracker.record(4)).toBe(false);
});

test("record() returns true once cumulative spend reaches the limit", () => {
  const tracker = createBudgetTracker(10, 0);
  expect(tracker.record(6)).toBe(false);
  expect(tracker.record(4)).toBe(true);
});

test("record() accounts for spend already made in prior stages via initialSpentUsd", () => {
  const tracker = createBudgetTracker(10, 9);
  expect(tracker.record(1)).toBe(true);
});

test("an undefined limitUsd never reports exceeded regardless of spend", () => {
  const tracker = createBudgetTracker(undefined, 0);
  expect(tracker.record(1_000_000)).toBe(false);
});

test("noopBudgetTracker never reports exceeded", () => {
  expect(noopBudgetTracker.record(1_000_000)).toBe(false);
  expect(noopBudgetTracker.limitUsd).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/budget.test.ts`
Expected: FAIL — `Cannot find module '../../src/gate/budget'`

- [ ] **Step 3: Implement `src/gate/budget.ts`**

```typescript
export interface BudgetTracker {
  limitUsd?: number;
  /** Records a newly-spent amount and returns true if the cumulative total has now reached the limit. */
  record(deltaUsd: number): boolean;
}

export function createBudgetTracker(limitUsd: number | undefined, initialSpentUsd: number): BudgetTracker {
  let spent = initialSpentUsd;
  return {
    limitUsd,
    record(deltaUsd: number): boolean {
      spent += deltaUsd;
      return limitUsd !== undefined && spent >= limitUsd;
    },
  };
}

export const noopBudgetTracker: BudgetTracker = { limitUsd: undefined, record: () => false };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/budget.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/gate/budget.ts test/unit/budget.test.ts
git commit -m "feat: add budget tracker for cumulative-spend circuit breaking"
```

---

### Task 9: Thread the budget tracker through the engine

**Files:**
- Modify: `src/engine/engine.ts`
- Test: `test/unit/engine.test.ts`

**Interfaces:**
- Consumes: `createBudgetTracker`, `BudgetTracker`, `noopBudgetTracker` (Task 8).
- Produces: `StageRunnerFn` gains a final optional `budget: BudgetTracker` parameter (defaults applied by the engine itself, not by the type — every runner implementation accepts it as its own last optional param starting Task 10/11).

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine.test.ts`:

```typescript
test("runPipelineOnce builds a budget tracker from pipeline.budget and passes it to the runner", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const budgetPipeline: PipelineConfig = { ...pipeline, budget: { max_cost_usd: 5 } };
    let seenLimit: number | undefined;
    const ralphLoop = mock(async (_stage, _stageState, _profiles, _cwd, _runDir, _nowFn, _signal, budget) => {
      seenLimit = budget?.limitUsd;
      return { result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } };
    });
    const state = await runPipelineOnce(budgetPipeline, profiles, "/tmp/does-not-matter", runDir, {
      runners: { ralph_loop: ralphLoop },
    });
    expect(seenLimit).toBe(5);
    expect(state.budget).toEqual({ limit_usd: 5 });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce's budget tracker for a later stage starts from the cost already spent in earlier stages", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    const twoStagePipeline: PipelineConfig = {
      name: "two-stage",
      budget: { max_cost_usd: 10 },
      stages: [
        { id: "first", type: "ralph_loop", model: "main-dev", per_story_fix_limit: 3, max_iterations: 10, stall_limit: 3, auto_clean: false, gate: { checks: [], ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] } } },
        { id: "second", type: "ralph_loop", model: "main-dev", per_story_fix_limit: 3, max_iterations: 10, stall_limit: 3, auto_clean: false, gate: { checks: [], ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] } } },
      ],
    };
    let secondStageExceeded: boolean | undefined;
    const ralphLoop = mock(async (stage, _stageState, _profiles, _cwd, _runDir, _nowFn, _signal, budget) => {
      if (stage.id === "second") secondStageExceeded = budget?.record(0.000001);
      return { result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: stage.id === "first" ? 10 : 0 } };
    });
    await runPipelineOnce(twoStagePipeline, profiles, "/tmp/does-not-matter", runDir, {
      runners: { ralph_loop: ralphLoop },
    });
    expect(secondStageExceeded).toBe(true);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce with no pipeline.budget passes a tracker with limitUsd undefined", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  try {
    let seenLimit: number | undefined = -1;
    const ralphLoop = mock(async (_stage, _stageState, _profiles, _cwd, _runDir, _nowFn, _signal, budget) => {
      seenLimit = budget?.limitUsd;
      return { result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } };
    });
    await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, { runners: { ralph_loop: ralphLoop } });
    expect(seenLimit).toBeUndefined();
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/engine.test.ts -t "budget"`
Expected: FAIL — runner is called with 7 args, `budget` is always `undefined`, and `state.budget` is never set.

- [ ] **Step 3: Update `src/engine/engine.ts`**

Add the import:

```typescript
import { createBudgetTracker, type BudgetTracker } from "../gate/budget";
```

Change `StageRunnerFn`:

```typescript
export type StageRunnerFn = (
  stageConfig: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  signal?: AbortSignal,
  budget?: BudgetTracker
) => Promise<StageOutcome>;
```

Update the 5 adapter functions (`adaptRalphLoop`, `adaptBrainstorm`, `adaptSpec`, `adaptPlan`, `adaptHumanGate`) to accept and forward `budget`. Show `adaptRalphLoop` in full (the other four follow the identical pattern — add the parameter and pass it through as the runner's final argument):

```typescript
async function adaptRalphLoop(
  stageConfig: StageConfig,
  _stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  _nowFn: () => Date,
  signal?: AbortSignal,
  budget?: BudgetTracker
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
    signal,
    budget
  );
  return { result: summary.result, reason: summary.reason, usage: summary.usage };
}
```

For `adaptBrainstorm`, `adaptSpec`, `adaptPlan` — each already ends in `(stageConfig, stageState, profiles, cwd, runDir, nowFn, signal)` calling e.g. `runBrainstormStage(stageConfig as BrainstormStageConfig, stageState, profiles, cwd, runDir, nowFn, signal)`. Add the `budget?: BudgetTracker` parameter to the adapter's own signature and append it as the call's final argument, e.g.:

```typescript
async function adaptBrainstorm(
  stageConfig: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  signal?: AbortSignal,
  budget?: BudgetTracker
): Promise<StageOutcome> {
  return runBrainstormStage(stageConfig as BrainstormStageConfig, stageState, profiles, cwd, runDir, nowFn, signal, undefined, budget);
}
```

(`undefined` here is `runBrainstormStage`'s existing `deps` parameter, kept at its default — Task 11 gives `budget` its actual final position once `runBrainstormStage`'s own signature is extended. If `bun test`/`tsc` complains about argument count/order here before Task 11 lands, that's expected — resolve by doing Task 11's signature change first if working out of order.) Apply the same pattern to `adaptSpec` (calling `runSpecStage`) and `adaptPlan` (calling `runPlanStage`). `adaptHumanGate` ignores `budget` entirely (add the parameter for signature consistency but don't use it):

```typescript
async function adaptHumanGate(
  stageConfig: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  signal?: AbortSignal,
  _budget?: BudgetTracker
): Promise<StageOutcome> {
  return runHumanGateStage(stageConfig as HumanGateStageConfig, stageState, profiles, cwd, runDir, nowFn, signal);
}
```

Update `executeStage` to build and pass the tracker:

```typescript
async function executeStage(
  stage: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  deps: EngineDeps,
  signal: AbortSignal | undefined,
  budget: BudgetTracker,
): Promise<StageExecutionResult> {
  if (signal?.aborted) return { state: { id: stage.id, status: "paused" } };

  const runner = deps.runners[stage.type];
  if (!runner) throw new Error(`No runner registered for stage type "${stage.type}"`);

  const outcome = await runner(stage, stageState, profiles, cwd, runDir, nowFn, signal, budget);
  const status = STATUS_MAP[outcome.result];
  const entered_at = outcome.entered_at ?? stageState.entered_at;
  return {
    state: { id: stage.id, status, reason: toStageStopReason(outcome.reason), entered_at },
    usage: outcome.usage,
  };
}
```

Finally, in `runPipelineOnce`, set `state.budget` right after the initial (non-resume) state is built, and construct a fresh `BudgetTracker` per stage inside the main loop. Replace:

```typescript
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
```

with:

```typescript
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
      ...(pipeline.budget ? { budget: { limit_usd: pipeline.budget.max_cost_usd } } : {}),
    };
  }
  writeStateAtomic(runDir, state);
```

And replace the `executeStage` call site inside the `for` loop:

```typescript
    const execResult = await executeStage(stage, stageState, profiles, cwd, runDir, nowFn, effectiveDeps, signal);
```

with:

```typescript
    const budgetTracker = createBudgetTracker(state.budget?.limit_usd, state.cost.est_usd);
    const execResult = await executeStage(stage, stageState, profiles, cwd, runDir, nowFn, effectiveDeps, signal, budgetTracker);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/engine.test.ts`
Expected: PASS (all existing + 3 new)

- [ ] **Step 5: Run the full suite**

Run: `bun test ./test`
Expected: Compile errors are expected/acceptable only in `brainstorm.ts`/`spec.ts`/`plan.ts` call sites until Task 11 lands (see the ordering note in Step 3). `ralph-loop.ts` (via `realRunRalphLoop`) needs its own signature updated — that's Task 10.

- [ ] **Step 6: Commit**

```bash
git add src/engine/engine.ts test/unit/engine.test.ts
git commit -m "feat: thread a per-stage BudgetTracker through the engine's StageRunnerFn"
```

---

### Task 10: Budget checks in `ralph_loop`

**Files:**
- Modify: `src/runners/ralph-loop.ts`
- Test: `test/unit/ralph-loop.test.ts`

**Interfaces:**
- Consumes: `BudgetTracker`, `noopBudgetTracker` (Task 8); `budget` param threaded by Task 9.
- Produces: `RalphLoopResult.result` gains `"paused"`; `runRalphLoopOnce` and `runRalphLoop` each accept a final optional `budget: BudgetTracker = noopBudgetTracker` parameter.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/ralph-loop.test.ts`:

```typescript
test("runRalphLoopOnce stops before the review gate when the agent call alone exceeds the budget", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 10, outTok: 5, costUsd: 6 } }));
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();
    const budget = createBudgetTracker(5, 0);

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
    }, budget);

    expect(result.result).toBe("paused");
    expect(runReviewGate).not.toHaveBeenCalled();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop stops the loop with reason budget_exceeded once cumulative spend reaches the limit", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(twoStoryPrd());
  try {
    const runAgentTask = alwaysOkAgent({ inTok: 1, outTok: 1, costUsd: 3 });
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();
    const budget = createBudgetTracker(5, 0);

    const summary = await runRalphLoop(loopStageConfig(), profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
    }, undefined, budget);

    expect(summary.result).toBe("paused");
    expect(summary.reason).toBe("budget_exceeded");
    expect(summary.iterations).toBe(2); // US-1 passes at cost 3, US-2's agent call brings total to 6 >= 5 and stops
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runRalphLoop with no budget tracker argument behaves exactly as before (no limit)", async () => {
  const { cwd, runDir } = makeFixtureDirsWith(samplePrd());
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
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

Add `createBudgetTracker` to the existing imports at the top of the file: `import { createBudgetTracker } from "../../src/gate/budget";`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/ralph-loop.test.ts -t "budget"`
Expected: FAIL — `runRalphLoopOnce`/`runRalphLoop` don't accept a `budget` argument yet, and never return `"paused"` for cost reasons.

- [ ] **Step 3: Update `src/runners/ralph-loop.ts`**

Add the import: `import { noopBudgetTracker, type BudgetTracker } from "../gate/budget";`.

Change `RalphLoopResult`:

```typescript
export interface RalphLoopResult {
  storyId: string;
  result: "pass" | "fail" | "suspended" | "paused";
  usage: { inTok: number; outTok: number; costUsd: number };
}
```

Change `runRalphLoopOnce`'s signature (append `budget`) — replace:

```typescript
export async function runRalphLoopOnce(
  stageConfig: RalphLoopStageConfig,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  specExcerpt: string,
  deps: RalphLoopDeps = defaultDeps
): Promise<RalphLoopResult> {
```

with:

```typescript
export async function runRalphLoopOnce(
  stageConfig: RalphLoopStageConfig,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  specExcerpt: string,
  deps: RalphLoopDeps = defaultDeps,
  budget: BudgetTracker = noopBudgetTracker
): Promise<RalphLoopResult> {
```

Insert the budget check right after the agent call succeeds and before the config-tamper check added in Task 5 — replace the block:

```typescript
  if (agentResult.ok && deps.hashConfigDir(cwd) !== configHashBefore) {
```

with:

```typescript
  if (agentResult.ok && budget.record(agentResult.usage.costUsd)) {
    return { storyId: story.id, result: "paused", usage: agentResult.usage };
  }

  if (agentResult.ok && deps.hashConfigDir(cwd) !== configHashBefore) {
```

Add a second budget check after the review gate call succeeds — replace:

```typescript
  const gateOutcome = await deps.runReviewGate(stageConfig.gate, reviewerProfile, cwd, diff, story.acceptance);

  appendEvent(runDir, {
```

with:

```typescript
  const gateOutcome = await deps.runReviewGate(stageConfig.gate, reviewerProfile, cwd, diff, story.acceptance);
  const totalUsage = {
    inTok: agentResult.usage.inTok + (gateOutcome.usage?.inTok ?? 0),
    outTok: agentResult.usage.outTok + (gateOutcome.usage?.outTok ?? 0),
    costUsd: agentResult.usage.costUsd + (gateOutcome.usage?.costUsd ?? 0),
  };

  if (gateOutcome.usage && budget.record(gateOutcome.usage.costUsd)) {
    return { storyId: story.id, result: "paused", usage: totalUsage };
  }

  appendEvent(runDir, {
```

Now replace every remaining `usage: agentResult.usage` return in the rest of the function with `usage: totalUsage`, so the reviewer's cost is reflected in the final result. Specifically, in the "gate passed" branch:

```typescript
  if (gatePassed) {
    const updatedPrd = markStoryPassed(prd, story.id);
    writePrd(prdPath, updatedPrd);
    await deps.git.stageAll(cwd);
    await deps.git.commit(cwd, `feat(${story.id}): ${story.title}`);
    appendFileSync(progressPath, `\n## ${story.id}\n${story.title} — passed checks and AI review.\n`);
    appendEvent(runDir, { ts: new Date().toISOString(), type: "story_result", story: story.id, result: "pass" });
    return { storyId: story.id, result: "pass", usage: totalUsage };
  }
```

and in the final return at the end of the function:

```typescript
  const suspended = updatedPrd.stories.find((s) => s.id === story.id)!.suspended === true;
  const result = suspended ? "suspended" : "fail";
  appendEvent(runDir, { ts: new Date().toISOString(), type: "story_result", story: story.id, result });
  return { storyId: story.id, result, usage: totalUsage };
```

(Leave the two earlier early-return paths — the `!agentResult.ok` branch and the config-tamper branch from Task 5 — using `agentResult.usage`, since neither of those reaches the review gate call.)

Change `runRalphLoop`'s signature (append `budget` after the existing `signal` parameter) — replace:

```typescript
export async function runRalphLoop(
  stageConfig: RalphLoopStageConfig,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  specExcerpt: string,
  deps: RalphLoopDeps = defaultDeps,
  signal?: AbortSignal
): Promise<RalphLoopSummary> {
```

with:

```typescript
export async function runRalphLoop(
  stageConfig: RalphLoopStageConfig,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  specExcerpt: string,
  deps: RalphLoopDeps = defaultDeps,
  signal?: AbortSignal,
  budget: BudgetTracker = noopBudgetTracker
): Promise<RalphLoopSummary> {
```

Pass `budget` through to `runRalphLoopOnce`, and handle its `"paused"` result — replace:

```typescript
    iterations += 1;
    const suspendedBefore = countStories(prd).suspended;

    const onceResult = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, specExcerpt, deps);
    usage.inTok += onceResult.usage.inTok;
    usage.outTok += onceResult.usage.outTok;
    usage.costUsd += onceResult.usage.costUsd;

    const prdAfter = readPrd(prdPath);
```

with:

```typescript
    iterations += 1;
    const suspendedBefore = countStories(prd).suspended;

    const onceResult = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, specExcerpt, deps, budget);
    usage.inTok += onceResult.usage.inTok;
    usage.outTok += onceResult.usage.outTok;
    usage.costUsd += onceResult.usage.costUsd;

    if (onceResult.result === "paused") {
      const outcome: RalphLoopSummary = { result: "paused", reason: "budget_exceeded", iterations, usage };
      emitLoopResult(runDir, stageConfig.id, prd, outcome);
      return outcome;
    }

    const prdAfter = readPrd(prdPath);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/ralph-loop.test.ts`
Expected: PASS (all existing + 3 new)

- [ ] **Step 5: Run the full suite**

Run: `bun test ./test`
Expected: `engine.ts`'s `VALID_STAGE_STOP_REASONS` set must include `"budget_exceeded"` for it to survive `toStageStopReason` — add it now:

In `src/engine/engine.ts`, change:

```typescript
const VALID_STAGE_STOP_REASONS = new Set<string>([
  "max_iterations",
  "stall",
  "stories_suspended",
  "human_gate_timeout",
  "human_gate_rejected",
]);
```

to:

```typescript
const VALID_STAGE_STOP_REASONS = new Set<string>([
  "max_iterations",
  "stall",
  "stories_suspended",
  "human_gate_timeout",
  "human_gate_rejected",
  "budget_exceeded",
]);
```

Then re-run: `bun test ./test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/runners/ralph-loop.ts src/engine/engine.ts test/unit/ralph-loop.test.ts
git commit -m "feat: stop ralph_loop immediately when a call pushes cumulative spend over budget"
```

---

### Task 11: Budget checks in `brainstorm`, `spec`, `plan`

**Files:**
- Modify: `src/runners/brainstorm.ts`
- Modify: `src/runners/spec.ts`
- Modify: `src/runners/plan.ts`
- Modify: `src/engine/engine.ts` (fix the placeholder `undefined` budget-forwarding from Task 9, Step 3)
- Test: `test/unit/brainstorm.test.ts`
- Test: `test/unit/spec.test.ts`
- Test: `test/unit/plan.test.ts`

**Interfaces:**
- Consumes: `BudgetTracker`, `noopBudgetTracker` (Task 8).
- Produces: `runBrainstormStage`, `runSpecStage`, `runPlanStage` each accept a final optional `budget: BudgetTracker = noopBudgetTracker` parameter; each returns `{ result: "paused", reason: "budget_exceeded" }` as a `StageOutcome` when exceeded (not a local sub-result type, since these three already return `StageOutcome` directly, unlike ralph-loop's internal `RalphLoopResult`/`RalphLoopSummary`).

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/brainstorm.test.ts` (check the file's existing `profiles`/`stageConfig` fixtures first and reuse them; the shape below assumes fixtures similar to `ralph-loop.test.ts`'s — adjust names to match what's actually in this file):

```typescript
test("stops after the first fan-out round if it alone exceeds the budget, without starting a debate round", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-brainstorm-test-"));
  try {
    const callLlmFanOut = mock(async (profs: unknown[]) =>
      profs.map((p) => ({ profile: p, ok: true, result: { text: "idea", usage: { inTok: 1, outTok: 1, costUsd: 6 } } }))
    );
    const callLlm = mock(async () => ({ text: "synthesis", usage: { inTok: 1, outTok: 1, costUsd: 0 } }));
    const budget = createBudgetTracker(5, 0);

    const outcome = await runBrainstormStage(
      { id: "ideate", type: "brainstorm", models: ["main-dev", "reviewer"], mode: "debate", debate_rounds: 2, synthesizer: "main-dev", output: "brainstorm-report.md" },
      { id: "ideate", status: "running" },
      profiles,
      "/tmp/does-not-matter",
      runDir,
      () => new Date(),
      undefined,
      { callLlm, callLlmFanOut },
      budget
    );

    expect(outcome.result).toBe("paused");
    expect(outcome.reason).toBe("budget_exceeded");
    expect(callLlm).not.toHaveBeenCalled(); // synthesizer call never happens
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

(Read `test/unit/brainstorm.test.ts` first to confirm the exact `profiles` fixture name and any existing `mkdtempSync`/import pattern already in the file, and align this test's setup with it rather than introducing a second convention.)

Append to `test/unit/spec.test.ts`:

```typescript
test("returns paused/budget_exceeded without writing the output file when the agent call exceeds budget", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-spec-budget-test-"));
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-spec-budget-cwd-"));
  try {
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 6 } }));
    const budget = createBudgetTracker(5, 0);

    const outcome = await runSpecStage(
      { id: "spec", type: "spec", model: "main-dev", output: "spec.md" },
      { id: "spec", status: "running" },
      profiles,
      cwd,
      runDir,
      () => new Date(),
      undefined,
      { runAgentTask },
      budget
    );

    expect(outcome.result).toBe("paused");
    expect(outcome.reason).toBe("budget_exceeded");
    expect(existsSync(join(cwd, "spec.md"))).toBe(false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

(Again, align the `profiles` fixture and imports with whatever `test/unit/spec.test.ts` already declares.)

Append to `test/unit/plan.test.ts`:

```typescript
test("returns paused/budget_exceeded after a single call that exceeds budget, without a retry", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-plan-budget-test-"));
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-plan-budget-cwd-"));
  try {
    writeFileSync(join(cwd, "spec.md"), "# Spec");
    const callLlm = mock(async () => ({ text: "not json", usage: { inTok: 1, outTok: 1, costUsd: 6 } }));
    const budget = createBudgetTracker(5, 0);

    const outcome = await runPlanStage(
      { id: "plan", type: "plan", model: "main-dev", input: "spec.md", output: "prd.json" },
      { id: "plan", status: "running" },
      profiles,
      cwd,
      runDir,
      () => new Date(),
      undefined,
      { callLlm },
      budget
    );

    expect(outcome.result).toBe("paused");
    expect(outcome.reason).toBe("budget_exceeded");
    expect(callLlm).toHaveBeenCalledTimes(1); // no second attempt
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/brainstorm.test.ts test/unit/spec.test.ts test/unit/plan.test.ts -t "budget"`
Expected: FAIL — none of the three runners accept a `budget` argument yet.

- [ ] **Step 3: Update `src/runners/brainstorm.ts`**

Add the import: `import { noopBudgetTracker, type BudgetTracker } from "../gate/budget";`.

Change the signature — replace:

```typescript
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
```

with:

```typescript
export async function runBrainstormStage(
  stageConfig: BrainstormStageConfig,
  _stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  _nowFn: () => Date,
  _signal: AbortSignal | undefined,
  deps: BrainstormDeps = defaultDeps,
  budget: BudgetTracker = noopBudgetTracker
): Promise<StageOutcome> {
```

After the first round's success-count check, add a budget check before proceeding — replace:

```typescript
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
```

with:

```typescript
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
  let overBudget = budget.record(sumUsage([round1]).costUsd);

  if (stageConfig.mode === "debate") {
    for (let round = 2; round <= stageConfig.debate_rounds && !overBudget; round++) {
      const previous = finalRound;
      finalRound = await deps.callLlmFanOut(modelProfiles, (profile) => {
        const others = previous.filter((r) => r.profile !== profile && r.ok && r.result).map((r) => r.result!.text);
        return renderDebatePrompt(requirement, others);
      });
      rounds.push(finalRound);
      overBudget = budget.record(sumUsage([finalRound]).costUsd);
    }
  }

  if (overBudget) {
    return { result: "paused", reason: "budget_exceeded", usage: sumUsage(rounds) };
  }

  const synthesizerProfile = profiles[stageConfig.synthesizer];
  const synthesis = await deps.callLlm({
    profile: synthesizerProfile,
    prompt: renderSynthesisPrompt(requirement, finalRound),
    thinking: true,
  });

  if (budget.record(synthesis.usage.costUsd)) {
    return { result: "paused", reason: "budget_exceeded", usage: sumUsage(rounds, synthesis) };
  }
```

- [ ] **Step 4: Update `src/runners/spec.ts`**

Add the import: `import { noopBudgetTracker, type BudgetTracker } from "../gate/budget";`.

Change the signature — replace:

```typescript
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
```

with:

```typescript
export async function runSpecStage(
  stageConfig: SpecStageConfig,
  _stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  _nowFn: () => Date,
  _signal: AbortSignal | undefined,
  deps: SpecDeps = defaultDeps,
  budget: BudgetTracker = noopBudgetTracker
): Promise<StageOutcome> {
```

Insert the check right after the agent call, before the existing result computation — replace:

```typescript
  const outputExists = existsSync(join(cwd, stageConfig.output));
  const result: "pass" | "fail" = agentResult.ok && outputExists ? "pass" : "fail";
  appendEvent(runDir, { ts: new Date().toISOString(), type: "spec_result", stage: stageConfig.id, result });
  return { result, usage: agentResult.usage };
```

with:

```typescript
  if (budget.record(agentResult.usage.costUsd)) {
    return { result: "paused", reason: "budget_exceeded", usage: agentResult.usage };
  }

  const outputExists = existsSync(join(cwd, stageConfig.output));
  const result: "pass" | "fail" = agentResult.ok && outputExists ? "pass" : "fail";
  appendEvent(runDir, { ts: new Date().toISOString(), type: "spec_result", stage: stageConfig.id, result });
  return { result, usage: agentResult.usage };
```

- [ ] **Step 5: Update `src/runners/plan.ts`**

Add the import: `import { noopBudgetTracker, type BudgetTracker } from "../gate/budget";`.

Change the signature — replace:

```typescript
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
```

with:

```typescript
export async function runPlanStage(
  stageConfig: PlanStageConfig,
  _stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  _nowFn: () => Date,
  _signal: AbortSignal | undefined,
  deps: PlanDeps = defaultDeps,
  budget: BudgetTracker = noopBudgetTracker
): Promise<StageOutcome> {
```

Insert the check inside the retry loop, right after usage is accumulated — replace:

```typescript
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await deps.callLlm({ profile, prompt: renderPlanPrompt(specText, lastError), jsonMode: true });
    usage.inTok += result.usage.inTok;
    usage.outTok += result.usage.outTok;
    usage.costUsd += result.usage.costUsd;

    try {
```

with:

```typescript
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await deps.callLlm({ profile, prompt: renderPlanPrompt(specText, lastError), jsonMode: true });
    usage.inTok += result.usage.inTok;
    usage.outTok += result.usage.outTok;
    usage.costUsd += result.usage.costUsd;

    if (budget.record(result.usage.costUsd)) {
      return { result: "paused", reason: "budget_exceeded", usage };
    }

    try {
```

- [ ] **Step 6: Fix the placeholder budget-forwarding in `src/engine/engine.ts`'s adapters**

Update `adaptBrainstorm`, `adaptSpec`, `adaptPlan` (left as `undefined` in Task 9, Step 3) to forward the real `budget` argument in its correct final position. Replace:

```typescript
async function adaptBrainstorm(
  stageConfig: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  signal?: AbortSignal,
  budget?: BudgetTracker
): Promise<StageOutcome> {
  return runBrainstormStage(stageConfig as BrainstormStageConfig, stageState, profiles, cwd, runDir, nowFn, signal, undefined, budget);
}
```

with:

```typescript
async function adaptBrainstorm(
  stageConfig: StageConfig,
  stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,
  signal?: AbortSignal,
  budget?: BudgetTracker
): Promise<StageOutcome> {
  return runBrainstormStage(stageConfig as BrainstormStageConfig, stageState, profiles, cwd, runDir, nowFn, signal, undefined, budget ?? noopBudgetTracker);
}
```

Apply the identical `budget ?? noopBudgetTracker` fix to `adaptSpec`'s call to `runSpecStage` and `adaptPlan`'s call to `runPlanStage`. Add `noopBudgetTracker` to the existing `"../gate/budget"` import in `engine.ts`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test test/unit/brainstorm.test.ts test/unit/spec.test.ts test/unit/plan.test.ts test/unit/engine.test.ts`
Expected: PASS

- [ ] **Step 8: Run the full suite**

Run: `bun test ./test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/runners/brainstorm.ts src/runners/spec.ts src/runners/plan.ts src/engine/engine.ts test/unit/brainstorm.test.ts test/unit/spec.test.ts test/unit/plan.test.ts
git commit -m "feat: stop brainstorm/spec/plan immediately when a call pushes spend over budget"
```

---

### Task 12: `--raise-budget`, `runCommand`'s `runId` param, and doctor pricing note

**Files:**
- Modify: `src/commands/resume.ts`
- Modify: `src/commands/run.ts`
- Modify: `src/commands/doctor.ts`
- Test: `test/unit/resume.test.ts`
- Test: `test/unit/doctor.test.ts`

**Interfaces:**
- Produces: `runResume`'s `opts` gains `raiseBudget?: number`. `runCommand` gains a 6th optional parameter `runId?: string` (falls back to `createRunId()` when omitted — needed so Task 2's `cli.ts` can generate the id before acquiring the lock and pass the same id through). `DoctorReport` gains `pricingWarnings: string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/resume.test.ts`:

```typescript
test("resume with --raise-budget overrides state.budget.limit_usd while preserving cost already spent", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-resume-budget-"));
  try {
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({
        run_id: runDir.split("/").pop(),
        pipeline: "ralph-only",
        stages: [{ id: "develop", status: "paused", reason: "budget_exceeded" }],
        cost: { input_tokens: 100, output_tokens: 20, est_usd: 5 },
        budget: { limit_usd: 5 },
      })
    );
    const ralphLoop = mock(async () => ({ result: "pass" as const, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
    const result = await runResume(
      "/tmp/does-not-matter",
      { runId: runDir.split("/").pop(), pipeline: "ralph-only", raiseBudget: 50 },
      { runners: { ralph_loop: ralphLoop } }
    );
    expect(result.state?.budget).toEqual({ limit_usd: 50 });
    expect(result.state?.cost.est_usd).toBe(5);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

(Adjust `loadModelsConfig`/`loadPipelineConfig` fixture setup to match whatever `resume.test.ts` already does for its existing tests — read the file first, since `runResume` internally loads real config files from `cwd/.aiflow/config/...`, so the temp `cwd` needs a scaffolded config, not just `/tmp/does-not-matter`. Mirror the existing test file's `setupProject()`-style helper if one exists; otherwise scaffold `.aiflow/config/models.yaml` and `.aiflow/config/pipelines/ralph-only.yaml` inline the same way `test/integration/auto-clean.test.ts` does.)

Append to `test/unit/doctor.test.ts`:

```typescript
test("reports a pricing warning for a channel:http profile missing input_cost_per_1m/output_cost_per_1m", async () => {
  process.env.TEST_DOCTOR_KEY = "present";
  const deps = {
    checkOpenCodeVersion: mock(async () => "1.17.11"),
    checkGitRepo: mock(async () => true),
    callReviewer: mock(async () => ({ data: { summary: "pong", issues: [] }, usage: { inTok: 0, outTok: 0, costUsd: 0 } })),
  };
  const report = await runDoctorChecks("/tmp/whatever", reviewerProfile, deps);
  expect(report.pricingWarnings).toContain(
    "Profile has no input_cost_per_1m/output_cost_per_1m configured; its spend will not count toward budget or cost reports."
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/resume.test.ts test/unit/doctor.test.ts -t "budget\|pricing"`
Expected: FAIL — `raiseBudget` isn't accepted by `runResume`'s `opts`, and `DoctorReport` has no `pricingWarnings`.

- [ ] **Step 3: Update `src/commands/resume.ts`**

Change `runResume`'s signature and body — replace:

```typescript
export async function runResume(
  cwd: string,
  opts: { runId?: string; pipeline?: string; force?: boolean },
  deps?: EngineDeps,
  signal?: AbortSignal
): Promise<ResumeResult> {
  const runId = opts.runId ?? pickLatestRun(cwd);
  if (!runId) return { status: "no_runs", message: `No .aiflow/runs found in ${cwd}` };
  const runDir = join(cwd, ".aiflow", "runs", runId);
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) {
    return { status: "missing_run_dir", runId, message: `Run directory ${runDir} exists but has no state.json` };
  }
  const persisted = JSON.parse(readFileSync(statePath, "utf-8")) as EngineState;
  const pipelineName = opts.pipeline ?? persisted.pipeline;
  const wasTerminal = persisted.stages.every((s) => isTerminalStatus(s.status));

  const modelsConfig = loadModelsConfig(join(cwd, ".aiflow", "config", "models.yaml"));
  const pipelineConfig = loadPipelineConfig(join(cwd, ".aiflow", "config", "pipelines", `${pipelineName}.yaml`));

  const profiles: Record<string, ModelProfile> = modelsConfig.profiles;
  const state = await runPipelineOnce(
    pipelineConfig,
    profiles,
    cwd,
    runDir,
    deps,
    signal,
    { resume: true, force: opts.force ?? false },
  );

  if (wasTerminal && !opts.force) return { status: "noop_terminal", state, runId };
  return { status: "resumed", state, runId };
}
```

with:

```typescript
export async function runResume(
  cwd: string,
  opts: { runId?: string; pipeline?: string; force?: boolean; raiseBudget?: number },
  deps?: EngineDeps,
  signal?: AbortSignal
): Promise<ResumeResult> {
  const runId = opts.runId ?? pickLatestRun(cwd);
  if (!runId) return { status: "no_runs", message: `No .aiflow/runs found in ${cwd}` };
  const runDir = join(cwd, ".aiflow", "runs", runId);
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) {
    return { status: "missing_run_dir", runId, message: `Run directory ${runDir} exists but has no state.json` };
  }
  const persisted = JSON.parse(readFileSync(statePath, "utf-8")) as EngineState;
  const pipelineName = opts.pipeline ?? persisted.pipeline;
  const wasTerminal = persisted.stages.every((s) => isTerminalStatus(s.status));

  if (opts.raiseBudget !== undefined) {
    persisted.budget = { limit_usd: opts.raiseBudget };
    writeFileSync(statePath, JSON.stringify(persisted, null, 2));
  }

  const modelsConfig = loadModelsConfig(join(cwd, ".aiflow", "config", "models.yaml"));
  const pipelineConfig = loadPipelineConfig(join(cwd, ".aiflow", "config", "pipelines", `${pipelineName}.yaml`));

  const profiles: Record<string, ModelProfile> = modelsConfig.profiles;
  const state = await runPipelineOnce(
    pipelineConfig,
    profiles,
    cwd,
    runDir,
    deps,
    signal,
    { resume: true, force: opts.force ?? false },
  );

  if (wasTerminal && !opts.force) return { status: "noop_terminal", state, runId };
  return { status: "resumed", state, runId };
}
```

Add `writeFileSync` to the file's existing `import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";` line.

- [ ] **Step 4: Update `src/commands/run.ts`'s `runCommand` to accept an explicit `runId`**

Change the signature and body — replace:

```typescript
export async function runCommand(
  cwd: string,
  pipelineName: string,
  overrides: RunCommandOverrides = {},
  requirementInput: RequirementInput = {},
  signal?: AbortSignal
): Promise<EngineState> {
```

with:

```typescript
export async function runCommand(
  cwd: string,
  pipelineName: string,
  overrides: RunCommandOverrides = {},
  requirementInput: RequirementInput = {},
  signal?: AbortSignal,
  runId?: string
): Promise<EngineState> {
```

and replace:

```typescript
  const runId = createRunId();
  const runDir = join(cwd, ".aiflow", "runs", runId);
```

with:

```typescript
  const effectiveRunId = runId ?? createRunId();
  const runDir = join(cwd, ".aiflow", "runs", effectiveRunId);
```

(then update every other use of the bare `runId` identifier later in the same function body to `effectiveRunId` — there are none besides the `runDir` join in this function, based on the current file contents already read).

- [ ] **Step 5: Update `src/commands/doctor.ts`**

Change `DoctorReport`:

```typescript
export interface DoctorReport {
  openCodeVersion: string | null;
  gitOk: boolean;
  reviewerKeyPresent: boolean;
  reviewerReachable: boolean | null;
  reviewerError?: string;
  pricingWarnings: string[];
}
```

`runDoctorChecks` currently only receives a single `reviewerProfile`, not the full profile map, so it can't yet warn about every profile missing pricing — for this task, warn specifically about the `reviewerProfile` it already has, matching the function's existing scope. Update each of the four `return` statements in `runDoctorChecks` to include `pricingWarnings`. Replace the whole function body with:

```typescript
export async function runDoctorChecks(
  cwd: string,
  reviewerProfile: ModelProfile | undefined,
  deps: DoctorDeps = defaultDeps
): Promise<DoctorReport> {
  const openCodeVersion = await deps.checkOpenCodeVersion();
  const gitOk = await deps.checkGitRepo(cwd);

  const pricingWarnings: string[] =
    reviewerProfile && reviewerProfile.channel === "http" &&
    (reviewerProfile.input_cost_per_1m === undefined || reviewerProfile.output_cost_per_1m === undefined)
      ? ["Profile has no input_cost_per_1m/output_cost_per_1m configured; its spend will not count toward budget or cost reports."]
      : [];

  const reviewerKeyPresent = Boolean(
    reviewerProfile?.api_key_env && process.env[reviewerProfile.api_key_env]
  );

  if (!reviewerProfile || !reviewerKeyPresent) {
    return { openCodeVersion, gitOk, reviewerKeyPresent, reviewerReachable: null, pricingWarnings };
  }

  try {
    await deps.callReviewer(reviewerProfile, 'Respond with only this JSON: {"summary":"pong","issues":[]}');
    return { openCodeVersion, gitOk, reviewerKeyPresent, reviewerReachable: true, pricingWarnings };
  } catch (err) {
    return {
      openCodeVersion,
      gitOk,
      reviewerKeyPresent,
      reviewerReachable: false,
      reviewerError: err instanceof Error ? err.message : String(err),
      pricingWarnings,
    };
  }
}
```

- [ ] **Step 6: Update `src/cli.ts`'s `doctor` command to print pricing warnings**

Append after the existing `if (report.reviewerError) console.log(...)` line:

```typescript
    for (const warning of report.pricingWarnings) console.log(`Pricing warning: ${warning}`);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test test/unit/resume.test.ts test/unit/doctor.test.ts`
Expected: PASS

- [ ] **Step 8: Run the full suite**

Run: `bun test ./test`
Expected: PASS. This is also the point where the `runCommand(...)` call added to `cli.ts` in Task 2 (with its trailing `runId` argument) finally type-checks cleanly — confirm by re-running `bun test test/unit/cli.test.ts` too.

- [ ] **Step 9: Commit**

```bash
git add src/commands/resume.ts src/commands/run.ts src/commands/doctor.ts src/cli.ts test/unit/resume.test.ts test/unit/doctor.test.ts
git commit -m "feat: add --raise-budget to resume, explicit run ids, and a doctor pricing warning"
```

---

### Task 13: Integration test — lock, budget, and tamper-check together

**Files:**
- Modify: `test/integration/multi-stage-mocked.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–12. No new production code.

- [ ] **Step 1: Write the test**

Append to `test/integration/multi-stage-mocked.test.ts` (reuse the file's existing `setupProject`/`FULL_PIPELINE` helpers where they fit; this scenario needs its own smaller pipeline, so define it locally):

```typescript
test("a budget-exceeded run releases its lock, and a second run in the same project can then acquire it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-safety-integration-"));
  try {
    mkdirSync(join(dir, ".aiflow", "config", "pipelines"), { recursive: true });
    writeFileSync(
      join(dir, ".aiflow", "config", "models.yaml"),
      "profiles:\n  main-dev:\n    channel: opencode\n    provider: x\n    model: y\n  reviewer:\n    channel: http\n    provider: y\n    model: z\n"
    );
    writeFileSync(
      join(dir, ".aiflow", "config", "pipelines", "budgeted.yaml"),
      'name: budgeted\nbudget:\n  max_cost_usd: 1\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    per_story_fix_limit: 3\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n'
    );
    writeFileSync(
      join(dir, "prd.json"),
      JSON.stringify({ branchName: "x", stories: [{ id: "US-1", title: "t", acceptance: [], priority: 1, passes: false, fixCount: 0 }] })
    );
    await $`git -C ${dir} init -q`;
    await $`git -C ${dir} config user.email "test@example.com"`;
    await $`git -C ${dir} config user.name "Test"`;
    await $`git -C ${dir} add -A`;
    await $`git -C ${dir} commit -q -m "initial"`;

    const expensiveAgent = async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 5 } });

    const state = await runCommand(dir, "budgeted", { runAgentTask: expensiveAgent });
    expect(state.stages[0].status).toBe("paused");
    expect(state.stages[0].reason).toBe("budget_exceeded");
    expect(existsSync(join(dir, ".aiflow", "run.lock"))).toBe(false);

    // A second, independent run in the same project must be able to acquire the lock immediately.
    writeFileSync(
      join(dir, ".aiflow", "config", "pipelines", "cheap.yaml"),
      'name: cheap\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    per_story_fix_limit: 3\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n'
    );
    const freeAgent = async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 1, outTok: 1, costUsd: 0 } });
    const second = await runCommand(dir, "cheap", { runAgentTask: freeAgent });
    expect(second.stages[0].status).toBe("done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Note: `runCommand` itself doesn't acquire the lock — only `cli.ts`'s command handlers do (Task 2). This test therefore exercises budget-exceeded-pauses-without-corrupting-state directly through `runCommand`, and separately asserts no lock file is left behind by `runCommand` (there never was one, since `runCommand` doesn't touch `.aiflow/run.lock` — confirm this assertion trivially passes, documenting that the lock is a CLI-layer concern, not an engine-layer one). If this distinction makes the "release" assertion vacuous, drop the `run.lock` assertions from this test and instead add a `Bun.spawn`-based CLI-level test analogous to Task 2 Step 2's, running two sequential `bun src/cli.ts run` invocations against the same `dir` and asserting the second one's exit code reflects a fresh, unblocked run.

- [ ] **Step 2: Run the test**

Run: `bun test test/integration/multi-stage-mocked.test.ts -t "budget-exceeded"`
Expected: PASS

- [ ] **Step 3: Run the full suite one final time**

Run: `bun test ./test`
Expected: PASS (entire suite green)

- [ ] **Step 4: Commit**

```bash
git add test/integration/multi-stage-mocked.test.ts
git commit -m "test: cover lock/budget/tamper-check interaction end-to-end"
```

---

## Self-Review Notes

- **Spec coverage:** 并发锁 → Tasks 1–2. 预算熔断 + 真实成本统计 → Tasks 6–12. 配置防篡改 → Tasks 3–5. `aiflow resume --raise-budget` → Task 12. Integration coverage of all three together → Task 13. All spec sections have a task.
- **Placeholder scan:** no TBD/TODO; the two "ordering note" callouts (Task 2 Step 4, Task 9 Step 3) are deliberate cross-task sequencing warnings, not unfinished work — each names the exact fix and which later task supplies it.
- **Type consistency:** `BudgetTracker`/`createBudgetTracker`/`noopBudgetTracker` (Task 8) are the only names used everywhere they're consumed (Tasks 9–11). `StageOutcome.result` already included `"paused"` before this plan; `StageStopReason`/`RalphLoopStopReason` gain exactly one new literal, `"budget_exceeded"`, used identically in `state.ts`, `engine.ts`'s `VALID_STAGE_STOP_REASONS`, and every runner. `ReviewGateOutcome.usage` and `RalphLoopResult`'s `totalUsage` naming is consistent between Task 7 and Task 10.
