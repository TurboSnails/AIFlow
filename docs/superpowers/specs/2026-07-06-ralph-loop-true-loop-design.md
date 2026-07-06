# Ralph Loop 真循环设计文档

> 承接：《AIFlow 技术设计文档 v1.0》§6.6（Ralph Loop Runner）
> 状态：草案

---

## 1. 背景与问题

当前 `runRalphLoopOnce`（`src/runners/ralph-loop.ts`）只做**一个 story 的一次尝试**：选一个 pending 故事、跑一次 agent、过一次 gate，返回 `pass | fail | suspended` 后立即返回。`engine.ts` 的 `executeStage` 对 `ralph_loop` stage 只调用这个函数一次，就把整个 stage 标记为终态。

这与技术设计文档 §6.6 描述的行为不符：真正的 Ralph Loop 应该反复选故事、反复迭代，直到"全部故事 passes / 达到 `max_iterations` / 连续 `stall_limit` 轮无状态变化"三个条件之一触发才停止。当前实现下，任何包含两个以上 story 的真实项目，跑一次 `aiflow run` 只会做完（或搞砸）第一个故事就结束，pipeline 无法自动把整个故事列表跑完。

本设计的目标：让 `ralph_loop` stage 具备设计文档描述的完整循环行为，并达到可商用的健壮性——而不仅仅是"能跑通"。

## 2. 范围

**包含：**
- `ralph_loop` stage 内部的多故事、多轮迭代循环
- `max_iterations` / `stall_limit` 配置项与终止判定
- 循环结束原因的可观测性（events.jsonl / run-report.md）
- 与现有 `aiflow resume --force` 的正确交互
- 对应的单元测试与集成测试

**不包含（明确延后）：**
- 预算追踪与超限自动暂停（`budget.max_cost_usd`，技术设计文档 §5.2）——这是独立的功能，留给下一轮
- `brainstorm` / `spec` / `plan` / `human_gate` 等其他 stage 类型
- GUI

## 3. 设计

### 3.1 配置 schema 变更

`RalphLoopStageSchema`（`src/config/schema.ts`）新增两个字段：

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

默认值取自技术设计文档 §5.2 的示例（`max_iterations: 10`，`stall_limit: 3`）。

### 3.2 核心算法：`runRalphLoop`

新增导出函数 `runRalphLoop(stageConfig, profiles, cwd, runDir, specExcerpt, deps?)`，与现有 `runRalphLoopOnce` **并存**（后者保持不变，作为内部单次迭代的构件，继续被现有测试覆盖）：

```
usage = { inTok: 0, outTok: 0, costUsd: 0 }
iterations = 0
stallCount = 0

loop:
  prd = readPrd(...)
  if selectNextStory(prd) == null:
    return finalize(prd, iterations, usage)   // 自然完成，最先检查

  iterations += 1
  suspendedBefore = prd.stories.filter(s => s.suspended).length

  onceResult = runRalphLoopOnce(...)   // 内部会重新 selectNextStory，选中同一个故事
  usage += onceResult.usage

  prdAfter = readPrd(...)
  // 本轮结束后立刻再检查一次"是否自然完成"——必须在 max_iterations 判定之前，
  // 否则"恰好在最后一轮做完"会被误判为"超限而放弃"。
  if selectNextStory(prdAfter) == null:
    return finalize(prdAfter, iterations, usage)

  if iterations >= max_iterations:
    return { result: "suspended", reason: "max_iterations", iterations, usage }

  suspendedAfter = prdAfter.stories.filter(s => s.suspended).length
  progressed = onceResult.result == "pass" || suspendedAfter > suspendedBefore

  stallCount = progressed ? 0 : stallCount + 1
  if stallCount >= stall_limit:
    return { result: "suspended", reason: "stall", iterations, usage }

function finalize(prd, iterations, usage):
  anySuspended = prd.stories.some(s => s.suspended)
  return {
    result: anySuspended ? "suspended" : "pass",
    reason: anySuspended ? "stories_suspended" : undefined,
    iterations,
    usage,
  }
```

