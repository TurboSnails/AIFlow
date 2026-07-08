# aiflow cost — 成本可观测与报表 — 设计

**日期**:2026-07-08
**状态**:已批准设计，待写实现计划

## 背景

前两轮加固周期已让 AIFlow 产生真实成本数据：`state.cost`（run 级 token/美元汇总，engine.ts 每个 stage 完成后从 `execResult.usage` 累加）与 events.jsonl（`opencode_step_finish` 事件，仅 opencode 通道）。但这些数据目前只在 `aiflow status`/`watch` 里以一行原始数字呈现，用户无法看清"钱花在哪个 stage"，也无法导出用于对账。

本轮把已有成本数据变成可展示、可审计、可导出的报表：新增全通道准确的 per-stage 成本事件，并提供 `aiflow cost` 命令。这是"商业化"维度的自然下一步。

## 目标

1. **全通道 per-stage 成本**：engine 在每个 stage 完成时写一条 `stage_cost` 事件，覆盖 opencode 与 http 两种通道（来源是既有的 `execResult.usage`），使 per-stage 明细可无损聚合，且所有 `stage_cost` 之和等于 run 级 `state.cost.est_usd`。
2. **`aiflow cost` 命令**：默认展示最新 run 的 per-stage 明细（token + 美元 + 总计）；`--run-id` 指定 run；`--all` 跨 run 汇总。
3. **导出**：默认人读表格；`--json` 结构化输出；`--csv` 逗号分隔（`--json`/`--csv` 互斥）。
4. **向后兼容**：历史 run 无 `stage_cost` 事件时，优雅降级为 run 级总数 + 明确标注，不报错、不造假数据。

## 非目标

- 不改 `state.json` 盘上格式（只往 events.jsonl 增加一种新事件类型）。
- 不做成本预测/趋势图/时间序列分析（YAGNI）。
- 不改 `status`/`watch` 现有的 Cost 行（本轮只新增 `cost` 命令；未来可复用聚合函数增强 status，但不在本轮）。
- 不引入并发锁（只读命令）。

## 组件设计

### 组件 1：`stage_cost` 事件（`src/events/events.ts` + `src/engine/engine.ts`）

**新事件类型**（加入 `events.ts`）：

```ts
export interface StageCostAiflowEvent {
  ts: string;
  type: "stage_cost";
  stage: string;
  in_tok: number;
  out_tok: number;
  cost_usd: number;
}
```

加入 `AiflowEvent` 联合类型。字段命名沿用现有 `opencode_step_finish` 的 `in_tok`/`out_tok`/`cost_usd` 约定。

**写入点**（`engine.ts`，`runPipelineOnce` 主循环，现约 292-304 行）：在累加 `state.cost` 的同一处，当 `execResult.usage` 存在时追加：

```ts
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

- 每个产生 usage 的 stage 恰好写一条；值等于该 stage 的 `execResult.usage`。
- 无 usage 的 stage（如 human_gate）不写，与既有"`execResult.usage` 为空则不动 state.cost"逻辑一致。
- **不变式**：一个 run 内所有 `stage_cost` 事件的 `cost_usd`（及 in/out）之和 == run 级 `state.cost.est_usd`（同一 `execResult.usage` 数据源）。
- 放 engine 而非各 runner：engine 是所有 stage usage 的唯一汇聚点，一处覆盖全部 stage 类型。

### 组件 2：成本聚合（`src/commands/cost.ts` 纯函数）

**单 run 聚合**：

```ts
export interface StageCost {
  stage: string;
  inTok: number;
  outTok: number;
  costUsd: number;
}

export interface RunCostSummary {
  runId: string;
  pipeline: string;
  stages: StageCost[];          // 每 stage 累计其所有 stage_cost 事件；按首次出现顺序
  totalInTok: number;
  totalOutTok: number;
  totalCostUsd: number;         // = sum(stages.costUsd)
  runLevelCostUsd: number;      // state.cost.est_usd，用于对账
  breakdownAvailable: boolean;  // 是否存在至少一条 stage_cost 事件
}

