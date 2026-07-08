# 预算告警(budget warnings)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已有 budget/cost 基础设施上,增加多阈值百分比预算告警(`budget_warning` 事件 + stderr)与 run 结束时的超支/接近提示,停止行为不变。

**Architecture:** 跨阈值检测放在纯逻辑的 `BudgetTracker`(单测友好);告警 I/O 集中在 engine 一处(与 `stage_cost` 落点相邻),通过 `drainPendingWarnings()` 从 tracker 取出攒下的阈值;run 结束提示由命令层纯函数 `formatBudgetOutcomeLine(state)` 计算、由 cli.ts 打印;status 读回并专门渲染。

**Tech Stack:** Bun + TypeScript,zod(config schema),bun:test。

## Global Constraints

- 不新增 npm 依赖。
- 不改停止行为(现有 100% 软停不变),不引入 hard 停止模式。
- 盘上仅 `state.budget` 增可选 `warn_at_pct`、events.jsonl 增 `budget_warning`(向后兼容:旧 run 无此事件、旧 state 无此字段,均不报错)。
- 跨阈值检测在 tracker(纯逻辑);I/O(写事件/stderr)集中在 engine,与 `stage_cost` 落点相邻。
- 告警幂等:每阈值每 run 只报一次,含 resume 场景(通过 `initialSpentUsd` 预填已跨阈值)。
- `budget_warning` 字段命名 snake_case:`threshold_pct` / `spent_usd` / `limit_usd`,与既有事件一致。
- `budget_warning` 不进 `stage_cost` 成本聚合,不影响 `cost` 命令数字。
- `record()` 保持 bool 返回语义(是否达 limit),调用点零改动。

---

### Task 1: `budget_warning` 事件类型

**Files:**
- Modify: `src/events/events.ts`(新增 interface + 加入 `AiflowEvent` 联合,约 98-116 行)
- Test: `test/unit/events.test.ts`

**Interfaces:**
- Produces: `BudgetWarningAiflowEvent { ts: string; type: "budget_warning"; stage: string; threshold_pct: number; spent_usd: number; limit_usd: number }`,并入 `AiflowEvent` 联合。

- [ ] **Step 1: Write the failing test**

在 `test/unit/events.test.ts` 末尾追加。该文件顶部已 import `test`/`expect`/`mkdtempSync`/`tmpdir`/`join`/`appendEvent`/`readEvents`/`AiflowEvent`——无需补 import:

```ts
test("budget_warning event round-trips through appendEvent/readEvents", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-events-test-"));
  const evt: AiflowEvent = {
    ts: "2026-07-08T00:00:00.000Z",
    type: "budget_warning",
    stage: "build",
    threshold_pct: 0.8,
    spent_usd: 8.5,
    limit_usd: 10,
  };
  appendEvent(dir, evt);
  const read = readEvents(dir);
  expect(read).toEqual([evt]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/events.test.ts`
Expected: FAIL —— TS 报 `type: "budget_warning"` 不在 `AiflowEvent` 联合中。

- [ ] **Step 3: Add the interface and union member**

在 `src/events/events.ts` 中 `StoryAutoCleanedAiflowEvent` 之后新增:

```ts
export interface BudgetWarningAiflowEvent {
  ts: string;
  type: "budget_warning";
  stage: string;
  threshold_pct: number;
  spent_usd: number;
  limit_usd: number;
}
```

并把它加入 `AiflowEvent` 联合(在 `| StoryAutoCleanedAiflowEvent;` 之前加一行):

```ts
  | StoryAutoCleanedAiflowEvent
  | BudgetWarningAiflowEvent;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/events.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/events/events.ts test/unit/events.test.ts
git commit -m "feat: add budget_warning event type"
```

---

### Task 2: BudgetTracker 跨阈值检测 + drainPendingWarnings

**Files:**
- Modify: `src/gate/budget.ts`(全量替换 —— 见下方完整实现)
- Test: `test/unit/budget.test.ts`(在现有 6 个测试后追加)

**Interfaces:**
- Consumes: 无(纯模块)。
- Produces:
  - `interface BudgetTracker { limitUsd?: number; record(deltaUsd: number): boolean; drainPendingWarnings(): number[] }`
  - `function createBudgetTracker(limitUsd: number | undefined, initialSpentUsd: number, warnAtPct?: number[]): BudgetTracker`
  - `const noopBudgetTracker: BudgetTracker`(`record` 恒 false,`drainPendingWarnings` 恒 `[]`)

