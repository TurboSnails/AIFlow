# aiflow cost 成本可观测与报表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增全通道准确的 `stage_cost` 事件与 `aiflow cost` 命令，把既有成本数据变成可展示、可审计、可导出（表格/JSON/CSV）的 per-stage 与跨 run 报表。

**Architecture:** engine 在每个 stage 完成时写一条 `stage_cost` 事件（来源是既有 `execResult.usage`，覆盖 opencode+http 全通道）。`src/commands/cost.ts` 提供与 I/O 解耦的纯聚合函数（`summarizeRunCost`/`summarizeAllRunsCost`）和纯渲染函数（表格/JSON/CSV），命令入口 `runCost` 负责读取与分发。`cli.ts` 注册只读的 `cost` 子命令。

**Tech Stack:** Bun (TypeScript)、bun:test、既有 events.jsonl / state.json、commander。无新依赖。

设计来源：`docs/superpowers/specs/2026-07-08-cost-observability-design.md`（commit 9839dc7）。

## Global Constraints

- 不新增 npm 依赖 —— 只用 Bun/Node 内置与既有模块（commander 已在用）。
- 不改 state.json / run.lock 盘上格式；events.jsonl 仅新增一种向后兼容的事件类型（旧 run 无此事件，新 run 有）。
- 聚合与渲染是纯函数（Summary/字符串进出）；I/O 隔离在读取层与命令入口。
- `cost` 是只读命令，不获取并发锁（与 status/watch 一致）。
- 不变式：一个 run 内所有 `stage_cost` 事件的 `cost_usd`（及 in/out）之和 == 该 run 的 `state.cost.est_usd`。
- `stage_cost` 字段命名（`in_tok`/`out_tok`/`cost_usd`）与既有 `opencode_step_finish` 一致。
- 金额显示 4 位小数（与 monitor `est_usd.toFixed(4)` 一致）。
- `--json` 与 `--csv` 互斥；`--all` 与 `--run-id` 互斥。
- 每个任务后运行 `bun test ./test`，保持全绿再进入下一个任务。

---

### Task 1: `stage_cost` 事件类型 + engine 写入

**Files:**
- Modify: `src/events/events.ts`（新增事件接口，加入联合类型）
- Modify: `src/engine/engine.ts`（import `appendEvent`；在累加 `state.cost` 处写事件）
- Test: `test/unit/events.test.ts`（round-trip）
- Test: `test/unit/engine.test.ts`（写入 + 不变式）

**Interfaces:**
- Produces: `StageCostAiflowEvent { ts: string; type: "stage_cost"; stage: string; in_tok: number; out_tok: number; cost_usd: number }`，加入 `AiflowEvent`。Task 2 消费。

- [ ] **Step 1: 写 events round-trip 失败测试**

Append to `test/unit/events.test.ts`（复用文件顶部已 import 的 `test/expect/mkdtempSync/rmSync/tmpdir/join/appendEvent/readEvents/AiflowEvent`）：

```typescript
test("appendEvent then readEvents round-trips a stage_cost event", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-events-test-"));
  try {
    const e: AiflowEvent = {
      ts: "2026-07-08T00:00:00.000Z",
      type: "stage_cost",
      stage: "develop",
      in_tok: 1200,
      out_tok: 340,
      cost_usd: 0.0512,
    };
    appendEvent(dir, e);
    const events = readEvents(dir);
    expect(events).toEqual([e]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/unit/events.test.ts -t "stage_cost"`
Expected: FAIL — TypeScript 报 `{ type: "stage_cost", ... }` 不可赋值给 `AiflowEvent`（联合类型尚无该成员）。

- [ ] **Step 3: 在 `src/events/events.ts` 新增事件类型**

在 `OpencodeStepFinishAiflowEvent` 接口之后插入：

```typescript
export interface StageCostAiflowEvent {
  ts: string;
  type: "stage_cost";
  stage: string;
  in_tok: number;
  out_tok: number;
  cost_usd: number;
}
```

在 `AiflowEvent` 联合类型中加入这一成员（放在 `OpencodeStepFinishAiflowEvent` 之后）：

```typescript
export type AiflowEvent =
  | OpencodeToolUseAiflowEvent
  | OpencodeStepFinishAiflowEvent
  | StageCostAiflowEvent
  | GateResultAiflowEvent
  | StoryResultAiflowEvent
  | RalphLoopResultAiflowEvent
  | BrainstormResultAiflowEvent
  | SpecResultAiflowEvent
  | PlanResultAiflowEvent
  | HumanGateWaitingAiflowEvent
  | HumanGateRejectedAiflowEvent
  | StoryAutoCleanedAiflowEvent;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/unit/events.test.ts`
Expected: PASS（新 round-trip + 所有现有事件测试）

- [ ] **Step 5: 写 engine 写入的失败测试**

Append to `test/unit/engine.test.ts`（复用文件顶部已 import 的 `runPipelineOnce`、`readState`、`mock`、`mkdtempSync/rmSync/join/tmpdir`；新增从 events 读取的 import）。先在文件顶部 import 区加一行：

```typescript
import { readEvents } from "../../src/events/events";
```

然后追加测试（用文件顶部已定义的 `pipeline`/`profiles` 夹具，其唯一 stage 是 `ralph_loop`；再定义一个含 human_gate 的两 stage 管道以验证无 usage 的 stage 不写事件）：