export function summarizeRunCost(
  runId: string,
  state: EngineState,
  events: AiflowEvent[]
): RunCostSummary;
```

逻辑：
- 过滤 `events` 中 `type === "stage_cost"`，按 `stage` 分组累加（同 stage 多条则相加）。
- `breakdownAvailable = 至少一条 stage_cost 事件`。
- 旧 run 降级：`breakdownAvailable === false` 时 `stages: []`、`totalInTok/totalOutTok/totalCostUsd = 0`，但 `runLevelCostUsd = state.cost.est_usd` 仍填。
- `pipeline` 取自 `state.pipeline`。

**跨 run 聚合（`--all`）**：

```ts
export interface AllRunsCostRow {
  runId: string;
  pipeline: string;
  totalInTok: number;
  totalOutTok: number;
  totalCostUsd: number;       // 用 state.cost（run 级权威口径，新旧 run 都有）
  breakdownAvailable: boolean;
}

export interface AllRunsCostSummary {
  rows: AllRunsCostRow[];      // 按传入顺序（读取层保证 mtime 倒序，最新在前）
  grandTotalInTok: number;
  grandTotalOutTok: number;
  grandTotalCostUsd: number;
}

export function summarizeAllRunsCost(
  runs: { runId: string; state: EngineState; events: AiflowEvent[] }[]
): AllRunsCostSummary;
```

- `--all` 每行用 `state.cost`（run 级口径），对新旧 run 都存在且权威；`breakdownAvailable` 仅作提示列。
- grand total 对所有 run 的 `state.cost` 求和。

**读取层**：cost 命令的 I/O 入口复用 monitor.ts 的 `pickLatestRun` 模式读取 state+events（不重复造轮子；若合适可直接调用 monitor 的 `readRunSnapshot`）。指定 run 读单个，`--all` 遍历 `.aiflow/runs` 下全部 run 目录（mtime 倒序）。

### 组件 3：渲染（`src/commands/cost.ts` 纯函数，Summary → string）

**表格（默认，人读）** —— 沿用 monitor.ts 的 ANSI 风格：

单 run：
```
Cost — run <run_id> (pipeline: <name>)

  Stage           In tokens   Out tokens      Cost
  <stage>            12,400        3,100   $0.0620
  ...
  ─────────────────────────────────────────────────
  Total             144,700       55,550   $1.0735
```
- 数字右对齐、千位分隔；金额 4 位小数（与 monitor `est_usd.toFixed(4)` 一致）。
- 若 `runLevelCostUsd !== totalCostUsd`，末尾加灰色对账行 `(run-level state.cost: $X.XXXX)`。
- 旧 run 降级：不打印 stage 表，改打印
  `Per-stage breakdown unavailable for this run (predates stage_cost events).`
  外加一行 `Total (run-level): $X.XXXX`。

`--all`：每 run 一行（run_id / pipeline / in / out / cost / 无 breakdown 时行尾 `*` 标注），末尾 grand total 行；脚注解释 `*`。

**JSON（`--json`）**：直接序列化对应的 `RunCostSummary` 或 `AllRunsCostSummary`。无 ANSI、无表格。

**CSV（`--csv`）**：
- 单 run：表头 `stage,in_tok,out_tok,cost_usd`，每 stage 一行，末尾 `total,...` 行。
- `--all`：表头 `run_id,pipeline,in_tok,out_tok,cost_usd,breakdown_available`，每 run 一行。
- 逗号分隔、数字不加千位分隔、金额保留原始精度（机读）。

### 组件 4：CLI 接线（`src/cli.ts`）+ 命令入口（`src/commands/cost.ts`）

**CLI 注册**（紧随 `status`/`watch`，同风格）：

```
aiflow cost [--run-id <id>] [--all] [--json] [--csv] [--no-color]
```

action 里 `await import("./commands/cost")`，调 `runCost(cwd, opts)`，`process.exitCode = runCost(...)`。只读命令，不获取并发锁（与 status/watch 一致）。

**命令入口** `runCost(cwd: string, opts: { runId?: string; all?: boolean; json?: boolean; csv?: boolean; color?: boolean }): number`：
- 校验互斥参数 → 读取 run(s) → 聚合 → 按格式渲染 → 写 stdout → 返回退出码。

## 数据流

```
agent/reviewer 调用 → execResult.usage (engine)
                          │
        ┌─────────────────┼──────────────────┐
        ▼                                     ▼
  state.cost 累加 (既有)          stage_cost 事件 (新) → events.jsonl
                                              │
                              aiflow cost: 读 state + events
                                              │
                       summarizeRunCost / summarizeAllRunsCost (纯函数)
                                              │
                       renderTable / renderJson / renderCsv (纯函数)
                                              │
                                           stdout
