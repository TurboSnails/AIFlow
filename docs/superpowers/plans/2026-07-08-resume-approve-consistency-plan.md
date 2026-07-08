# resume/approve 一致性加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐上一轮"Run 安全加固"遗留的三个跨路径漏洞：`resume`/`approve` 缺少 `auto_clean` 脏树守卫、`lock.release()` 不校验归属、`ralph_loop` 失败/篡改路径不记账 budget。

**Architecture:** 三个改动彼此独立。脏树守卫抽成一个共享函数 `src/commands/dirty-guard.ts`，`run`/`resume`/`approve` 三处统一调用（resume/approve 需把 config 加载与守卫提到任何盘上写入之前）。`lock.release()` 改为读锁校验 `pid+run_id+started_at` 三元组后再删。`ralph_loop` 的失败/篡改早返回路径各插一次 `budget.record()`，忽略返回值（记账不熔断）。

**Tech Stack:** Bun (TypeScript)、bun:test、既有 `src/git.ts` 的 `isClean`、现有依赖注入约定。无新依赖。

设计来源：`docs/superpowers/specs/2026-07-08-resume-approve-consistency-design.md`（commit 016f7a4）。

## Global Constraints

- 不新增 npm 依赖 —— 只用 Bun/Node 内置与既有模块。
- 不改 `LockInfo` 结构，不改 `state.json`/`run.lock`/`events.jsonl` 盘上格式。
- 保持既有依赖注入约定：注入函数作为可选末位参数，默认真实实现。
- 三处脏树守卫的错误信息文本**完全一致**（只按实际值插值 `pipelineName` 与 `cwd`）。
- 每个任务后运行 `bun test ./test`，必须保持全绿再进入下一个任务。

---

### Task 1: 共享脏树守卫模块 + 重构 run.ts

**Files:**
- Create: `src/commands/dirty-guard.ts`
- Modify: `src/commands/run.ts:64-69`（删除内联守卫，改调共享函数）
- Test: `test/unit/dirty-guard.test.ts`

**Interfaces:**
- Produces: `assertCleanIfAutoClean(cwd: string, pipeline: PipelineConfig, pipelineName: string, isCleanFn?: (cwd: string) => Promise<boolean>): Promise<void>`。Task 2、3 直接 import 使用。

- [ ] **Step 1: 写失败测试**

Create `test/unit/dirty-guard.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { assertCleanIfAutoClean } from "../../src/commands/dirty-guard";
import type { PipelineConfig } from "../../src/config/schema";

function autoCleanPipeline(): PipelineConfig {
  return {
    name: "ralph-only",
    stages: [
      {
        id: "develop",
        type: "ralph_loop",
        model: "main-dev",
        per_story_fix_limit: 3,
        max_iterations: 10,
        stall_limit: 3,
        auto_clean: true,
        gate: { checks: [], ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] } },
      },
    ],
  } as PipelineConfig;
}

function noAutoCleanPipeline(): PipelineConfig {
  const p = autoCleanPipeline();
  (p.stages[0] as { auto_clean: boolean }).auto_clean = false;
  return p;
}

test("throws when an auto_clean ralph_loop pipeline meets a dirty tree", async () => {
  await expect(
    assertCleanIfAutoClean("/some/cwd", autoCleanPipeline(), "ralph-only", async () => false)
  ).rejects.toThrow(/auto_clean enabled on a ralph_loop stage/);
});

test("error message includes the pipeline name and cwd", async () => {
  try {
    await assertCleanIfAutoClean("/my/project", autoCleanPipeline(), "ralph-only", async () => false);
    throw new Error("should have thrown");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).toContain('"ralph-only"');
    expect(msg).toContain("/my/project");
  }
});

test("does not throw when the tree is clean", async () => {
  await expect(
    assertCleanIfAutoClean("/some/cwd", autoCleanPipeline(), "ralph-only", async () => true)
  ).resolves.toBeUndefined();
});

test("does not throw for a pipeline without auto_clean, and never inspects the tree", async () => {
  let inspected = false;
  await assertCleanIfAutoClean("/some/cwd", noAutoCleanPipeline(), "ralph-only", async () => {
    inspected = true;
    return false;
  });
  expect(inspected).toBe(false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/unit/dirty-guard.test.ts`