```typescript
test("runPipelineOnce writes a stage_cost event per stage that reports usage, and their sum equals state.cost", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-cost-"));
  try {
    const ralphLoop = mock(async () => ({ result: "pass" as const, usage: { inTok: 120, outTok: 45, costUsd: 0.9 } }));
    const state = await runPipelineOnce(pipeline, profiles, "/tmp/does-not-matter", runDir, {
      runners: { ralph_loop: ralphLoop },
    });
    const events = readEvents(runDir);
    const stageCosts = events.filter((e) => e.type === "stage_cost");
    expect(stageCosts).toEqual([
      { ts: expect.any(String), type: "stage_cost", stage: "develop", in_tok: 120, out_tok: 45, cost_usd: 0.9 },
    ]);
    // 不变式：stage_cost 之和 == run 级 state.cost
    const sum = stageCosts.reduce((a, e) => a + (e.type === "stage_cost" ? e.cost_usd : 0), 0);
    expect(sum).toBeCloseTo(state.cost.est_usd, 10);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runPipelineOnce does not write a stage_cost event for a stage that reports no usage", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-engine-cost-nousage-"));
  try {
    const twoStage: PipelineConfig = {
      name: "gated",
      stages: [
        { id: "confirm", type: "human_gate", prompt: "ok?" },
        {
          id: "develop",
          type: "ralph_loop",
          model: "main-dev",
          per_story_fix_limit: 3,
          max_iterations: 10,
          stall_limit: 3,
          auto_clean: false,
          gate: { checks: [], ai_review: { enabled: false, model: "reviewer", fail_on: ["blocker"] } },
        },
      ],
    };
    // human_gate returns waiting_human with NO usage → pipeline pauses at stage 0, no stage_cost written.
    const state = await runPipelineOnce(twoStage, profiles, "/tmp/does-not-matter", runDir, {
      runners: {
        human_gate: mock(async () => ({ result: "waiting_human" as const })),
      },
    });
    expect(state.stages[0].status).toBe("waiting_human");
    const events = readEvents(runDir);
    expect(events.filter((e) => e.type === "stage_cost")).toEqual([]);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `bun test test/unit/engine.test.ts -t "stage_cost"`
Expected: FAIL — engine 尚未写 `stage_cost` 事件，第一个测试的 `stageCosts` 为空数组。

- [ ] **Step 7: 在 `src/engine/engine.ts` 写入事件**

在 import 区把 events 的 import 从：

```typescript
import { readEvents } from "../events/events";
```

改为：

```typescript
import { readEvents, appendEvent } from "../events/events";
```

在 `runPipelineOnce` 主循环中，累加 `state.cost` 的那段（当前约 293-304 行）：

```typescript
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
```

替换为（在写 state 之后、若有 usage 则追加事件）：

```typescript
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

    if (execResult.usage) {
      appendEvent(runDir, {
        ts: nowFn().toISOString(),
        type: "stage_cost",
        stage: stage.id,
        in_tok: execResult.usage.inTok,
        out_tok: execResult.usage.outTok,
        cost_usd: execResult.usage.costUsd,
      });
    }
```

（`nowFn` 已在 `runPipelineOnce` 作用域内定义；`stage` 是主循环的当前 `StageConfig`，`stage.id` 可用。）

- [ ] **Step 8: 运行测试确认通过**

Run: `bun test test/unit/engine.test.ts`
Expected: PASS

- [ ] **Step 9: 运行全量测试**

Run: `bun test ./test`
Expected: PASS

- [ ] **Step 10: 提交**

```bash
git add src/events/events.ts src/engine/engine.ts test/unit/events.test.ts test/unit/engine.test.ts
git commit -m "feat: emit stage_cost event per stage for full-channel per-stage cost accounting"
```

---

### Task 2: 成本聚合纯函数

**Files:**
- Create: `src/commands/cost.ts`
- Test: `test/unit/cost.test.ts`

**Interfaces:**
- Consumes: `StageCostAiflowEvent`（Task 1）、`AiflowEvent`、`EngineState`。
- Produces:
  - `summarizeRunCost(runId: string, state: EngineState, events: AiflowEvent[]): RunCostSummary`
  - `summarizeAllRunsCost(runs: { runId: string; state: EngineState; events: AiflowEvent[] }[]): AllRunsCostSummary`
  - 类型 `StageCost`、`RunCostSummary`、`AllRunsCostRow`、`AllRunsCostSummary`（Task 3 消费）。

- [ ] **Step 1: 写失败测试**

Create `test/unit/cost.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { summarizeRunCost, summarizeAllRunsCost } from "../../src/commands/cost";
import type { EngineState } from "../../src/engine/state";
import type { AiflowEvent } from "../../src/events/events";

function stateWith(estUsd: number, pipeline = "full-auto"): EngineState {
  return {
    run_id: "r1",
    pipeline,
    stages: [],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: estUsd },
  };
}

function stageCost(stage: string, inTok: number, outTok: number, costUsd: number): AiflowEvent {
  return { ts: "2026-07-08T00:00:00.000Z", type: "stage_cost", stage, in_tok: inTok, out_tok: outTok, cost_usd: costUsd };
}