- [ ] **Step 1: Write the failing tests**

在 `test/unit/budget.test.ts` 末尾追加:

```ts
test("drainPendingWarnings returns each crossed threshold once, in ascending order", () => {
  const tracker = createBudgetTracker(10, 0, [0.5, 0.8]);
  tracker.record(3); // 30% — none crossed
  expect(tracker.drainPendingWarnings()).toEqual([]);
  tracker.record(3); // 60% — crosses 0.5
  expect(tracker.drainPendingWarnings()).toEqual([0.5]);
  tracker.record(2); // 80% — crosses 0.8
  expect(tracker.drainPendingWarnings()).toEqual([0.8]);
  // drained buffer is now empty
  expect(tracker.drainPendingWarnings()).toEqual([]);
});

test("a single record crossing multiple thresholds drains all of them ascending", () => {
  const tracker = createBudgetTracker(10, 0, [0.5, 0.8]);
  tracker.record(9); // 90% — crosses both 0.5 and 0.8 at once
  expect(tracker.drainPendingWarnings()).toEqual([0.5, 0.8]);
});

test("each threshold warns at most once even across many records", () => {
  const tracker = createBudgetTracker(10, 0, [0.5]);
  tracker.record(6); // crosses 0.5
  expect(tracker.drainPendingWarnings()).toEqual([0.5]);
  tracker.record(1); // still above 0.5, but already warned
  expect(tracker.drainPendingWarnings()).toEqual([]);
});

test("thresholds already crossed by initialSpentUsd are pre-marked and never warn (resume)", () => {
  const tracker = createBudgetTracker(10, 6, [0.5, 0.8]); // 60% already spent
  tracker.record(1); // 70% — 0.5 already passed at init, 0.8 not yet
  expect(tracker.drainPendingWarnings()).toEqual([]);
  tracker.record(1); // 80% — crosses 0.8
  expect(tracker.drainPendingWarnings()).toEqual([0.8]);
});

test("an undefined limitUsd yields no warnings and record stays false", () => {
  const tracker = createBudgetTracker(undefined, 0, [0.5, 0.8]);
  expect(tracker.record(1_000_000)).toBe(false);
  expect(tracker.drainPendingWarnings()).toEqual([]);
});

test("warnAtPct is sorted and de-duplicated", () => {
  const tracker = createBudgetTracker(10, 0, [0.8, 0.5, 0.8]);
  tracker.record(9); // crosses both distinct thresholds
  expect(tracker.drainPendingWarnings()).toEqual([0.5, 0.8]);
});

test("noopBudgetTracker drains empty", () => {
  expect(noopBudgetTracker.drainPendingWarnings()).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/budget.test.ts`
Expected: FAIL —— `createBudgetTracker` 第三参数与 `drainPendingWarnings` 未定义。

- [ ] **Step 3: Replace `src/gate/budget.ts` with the full implementation**

```ts
export interface BudgetTracker {
  limitUsd?: number;
  /** Records a newly-spent amount and returns true once cumulative spend reaches the limit. */
  record(deltaUsd: number): boolean;
  /** Returns (ascending) and clears the warning thresholds newly crossed since the last drain. */
  drainPendingWarnings(): number[];
}

export function createBudgetTracker(
  limitUsd: number | undefined,
  initialSpentUsd: number,
  warnAtPct: number[] = [],
): BudgetTracker {
  let spent = initialSpentUsd;
  const thresholds = [...new Set(warnAtPct)].sort((a, b) => a - b);
  const warned = new Set<number>();
  const pending: number[] = [];

  // Pre-mark thresholds already crossed by the resumed starting spend so a
  // resume does not re-warn for history.
  if (limitUsd !== undefined && limitUsd > 0) {
    const startRatio = spent / limitUsd;
    for (const t of thresholds) {
      if (startRatio >= t) warned.add(t);
    }
  }

  return {
    limitUsd,
    record(deltaUsd: number): boolean {
      spent += deltaUsd;
      if (limitUsd !== undefined && limitUsd > 0) {
        const ratio = spent / limitUsd;
        for (const t of thresholds) {
          if (ratio >= t && !warned.has(t)) {
            warned.add(t);
            pending.push(t);
          }
        }
      }
      return limitUsd !== undefined && spent >= limitUsd;
    },
    drainPendingWarnings(): number[] {
      const out = pending.slice().sort((a, b) => a - b);
      pending.length = 0;
      return out;
    },
  };
}

export const noopBudgetTracker: BudgetTracker = {
  limitUsd: undefined,
  record: () => false,
  drainPendingWarnings: () => [],
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/budget.test.ts`
Expected: PASS —— 全部旧 6 个 + 新 7 个测试通过(旧测试因 `warnAtPct` 有默认值 `[]` 不受影响)。

