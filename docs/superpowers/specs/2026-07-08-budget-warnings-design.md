# 预算告警(budget warnings)— 设计

**日期**:2026-07-08
**状态**:已批准设计,待写实现计划

## 背景

前几轮加固已让 AIFlow 具备真实的预算基础设施:`budget.max_cost_usd`(config)→ `state.budget.limit_usd`,`createBudgetTracker` 在累计 `spent >= limit` 时使 `record()` 返回 true,ralph-loop 在超限后当前 iteration 结束即 `paused` + `reason: "budget_exceeded"`(现有软停)。但目前**没有**预算阈值告警:用户只有在 100% 熔断时才知道钱花超了,没有"接近预算"的早期信号,run 结束时也没有超支/接近的汇总提示。

本轮在已有 budget/cost 基础设施上,增加**跨阈值告警**与 **run 结束时的预算提示**。停止行为完全不变——沿用现有 100% 软停,不引入 hard 模式。

## 目标

1. **多阈值百分比告警**:`budget` 下新增可选 `warn_at_pct: [0.5, 0.8, 0.95]`(基于 limit 的比例);累计花费跨过某阈值时写一条 `budget_warning` 事件 + stderr 一行。每阈值每 run 只报一次。
2. **run 结束提示**:run/resume 结束时,若配置了 budget,命令层根据 `state.cost.est_usd` vs `limit_usd` 打印"超支"或"接近预算"提示行。
3. **可观测**:`budget_warning` 是 events.jsonl 事件,`status` 命令读回并专门渲染,同时展示预算用量行。
4. **向后兼容**:无 `warn_at_pct` 的旧 config/state → 空数组 → 无告警,不报错;现有无预算行为完全不变。

## 非目标

- 不改停止行为:软停(100% 后当前 stage/iteration 跑完 paused)保持不变,不引入 hard 停止模式。
- 不改 `cost` 命令(预算展示交给 `status`;`budget_warning` 不进 `stage_cost` 成本聚合)。
- 不做成本预测/趋势(YAGNI)。
- 不引入并发锁(告警在既有 run 流程内,status 只读)。

## 组件设计

### 组件 1:BudgetTracker 跨阈值检测(`src/gate/budget.ts`)

`record` 保持 bool 语义(是否达 limit,调用点零改动);新增 `drainPendingWarnings()` 累积并取出新跨的告警阈值。

```ts
export interface BudgetTracker {
  limitUsd?: number;
  /** 累计记账,返回累计是否已达 limit(语义不变)。同时把本次新跨过的告警阈值攒进内部缓冲。 */
  record(deltaUsd: number): boolean;
  /** 取出并清空自上次以来新跨过的告警阈值(pct 值,升序);无则返回 []。 */
  drainPendingWarnings(): number[];
}

export function createBudgetTracker(
  limitUsd: number | undefined,
  initialSpentUsd: number,
  warnAtPct?: number[],
): BudgetTracker;

export const noopBudgetTracker: BudgetTracker;
```

内部逻辑:
- 维护 `spent`、排序去重后的 `thresholds`(来自 `warnAtPct ?? []`)、`warnedThresholds: Set<number>`、`pending: number[]`。
- 构造时,若有 `limitUsd`,把所有 `initialSpentUsd/limitUsd >= t` 的阈值 `t` 预填进 `warnedThresholds`(resume 场景:历史已跨的阈值不重复告警)。
- `record(delta)`:`spent += delta`;若有 `limitUsd`,对每个 `t` 满足 `spent/limitUsd >= t 且 !warnedThresholds.has(t)` 的,加入 `warnedThresholds` 和 `pending`;返回 `spent >= limitUsd`(无 limit 时返回 false)。
- `drainPendingWarnings()`:返回 `pending` 的副本(升序)并清空 `pending`。
- `noopBudgetTracker`:`record` 恒返回 false,`drainPendingWarnings` 恒返回 `[]`。

**幂等**:每阈值每 run 只报一次;含 resume(通过 `initialSpentUsd` 预填)。

### 组件 2:crossedWarnings 从 runner 冒泡到 engine(接缝)

**问题**:告警阈值可能在 ralph-loop **内部**跨过(一个 stage 内多次 iteration,每次 `budget.record`),但写事件的 I/O 集中在 engine。engine 只在 stage 边界看到 `execResult.usage`,看不到 iteration 级的 record。

