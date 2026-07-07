# 优雅中断与工作区自愈设计文档

> 承接：《AIFlow 技术设计文档 v1.0》§7（错误处理与恢复策略）、§6.6（Ralph Loop Runner 安全约束）——这两条是文档里写明但从未落地的能力。本设计是对照需求文档做差距分析后，挑出的第一个子项目（另外三个——安全控制、可观测性、配置体系——留作后续独立立项）。
> 状态：草案

---

## 1. 背景与问题

对照《AIFlow 技术设计文档 v1.0》逐节核对当前实现（独立的《需求文档-AIFlow-v1》本身不在仓库里，只能以这份技术设计文档作为需求的代理），发现两条明确写在文档里、但从未实现的能力：

1. **§7 错误处理表**：`用户 Ctrl+C | 优雅暂停：等当前 LLM/子进程调用结束或强制 kill（双击 Ctrl+C），状态置 paused`。当前 `aiflow run`（`src/cli.ts`）**完全没有注册 SIGINT 监听**——只有 `watch` 命令有（`src/cli.ts:165-179`）。`aiflow resume`/`aiflow approve` 同样没有：它们调用 `runPipelineOnce` 时最后一个 `signal` 参数硬编码传 `undefined`。
2. **§6.6 安全约束**：`若 agent 产生了非预期的破坏（门禁连续失败且工作区脏），提供 --auto-clean 选项在下一轮前 git checkout . 回到干净状态`。当前 `ralph-loop.ts` 只在每轮开始前记录 `git rev-parse HEAD`（`ralph-loop.ts:94`），从未实现任何清理逻辑——story 被挂起后，agent 留下的脏改动会一直留在工作区里，没有任何自动恢复手段。

这两条看似独立，但共享同一个基础设施诉求：**引擎需要一个"可恢复的暂停态"概念**，而不是把"临时先不跑了"和"彻底做完/彻底失败"混为一谈。

## 2. 范围

**包含：**
- 新增 `paused` StageStatus，`aiflow run`/`resume`/`approve` 三个会驱动 pipeline 执行的命令都接上 SIGINT 处理
- `ralph_loop` 新增 `auto_clean: boolean` 配置项，story 挂起时按需清理工作区
- 对应的单元测试与集成测试

**不包含（明确延后，属于差距分析里其余三个独立子项目）：**
- 安全控制类：`.aiflow/config/` 防篡改 hash 校验、日志脱敏、shell 命令执行前回显
- 可观测性类：brainstorm/plan 阶段的中间进度事件、AI review 原始 JSON 归档
- 配置体系类：`project.yaml` 落地、预算追踪
- 双击 Ctrl+C 强制 kill（本次只做单次优雅暂停，见 §3.2 的取舍说明）
- 对 brainstorm/spec/plan/human_gate 四种"单次调用型" stage 做真正的调用中断（比如打断一个正在进行的 HTTP 请求）——这四种 stage 的 Ctrl+C 响应粒度是"等这次调用自然结束"，只有 `ralph_loop` 因为本身是多轮循环，才能在两轮之间提前响应（见 §3.2）

## 3. 设计

### 3.1 新增 `paused` 状态，语义与 `aborted`/`suspended` 严格区分

当前 `TERMINAL_STATUSES = {done, failed, aborted, suspended}`，`aborted` 同时承担两种含义：`aiflow reject` 主动拒绝、`human_gate` 超时判 abort——这两种都是"用户/配置明确决定不再继续"，理应保持终态语义不变。

新增的 `paused` 专门给"信号触发的中断"用，语义是"只是先歇一下"：

```ts
// src/engine/state.ts
export type StageStatus = "pending" | "running" | "done" | "failed" | "aborted" | "suspended" | "waiting_human" | "paused";
```

`paused` **不加入** `TERMINAL_STATUSES`——跟 `waiting_human` 一个待遇：普通 `aiflow resume`（不需要 `--force`）直接把它当"非终态"续跑。