test("summarizeRunCost groups stage_cost events by stage and totals them", () => {
  const events: AiflowEvent[] = [
    stageCost("ideate", 12400, 3100, 0.062),
    stageCost("develop", 120000, 45000, 0.95),
  ];
  const s = summarizeRunCost("r1", stateWith(1.012), events);
  expect(s.breakdownAvailable).toBe(true);
  expect(s.stages).toEqual([
    { stage: "ideate", inTok: 12400, outTok: 3100, costUsd: 0.062 },
    { stage: "develop", inTok: 120000, outTok: 45000, costUsd: 0.95 },
  ]);
  expect(s.totalInTok).toBe(132400);
  expect(s.totalOutTok).toBe(48100);
  expect(s.totalCostUsd).toBeCloseTo(1.012, 10);
  expect(s.runLevelCostUsd).toBe(1.012);
  expect(s.pipeline).toBe("full-auto");
});

test("summarizeRunCost accumulates multiple stage_cost events for the same stage into one row", () => {
  const events: AiflowEvent[] = [
    stageCost("develop", 100, 10, 0.1),
    stageCost("develop", 200, 20, 0.2),
  ];
  const s = summarizeRunCost("r1", stateWith(0.3), events);
  expect(s.stages).toEqual([{ stage: "develop", inTok: 300, outTok: 30, costUsd: 0.3 }]);
  expect(s.totalCostUsd).toBeCloseTo(0.3, 10);
});

test("summarizeRunCost degrades gracefully for a run with no stage_cost events", () => {
  const s = summarizeRunCost("old-run", stateWith(0.5), [
    { ts: "t", type: "story_result", story: "US-1", result: "pass" },
  ]);
  expect(s.breakdownAvailable).toBe(false);
  expect(s.stages).toEqual([]);
  expect(s.totalCostUsd).toBe(0);
  expect(s.totalInTok).toBe(0);
  expect(s.totalOutTok).toBe(0);
  expect(s.runLevelCostUsd).toBe(0.5);
});