- [ ] **Step 5: Commit**

```bash
git add src/gate/budget.ts test/unit/budget.test.ts
git commit -m "feat: track and drain budget warning thresholds"
```

---

### Task 3: config schema + state 增 `warn_at_pct`,engine 写入 state 并传入 tracker

**Files:**
- Modify: `src/config/schema.ts:93-95`(`BudgetConfigSchema`)
- Modify: `src/engine/state.ts:23`(`EngineState.budget` 类型)
- Modify: `src/engine/engine.ts`(state 初始化约 246-249 行;tracker 创建约 291 行)
- Test: `test/unit/engine.test.ts`(追加一个 state 初始化断言);config 校验就近加一个 loader/schema 测试(见 Step 1)

**Interfaces:**
- Consumes: `createBudgetTracker(limitUsd, initialSpentUsd, warnAtPct?)`(Task 2)。
- Produces:
  - `BudgetConfigSchema` 增 `warn_at_pct: z.array(z.number().positive().max(1)).optional()`。
  - `EngineState.budget?: { limit_usd: number; warn_at_pct?: number[] }`。
  - engine 初始化 state 时把 `pipeline.budget.warn_at_pct` 写入 `state.budget`;创建 tracker 时把 `state.budget?.warn_at_pct` 作第三参数传入。

- [ ] **Step 1: Write the failing tests**

(a) config schema —— 在 `test/unit/` 下找到已有的 schema/loader 测试文件(如 `test/unit/config-loader.test.ts` 或 `test/unit/schema.test.ts`;若都不存在,新建 `test/unit/budget-config.test.ts`)。追加:

```ts
import { test, expect } from "bun:test";
import { BudgetConfigSchema } from "../../src/config/schema";

test("BudgetConfigSchema accepts optional warn_at_pct percentages", () => {
  const parsed = BudgetConfigSchema.parse({ max_cost_usd: 10, warn_at_pct: [0.5, 0.8] });
  expect(parsed.warn_at_pct).toEqual([0.5, 0.8]);
});

test("BudgetConfigSchema rejects warn_at_pct values above 1", () => {
  expect(() => BudgetConfigSchema.parse({ max_cost_usd: 10, warn_at_pct: [1.5] })).toThrow();
});

test("BudgetConfigSchema allows omitting warn_at_pct", () => {
  const parsed = BudgetConfigSchema.parse({ max_cost_usd: 10 });
  expect(parsed.warn_at_pct).toBeUndefined();
});
```

(b) engine state init —— 在 `test/unit/engine.test.ts` 追加一个测试,断言带 `warn_at_pct` 的 pipeline 初始化后 `state.budget.warn_at_pct` 被写入。参考该文件已有的 `runPipelineOnce` 调用与临时 runDir 搭建方式(复用文件顶部已有的 helper/mock runner):

engine.test.ts 已 import `mkdtempSync`/`tmpdir`/`join`/`readState`/`readEvents`/`runPipelineOnce`(见文件顶部),直接复用:

```ts
test("runPipelineOnce persists budget.warn_at_pct into state", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  const pipeline = {
    name: "p",
    budget: { max_cost_usd: 10, warn_at_pct: [0.5, 0.8] },
    stages: [{ id: "s1", type: "human_gate", prompt: "ok", on_timeout: "abort" }],
  } as any;
  await runPipelineOnce(pipeline, {}, "/tmp", runDir, /* deps */ undefined as any);
  const state = readState(runDir);
  expect(state.budget).toEqual({ limit_usd: 10, warn_at_pct: [0.5, 0.8] });
});
```