### 3.2 SIGINT 接入三个执行入口

**`src/runners/ralph-loop.ts`**：`RalphLoopSummary.result` 的 `"aborted"` 改名为 `"paused"`（这是对一个已经过完整 review 流程的模块的必要修改——语义确实变了，不是随便动）：

```ts
export interface RalphLoopSummary {
  result: "pass" | "suspended" | "paused";  // 原来是 "aborted"
  reason?: RalphLoopStopReason;
  iterations: number;
  usage: { inTok: number; outTok: number; costUsd: number };
}
```

`runRalphLoop` 内部信号检查（`ralph-loop.ts:230-234`）把 `result: "aborted"` 改成 `result: "paused"`，其余逻辑不变——检查点仍然是"每轮开始前"，即等当前这一轮 `runRalphLoopOnce`（内含一次完整的 agent 调用 + 门禁）跑完才响应，不打断正在进行的调用。

**`src/engine/engine.ts`**：
- `StageOutcome.result` 的 `"aborted"` 改成 `"paused"`
- `STATUS_MAP` 对应从 `aborted: "aborted"` 改成 `paused: "paused"`
- `executeStage` 里调用前的信号预检查（`engine.ts:178`）：`status: "aborted"` → `status: "paused"`
- `runPipelineOnce` 顶层轮询循环里、两个 stage 之间检测到信号已中止的分支（`engine.ts:267-268`）：批量标记为 `pending`/`running` 的 stage 时，状态改成 `"paused"`

`brainstorm`/`spec`/`plan`/`human_gate` 四个 runner 的函数签名里虽然都有 `signal` 参数，但内部从不检查它（都是 `_signal` 命名，本来就没用）——这次不改这四个文件。它们的 Ctrl+C 响应完全靠 `executeStage`/`runPipelineOnce` 的两层预检查：如果信号在这类 stage **开始跑之前**已经中止，会被拦下来变成 `paused`；如果是在跑的**过程中**才按下 Ctrl+C，这次调用不会被打断，会等它自然结束，下一次状态转换时才会被拦下来。这是一个明确的、文档化的限制，不是遗漏。

**`src/events/events.ts`**：`RalphLoopResultAiflowEvent.result` 字段的类型同样是 `"pass" | "suspended" | "aborted"`（`events.ts:44`，跟 `RalphLoopSummary.result` 是同一套语义），一并把 `"aborted"` 改成 `"paused"`。

**`src/commands/run.ts`**：`runCommand` 新增 `signal?: AbortSignal` 参数（第 5 个），透传给 `runPipelineOnce` 调用（当前硬编码传 `undefined` 的位置）。

**`src/commands/resume.ts`**：`runResume` 同样新增 `signal?: AbortSignal` 参数，替换掉硬编码 `undefined` 的位置。

**`src/commands/approve.ts`**：`runApprove` 同样新增 `signal?: AbortSignal` 参数，替换掉硬编码 `undefined` 的位置。

**`src/cli.ts`**：`run`/`resume`/`approve` 三个命令的 `action` 里，各自照抄 `watch` 已有的写法（`cli.ts:165-179`）：

```ts
const controller = new AbortController();
const onSigint = () => controller.abort();
process.once("SIGINT", onSigint);
try {
  const state = await runCommand(process.cwd(), opts.pipeline, {}, { requirement: opts.requirement, requirementFile: opts.requirementFile }, controller.signal);
  // ...原有输出逻辑...
} finally {
  process.removeListener("SIGINT", onSigint);
}
```

`resume`/`approve` 的 `action` 做同样的包裹，把 `controller.signal` 传给各自的 `runResume`/`runApprove`。

### 3.3 `ralph_loop` 的 `auto_clean` 配置项

**`src/config/schema.ts`**：`RalphLoopStageSchema` 新增一个字段：