```

## 错误处理

- 无 `.aiflow/runs` 或空目录：`No runs found in <cwd>/.aiflow/runs`，退出码 1。
- `--run-id` 指向不存在的 run：`Run <id> not found`，退出码 1。
- `--all` 与 `--run-id` 同时给：报错，退出码 1。
- `--json` 与 `--csv` 同时给：报错，退出码 1。
- events.jsonl 缺失但 state.json 存在：视为旧 run 降级（不报错）。
- 成功：退出码 0。

## 测试策略

全部 bun:test，聚合与渲染为纯函数便于覆盖：

1. **事件 round-trip**（`test/unit/events.test.ts` 或就近）：`stage_cost` 事件过 `appendEvent`/`readEvents` 保真。
2. **engine 写入**（`test/unit/engine.test.ts`）：mock 一个返回 usage 的 stage，断言 events.jsonl 出现对应 `stage_cost`、值等于 usage；断言无 usage 的 stage（human_gate 式）不写 `stage_cost`；断言 per-run 所有 stage_cost 之和 == state.cost.est_usd。
3. **聚合**（`test/unit/cost.test.ts` 新）：
   - `summarizeRunCost`：多 stage 事件 → 正确分组求和、total==sum、breakdownAvailable=true。
   - 无 stage_cost 事件 → breakdownAvailable=false、stages=[]、runLevelCostUsd 来自 state。
   - 同一 stage 多条 stage_cost → 累加为一行。
   - `summarizeAllRunsCost`：每行用 state.cost、grand total 正确。
4. **渲染 + 入口**（`test/unit/cost.test.ts`）：
   - 表格含对齐 + Total 行；旧 run 降级文案正确；对账行仅在不等时出现。
   - JSON 结构正确（字段名/嵌套）。
   - CSV 表头 + 每行 + total 行；机读无千位分隔。
   - `runCost`：`--json`/`--csv` 互斥报错退出 1；`--all`/`--run-id` 互斥报错退出 1；无 run 报错退出 1；`--run-id` 不存在报错退出 1。
5. **集成（可选但推荐）**（`test/integration/`）：真跑一个 mock pipeline，再 `runCost` 读回，断言 per-stage 求和 == state.cost（端到端验证事件写入与聚合闭环）。

## 全局约束

- 不新增 npm 依赖。
- 不改 state.json / run.lock 盘上格式；events.jsonl 仅新增一种向后兼容的事件类型（旧 run 无此事件，新 run 有）。
- 聚合与渲染是纯函数（Summary/字符串进出），I/O 隔离在读取层与命令入口。
- `cost` 是只读命令，不获取并发锁（与 status/watch 一致）。
- 不变式：一个 run 内 `stage_cost` 事件的 cost_usd 之和 == 该 run 的 `state.cost.est_usd`。
- `stage_cost` 字段命名（`in_tok`/`out_tok`/`cost_usd`）与既有 `opencode_step_finish` 一致。