> 注:若 `runPipelineOnce` 的 human_gate runner 在无交互下会阻塞,改用文件中已有的 mock deps 模式(传一个立即返回 `{ result: "waiting_human" }` 或 `{ result: "pass" }` 的 runner),关键只在于断言 state 写入,不在于跑完 stage。对齐 engine.test.ts 现有写法。

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/engine.test.ts` 和 config 测试文件
Expected: FAIL —— `warn_at_pct` 不被 schema 接受 / `state.budget` 无 `warn_at_pct`。

- [ ] **Step 3a: Extend `BudgetConfigSchema`**

`src/config/schema.ts` 把:

```ts
export const BudgetConfigSchema = z.object({
  max_cost_usd: z.number().positive(),
});
```

改为:

```ts
export const BudgetConfigSchema = z.object({
  max_cost_usd: z.number().positive(),
  warn_at_pct: z.array(z.number().positive().max(1)).optional(),
});
```

- [ ] **Step 3b: Extend `EngineState.budget` type**

`src/engine/state.ts` 把 `budget?: { limit_usd: number };` 改为:

```ts
  budget?: { limit_usd: number; warn_at_pct?: number[] };
```

- [ ] **Step 3c: Write warn_at_pct into state on init**

`src/engine/engine.ts` 中 state 初始化的 budget 展开(现约 248 行):

```ts
      ...(pipeline.budget ? { budget: { limit_usd: pipeline.budget.max_cost_usd } } : {}),
```

改为:

```ts
      ...(pipeline.budget
        ? {
            budget: {
              limit_usd: pipeline.budget.max_cost_usd,
              ...(pipeline.budget.warn_at_pct ? { warn_at_pct: pipeline.budget.warn_at_pct } : {}),
            },
          }
        : {}),
```

- [ ] **Step 3d: Pass warn_at_pct into the tracker**

`src/engine/engine.ts` 中(现约 291 行):

```ts
    const budgetTracker = createBudgetTracker(state.budget?.limit_usd, state.cost.est_usd);
```

改为:

```ts
    const budgetTracker = createBudgetTracker(state.budget?.limit_usd, state.cost.est_usd, state.budget?.warn_at_pct);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/engine.test.ts` 和 config 测试文件
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts src/engine/state.ts src/engine/engine.ts test/unit/engine.test.ts test/unit/budget-config.test.ts
git commit -m "feat: thread warn_at_pct through config, state, and budget tracker"
```

> 提交前若 config 测试写进了已存在的文件,`git add` 相应文件即可。

---

### Task 4: engine 在 stage 后 drain 并写 `budget_warning` 事件 + stderr

**Files:**
- Modify: `src/engine/engine.ts`(在 `stage_cost` 追加块之后,现约 306-315 行)
- Test: `test/unit/engine.test.ts`

**Interfaces:**
- Consumes: `budgetTracker.drainPendingWarnings()`(Task 2/3);`appendEvent`(已 import);`BudgetWarningAiflowEvent`(Task 1)。
- Produces: 每个 drain 出的阈值写一条 `budget_warning` 事件到 events.jsonl,并向 stderr 打一行。

- [ ] **Step 1: Write the failing test**

在 `test/unit/engine.test.ts` 追加。用一个 mock runner 返回 usage 使花费跨过阈值,断言 events.jsonl 出现 `budget_warning`:

```ts
test("runPipelineOnce emits budget_warning when a stage crosses a warn threshold", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  const deps = {
    runners: {
      // stage 花费 8 USD,limit 10,跨 0.5 与 0.8
      ralph_loop: async () => ({ result: "pass", usage: { inTok: 0, outTok: 0, costUsd: 8 } }),
    },
    nowFn: () => new Date("2026-07-08T00:00:00.000Z"),
  } as any;
  const pipeline = {
    name: "p",
    budget: { max_cost_usd: 10, warn_at_pct: [0.5, 0.8] },
    stages: [{ id: "build", type: "ralph_loop" }],
  } as any;
  await runPipelineOnce(pipeline, {}, "/tmp", runDir, deps);
  const events = readEvents(runDir);
  const warnings = events.filter((e) => e.type === "budget_warning");
  expect(warnings.map((w: any) => w.threshold_pct)).toEqual([0.5, 0.8]);
  expect(warnings.every((w: any) => w.stage === "build" && w.limit_usd === 10 && w.spent_usd === 8)).toBe(true);
});

test("runPipelineOnce emits no budget_warning when there is no budget", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-test-"));
  const deps = {
    runners: { ralph_loop: async () => ({ result: "pass", usage: { inTok: 0, outTok: 0, costUsd: 8 } }) },
  } as any;
  const pipeline = { name: "p", stages: [{ id: "build", type: "ralph_loop" }] } as any;
  await runPipelineOnce(pipeline, {}, "/tmp", runDir, deps);
  expect(readEvents(runDir).some((e) => e.type === "budget_warning")).toBe(false);
});
```