```ts
export const RalphLoopStageSchema = z.object({
  id: z.string(),
  type: z.literal("ralph_loop"),
  model: z.string(),
  per_story_fix_limit: z.number().int().positive().default(3),
  max_iterations: z.number().int().positive().default(10),
  stall_limit: z.number().int().positive().default(3),
  auto_clean: z.boolean().default(false),   // 新增
  gate: ReviewGateConfigSchema,
});
```

**`src/git.ts`** 新增两个 helper：

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

**`src/runners/ralph-loop.ts`**：`RalphLoopDeps.git` 接口新增 `checkoutClean`；`defaultDeps.git` 补上真实实现。在 `runRalphLoop` 的循环里，检测到"这一轮让某个 story 从未挂起变成挂起"（即 `suspendedAfter > suspendedBefore`，这行判断代码本来就存在，`ralph-loop.ts:264`）时，如果 `stageConfig.auto_clean` 为真，在继续下一轮之前调用 `deps.git.checkoutClean(cwd)`，并往 `fix_list.md`/`progress.md` 之外新增一条 `story_auto_cleaned` 事件（复用现有 `appendEvent` 机制，字段：`ts`/`type`/`story`），留一条审计记录：

```ts
const suspendedAfter = countStories(prdAfter).suspended;
const progressed = onceResult.result === "pass" || suspendedAfter > suspendedBefore;

if (suspendedAfter > suspendedBefore && stageConfig.auto_clean) {
  await deps.git.checkoutClean(cwd);
  appendEvent(runDir, { ts: new Date().toISOString(), type: "story_auto_cleaned", story: onceResult.storyId });
}

stallCount = progressed ? 0 : stallCount + 1;
```

需要给 `src/events/events.ts` 新增 `StoryAutoCleanedAiflowEvent { ts, type: "story_auto_cleaned", story: string }` 并加入 `AiflowEvent` 联合类型（`src/commands/monitor.ts` 的 `describeEvent` 已经有通用 `default` 兜底分支，这次不用再改 monitor.ts）。

**安全阀（`src/commands/run.ts`）**：为什么只在 `run.ts`（全新起跑），不在 `resume.ts`/`approve.ts`（续跑）——续跑本来就可能面对自己之前留下的脏状态，那是正常的；只有"全新起跑前"工作区脏，才说明是用户自己的未提交改动，必须拦住。在现有 `--requirement` 前置校验（`run.ts:49-57`，创建 run 目录之前）紧接着加一段：

```ts
const hasAutoClean = pipelineConfig.stages.some((s) => s.type === "ralph_loop" && s.auto_clean);
if (hasAutoClean && !(await isClean(cwd))) {
  throw new Error(
    `Pipeline "${pipelineName}" has auto_clean enabled on a ralph_loop stage, but the working tree at ${cwd} is not clean. Commit or stash your changes before running (auto_clean cannot distinguish your uncommitted work from a failed agent attempt).`
  );
}
```

同样在创建 run 目录**之前**报错退出，不留空 run 目录（跟 `--requirement` 校验的既有约定一致）。

## 4. 错误处理（延续技术设计文档 §7 的表格）

| 情况 | 策略 |
| --- | --- |
| `aiflow run`/`resume`/`approve` 执行期间收到 SIGINT | 等当前这一轮 agent/LLM 调用自然结束（不强杀子进程），当前 stage 及之后所有未跑的 stage 标记 `paused`；普通 `aiflow resume`（不需要 `--force`）即可续跑 |
| `ralph_loop` 的 story 被挂起且 `auto_clean: true` | `git checkout -- .` + `git clean -fd` 回到 HEAD，记一条 `story_auto_cleaned` 事件 |
| `auto_clean: true` 但起跑前工作区已经不干净 | 直接报错退出，不创建 run 目录，不动用户任何文件 |
| 双击 Ctrl+C | 不支持（见 §2"不包含"），第二次 Ctrl+C 会被 Node/Bun 默认行为直接终止进程，不会走优雅路径，也不会被视为 bug |