Expected: FAIL — `Cannot find module '../../src/commands/dirty-guard'`

- [ ] **Step 3: 实现 `src/commands/dirty-guard.ts`**

```typescript
import { isClean } from "../git";
import type { PipelineConfig } from "../config/schema";

/**
 * 若管道任一 stage 是 auto_clean 的 ralph_loop，则要求工作区干净，否则 throw。
 * checkoutClean 无法区分用户未提交的工作和失败的 agent 尝试，故恢复前必须先拦。
 */
export async function assertCleanIfAutoClean(
  cwd: string,
  pipeline: PipelineConfig,
  pipelineName: string,
  isCleanFn: (cwd: string) => Promise<boolean> = isClean
): Promise<void> {
  const hasAutoClean = pipeline.stages.some((s) => s.type === "ralph_loop" && s.auto_clean);
  if (!hasAutoClean) return;
  if (!(await isCleanFn(cwd))) {
    throw new Error(
      `Pipeline "${pipelineName}" has auto_clean enabled on a ralph_loop stage, but the working tree at ${cwd} is not clean. Commit or stash your changes before running (auto_clean cannot distinguish your uncommitted work from a failed agent attempt).`
    );
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/unit/dirty-guard.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 重构 `src/commands/run.ts` 改用共享函数**

在 import 区（`run.ts` 顶部已有的 import 块）加入：

```typescript
import { assertCleanIfAutoClean } from "./dirty-guard";
```

将现有的内联守卫（`run.ts` 第 64-69 行）：

```typescript
  const hasAutoClean = pipelineConfig.stages.some((s) => s.type === "ralph_loop" && s.auto_clean);
  if (hasAutoClean && !(await isClean(cwd))) {
    throw new Error(
      `Pipeline "${pipelineName}" has auto_clean enabled on a ralph_loop stage, but the working tree at ${cwd} is not clean. Commit or stash your changes before running (auto_clean cannot distinguish your uncommitted work from a failed agent attempt).`
    );
  }
```

替换为：

```typescript
  await assertCleanIfAutoClean(cwd, pipelineConfig, pipelineName);