> `readEvents` / `readState` 需在测试文件顶部 import;对齐 engine.test.ts 现有 import(多半已 import `readEvents`)。

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/engine.test.ts`
Expected: FAIL —— 无 `budget_warning` 事件写入。

- [ ] **Step 3: Emit budget_warning after draining**

`src/engine/engine.ts` 中,在现有 `stage_cost` 追加块之后(现约 306-315 行的 `if (execResult.usage) { appendEvent(... stage_cost ...) }` 之后)新增:

```ts
    // Best-effort: drain any budget warning thresholds this stage's spend crossed.
    // Detection lives in the tracker (pure); the I/O is centralized here next to
    // stage_cost. Each threshold warns at most once per run (resume-safe).
    for (const thresholdPct of budgetTracker.drainPendingWarnings()) {
      const limitUsd = state.budget?.limit_usd ?? 0;
      appendEvent(runDir, {
        ts: nowFn().toISOString(),
        type: "budget_warning",
        stage: stage.id,
        threshold_pct: thresholdPct,
        spent_usd: state.cost.est_usd,
        limit_usd: limitUsd,
      });
      process.stderr.write(
        `Budget warning: spent $${state.cost.est_usd.toFixed(4)} / $${limitUsd.toFixed(4)} (${Math.round(thresholdPct * 100)}% of limit) at stage ${stage.id}\n`,
      );
    }
```

> `budgetTracker` 变量已在同作用域(Task 3 Step 3d 处创建);`state.cost.est_usd` 此时已含本 stage 的 usage(在上方 `state = { ... cost: ... }` 之后)。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/engine.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/engine/engine.ts test/unit/engine.test.ts
git commit -m "feat: emit budget_warning events and stderr on threshold crossing"
```

---

### Task 5: run 结束提示 `formatBudgetOutcomeLine` + cli 接线

**Files:**
- Create: `src/commands/budget-outcome.ts`
- Modify: `src/cli.ts`(run action 约 96-98 行;resume action 约 152-154 行;approve action 约 193-195 行)
- Test: `test/unit/budget-outcome.test.ts`

**Interfaces:**
- Consumes: `EngineState`(from `../engine/state`)。
- Produces: `function formatBudgetOutcomeLine(state: EngineState): string | undefined` —— 超支返回 `Budget exceeded: $X / $Y`;接近(配置了非空 warn_at_pct 且 `est >= max(warn_at_pct)*limit` 但未超)返回 `Budget near limit: $X / $Y (Z%)`;否则 `undefined`。

- [ ] **Step 1: Write the failing tests**

`test/unit/budget-outcome.test.ts`:

```ts
import { test, expect } from "bun:test";
import { formatBudgetOutcomeLine } from "../../src/commands/budget-outcome";
import type { EngineState } from "../../src/engine/state";

function stateWith(estUsd: number, budget?: { limit_usd: number; warn_at_pct?: number[] }): EngineState {
  return {
    run_id: "r",
    pipeline: "p",
    stages: [],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: estUsd },
    ...(budget ? { budget } : {}),
  };
}

test("returns exceeded line when spend reaches the limit", () => {
  const line = formatBudgetOutcomeLine(stateWith(10.5, { limit_usd: 10, warn_at_pct: [0.8] }));
  expect(line).toBe("Budget exceeded: $10.5000 / $10.0000");
});

test("returns near-limit line when spend passes the highest warn threshold but stays under limit", () => {
  const line = formatBudgetOutcomeLine(stateWith(8.5, { limit_usd: 10, warn_at_pct: [0.5, 0.8] }));
  expect(line).toBe("Budget near limit: $8.5000 / $10.0000 (85%)");
});

test("returns undefined when spend is below the highest warn threshold", () => {
  expect(formatBudgetOutcomeLine(stateWith(6, { limit_usd: 10, warn_at_pct: [0.8] }))).toBeUndefined();
});

test("returns undefined when there is no budget", () => {
  expect(formatBudgetOutcomeLine(stateWith(100))).toBeUndefined();
});

test("without warn_at_pct only exceeded can appear (no near-limit)", () => {
  expect(formatBudgetOutcomeLine(stateWith(9.9, { limit_usd: 10 }))).toBeUndefined();
  expect(formatBudgetOutcomeLine(stateWith(10, { limit_usd: 10 }))).toBe("Budget exceeded: $10.0000 / $10.0000");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/budget-outcome.test.ts`