**关键点：**
- "进展"（progress）的定义是"本轮故事变成 done，或本轮有新故事被标记 suspended"——单纯 `fixCount` 增加但故事仍是 pending，不算进展，会累计 stall 计数。这个定义是刻意的：`per_story_fix_limit` 已经保证单个故事在 `per_story_fix_limit + 1` 次尝试后必然被 suspend（即必然产生一次"状态变化"），所以 `stall_limit` 的实际意义是——当你想比"耗尽单个故事的重试次数"更早放弃时的独立旋钮（例如 `stall_limit=3 < per_story_fix_limit=5` 时，3 轮无进展就整体收工，不必等到第 6 轮该故事才被 suspend）。两个参数职责不同：`per_story_fix_limit` 决定"何时放弃一个故事"，`stall_limit` 决定"何时放弃整个 stage"。
- 就"故事是否跑完"而言，循环的自然结果只有 `pass | suspended` 两种（不再有 `fail`）——因为单次迭代失败不再让 stage 立即终止，而是反映为 `fixCount` 增加、故事保留在 pending 池里重试。`fail` 作为 stage 级别结果因此在当前代码路径下变得不可达，这是设计的直接结果，不是遗漏。§3.3 会再引入第三种结果 `aborted`，但那是外部中断信号导致的提前退出，不属于"故事跑完与否"的自然结果，两者不矛盾。
- `usage` 在每轮迭代后原地累加，循环结束时一次性返回给 `engine.ts`（`engine.ts` 现有的按 stage 累加 `state.cost` 的逻辑不需要改动）。

### 3.3 中断处理（SIGINT / AbortSignal）

现状：`engine.ts` 的 `executeStage` 只在调用 stage 函数**之前**检查一次 `signal?.aborted`。过去单次迭代场景下这已经勉强够用（最多等一次 agent 调用超时）；但一旦 `ralph_loop` 内部变成最多 `max_iterations` 轮的真循环，Ctrl+C 若不能在轮次之间生效，用户可能要等上"轮数 × 单轮超时"的时间量级才能真正退出。

因此 `runRalphLoop` 新增可选的 `signal?: AbortSignal` 参数，**在每轮迭代最开始**（读 prd 之前）检查一次：若已中止，立即返回 `{ result: "aborted", iterations, usage }`（`usage` 只累加已经完成的轮次）。`RalphLoopSummary.result` 的类型相应变为 `"pass" | "suspended" | "aborted"`。

`engine.ts` 的改动：
- 保留原有"调用前"的快速短路检查（覆盖"pipeline 在跑到这个 stage 之前就已经被中止"的情况）；
- 把 `signal` 一并透传给 `deps.runRalphLoop(...)`；
- 状态映射从二分支变回三分支：`result === "pass" ? "done" : result === "aborted" ? "aborted" : "suspended"`。

这样 Ctrl+C 的响应延迟从"最多等完整个循环"收窄回"最多等完当前这一轮迭代"，与中断前的行为保持一致的用户体验。

### 3.4 StageState.reason 与可观测性

`StageState`（`src/engine/state.ts`）新增可选字段：

```ts
export type RalphLoopStopReason = "max_iterations" | "stall" | "stories_suspended";

export interface StageState {
  id: string;
  status: StageStatus;
  iteration?: number;
  reason?: RalphLoopStopReason;
}
```

这是纯附加信息，不影响 `TERMINAL_STATUSES` / `isTerminalStatus` / resume 判定逻辑（这些只看 `status`）。

`engine.ts` 的 `executeStage` 把 `runRalphLoop` 返回的 `reason` 透传进 `StageState.reason`。

`events.jsonl` 新增一种事件（循环结束时追加一条，独立于每轮的 `story_result`/`gate_result`）：

```ts
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
```

（`aborted` 时 `reason` 不设置——中止不是"停止原因"三选一里的任何一种，它是外部信号打断。）

`run-report.md` 的 Stages 表增加一列：

| id | status | reason |
| --- | --- | --- |
| develop | suspended | stall (2 done, 1 suspended, 2 pending after 7 iterations) |

### 3.5 engine.ts 变更