**决定:tracker 累积,engine 在 stage 后一次性 drain。**
- runner(ralph-loop)照常调 `record`,签名不变;tracker 自己把新跨阈值攒进 `pending`。
- engine 在每个 stage 记完账、写完 `stage_cost` 后,调 `budget.drainPendingWarnings()`,把攒下的阈值一次性取出,为每个写一条 `budget_warning` 事件 + stderr 一行。
- ralph-loop 现有 4 处 `budget.record(x)` **一字不用改**(仍读 bool 或忽略)。

engine 需持有当次 stage 使用的 tracker 引用以调用 drain——现有 engine 在 stage 循环内 `createBudgetTracker(...)` 并传入 `executeStage`;drain 在同一作用域内的 stage_cost 写入之后进行。

### 组件 3:config schema + state(`src/config/schema.ts`, `src/engine/state.ts`)

```ts
// BudgetConfigSchema 新增(现有 max_cost_usd 不变):
warn_at_pct: z.array(z.number().positive().max(1)).optional()

// state.budget 盘上新增字段(现有 limit_usd 不变):
budget?: { limit_usd: number; warn_at_pct?: number[] }
```

- engine 初始化 state 时,把 `pipeline.budget.warn_at_pct` 一并写入 `state.budget`。
- resume 时从 state 读回,`createBudgetTracker(limit, state.cost.est_usd, state.budget?.warn_at_pct)`。
- 向后兼容:旧 state 无 `warn_at_pct` → `undefined` → tracker 视作空数组 → 无告警。
- 校验:`.positive().max(1)` 拒绝 ≤0 或 >1 的值(加载期报错,不进运行时);tracker 内部排序去重。

### 组件 4:budget_warning 事件(`src/events/events.ts`)

```ts
export interface BudgetWarningAiflowEvent {
  ts: string;
  type: "budget_warning";
  stage: string;         // 触发时正在跑的 stage id
  threshold_pct: number; // 跨过的阈值,如 0.8
  spent_usd: number;     // 触发时累计花费
  limit_usd: number;
}
```

加入 `AiflowEvent` 联合。字段命名沿用既有 snake_case 约定(`spent_usd`/`limit_usd`/`threshold_pct`)。engine 在 drain 后为每个阈值写一条,并向 stderr 打:
`Budget warning: spent $X.XXXX / $Y.YYYY (Z% of limit) at stage <id>`
其中 `Z` = `threshold_pct * 100`(整数或必要精度)。

### 组件 5:run 结束提示(命令层 `src/commands/run.ts` / `src/commands/resume.ts`)

run/resume 结束时,若 `state.budget?.limit_usd` 存在,命令层根据 `state.cost.est_usd` 计算并**追加**一行(在现有 outcome 行之后):
- `est_usd >= limit` → `Budget exceeded: $X.XXXX / $Y.YYYY`
- 否则,若配置了非空 `warn_at_pct` 且 `est_usd >= max(warn_at_pct) * limit`(接近但未超)→ `Budget near limit: $X.XXXX / $Y.YYYY (Z%)`,`Z = round(est_usd/limit*100)`
- 否则(未超且未配 warn_at_pct,或未达最高阈值)不打印预算行。即:未配 `warn_at_pct` 时只可能出现 "exceeded",不出现 "near limit"。

放命令层而非 `summarizePipelineOutcome`:后者只返回 `{line, exitCode}` 且被多处复用,不宜塞预算语义;命令层已持有 `state`。run.ts 与 resume.ts 各自调用一个共享的纯函数 `formatBudgetOutcomeLine(state): string | undefined`(放 `src/commands/` 下的合适位置,便于单测),避免两处重复逻辑。

### 组件 6:status 读回(`src/commands/monitor.ts`)

- `describeEvent` 新增 `case "budget_warning"`:渲染专门行,如
  `<time>  warn     <stage>  budget <Z>% $X.XXXX/$Y.YYYY`(与其他事件同风格,`warn` 用黄色)。
  (现有 `default` 分支已能通用渲染任意事件类型,故不加 case 也不报错;加 case 仅为可读性。)
- `renderStatus` 在现有 `Cost:` 区块内(或紧随其后),若 `state.budget?.limit_usd` 存在,增加预算用量行:
  `Budget: $X.XXXX / $Y.YYYY (Z%)`,超限时 `Z` 标红。

## 数据流