Expected: FAIL —— module 不存在。

- [ ] **Step 3: Implement `src/commands/budget-outcome.ts`**

```ts
import type { EngineState } from "../engine/state";

/**
 * Returns a one-line budget outcome note for a finished run, or undefined when
 * no note applies. "exceeded" when spend reached the limit; "near limit" when
 * spend passed the highest configured warn_at_pct threshold but stayed under
 * the limit. Without warn_at_pct, only "exceeded" is possible.
 */
export function formatBudgetOutcomeLine(state: EngineState): string | undefined {
  const budget = state.budget;
  if (!budget) return undefined;
  const spent = state.cost.est_usd;
  const limit = budget.limit_usd;
  const spentStr = `$${spent.toFixed(4)}`;
  const limitStr = `$${limit.toFixed(4)}`;
  if (spent >= limit) {
    return `Budget exceeded: ${spentStr} / ${limitStr}`;
  }
  const thresholds = budget.warn_at_pct ?? [];
  if (thresholds.length > 0 && limit > 0) {
    const highest = Math.max(...thresholds);
    if (spent >= highest * limit) {
      const pct = Math.round((spent / limit) * 100);
      return `Budget near limit: ${spentStr} / ${limitStr} (${pct}%)`;
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/budget-outcome.test.ts`
Expected: PASS。

- [ ] **Step 5: Wire into cli.ts (run / resume / approve)**

在 `src/cli.ts` 顶部 import 附近不需要静态 import(其他命令用动态 import);在每个 action 打印 outcome 后追加预算行。

run action(现约 96-98 行):

```ts
      const outcome = summarizePipelineOutcome(state);
      console.log(outcome.line);
      process.exitCode = outcome.exitCode;
```

改为:

```ts
      const outcome = summarizePipelineOutcome(state);
      console.log(outcome.line);
      const { formatBudgetOutcomeLine } = await import("./commands/budget-outcome");
      const budgetLine = formatBudgetOutcomeLine(state);
      if (budgetLine) console.log(budgetLine);
      process.exitCode = outcome.exitCode;
```

resume action(现约 151-154 行):

```ts
      const { summarizePipelineOutcome } = await import("./engine/engine");
      const outcome = summarizePipelineOutcome(result.state!);
      console.log(`Run ${result.runId}: ${outcome.line}`);
      process.exitCode = outcome.exitCode;
```

改为:

```ts
      const { summarizePipelineOutcome } = await import("./engine/engine");
      const outcome = summarizePipelineOutcome(result.state!);
      console.log(`Run ${result.runId}: ${outcome.line}`);
      const { formatBudgetOutcomeLine } = await import("./commands/budget-outcome");
      const budgetLine = formatBudgetOutcomeLine(result.state!);
      if (budgetLine) console.log(budgetLine);
      process.exitCode = outcome.exitCode;
```

approve action(现约 193-196 行)—— 同 resume,`result.state!`:

```ts
      const { summarizePipelineOutcome } = await import("./engine/engine");
      const outcome = summarizePipelineOutcome(result.state!);
      console.log(`Run ${result.runId}: ${outcome.line}`);
      const { formatBudgetOutcomeLine } = await import("./commands/budget-outcome");
      const budgetLine = formatBudgetOutcomeLine(result.state!);
      if (budgetLine) console.log(budgetLine);
      process.exitCode = outcome.exitCode;
```

- [ ] **Step 6: Verify cli.ts compiles and smoke-check**

Run: `bunx tsc --noEmit 2>&1 | grep cli.ts || echo "cli.ts clean"`
Expected: `cli.ts clean`(无 cli.ts 报错;其它预先存在的测试文件报错不在此列)。

- [ ] **Step 7: Commit**

```bash
git add src/commands/budget-outcome.ts test/unit/budget-outcome.test.ts src/cli.ts
git commit -m "feat: print budget outcome note after run/resume/approve"
```

---

### Task 6: status 读回 —— `budget_warning` 专门渲染 + 预算用量行