## 5. 测试计划

- **`test/unit/state.test.ts`**：`paused` 状态的 round-trip 序列化测试
- **`test/unit/ralph-loop.test.ts`**：新增用例——已中止的 `signal` 传入 `runRalphLoop`，断言 `result: "paused"`（而不是原来断言的 `"aborted"`，这是对现有测试的必要更新，不是新增）；`auto_clean: true` 且某个 story 被挂起时，断言 `deps.git.checkoutClean` 被调用且 `events.jsonl` 里出现 `story_auto_cleaned`；`auto_clean: false`（默认）时同样场景，断言 `checkoutClean` **没有**被调用
- **`test/unit/engine.test.ts`**：更新现有对 `"aborted"` 结果的 mock/断言为 `"paused"`；新增 `TERMINAL_STATUSES` 不包含 `"paused"` 的断言；新增 `paused` 状态下 `aiflow resume`（不加 `--force`）能正常续跑的测试（复用 `waiting_human` 现有的类似测试模式）
- **`test/unit/git.test.ts`**（如果不存在则新建）：`isClean`/`checkoutClean` 的真实 git 行为测试（用临时 git 仓库，不 mock）
- **`test/unit/run-multi-stage.test.ts`** 或新文件：`auto_clean: true` + 工作区不干净 → `runCommand` 在创建 run 目录前报错；`auto_clean: true` + 工作区干净 → 正常起跑
- **`test/integration/`**：一个端到端场景——mock 一个总是失败的 `runAgentTask`，`per_story_fix_limit` 耗尽后 story 挂起，`auto_clean: true`，断言工作区文件确实被清理回 HEAD

## 6. 边界情况

| 场景 | 处理 |
| --- | --- |
| Ctrl+C 恰好在最后一个 stage 刚做完、还没到下一个 stage 之间按下 | `runPipelineOnce` 循环顶部的信号检查会在下一次循环迭代时命中，把所有还没跑的 stage（此时已经没有了）标记 paused；如果这已经是最后一个 stage，整个 pipeline 直接以正常完成状态返回，不受影响 |
| `auto_clean: true` 但这个 story 从来没有失败过（一次通过） | `suspendedAfter > suspendedBefore` 恒为假，`checkoutClean` 从不触发，零影响 |
| `resume`/`approve` 过程中按 Ctrl+C，此时工作区其实是脏的（正常情况） | 跟 `run` 一样标记 `paused`，`checkoutClean` 不会被牵扯进这条路径（`auto_clean` 只在"story 挂起"这一个时机触发，不是"任何中断都清理"） |
| `paused` 状态的 stage 恰好是 `ralph_loop`，之后 `aiflow resume` | `runRalphLoop` 重新从 `readPrd` 开始，天然只处理还没做完的 story，之前已经 `passes:true` 的不受影响——这条路径已经被"resume 交互"验证过（ralph-loop-true-loop 设计文档 §3.6），这次不需要新逻辑 |

## 7. 不做的事

- 不做双击 Ctrl+C 强制 kill（§2 已说明）
- 不给 `brainstorm`/`spec`/`plan`/`human_gate` 做真正的调用级中断（需要把 `AbortSignal` 一路传进 `fetch`/`Bun.spawn` 内部并处理部分响应，属于更大的改动，且当前"等这次调用结束"的粒度已经满足"优雅"这个诉求）
- 不做"暂停超过 N 小时自动怎样"之类的策略——`paused` 就是纯粹等人来 `resume`，没有超时概念（跟 `human_gate` 的 `timeout` 是两回事）
- 不实现"auto_clean 之外的其他自愈策略"（比如自动重试用不同 prompt）——这次只做"回到干净状态"这一件事
- 不改动 `.aiflow/config/pipelines/` 下任何一份现有 pipeline 模板文件——`auto_clean` 有 `.default(false)`，全部现有配置零改动、零影响