```

注意：`run.ts` 顶部第 21 行的 import 仍从 `../git` 引入 `isClean`；替换后 `run.ts` 不再直接用 `isClean`，需从该 import 语句中移除 `isClean`，避免未使用告警。该行当前是：

```typescript
import { revParseHead, stageAll, diffCached, commit, checkoutClean, checkoutConfigOnly, isClean } from "../git";
```

改为：

```typescript
import { revParseHead, stageAll, diffCached, commit, checkoutClean, checkoutConfigOnly } from "../git";
```

- [ ] **Step 6: 运行全量测试**

Run: `bun test ./test`
Expected: PASS — run 现有的 auto_clean 拒绝测试（在 `test/integration/` 里）行为不变，仍绿。

- [ ] **Step 7: 提交**

```bash
git add src/commands/dirty-guard.ts src/commands/run.ts test/unit/dirty-guard.test.ts
git commit -m "refactor: extract shared auto_clean dirty-tree guard"
```

---

### Task 2: 把脏树守卫接入 resume.ts

**Files:**
- Modify: `src/commands/resume.ts`
- Test: `test/unit/resume.test.ts`

**Interfaces:**
- Consumes: `assertCleanIfAutoClean`（Task 1）。

`resume.ts` 当前结构（供参照，实现前先 `cat src/commands/resume.ts` 核对行号）：`raiseBudget` 的 `writeFileSync(statePath, ...)`（约 41-44 行）发生在 `loadModelsConfig`/`loadPipelineConfig`（约 46-47 行）**之前**。守卫需要 `pipelineConfig`，且必须在任何盘上写入之前触发，因此本任务把 config 加载提到 `raiseBudget` 写入之前，并在其后插入守卫。

- [ ] **Step 1: 写失败测试**

Append to `test/unit/resume.test.ts`（在 `describe("runResume", () => {` 块内追加；复用文件顶部已 import 的 `mkdtempSync/mkdirSync/writeFileSync/rmSync/join/tmpdir`）：

```typescript
  test("rejects a dirty tree for an auto_clean pipeline before mutating state.json", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "aiflow-resume-dirty-"));
    try {
      mkdirSync(join(cwd, ".aiflow", "config", "pipelines"), { recursive: true });
      writeFileSync(
        join(cwd, ".aiflow", "config", "models.yaml"),
        "profiles:\n  main-dev:\n    channel: opencode\n    provider: x\n    model: y\n  reviewer:\n    channel: http\n    provider: y\n    model: z\n"
      );
      writeFileSync(
        join(cwd, ".aiflow", "config", "pipelines", "ac.yaml"),
        'name: ac\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    per_story_fix_limit: 3\n    auto_clean: true\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n'
      );
      const runId = "20260708_120000_abcd12";
      const runDir = join(cwd, ".aiflow", "runs", runId);
      mkdirSync(runDir, { recursive: true });
      const stateJson = JSON.stringify({
        run_id: runId,
        pipeline: "ac",
        stages: [{ id: "develop", status: "paused", reason: "budget_exceeded" }],
        cost: { input_tokens: 0, output_tokens: 0, est_usd: 5 },
        budget: { limit_usd: 5 },
      });
      writeFileSync(join(runDir, "state.json"), stateJson);

      // isCleanFn 注入为脏；raiseBudget 若在守卫前写盘就会篡改 state.json。
      await expect(
        runResume(cwd, { runId, raiseBudget: 50 }, undefined, undefined, async () => false)
      ).rejects.toThrow(/auto_clean enabled on a ralph_loop stage/);

      // 断言 state.json 未被 raiseBudget 改动（守卫在写盘前拦住）。
      const after = readFileSync(join(runDir, "state.json"), "utf-8");
      expect(after).toBe(stateJson);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/unit/resume.test.ts -t "rejects a dirty tree"`
Expected: FAIL — 当前 `runResume` 无第 5 个 `isCleanFn` 参数（TypeScript 报参数过多），且守卫不存在，`raiseBudget` 会先写盘。

- [ ] **Step 3: 修改 `src/commands/resume.ts`**

在 import 区加入：

```typescript
import { assertCleanIfAutoClean } from "./dirty-guard";
```

将 `runResume` 的签名从：

```typescript
export async function runResume(
  cwd: string,
  opts: { runId?: string; pipeline?: string; force?: boolean; raiseBudget?: number },
  deps?: EngineDeps,
  signal?: AbortSignal
): Promise<ResumeResult> {
```

改为（追加可选末位参数 `isCleanFn`，默认交给 `assertCleanIfAutoClean` 内部的默认）：

```typescript
export async function runResume(
  cwd: string,
  opts: { runId?: string; pipeline?: string; force?: boolean; raiseBudget?: number },
  deps?: EngineDeps,
  signal?: AbortSignal,
  isCleanFn?: (cwd: string) => Promise<boolean>
): Promise<ResumeResult> {
```

然后把函数体中"读取 persisted → 加载 config → 守卫 → 再处理 raiseBudget 写盘"的顺序调整。当前函数体（从读取 persisted 到 runPipelineOnce）是：

```typescript
  const persisted = JSON.parse(readFileSync(statePath, "utf-8")) as EngineState;
  const pipelineName = opts.pipeline ?? persisted.pipeline;
  const wasTerminal = persisted.stages.every((s) => isTerminalStatus(s.status));

  if (opts.raiseBudget !== undefined) {
    if (!Number.isFinite(opts.raiseBudget) || opts.raiseBudget <= 0) {
      throw new Error(`Invalid --raise-budget value: ${opts.raiseBudget}. Must be a positive number.`);
    }
    persisted.budget = { limit_usd: opts.raiseBudget };
    writeFileSync(statePath, JSON.stringify(persisted, null, 2));
  }

  const modelsConfig = loadModelsConfig(join(cwd, ".aiflow", "config", "models.yaml"));
  const pipelineConfig = loadPipelineConfig(join(cwd, ".aiflow", "config", "pipelines", `${pipelineName}.yaml`));

  const profiles: Record<string, ModelProfile> = modelsConfig.profiles;
```

替换为（config 加载与守卫提到 raiseBudget 写盘之前；raiseBudget 的校验保持不变）：

```typescript
  const persisted = JSON.parse(readFileSync(statePath, "utf-8")) as EngineState;
  const pipelineName = opts.pipeline ?? persisted.pipeline;
  const wasTerminal = persisted.stages.every((s) => isTerminalStatus(s.status));

  const modelsConfig = loadModelsConfig(join(cwd, ".aiflow", "config", "models.yaml"));
  const pipelineConfig = loadPipelineConfig(join(cwd, ".aiflow", "config", "pipelines", `${pipelineName}.yaml`));

  await assertCleanIfAutoClean(cwd, pipelineConfig, pipelineName, isCleanFn);

  if (opts.raiseBudget !== undefined) {
    if (!Number.isFinite(opts.raiseBudget) || opts.raiseBudget <= 0) {
      throw new Error(`Invalid --raise-budget value: ${opts.raiseBudget}. Must be a positive number.`);
    }
    persisted.budget = { limit_usd: opts.raiseBudget };
    writeFileSync(statePath, JSON.stringify(persisted, null, 2));
  }

  const profiles: Record<string, ModelProfile> = modelsConfig.profiles;
```

（`runPipelineOnce` 调用及其之后保持不变。）

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/unit/resume.test.ts`
Expected: PASS（新测试 + 所有现有 resume 测试）

- [ ] **Step 5: 运行全量测试**

Run: `bun test ./test`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/commands/resume.ts test/unit/resume.test.ts
git commit -m "fix: reject dirty tree in resume for auto_clean pipelines before mutating state"
```

---

### Task 3: 把脏树守卫接入 approve.ts

**Files:**
- Modify: `src/commands/approve.ts`
- Test: `test/unit/approve.test.ts`（若不存在则创建；先 `ls test/unit/approve.test.ts` 确认）

**Interfaces:**
- Consumes: `assertCleanIfAutoClean`（Task 1）。

`approve.ts` 当前先把目标 stage 置为 `done` 并 `writeStateAtomic(runDir, state)`（约 56-57 行），**再** `loadModelsConfig`/`loadPipelineConfig`（约 59-60 行）。守卫需要 `pipelineConfig` 且必须在 `writeStateAtomic` 之前触发，因此本任务把 config 加载提到状态写入之前，守卫置于其后、`writeStateAtomic` 之前。

- [ ] **Step 1: 确认/准备测试文件**

Run: `ls test/unit/approve.test.ts 2>/dev/null && echo EXISTS || echo MISSING`

若 EXISTS：在其内追加下方测试并复用其已有 import。若 MISSING：创建下面这个完整文件。

- [ ] **Step 2: 写失败测试**

若文件缺失，Create `test/unit/approve.test.ts`：

```typescript
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApprove } from "../../src/commands/approve";

function setupWaitingRun(autoClean: boolean): { cwd: string; runId: string; runDir: string; stateJson: string } {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-approve-dirty-"));
  mkdirSync(join(cwd, ".aiflow", "config", "pipelines"), { recursive: true });
  writeFileSync(
    join(cwd, ".aiflow", "config", "models.yaml"),
    "profiles:\n  main-dev:\n    channel: opencode\n    provider: x\n    model: y\n  reviewer:\n    channel: http\n    provider: y\n    model: z\n"
  );
  writeFileSync(
    join(cwd, ".aiflow", "config", "pipelines", "gated.yaml"),
    `name: gated\nstages:\n  - id: confirm\n    type: human_gate\n    prompt: "ok?"\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    per_story_fix_limit: 3\n    auto_clean: ${autoClean}\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n`
  );
  const runId = "20260708_130000_abcd12";
  const runDir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const stateJson = JSON.stringify({
    run_id: runId,
    pipeline: "gated",
    stages: [
      { id: "confirm", status: "waiting_human" },
      { id: "develop", status: "pending" },
    ],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
  });
  writeFileSync(join(runDir, "state.json"), stateJson);
  return { cwd, runId, runDir, stateJson };
}

test("approve rejects a dirty tree for an auto_clean pipeline without recording the approval", async () => {
  const { cwd, runId, runDir, stateJson } = setupWaitingRun(true);
  try {
    await expect(
      runApprove(cwd, { runId }, undefined, undefined, async () => false)
    ).rejects.toThrow(/auto_clean enabled on a ralph_loop stage/);
    // state.json 未被改动：confirm 仍是 waiting_human，approval 没落盘。
    const after = readFileSync(join(runDir, "state.json"), "utf-8");
    expect(after).toBe(stateJson);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `bun test test/unit/approve.test.ts -t "rejects a dirty tree"`
Expected: FAIL — `runApprove` 当前无第 5 个 `isCleanFn` 参数，且守卫不存在，approval 会先写盘。

- [ ] **Step 4: 修改 `src/commands/approve.ts`**

在 import 区加入：

```typescript
import { assertCleanIfAutoClean } from "./dirty-guard";
```

将 `runApprove` 签名从：

```typescript
export async function runApprove(
  cwd: string,
  opts: { runId?: string; stage?: string },
  deps?: EngineDeps,
  signal?: AbortSignal
): Promise<ApproveResult> {
```

改为：

```typescript
export async function runApprove(
  cwd: string,
  opts: { runId?: string; stage?: string },
  deps?: EngineDeps,
  signal?: AbortSignal,
  isCleanFn?: (cwd: string) => Promise<boolean>
): Promise<ApproveResult> {
```

当前函数体中，选出 `targetIndex` 之后是：

```typescript
  state.stages[targetIndex] = { id: state.stages[targetIndex].id, status: "done" };
  writeStateAtomic(runDir, state);

  const modelsConfig = loadModelsConfig(join(cwd, ".aiflow", "config", "models.yaml"));
  const pipelineConfig = loadPipelineConfig(join(cwd, ".aiflow", "config", "pipelines", `${state.pipeline}.yaml`));

  const resultState = await runPipelineOnce(pipelineConfig, modelsConfig.profiles, cwd, runDir, deps, signal, { resume: true });
```

替换为（config 加载与守卫提到 `writeStateAtomic` 之前）：

```typescript
  const modelsConfig = loadModelsConfig(join(cwd, ".aiflow", "config", "models.yaml"));
  const pipelineConfig = loadPipelineConfig(join(cwd, ".aiflow", "config", "pipelines", `${state.pipeline}.yaml`));

  await assertCleanIfAutoClean(cwd, pipelineConfig, state.pipeline, isCleanFn);

  state.stages[targetIndex] = { id: state.stages[targetIndex].id, status: "done" };
  writeStateAtomic(runDir, state);

  const resultState = await runPipelineOnce(pipelineConfig, modelsConfig.profiles, cwd, runDir, deps, signal, { resume: true });
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test test/unit/approve.test.ts`
Expected: PASS

- [ ] **Step 6: 运行全量测试**

Run: `bun test ./test`
Expected: PASS — 现有的 approve 集成测试（`test/integration/multi-stage-mocked.test.ts` 里那条 approve 流程）用的是无 auto_clean 的 full-auto 管道，守卫对它是 no-op，行为不变。

- [ ] **Step 7: 提交**

```bash
git add src/commands/approve.ts test/unit/approve.test.ts
git commit -m "fix: reject dirty tree in approve for auto_clean pipelines before recording approval"
```

---

### Task 4: lock.release() 归属校验

**Files:**
- Modify: `src/lock.ts:71-86`
- Test: `test/unit/lock.test.ts`

**Interfaces:**
- 不改公开签名。`RunLock.release()` 行为收紧：只删除仍属于本持有者的锁。

- [ ] **Step 1: 写失败测试**

Append to `test/unit/lock.test.ts`（顶部已 import `mkdtempSync/rmSync/existsSync/readFileSync/unlinkSync/join/acquireRunLock`；`writeFileSync` 需加入 import）。先把第 2 行 import 改为包含 `writeFileSync`：

```typescript
import { mkdtempSync, rmSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
```

然后追加两个测试：

```typescript
test("release() does not delete a lock that has been reclaimed by another holder", async () => {
  const dir = tmpProject();
  try {
    const lock = await acquireRunLock(dir, "run-A", { isPidAliveFn: () => true });
    const lockPath = join(dir, ".aiflow", "run.lock");
    // 模拟：原锁被判 stale 并被 B 回收 —— 文件内容现在是 B 的 info（不同 pid/run_id/started_at）。
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid + 1, run_id: "run-B", started_at: new Date(Date.now() + 1000).toISOString() })
    );
    lock.release(); // A 的 release 不应删掉 B 的锁
    expect(existsSync(lockPath)).toBe(true);
    const stillB = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(stillB.run_id).toBe("run-B");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release() silently returns when the lock file is already gone", async () => {
  const dir = tmpProject();
  try {
    const lock = await acquireRunLock(dir, "run-A", { isPidAliveFn: () => true });
    const lockPath = join(dir, ".aiflow", "run.lock");
    unlinkSync(lockPath); // 锁已被外部删除
    expect(() => lock.release()).not.toThrow();
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

（注意：文件顶部第一个测试 `release() removes it` 仍应通过 —— 正常归属下 release 照常删除。）

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/unit/lock.test.ts -t "reclaimed by another holder"`
Expected: FAIL — 当前 `release()` 无条件 `unlinkSync`，会删掉 B 的锁。

- [ ] **Step 3: 修改 `src/lock.ts`**

将 `acquireRunLock` 中成功写锁后返回的 release 闭包（当前 74-82 行）：

```typescript
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
```

替换为：

```typescript
      writeFileSync(path, JSON.stringify(info), { flag: "wx" });
      return {
        release: () => {
          let current: LockInfo;
          try {
            current = readLockFn(path);
          } catch {
            // 锁文件已不存在或损坏 —— 不再是我们的锁，静默返回。
            return;
          }
          if (
            current.pid !== info.pid ||
            current.run_id !== info.run_id ||
            current.started_at !== info.started_at
          ) {
            // 已被他人回收（stale 回收竞态）—— 不删他人的活动锁。
            return;
          }
          try {
            unlinkSync(path);
          } catch {
            // 最后的竞态兜底：文件在校验与 unlink 之间被删。
          }
        },
      };
```

（`info` 已在同一 `while` 循环体内声明为 `const info: LockInfo = {...}`，release 闭包直接捕获它；`readLockFn` 已从 opts 解构，闭包同样可见。）

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/unit/lock.test.ts`
Expected: PASS（新增 2 个 + 现有 6 个）

- [ ] **Step 5: 运行全量测试**

Run: `bun test ./test`
Expected: PASS — CLI 层各命令的 `lock.release()`（`test/integration/cli-lock.test.ts` 等）在正常归属下照常删锁，不受影响。

- [ ] **Step 6: 提交**

```bash
git add src/lock.ts test/unit/lock.test.ts
git commit -m "fix: verify lock ownership in release() before unlinking"
```

---

### Task 5: ralph_loop 失败/篡改路径 budget 记账

**Files:**
- Modify: `src/runners/ralph-loop.ts`（篡改分支与 agent 失败分支各插一次 `budget.record`）
- Test: `test/unit/ralph-loop.test.ts`

**Interfaces:**
- 不改公开签名。收紧：失败/篡改早返回前把已产生成本计入 `budget`（忽略返回值，不熔断）。

`ralph-loop.ts` 相关片段（供参照，实现前先核对行号）：篡改分支约 118-140 行，agent 失败分支约 142-148 行。两处都在各自 `return` 前**没有** `budget.record`。

- [ ] **Step 1: 写失败测试**

Append to `test/unit/ralph-loop.test.ts`（顶部已 import `runRalphLoopOnce`、`createBudgetTracker`、`mock` 等；本测试用一个可观测的 tracker）。追加：

```typescript
test("a failed agent call still records its cost in the budget tracker (without pausing)", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const recorded: number[] = [];
    const budget: BudgetTracker = {
      limitUsd: undefined,
      record: (delta: number) => { recorded.push(delta); return false; },
    };
    const runAgentTask = mock(async () => ({ ok: false, transcriptPath: "unused", usage: { inTok: 3, outTok: 1, costUsd: 0.4 } }));
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = fixedGit();

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir: mock(() => "same-hash"),
    }, budget);

    expect(result.result).toBe("fail");
    expect(recorded).toContain(0.4);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a config-tamper iteration still records its cost in the budget tracker (without pausing)", async () => {
  const { cwd, runDir } = makeFixtureDirs();
  try {
    const recorded: number[] = [];
    const budget: BudgetTracker = {
      limitUsd: undefined,
      record: (delta: number) => { recorded.push(delta); return false; },
    };
    let hashCall = 0;
    const hashConfigDir = mock(() => {
      hashCall += 1;
      return hashCall === 1 ? "before" : "after-different";
    });
    const checkoutConfigOnly = mock(async () => {});
    const runAgentTask = mock(async () => ({ ok: true, transcriptPath: "unused", usage: { inTok: 3, outTok: 1, costUsd: 0.7 } }));
    const runReviewGate = mock(async () => ({ checks: "pass" as const, aiReview: "skipped" as const, blockers: 0 }));
    const git = { ...fixedGit(), checkoutConfigOnly };

    const result = await runRalphLoopOnce(stageConfig, profiles, cwd, runDir, "spec excerpt", {
      runAgentTask,
      runReviewGate,
      git,
      hashConfigDir,
    }, budget);

    expect(result.result).toBe("fail");
    expect(checkoutConfigOnly).toHaveBeenCalledWith(cwd);
    expect(runReviewGate).not.toHaveBeenCalled();
    expect(recorded).toContain(0.7);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

`BudgetTracker` 需从 `../../src/gate/budget` import —— 在文件顶部现有的 `import { createBudgetTracker } from "../../src/gate/budget";` 改为：

```typescript
import { createBudgetTracker, type BudgetTracker } from "../../src/gate/budget";
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/unit/ralph-loop.test.ts -t "records its cost"`
Expected: FAIL — 两条早返回路径当前都不调 `budget.record`，`recorded` 数组为空，`toContain` 失败。

- [ ] **Step 3: 修改 `src/runners/ralph-loop.ts`**

**篡改分支**：当前该分支（`agentResult.ok && deps.hashConfigDir(cwd) !== configHashBefore` 之内）末尾是：

```typescript
    const suspended = updatedPrd.stories.find((s) => s.id === story.id)!.suspended === true;
    const result = suspended ? "suspended" : "fail";
    appendEvent(runDir, { ts: new Date().toISOString(), type: "story_result", story: story.id, result });
    return { storyId: story.id, result, usage: agentResult.usage };
  }
```

在 `return` 之前插入一行 `budget.record`（忽略返回值）：

```typescript
    const suspended = updatedPrd.stories.find((s) => s.id === story.id)!.suspended === true;
    const result = suspended ? "suspended" : "fail";
    appendEvent(runDir, { ts: new Date().toISOString(), type: "story_result", story: story.id, result });
    budget.record(agentResult.usage.costUsd); // 记账；本轮因篡改结束，不熔断
    return { storyId: story.id, result, usage: agentResult.usage };
  }
```

**agent 失败分支**：当前是：

```typescript
  if (!agentResult.ok) {
    const updatedPrd = recordStoryFailure(prd, story.id, stageConfig.per_story_fix_limit);
    writePrd(prdPath, updatedPrd);
    appendFileSync(fixListPath, `\n## ${story.id} (agent call failed)\nOpenCode agent invocation did not complete successfully.\n`);
    appendEvent(runDir, { ts: new Date().toISOString(), type: "story_result", story: story.id, result: "fail" });
    return { storyId: story.id, result: "fail", usage: agentResult.usage };
  }
```

在 `return` 之前插入：

```typescript
  if (!agentResult.ok) {
    const updatedPrd = recordStoryFailure(prd, story.id, stageConfig.per_story_fix_limit);
    writePrd(prdPath, updatedPrd);
    appendFileSync(fixListPath, `\n## ${story.id} (agent call failed)\nOpenCode agent invocation did not complete successfully.\n`);
    appendEvent(runDir, { ts: new Date().toISOString(), type: "story_result", story: story.id, result: "fail" });
    budget.record(agentResult.usage.costUsd); // 记账；本轮 agent 失败，不熔断
    return { storyId: story.id, result: "fail", usage: agentResult.usage };
  }
```

**不要动主路径**：主路径已有的 `budget.record(agentResult.usage.costUsd)`（篡改检查之后、成功路径上那处）保持原样。篡改分支在主路径 record 之前就返回，故两者不会对同一次调用重复记账。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/unit/ralph-loop.test.ts`
Expected: PASS（新增 2 个 + 现有全部）

- [ ] **Step 5: 运行全量测试**

Run: `bun test ./test`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/runners/ralph-loop.ts test/unit/ralph-loop.test.ts
git commit -m "fix: record agent cost on ralph_loop failed and config-tamper paths"
```

---

## Self-Review Notes

- **Spec coverage:** 组件 1（脏树守卫共享化）→ Tasks 1–3。组件 2（release 归属校验）→ Task 4。组件 3（失败/篡改 budget 记账）→ Task 5。设计的三个测试策略小节分别落在对应任务的 Step 1。全部覆盖。
- **Placeholder scan:** 无 TBD/TODO；每个改动步骤都给出完整替换前/后代码块。resume/approve 两处的"先 `cat`/`ls` 核对行号"是有意的定位提示（因为这些文件在本分支上会随任务推进略有位移），不是未完成工作 —— 替换锚点用的是稳定的代码文本而非行号。
- **Type consistency:** `assertCleanIfAutoClean(cwd, pipeline, pipelineName, isCleanFn?)` 的签名在 Task 1 定义，Task 2/3 按同一签名调用（resume 传 `pipelineName`、approve 传 `state.pipeline`）。`isCleanFn?: (cwd: string) => Promise<boolean>` 作为可选末位参数在 run/resume/approve 三处一致。`BudgetTracker.record(delta): boolean` 与 `budget.ts` 既有定义一致；Task 5 测试用的手写 tracker 实现了 `limitUsd` + `record` 两个字段，与接口吻合。
- **错误信息一致性:** Task 1 的错误文本被 run（Step 5 移除内联、改调共享函数）、resume、approve 共用同一份，满足全局约束。