**Files:**
- Modify: `src/commands/monitor.ts`(`describeEvent` switch,约 151-178 行;`renderStatus` 的 Cost 区块,约 197-199 行)
- Test: `test/unit/monitor.test.ts`

**Interfaces:**
- Consumes: `AiflowEvent`(含 `budget_warning`,Task 1);`EngineState.budget`(Task 3)。
- Produces: `describeEvent` 对 `budget_warning` 输出专门行;`renderStatus` 在有 budget 时输出 `Budget:` 用量行。

- [ ] **Step 1: Write the failing tests**

在 `test/unit/monitor.test.ts` 追加(对齐文件已有对 `renderStatus`/`describeEvent` 的调用方式;下面用 `renderStatus` 整体断言,避免依赖 `describeEvent` 是否 export):

```ts
test("renderStatus renders a budget_warning event on its own line", () => {
  const state = {
    run_id: "r", pipeline: "p", stages: [],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 8 },
    budget: { limit_usd: 10, warn_at_pct: [0.8] },
  } as any;
  const events = [
    { ts: "2026-07-08T00:00:00.000Z", type: "budget_warning", stage: "build", threshold_pct: 0.8, spent_usd: 8, limit_usd: 10 },
  ] as any;
  const out = renderStatus(state, events, { tail: 8, color: false, now: new Date("2026-07-08T00:00:01.000Z") } as any);
  expect(out).toContain("budget 80%");
  expect(out).toContain("$8.0000/$10.0000");
});

test("renderStatus shows a Budget usage line when the run has a budget", () => {
  const state = {
    run_id: "r", pipeline: "p", stages: [],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 8 },
    budget: { limit_usd: 10 },
  } as any;
  const out = renderStatus(state, [], { tail: 8, color: false, now: new Date() } as any);
  expect(out).toContain("Budget: $8.0000 / $10.0000 (80%)");
});

test("renderStatus omits the Budget line when the run has no budget", () => {
  const state = {
    run_id: "r", pipeline: "p", stages: [],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 8 },
  } as any;
  const out = renderStatus(state, [], { tail: 8, color: false, now: new Date() } as any);
  expect(out).not.toContain("Budget:");
});
```

> 若 `renderStatus` 的 import 名或 opts 形状与文件现有测试不同,对齐文件顶部现有 import 与既有测试的 opts 构造。

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/monitor.test.ts`
Expected: FAIL —— 无 `budget 80%` 专门行,无 `Budget:` 用量行。

- [ ] **Step 3a: Add a describeEvent case for budget_warning**

`src/commands/monitor.ts` 的 `describeEvent` switch,在 `ralph_loop_result` case 之后、`default` 之前新增:

```ts
    case "budget_warning":
      return `${formatTime(evt.ts, now)}  ${c("yellow", color, "warn")}     ${evt.stage}  budget ${Math.round(evt.threshold_pct * 100)}% $${evt.spent_usd.toFixed(4)}/$${evt.limit_usd.toFixed(4)}`;
```

- [ ] **Step 3b: Add a Budget usage line to renderStatus**

`src/commands/monitor.ts` 的 `renderStatus`,在 Cost 区块(现约 197-199 行)之后新增。现有:

```ts
  lines.push(c("bold", color, "Cost:"));
  lines.push(`  in=${state.cost.input_tokens}  out=${state.cost.output_tokens}  est_usd=$${state.cost.est_usd.toFixed(4)}`);
  lines.push("");
```

在两条 push 之间(`est_usd` 行之后、空行之前)插入:

```ts
  if (state.budget) {
    const pct = state.budget.limit_usd > 0 ? Math.round((state.cost.est_usd / state.budget.limit_usd) * 100) : 0;
    const over = state.cost.est_usd >= state.budget.limit_usd;
    const usage = `  Budget: $${state.cost.est_usd.toFixed(4)} / $${state.budget.limit_usd.toFixed(4)} (${pct}%)`;
    lines.push(over ? c("red", color, usage) : usage);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/monitor.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/commands/monitor.ts test/unit/monitor.test.ts
git commit -m "feat: render budget_warning events and budget usage in status"
```

---

### Task 7: 端到端集成 + 全量校验

**Files:**
- Test: `test/integration/` 下新增或扩展一个 mocked-pipeline 测试(如 `test/integration/budget-warnings.test.ts`)
- 验证:全量 `bun test ./test` + `bunx tsc --noEmit`

**Interfaces:**
- Consumes: 全部前序任务的公共行为(engine 写事件、cost/state、formatBudgetOutcomeLine、status 渲染)。

- [ ] **Step 1: Write the end-to-end test**

参考 `test/integration/multi-stage-mocked.test.ts` 的搭建方式(真建临时 project、mock runner 产生 usage、跑 `runPipelineOnce` 或命令层),新建 `test/integration/budget-warnings.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipelineOnce } from "../../src/engine/engine";
import { readEvents } from "../../src/events/events";
import { formatBudgetOutcomeLine } from "../../src/commands/budget-outcome";