`EngineDeps` 的注入字段从 `runRalphLoopOnce` 改名为 `runRalphLoop`（类型也从"单次迭代函数"换成"整段循环函数"，并接受 §3.3 新增的 `signal` 参数），避免与 `ralph-loop.ts` 里同名但语义不同的 `runRalphLoopOnce` 混淆。`defaultDeps.runRalphLoop` 接到新的 `runRalphLoop` 实现。

`executeStage` 的状态映射（三分支，对应 §3.3 引入的 `aborted`）：

```ts
const status: StageStatus =
  result.result === "pass" ? "done" : result.result === "aborted" ? "aborted" : "suspended";
```

`test/unit/engine.test.ts` 里所有 mock `runRalphLoopOnce` 的地方，改名为 mock `runRalphLoop`，返回值需要加 `iterations` 字段（`reason` 按需）。这是一个必要的改名，不是历史包袱。

### 3.6 Resume 交互

无需新增逻辑：`aiflow resume --force` 已经把 stage 状态重置为 `pending` 后重新调用 stage 的执行函数；`runRalphLoop` 内部第一步就是 `selectNextStory`，天然跳过已经 `passes:true` 或 `suspended:true` 的故事，只续跑还没完成的部分。会验证这一点的集成测试见 §4。

## 4. 测试计划

- 单元测试（`ralph-loop.test.ts` 新增，`runRalphLoopOnce` 现有测试不变）：
  - 全部故事一次通过 → `result: "pass"`, `reason: undefined`
  - 3 个故事，1 个连续失败到 suspended，其余 2 个通过 → `result: "suspended"`, `reason: "stories_suspended"`
  - 单故事连续失败直到 `stall_limit` 命中（且 `stall_limit < per_story_fix_limit`，故事本身还没到 suspend 线）→ `result: "suspended"`, `reason: "stall"`
  - 多故事、每轮都各自推进一点但总迭代数达到 `max_iterations` → `result: "suspended"`, `reason: "max_iterations"`
  - usage 在多轮之间正确累加（构造每轮不同 usage，断言总和）
  - 空 prd（0 个 pending 故事，如全部已 done）→ 立即返回 `pass`，0 次迭代，不调用 agent
  - 传入已 `aborted` 的 `signal` → 循环体一次都不进入，`result: "aborted"`, `iterations: 0`；传入在第 2 轮迭代之间才被 abort 的 signal → `result: "aborted"`, `iterations: 2`，且第 3 轮的 agent 调用从未发生
- 集成测试（mocked，`ralph-loop-mocked.test.ts` 补充或新增）：
  - `aiflow resume --force` 对一个之前跑到 `max_iterations` 中断的 3-story pipeline，验证已完成的故事不会被重跑，只续跑剩余 pending 的
- `engine.test.ts`：更新现有 mock 字段名；补充 `reason` 透传到 `state.stages[i].reason` 的断言
- `report.test.ts`（如果存在，否则在 report 相关测试文件里补充）：`reason` 列正确渲染

## 5. 边界情况

| 场景 | 处理 |
| --- | --- |
| `prd.json` 一开始就没有任何 story | `selectNextStory` 首次即返回 null → 0 次迭代直接 `pass` |
| `max_iterations` 恰好等于让最后一个故事通过所需的轮数 | 每轮迭代跑完后立刻重新检查 `selectNextStory==null`，且这一检查在 `iterations >= max_iterations` 判定之前执行（见 §3.2 伪代码），确保"恰好在上限那一轮做完"返回的是 `pass`/`stories_suspended`，而不是 `max_iterations` |
| `stall_limit` 或 `max_iterations` 配置为 0 或负数 | zod schema 校验阶段拒绝（`.int().positive()`），配置加载时报错，不进入运行时 |

## 6. 不做的事

- 不引入新的 `StageStatus` 枚举值——`suspended` 已经承载"没跑完但可续跑"的语义，`reason` 字段负责区分具体原因，避免状态爆炸。
- 不改变 `runRalphLoopOnce` 的对外契约或现有测试——所有新逻辑都在新的 `runRalphLoop` 包装层里。
- 不做预算/成本硬性拦截——`state.cost` 继续只做记账，不做超限熔断（留给未来的预算功能）。