test("summarizeAllRunsCost uses run-level state.cost per row and computes grand totals", () => {
  const runs = [
    { runId: "r2", state: { ...stateWith(2, "p2"), cost: { input_tokens: 20, output_tokens: 8, est_usd: 2 } }, events: [stageCost("develop", 20, 8, 2)] },
    { runId: "r1", state: { ...stateWith(0.5, "p1"), cost: { input_tokens: 10, output_tokens: 4, est_usd: 0.5 } }, events: [] as AiflowEvent[] },
  ];
  const s = summarizeAllRunsCost(runs);
  expect(s.rows).toEqual([
    { runId: "r2", pipeline: "p2", totalInTok: 20, totalOutTok: 8, totalCostUsd: 2, breakdownAvailable: true },
    { runId: "r1", pipeline: "p1", totalInTok: 10, totalOutTok: 4, totalCostUsd: 0.5, breakdownAvailable: false },
  ]);
  expect(s.grandTotalInTok).toBe(30);
  expect(s.grandTotalOutTok).toBe(12);
  expect(s.grandTotalCostUsd).toBeCloseTo(2.5, 10);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/unit/cost.test.ts`
Expected: FAIL — `Cannot find module '../../src/commands/cost'`

- [ ] **Step 3: 实现 `src/commands/cost.ts`（聚合部分）**

```typescript
import type { EngineState } from "../engine/state";
import type { AiflowEvent } from "../events/events";

export interface StageCost {
  stage: string;
  inTok: number;
  outTok: number;
  costUsd: number;
}

export interface RunCostSummary {
  runId: string;
  pipeline: string;
  stages: StageCost[];
  totalInTok: number;
  totalOutTok: number;
  totalCostUsd: number;
  runLevelCostUsd: number;
  breakdownAvailable: boolean;
}

export interface AllRunsCostRow {
  runId: string;
  pipeline: string;
  totalInTok: number;
  totalOutTok: number;
  totalCostUsd: number;
  breakdownAvailable: boolean;
}

export interface AllRunsCostSummary {
  rows: AllRunsCostRow[];
  grandTotalInTok: number;
  grandTotalOutTok: number;
  grandTotalCostUsd: number;
}

export function summarizeRunCost(runId: string, state: EngineState, events: AiflowEvent[]): RunCostSummary {
  const order: string[] = [];
  const byStage = new Map<string, StageCost>();
  for (const e of events) {
    if (e.type !== "stage_cost") continue;
    let row = byStage.get(e.stage);
    if (!row) {
      row = { stage: e.stage, inTok: 0, outTok: 0, costUsd: 0 };
      byStage.set(e.stage, row);
      order.push(e.stage);
    }
    row.inTok += e.in_tok;
    row.outTok += e.out_tok;
    row.costUsd += e.cost_usd;
  }
  const stages = order.map((s) => byStage.get(s)!);
  const totalInTok = stages.reduce((a, s) => a + s.inTok, 0);
  const totalOutTok = stages.reduce((a, s) => a + s.outTok, 0);
  const totalCostUsd = stages.reduce((a, s) => a + s.costUsd, 0);
  return {
    runId,
    pipeline: state.pipeline,
    stages,
    totalInTok,
    totalOutTok,
    totalCostUsd,
    runLevelCostUsd: state.cost.est_usd,
    breakdownAvailable: stages.length > 0,
  };
}

export function summarizeAllRunsCost(
  runs: { runId: string; state: EngineState; events: AiflowEvent[] }[]
): AllRunsCostSummary {
  const rows: AllRunsCostRow[] = runs.map(({ runId, state, events }) => ({
    runId,
    pipeline: state.pipeline,
    totalInTok: state.cost.input_tokens,
    totalOutTok: state.cost.output_tokens,
    totalCostUsd: state.cost.est_usd,
    breakdownAvailable: events.some((e) => e.type === "stage_cost"),
  }));
  return {
    rows,
    grandTotalInTok: rows.reduce((a, r) => a + r.totalInTok, 0),
    grandTotalOutTok: rows.reduce((a, r) => a + r.totalOutTok, 0),
    grandTotalCostUsd: rows.reduce((a, r) => a + r.totalCostUsd, 0),
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/unit/cost.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 运行全量测试**

Run: `bun test ./test`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/commands/cost.ts test/unit/cost.test.ts
git commit -m "feat: add pure cost aggregation functions (per-run and cross-run)"
```

---

### Task 3: 渲染纯函数（表格/JSON/CSV）

**Files:**
- Modify: `src/commands/cost.ts`（追加三个渲染函数）
- Test: `test/unit/cost.test.ts`（追加渲染测试）

**Interfaces:**
- Consumes: `RunCostSummary`、`AllRunsCostSummary`（Task 2）。
- Produces:
  - `renderRunCostTable(summary: RunCostSummary, opts?: { color?: boolean }): string`
  - `renderAllRunsCostTable(summary: AllRunsCostSummary, opts?: { color?: boolean }): string`
  - `renderCostJson(summary: RunCostSummary | AllRunsCostSummary): string`
  - `renderRunCostCsv(summary: RunCostSummary): string`
  - `renderAllRunsCostCsv(summary: AllRunsCostSummary): string`

- [ ] **Step 1: 写失败测试**

Append to `test/unit/cost.test.ts`（复用文件顶部的 helper；新增被测函数的 import —— 把顶部 import 行改为包含全部渲染函数）：

顶部 import 改为：

```typescript
import {
  summarizeRunCost,
  summarizeAllRunsCost,
  renderRunCostTable,
  renderAllRunsCostTable,
  renderCostJson,
  renderRunCostCsv,
  renderAllRunsCostCsv,
} from "../../src/commands/cost";
```

追加测试：

```typescript
test("renderRunCostTable shows per-stage rows, a total row, and the run/pipeline header", () => {
  const s = summarizeRunCost("run-x", stateWith(1.012, "full-auto"), [
    stageCost("ideate", 12400, 3100, 0.062),
    stageCost("develop", 120000, 45000, 0.95),
  ]);
  const out = renderRunCostTable(s, { color: false });
  expect(out).toContain("run-x");
  expect(out).toContain("full-auto");
  expect(out).toContain("ideate");
  expect(out).toContain("develop");
  expect(out).toContain("Total");
  expect(out).toContain("$1.0120");
  // 千位分隔
  expect(out).toContain("120,000");
});

test("renderRunCostTable prints the degraded notice and run-level total when breakdown is unavailable", () => {
  const s = summarizeRunCost("old-run", stateWith(0.5), []);
  const out = renderRunCostTable(s, { color: false });
  expect(out).toContain("Per-stage breakdown unavailable");
  expect(out).toContain("$0.5000");
  expect(out).not.toContain("Total  ");
});

test("renderRunCostTable adds a reconciliation line when stage sum differs from run-level cost", () => {
  const s = summarizeRunCost("run-x", stateWith(2.0), [stageCost("develop", 1, 1, 1.5)]);
  const out = renderRunCostTable(s, { color: false });
  expect(out).toContain("run-level state.cost: $2.0000");
});

test("renderCostJson serializes the RunCostSummary structurally", () => {
  const s = summarizeRunCost("run-x", stateWith(0.062, "p"), [stageCost("ideate", 12400, 3100, 0.062)]);
  const parsed = JSON.parse(renderCostJson(s));
  expect(parsed.runId).toBe("run-x");
  expect(parsed.stages[0]).toEqual({ stage: "ideate", inTok: 12400, outTok: 3100, costUsd: 0.062 });
  expect(parsed.breakdownAvailable).toBe(true);
});

test("renderRunCostCsv emits a header, one row per stage, and a total row without thousands separators", () => {
  const s = summarizeRunCost("run-x", stateWith(1.012), [
    stageCost("ideate", 12400, 3100, 0.062),
    stageCost("develop", 120000, 45000, 0.95),
  ]);
  const csv = renderRunCostCsv(s);
  const lines = csv.trim().split("\n");
  expect(lines[0]).toBe("stage,in_tok,out_tok,cost_usd");
  expect(lines[1]).toBe("ideate,12400,3100,0.062");
  expect(lines[2]).toBe("develop,120000,45000,0.95");
  expect(lines[3]).toBe("total,132400,48100,1.012");
});

test("renderAllRunsCostCsv emits a header and one row per run with breakdown_available", () => {
  const s = summarizeAllRunsCost([
    { runId: "r2", state: { ...stateWith(2, "p2"), cost: { input_tokens: 20, output_tokens: 8, est_usd: 2 } }, events: [stageCost("develop", 20, 8, 2)] },
    { runId: "r1", state: { ...stateWith(0.5, "p1"), cost: { input_tokens: 10, output_tokens: 4, est_usd: 0.5 } }, events: [] },
  ]);
  const csv = renderAllRunsCostCsv(s);
  const lines = csv.trim().split("\n");
  expect(lines[0]).toBe("run_id,pipeline,in_tok,out_tok,cost_usd,breakdown_available");
  expect(lines[1]).toBe("r2,p2,20,8,2,true");
  expect(lines[2]).toBe("r1,p1,10,4,0.5,false");
});

test("renderAllRunsCostTable shows one row per run and a grand total", () => {
  const s = summarizeAllRunsCost([
    { runId: "r2", state: { ...stateWith(2, "p2"), cost: { input_tokens: 20, output_tokens: 8, est_usd: 2 } }, events: [stageCost("develop", 20, 8, 2)] },
  ]);
  const out = renderAllRunsCostTable(s, { color: false });
  expect(out).toContain("r2");
  expect(out).toContain("p2");
  expect(out).toContain("$2.0000");
  expect(out).toContain("Grand total");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/unit/cost.test.ts -t "render"`
Expected: FAIL — 渲染函数未定义。

- [ ] **Step 3: 在 `src/commands/cost.ts` 追加渲染函数**

在文件末尾追加。ANSI 辅助复制 monitor.ts 的最小子集（避免跨文件耦合）：

```typescript
const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", gray: "\x1b[90m" } as const;

function paint(code: keyof typeof ANSI, on: boolean, text: string): string {
  return on ? `${ANSI[code]}${text}${ANSI.reset}` : text;
}

function commas(n: number): string {
  return n.toLocaleString("en-US");
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

export function renderRunCostTable(summary: RunCostSummary, opts: { color?: boolean } = {}): string {
  const color = opts.color !== false;
  const lines: string[] = [];
  lines.push(paint("bold", color, `Cost — run ${summary.runId} (pipeline: ${summary.pipeline})`));
  lines.push("");
  if (!summary.breakdownAvailable) {
    lines.push("  Per-stage breakdown unavailable for this run (predates stage_cost events).");
    lines.push(`  Total (run-level): ${usd(summary.runLevelCostUsd)}`);
    return lines.join("\n");
  }
  const stageW = Math.max(14, ...summary.stages.map((s) => s.stage.length));
  const header = `  ${"Stage".padEnd(stageW)}  ${"In tokens".padStart(12)}  ${"Out tokens".padStart(12)}  ${"Cost".padStart(10)}`;
  lines.push(paint("bold", color, header));
  for (const s of summary.stages) {
    lines.push(`  ${s.stage.padEnd(stageW)}  ${commas(s.inTok).padStart(12)}  ${commas(s.outTok).padStart(12)}  ${usd(s.costUsd).padStart(10)}`);
  }
  lines.push(`  ${"-".repeat(stageW + 40)}`);
  lines.push(`  ${"Total".padEnd(stageW)}  ${commas(summary.totalInTok).padStart(12)}  ${commas(summary.totalOutTok).padStart(12)}  ${usd(summary.totalCostUsd).padStart(10)}`);
  if (Math.abs(summary.totalCostUsd - summary.runLevelCostUsd) > 1e-9) {
    lines.push(paint("gray", color, `  (run-level state.cost: ${usd(summary.runLevelCostUsd)})`));
  }
  return lines.join("\n");
}

export function renderAllRunsCostTable(summary: AllRunsCostSummary, opts: { color?: boolean } = {}): string {
  const color = opts.color !== false;
  const lines: string[] = [];
  lines.push(paint("bold", color, "Cost — all runs"));
  lines.push("");
  const runW = Math.max(20, ...summary.rows.map((r) => r.runId.length));
  const pipeW = Math.max(10, ...summary.rows.map((r) => r.pipeline.length));
  const header = `  ${"Run".padEnd(runW)}  ${"Pipeline".padEnd(pipeW)}  ${"In tokens".padStart(12)}  ${"Out tokens".padStart(12)}  ${"Cost".padStart(10)}`;
  lines.push(paint("bold", color, header));
  let anyDegraded = false;
  for (const r of summary.rows) {
    const mark = r.breakdownAvailable ? "" : " *";
    if (!r.breakdownAvailable) anyDegraded = true;
    lines.push(`  ${r.runId.padEnd(runW)}  ${r.pipeline.padEnd(pipeW)}  ${commas(r.totalInTok).padStart(12)}  ${commas(r.totalOutTok).padStart(12)}  ${(usd(r.totalCostUsd) + mark).padStart(10)}`);
  }
  lines.push(`  ${"-".repeat(runW + pipeW + 40)}`);
  lines.push(`  ${"Grand total".padEnd(runW)}  ${"".padEnd(pipeW)}  ${commas(summary.grandTotalInTok).padStart(12)}  ${commas(summary.grandTotalOutTok).padStart(12)}  ${usd(summary.grandTotalCostUsd).padStart(10)}`);
  if (anyDegraded) {
    lines.push(paint("gray", color, "  * per-stage breakdown unavailable (predates stage_cost events)"));
  }
  return lines.join("\n");
}

export function renderCostJson(summary: RunCostSummary | AllRunsCostSummary): string {
  return JSON.stringify(summary, null, 2);
}

export function renderRunCostCsv(summary: RunCostSummary): string {
  const lines: string[] = ["stage,in_tok,out_tok,cost_usd"];
  for (const s of summary.stages) {
    lines.push(`${s.stage},${s.inTok},${s.outTok},${s.costUsd}`);
  }
  lines.push(`total,${summary.totalInTok},${summary.totalOutTok},${summary.totalCostUsd}`);
  return lines.join("\n") + "\n";
}

export function renderAllRunsCostCsv(summary: AllRunsCostSummary): string {
  const lines: string[] = ["run_id,pipeline,in_tok,out_tok,cost_usd,breakdown_available"];
  for (const r of summary.rows) {
    lines.push(`${r.runId},${r.pipeline},${r.totalInTok},${r.totalOutTok},${r.totalCostUsd},${r.breakdownAvailable}`);
  }
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/unit/cost.test.ts`
Expected: PASS（聚合 4 + 渲染 7）

注意：`renderRunCostTable` 降级测试断言 `expect(out).not.toContain("Total  ")`（"Total" 后跟两个空格，即表格里的对齐总计行）——降级路径打印的是 `Total (run-level):`（"Total" 后跟空格加括号），不含 `"Total  "` 双空格序列，断言成立。

- [ ] **Step 5: 运行全量测试**

Run: `bun test ./test`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/commands/cost.ts test/unit/cost.test.ts
git commit -m "feat: add table/JSON/CSV renderers for cost summaries"
```

---

### Task 4: 命令入口 `runCost` + CLI 接线 + 集成测试

**Files:**
- Modify: `src/commands/cost.ts`（追加读取层 + `runCost` 入口）
- Modify: `src/cli.ts`（注册 `cost` 子命令）
- Test: `test/unit/cost.test.ts`（追加 `runCost` 分发/错误测试）
- Test: `test/integration/multi-stage-mocked.test.ts`（追加端到端 per-stage 对账测试）

**Interfaces:**
- Consumes: 全部 Task 1–3 的产物。
- Produces: `runCost(cwd: string, opts: RunCostOptions): number`，`RunCostOptions { runId?: string; all?: boolean; json?: boolean; csv?: boolean; color?: boolean; write?: (s: string) => void }`。

- [ ] **Step 1: 写失败测试**

Append to `test/unit/cost.test.ts`（新增 import：`runCost`，以及 node:fs/os/path 用于搭建临时 run 目录）。在顶部 import 区补充：

```typescript
import { runCost } from "../../src/commands/cost";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

（`test`/`expect` 已在顶部 import；若 `join` 等已被前面的 helper 引入则合并，勿重复声明。）

追加测试：

```typescript
function makeRun(cwd: string, runId: string, estUsd: number, stageEvents: AiflowEvent[]): void {
  const runDir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const state: EngineState = {
    run_id: runId,
    pipeline: "full-auto",
    stages: [{ id: "develop", status: "done" }],
    cost: { input_tokens: 100, output_tokens: 40, est_usd: estUsd },
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state));
  if (stageEvents.length > 0) {
    writeFileSync(join(runDir, "events.jsonl"), stageEvents.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
}

test("runCost renders the latest run's table by default and returns 0", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-cost-cmd-"));
  try {
    makeRun(cwd, "20260708_100000_aaaaaa", 0.5, [stageCost("develop", 100, 40, 0.5)]);
    let out = "";
    const code = runCost(cwd, { color: false, write: (s) => { out += s; } });
    expect(code).toBe(0);
    expect(out).toContain("develop");
    expect(out).toContain("$0.5000");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runCost --json emits parseable JSON for the run", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-cost-cmd-json-"));
  try {
    makeRun(cwd, "20260708_100000_bbbbbb", 0.5, [stageCost("develop", 100, 40, 0.5)]);
    let out = "";
    const code = runCost(cwd, { json: true, write: (s) => { out += s; } });
    expect(code).toBe(0);
    expect(JSON.parse(out).stages[0].stage).toBe("develop");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runCost --all lists every run with a grand total", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-cost-cmd-all-"));
  try {
    makeRun(cwd, "20260708_100000_run1aa", 0.5, [stageCost("develop", 100, 40, 0.5)]);
    makeRun(cwd, "20260708_110000_run2bb", 1.5, [stageCost("develop", 200, 80, 1.5)]);
    let out = "";
    const code = runCost(cwd, { all: true, color: false, write: (s) => { out += s; } });
    expect(code).toBe(0);
    expect(out).toContain("Grand total");
    expect(out).toContain("$2.0000");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runCost returns 1 and writes an error when there are no runs", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-cost-cmd-empty-"));
  try {
    let err = "";
    const code = runCost(cwd, { write: () => {}, writeErr: (s) => { err += s; } });
    expect(code).toBe(1);
    expect(err).toContain("No runs found");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runCost returns 1 when --json and --csv are combined", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-cost-cmd-x1-"));
  try {
    makeRun(cwd, "20260708_100000_cccccc", 0.5, [stageCost("develop", 100, 40, 0.5)]);
    let err = "";
    const code = runCost(cwd, { json: true, csv: true, write: () => {}, writeErr: (s) => { err += s; } });
    expect(code).toBe(1);
    expect(err).toContain("mutually exclusive");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runCost returns 1 when --all and --run-id are combined", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-cost-cmd-x2-"));
  try {
    makeRun(cwd, "20260708_100000_dddddd", 0.5, [stageCost("develop", 100, 40, 0.5)]);
    let err = "";
    const code = runCost(cwd, { all: true, runId: "20260708_100000_dddddd", write: () => {}, writeErr: (s) => { err += s; } });
    expect(code).toBe(1);
    expect(err).toContain("mutually exclusive");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runCost returns 1 when the requested --run-id does not exist", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-cost-cmd-x3-"));
  try {
    makeRun(cwd, "20260708_100000_eeeeee", 0.5, [stageCost("develop", 100, 40, 0.5)]);
    let err = "";
    const code = runCost(cwd, { runId: "nonexistent", write: () => {}, writeErr: (s) => { err += s; } });
    expect(code).toBe(1);
    expect(err).toContain("not found");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/unit/cost.test.ts -t "runCost"`
Expected: FAIL — `runCost` 未定义。

- [ ] **Step 3: 在 `src/commands/cost.ts` 追加读取层与 `runCost`**

在文件顶部 import 区补充：

```typescript
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
```

在文件末尾追加：

```typescript
export interface RunCostOptions {
  runId?: string;
  all?: boolean;
  json?: boolean;
  csv?: boolean;
  color?: boolean;
  write?: (s: string) => void;
  writeErr?: (s: string) => void;
}

interface LoadedRun {
  runId: string;
  state: EngineState;
  events: AiflowEvent[];
}

function runsRoot(cwd: string): string {
  return join(cwd, ".aiflow", "runs");
}

function listRunIdsByMtimeDesc(cwd: string): string[] {
  const root = runsRoot(cwd);
  if (!existsSync(root)) return [];
  const dirs = readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory());
  dirs.sort((a, b) => statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs);
  return dirs;
}

function loadRun(cwd: string, runId: string): LoadedRun | undefined {
  const runDir = join(runsRoot(cwd), runId);
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) return undefined;
  const state = JSON.parse(readFileSync(statePath, "utf-8")) as EngineState;
  const eventsPath = join(runDir, "events.jsonl");
  const events: AiflowEvent[] = existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as AiflowEvent)
    : [];
  return { runId, state, events };
}

export function runCost(cwd: string, opts: RunCostOptions): number {
  const write = opts.write ?? ((s) => process.stdout.write(s));
  const writeErr = opts.writeErr ?? ((s) => process.stderr.write(s));
  const color = opts.color !== false;

  if (opts.json && opts.csv) {
    writeErr("--json and --csv are mutually exclusive\n");
    return 1;
  }
  if (opts.all && opts.runId) {
    writeErr("--all and --run-id are mutually exclusive\n");
    return 1;
  }

  if (opts.all) {
    const ids = listRunIdsByMtimeDesc(cwd);
    if (ids.length === 0) {
      writeErr(`No runs found in ${runsRoot(cwd)}\n`);
      return 1;
    }
    const loaded = ids.map((id) => loadRun(cwd, id)).filter((r): r is LoadedRun => r !== undefined);
    const summary = summarizeAllRunsCost(loaded);
    if (opts.json) write(renderCostJson(summary) + "\n");
    else if (opts.csv) write(renderAllRunsCostCsv(summary));
    else write(renderAllRunsCostTable(summary, { color }) + "\n");
    return 0;
  }

  let runId = opts.runId;
  if (!runId) {
    const ids = listRunIdsByMtimeDesc(cwd);
    if (ids.length === 0) {
      writeErr(`No runs found in ${runsRoot(cwd)}\n`);
      return 1;
    }
    runId = ids[0];
  }
  const loaded = loadRun(cwd, runId);
  if (!loaded) {
    writeErr(`Run ${runId} not found in ${runsRoot(cwd)}\n`);
    return 1;
  }
  const summary = summarizeRunCost(loaded.runId, loaded.state, loaded.events);
  if (opts.json) write(renderCostJson(summary) + "\n");
  else if (opts.csv) write(renderRunCostCsv(summary));
  else write(renderRunCostTable(summary, { color }) + "\n");
  return 0;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/unit/cost.test.ts`
Expected: PASS（聚合 4 + 渲染 7 + runCost 7）

- [ ] **Step 5: 在 `src/cli.ts` 注册 `cost` 子命令**

在 `status` 命令注册块之后（`program.command("watch")` 之前或之后均可，放 `status` 之后最自然）插入：

```typescript
program
  .command("cost")
  .description("Report token and USD cost per stage (default: latest run)")
  .option("--run-id <id>", "show a specific run (defaults to latest)")
  .option("--all", "summarize cost across all runs", false)
  .option("--json", "output structured JSON", false)
  .option("--csv", "output CSV", false)
  .option("--no-color", "disable ANSI colors")
  .action(async (opts: { runId?: string; all: boolean; json: boolean; csv: boolean; color: boolean }) => {
    const { runCost } = await import("./commands/cost");
    const code = runCost(process.cwd(), {
      runId: opts.runId,
      all: opts.all,
      json: opts.json,
      csv: opts.csv,
      color: opts.color,
    });
    process.exitCode = code;
  });
```

- [ ] **Step 6: 写端到端集成测试**

Append to `test/integration/multi-stage-mocked.test.ts`（复用该文件已有的 `runCommand` import 与 `setupProject` 风格；新增 `runCost` 的 import 和从 events 读取）。在文件顶部 import 区补充：

```typescript
import { runCost, summarizeRunCost } from "../../src/commands/cost";
import { readRunSnapshot } from "../../src/commands/monitor";
```

追加测试：

```typescript
test("aiflow cost per-stage totals reconcile with state.cost after a real mocked run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-cost-e2e-"));
  try {
    mkdirSync(join(dir, ".aiflow", "config", "pipelines"), { recursive: true });
    writeFileSync(
      join(dir, ".aiflow", "config", "models.yaml"),
      "profiles:\n  main-dev:\n    channel: opencode\n    provider: x\n    model: y\n  reviewer:\n    channel: http\n    provider: y\n    model: z\n"
    );
    writeFileSync(
      join(dir, ".aiflow", "config", "pipelines", "priced.yaml"),
      'name: priced\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    per_story_fix_limit: 3\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n'
    );
    writeFileSync(
      join(dir, "prd.json"),
      JSON.stringify({ branchName: "x", stories: [{ id: "US-1", title: "t", acceptance: [], priority: 1, passes: true, fixCount: 0 }] })
    );
    await $`git -C ${dir} init -q`;
    await $`git -C ${dir} config user.email "test@example.com"`;
    await $`git -C ${dir} config user.name "Test"`;
    await $`git -C ${dir} add -A`;
    await $`git -C ${dir} commit -q -m "initial"`;

    // All stories already pass → ralph_loop completes with a small usage; a stage_cost event is written.
    const state = await runCommand(dir, "priced", { runAgentTask: async () => ({ ok: true, transcriptPath: "u", usage: { inTok: 5, outTok: 2, costUsd: 0.03 } }) });

    const snap = readRunSnapshot(dir, state.run_id)!;
    const summary = summarizeRunCost(state.run_id, snap.state, snap.events);
    // per-stage total reconciles with run-level state.cost
    expect(summary.totalCostUsd).toBeCloseTo(snap.state.cost.est_usd, 10);

    let out = "";
    const code = runCost(dir, { runId: state.run_id, color: false, write: (s) => { out += s; } });
    expect(code).toBe(0);
    expect(out).toContain("develop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

（注意：若 `all-stories-already-pass` 导致 ralph_loop 未发生 agent 调用而无 usage，则改用 `passes: false` 让其跑一轮。实现者请先运行看 `state.cost.est_usd` 是否 >0；若为 0，把 `passes` 改为 `false` 并保持 mock agent 使 US-1 通过一轮。核心断言是 `summary.totalCostUsd` 与 `state.cost.est_usd` 相等，无论具体数值。）

- [ ] **Step 7: 运行集成测试确认通过**

Run: `bun test test/integration/multi-stage-mocked.test.ts -t "reconcile"`
Expected: PASS

- [ ] **Step 8: 运行全量测试**

Run: `bun test ./test`
Expected: PASS

- [ ] **Step 9: 手动冒烟（可选但推荐）**

Run: `bun run src/cli.ts cost --help`
Expected: 显示 `cost` 命令与 `--run-id/--all/--json/--csv/--no-color` 选项。

- [ ] **Step 10: 提交**

```bash
git add src/commands/cost.ts src/cli.ts test/unit/cost.test.ts test/integration/multi-stage-mocked.test.ts
git commit -m "feat: add aiflow cost command wiring and end-to-end reconciliation test"
```

---

## Self-Review Notes

- **Spec coverage:** 组件 1（stage_cost 事件 + engine 写入）→ Task 1。组件 2（聚合纯函数）→ Task 2。组件 3（三种渲染）→ Task 3。组件 4（CLI 接线 + runCost 入口 + 错误处理 + 集成对账）→ Task 4。设计的五点测试策略分散在各任务的 Step。全部覆盖。
- **Placeholder scan:** 无 TBD/TODO。Task 4 Step 6 的"若全通过导致无 usage 则改 passes:false"是一条明确的实现者指令（含判据与备选动作），非未完成工作 —— 核心断言（total == state.cost）与具体数值无关，稳健。
- **Type consistency:** `StageCostAiflowEvent` 字段 `in_tok/out_tok/cost_usd`（Task 1）在聚合（Task 2 读 `e.in_tok` 等）与测试夹具中一致。`StageCost` 用驼峰 `inTok/outTok/costUsd`（Task 2 定义，Task 3 渲染消费）。`RunCostSummary`/`AllRunsCostSummary`/`RunCostOptions` 名称在 Task 2–4 间一致。`runCost(cwd, opts): number` 签名与 status 的 `runStatus` 风格一致，`write/writeErr` 注入便于测试。
- **不变式落测:** Task 1 Step 5 的第一个测试与 Task 4 Step 6 的集成测试都断言 `stage_cost 之和 == state.cost.est_usd`，双层保证。
- **只读约束:** `cost` 命令 action 里不调用 `acquireRunLock`（与 status/watch 一致），符合全局约束。