test("a run that crosses budget thresholds emits warnings and a near/exceeded outcome", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-budget-"));
  const deps = {
    runners: { ralph_loop: async () => ({ result: "pass", usage: { inTok: 0, outTok: 0, costUsd: 8.5 } }) },
    nowFn: () => new Date("2026-07-08T00:00:00.000Z"),
  } as any;
  const pipeline = {
    name: "p",
    budget: { max_cost_usd: 10, warn_at_pct: [0.5, 0.8] },
    stages: [{ id: "build", type: "ralph_loop" }],
  } as any;
  const state = await runPipelineOnce(pipeline, {}, "/tmp", runDir, deps);

  const warnings = readEvents(runDir).filter((e) => e.type === "budget_warning");
  expect(warnings.map((w: any) => w.threshold_pct)).toEqual([0.5, 0.8]);

  const line = formatBudgetOutcomeLine(state);
  expect(line).toBe("Budget near limit: $8.5000 / $10.0000 (85%)");
});
```

- [ ] **Step 2: Run the integration test**

Run: `bun test test/integration/budget-warnings.test.ts`
Expected: PASS。

- [ ] **Step 3: Run the full suite**

Run: `bun test ./test`
Expected: 全绿(前序各任务的测试 + 既有 268 + 新增,0 fail)。

- [ ] **Step 4: Type-check**

Run: `bunx tsc --noEmit`
Expected: 仅剩既有的预先存在测试文件类型错误(`test/integration/multi-stage-mocked.test.ts`、`test/unit/brainstorm.test.ts`、`test/unit/engine.test.ts` 的 `on_timeout`/`profiles` mock 类型);无生产文件新错误。

- [ ] **Step 5: Commit**

```bash
git add test/integration/budget-warnings.test.ts
git commit -m "test: end-to-end budget warnings and outcome note"
```

---

## Self-Review

**Spec coverage:**
- 目标1(多阈值告警)→ Task 2(检测)+ Task 4(写事件/stderr)。
- 目标2(run 结束提示)→ Task 5。
- 目标3(可观测:status 读回 + 渲染)→ Task 6。
- 目标4(向后兼容)→ Task 2(`warnAtPct` 默认 `[]`)、Task 3(state 可选字段)、Task 6(无 budget 省略)——各任务测试含无预算路径。
- 组件1 tracker → Task 2;组件2 接缝(drain)→ Task 4;组件3 config/state → Task 3;组件4 事件 → Task 1;组件5 结束提示 → Task 5;组件6 status → Task 6。
- 幂等/resume 预填 → Task 2 测试"initialSpentUsd 预填";engine 传 `state.cost.est_usd` 作 initial → Task 3 Step 3d。

**Placeholder scan:** 无 TBD/TODO;每个改动步骤含完整代码。少量"对齐文件现有 import/helper"的说明是因为 engine.test.ts / monitor.test.ts 的既有测试搭建方式需就地复用(实现者应打开文件确认 helper 名),非占位——每处都给了完整的目标测试代码。

**Type consistency:**
- `createBudgetTracker(limitUsd, initialSpentUsd, warnAtPct?)` 三处一致(Task 2 定义、Task 3 调用)。
- `drainPendingWarnings(): number[]` Task 2 定义、Task 4 使用一致。
- `BudgetWarningAiflowEvent` 字段(`threshold_pct`/`spent_usd`/`limit_usd`/`stage`)Task 1 定义,Task 4 写入、Task 6 渲染、Task 5 无关(用 state)全一致。
- `formatBudgetOutcomeLine(state): string | undefined` Task 5 定义、cli 三处调用、Task 7 使用一致。
- `EngineState.budget.warn_at_pct?: number[]` Task 3 定义,Task 4/5/6 读取一致。