```
config: budget.max_cost_usd + budget.warn_at_pct: [0.5, 0.8, 0.95]
   │
   ▼
state.budget = { limit_usd, warn_at_pct }   (盘上新增 warn_at_pct)
   │
   ▼
createBudgetTracker(limit, state.cost.est_usd, warn_at_pct)
   │   record(delta) → bool(达 limit);内部攒 pending 告警
   │   drainPendingWarnings() → number[]
   ▼
engine 每个 stage 记账 + 写 stage_cost 后:
   drainPendingWarnings() 非空 → 每阈值写一条 budget_warning 事件 + stderr
   record 返回 true → 现有软停(不变)
   │
   ▼
run/resume 结束:formatBudgetOutcomeLine(state)
   → "Budget exceeded" / "Budget near limit" / (无)
   │
   ▼
status:读回 budget_warning 事件(专门渲染)+ 预算用量行
```

## 错误处理

- `warn_at_pct` 含 >1 或 ≤0:zod schema 加载期报错(`.positive().max(1)`),不进运行时。
- 无 `budget` 配置:tracker `limitUsd=undefined`,`drainPendingWarnings()` 恒 `[]`,`record` 恒 false——现有无预算行为完全不变,不打印预算行。
- resume 已跨阈值:`initialSpentUsd` 预填 `warnedThresholds`,drain 不含历史已跨阈值,不重复告警。此幂等保证是**完成-stage 粒度**:est_usd 仅在 stage 完成后持久化,若某 stage 在写出 budget_warning 后、成本持久化前崩溃,resume 会用较旧的 est_usd 重建 tracker,可能对该阈值重复告警一次。这是 AIFlow 阶段级成本模型的既有特性,视为可接受的限制。
- 阈值 `1.0` 与 limit 重合:`warn_at_pct: [1.0]` 与 100% 软停同时触发——两者独立(一个写 warning 事件,一个熔断),语义不冲突,允许。
- 空 `warn_at_pct: []`:合法,等价于无告警。
- events.jsonl 缺失/state 无 budget:status 优雅省略预算行,不报错。

## 测试策略

全 bun:test,纯逻辑(tracker、结束提示格式化)优先单测:

1. **tracker 单测**(`test/unit/budget.test.ts`):
   - 多阈值 `[0.5, 0.8]`,分次 record 跨过 → drain 依次返回 `[0.5]`、`[0.8]`;drain 后再 drain 为空。
   - 同一次 record 跨多个阈值 → 一次 drain 返回全部(升序,如 `[0.5, 0.8]`)。
   - 每阈值只报一次(重复 record 不再出现)。
   - `initialSpentUsd` 已过阈值 → 预填,drain 不含它(resume 不重复)。
   - `limitUsd=undefined` → drain 恒空;`record` 仍返回 false。
   - `record` 的 bool 语义与旧行为一致(回归)。
   - 阈值排序去重:传 `[0.8, 0.5, 0.8]` 视作 `[0.5, 0.8]`。
2. **engine 写事件**(`test/unit/engine.test.ts`):mock 一个跨阈值的 stage → 断言 events.jsonl 出现 `budget_warning`,字段(threshold_pct/spent_usd/limit_usd/stage)正确;无预算配置的 run 不写 budget_warning。
3. **结束提示**(命令层测试):`formatBudgetOutcomeLine` 超支 → 含 "exceeded";接近 → 含 "near limit";未接近或无 budget → `undefined`。
4. **status 渲染**(`test/unit/monitor.test.ts`):`budget_warning` 渲染为专门行;预算用量行在有 budget 时出现,无 budget 时不出现。
5. **round-trip**(`test/unit/events.test.ts`):`budget_warning` 过 appendEvent/readEvents 保真。
6. **集成(可选但推荐)**(`test/integration/`):真跑带 `budget` + `warn_at_pct` 的 mock pipeline,断言告警事件与结束提示端到端出现。

## 全局约束

- 不新增 npm 依赖。
- 不改停止行为(软停不变),不引入 hard 停止模式。
- 盘上仅 `state.budget` 增 `warn_at_pct`(可选)、events.jsonl 增 `budget_warning`(向后兼容;旧 run 无此事件、旧 state 无此字段)。
- 跨阈值检测在 tracker(纯逻辑,可单测);I/O(写事件/stderr)集中在 engine 一处,与 `stage_cost` 落点相邻。
- 告警幂等:每阈值每 run 只报一次,含 resume 场景。
- `budget_warning` 字段命名(snake_case:`threshold_pct`/`spent_usd`/`limit_usd`)与既有事件一致。
- `budget_warning` 不进 `stage_cost` 成本聚合,不影响 `cost` 命令数字。
