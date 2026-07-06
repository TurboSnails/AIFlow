# 多阶段 Pipeline Runner 设计文档

> 承接：《AIFlow 技术设计文档 v1.0》§6.3-6.7（Pipeline Engine / Brainstorm / Spec / Plan / Ralph Loop / Review Gate Runner）
> 状态：草案

---

## 1. 背景与问题

当前 `StageConfigSchema`（`src/config/schema.ts`）等于 `RalphLoopStageSchema`——pipeline 只能声明一种 stage 类型。`EngineDeps`（`src/engine/engine.ts`）也只有一个硬编码字段 `runRalphLoop`。这意味着：

- 无法表达技术设计文档 §5.2 举例的 `full-auto` pipeline（`brainstorm → spec → confirm-spec(human_gate) → plan → develop(ralph_loop)`）
- 每次 `aiflow run` 都要求项目根目录预先手工放好 `spec.md`/`prd.json`，AIFlow 自己产不出这两个文件
- `src/llm/client.ts` 只有一个为 review 场景写死的 `callReviewer`（强制 JSON 模式、关闭 thinking、零重试），没有可复用的通用 LLM 调用层

本设计的目标：让引擎支持任意组合的多阶段 pipeline，补齐 `brainstorm`/`spec`/`plan`/`human_gate` 四种 Runner，使 `full-auto` 这类多阶段 pipeline 第一次具备可运行的地基。这是后续"多工作流模板切换"和"GUI"的前置依赖——没有这一步，GUI 除了给 `ralph_loop` 套壳没有别的可展示。

## 2. 范围

**包含：**
- Stage 类型注册机制（discriminated union schema + runner 注册表），替换现有的单一 `runRalphLoop` 硬编码
- `src/llm/client.ts` 通用化：`callLlm`（单次调用，支持 jsonMode/thinking 开关 + 重试）、`callLlmFanOut`（并发多 profile 调用）；`callReviewer` 保持原签名，内部改薄封装
- `brainstorm` Runner：`independent` 与 `debate` 两种模式
- `spec` Runner（走 opencode 通道）
- `plan` Runner（走 http 通道，产出 `prd.json`）
- `human_gate` Runner：异步阻塞（`waiting_human`）+ 超时自动决议 + `approve`/`reject` 命令
- CLI 新增：`run --requirement`/`--requirement-file`、`aiflow approve`、`aiflow reject`
- 对应的单元测试与集成测试

**不包含（明确延后）：**
- 预算追踪与超限自动暂停（`budget.max_cost_usd`）
- `human_gate` 的"拒绝后打回上一阶段重跑"（reject 目前只终止管线）
- `doctor` 命令对新 profile/新 stage 类型的连通性检查扩展
- GUI 本身（本设计是它的前置依赖，但不涉及任何前端代码）
- 工作流模板库（openspec/superpowers/ralph/spec-superflow 到具体 stage 组合的映射）——这是下一个子项目，依赖本设计先落地

## 3. 设计

### 3.1 配置 schema：discriminated union

```ts
export const BrainstormStageSchema = z.object({
  id: z.string(),
  type: z.literal("brainstorm"),
  models: z.array(z.string()).min(2),   // 运行时要求成功数 ≥2，配置阶段就该拦住 <2 的情况
  mode: z.enum(["independent", "debate"]).default("independent"),
  debate_rounds: z.number().int().positive().default(2),
  synthesizer: z.string(),
  output: z.string().default("brainstorm-report.md"),
});

export const SpecStageSchema = z.object({
  id: z.string(),
  type: z.literal("spec"),
  model: z.string(),
  output: z.string().default("spec.md"),
});

export const PlanStageSchema = z.object({
  id: z.string(),
  type: z.literal("plan"),
  model: z.string(),
  input: z.string().default("spec.md"),
  output: z.string().default("prd.json"),
});

export const HumanGateStageSchema = z.object({
  id: z.string(),
  type: z.literal("human_gate"),
  prompt: z.string(),
  timeout: z.number().int().positive().optional(),        // 秒；省略 = 一直等
  on_timeout: z.enum(["approve", "abort"]).default("abort"),
});

export const StageConfigSchema = z.discriminatedUnion("type", [
  RalphLoopStageSchema,
  BrainstormStageSchema,
  SpecStageSchema,
  PlanStageSchema,
  HumanGateStageSchema,
]);
export type StageConfig = z.infer<typeof StageConfigSchema>;
```

`RalphLoopStageSchema` 本身不改动。`PipelineConfigSchema`（`stages: z.array(StageConfigSchema).min(1)`）不需要改动，`z.array` 对 discriminated union 直接生效。

### 3.2 引擎侧：Runner 注册表

`StageOutcome`（新类型，`src/engine/engine.ts`）统一四种新 Runner + `ralph_loop` 的返回形状：

```ts
export interface StageOutcome {
  result: "pass" | "fail" | "suspended" | "aborted" | "waiting_human";
  reason?: string;
  usage?: { inTok: number; outTok: number; costUsd: number };
  entered_at?: string;   // 只有 human_gate 首次进入 waiting_human 时设置，见 §3.8
}

export type StageRunnerFn = (
  stageConfig: StageConfig,
  stageState: StageState,             // 本次执行前的状态快照，human_gate 靠它读 entered_at
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  nowFn: () => Date,                  // 复用 EngineDeps.nowFn，human_gate 判超时要用，其余 runner 可忽略
  signal?: AbortSignal
) => Promise<StageOutcome>;
```

`executeStage` 写回状态时，`entered_at` 采用"outcome 有就用 outcome 的，没有就沿用调用前的旧值"的合并策略（`outcome.entered_at ?? stageState.entered_at`），这样 human_gate 第二次及以后的调用不需要每次重复回传 `entered_at`，只有首次设置。

`EngineDeps` 从单一字段改为注册表：

```ts
export interface EngineDeps {
  runners: Partial<Record<StageConfig["type"], StageRunnerFn>>;
  nowFn?: () => Date;
  writeRunReport?: (...) => void;
}

const defaultDeps: EngineDeps = {
  runners: {
    ralph_loop: adaptRalphLoop,   // 包一层，把 RalphLoopSummary 转成 StageOutcome
    brainstorm: runBrainstormStage,
    spec: runSpecStage,
    plan: runPlanStage,
    human_gate: runHumanGateStage,
  },
  nowFn: () => new Date(),
  writeRunReport: ...,
};
```

`executeStage` 改为按 `stage.type` 查表：

```ts
const runner = deps.runners[stage.type];
if (!runner) throw new Error(`No runner registered for stage type "${stage.type}"`);
const outcome = await runner(stage, profiles, cwd, runDir, signal);
```

`ralph_loop` 的适配层 `adaptRalphLoop` 只做返回值转换（`"pass"→"pass"`、`"suspended"→"suspended"`、`"aborted"→"aborted"`），**不改动** `runRalphLoop`/`runRalphLoopOnce` 本身，`ralph-loop.test.ts` 不受影响。

`StageStatus`（`src/engine/state.ts`）新增一个非终态值：

```ts
export type StageStatus = "pending" | "running" | "done" | "failed" | "aborted" | "suspended" | "waiting_human";
```

`TERMINAL_STATUSES` 不变（`done`/`failed`/`aborted`/`suspended`）——`waiting_human` 特意不加入终态集合，这样 `resume` 重新调度到这个 stage 时会自然地再次调用 `human_gate` runner（用于惰性超时检查，见 §3.6），而不是被当成"已经跑完"直接跳过。

`executeStage` 的状态映射扩展成五分支：

```ts
const statusMap: Record<StageOutcome["result"], StageStatus> = {
  pass: "done", fail: "failed", suspended: "suspended", aborted: "aborted", waiting_human: "waiting_human",
};
```

### 3.3 Stage 间文件传递：`specExcerpt` 读取时机后移

现状：`commands/run.ts` 在调用任何 stage 之前，一次性把 `cwd/spec.md` 读成 `specExcerpt` 字符串传给引擎。多阶段场景下 `spec.md` 可能是本次运行中途才由 `spec` stage 写出来的，一次性预读会读到空文件或旧文件。

改动：把这次读取从 `commands/run.ts` 移进 `engine.ts` 的 `executeStage`，改成**每次执行 stage 前现读**（文件不存在则传空字符串）。`ralph_loop` 的适配层把现读到的内容原样传给 `runRalphLoop`，其内部逻辑不变。`commands/run.ts` 不再自己读 `spec.md`。

其余跨 stage 数据完全走文件约定，不引入内存态的 context 对象：

| Stage | 读 | 写 |
|---|---|---|
| brainstorm | `artifacts/requirement.md` | `artifacts/<output>`（默认 `brainstorm-report.md`） |
| spec | `artifacts/brainstorm-report.md`（存在则用）否则 `artifacts/requirement.md` | 项目根 `<output>`（默认 `spec.md`） |
| plan | 项目根 `<input>`（默认 `spec.md`） | 项目根 `<output>`（默认 `prd.json`） |
| ralph_loop | 项目根 `spec.md`（现读，§3.3） | `prd.json`（already 由现有代码维护） |

### 3.4 LLM Client 通用化

```ts
interface LlmCallOptions {
  profile: ModelProfile;
  prompt: string;
  jsonMode?: boolean;
  thinking?: boolean;       // 默认 false；与 jsonMode 解耦，brainstorm 可显式开启
  fetchFn?: typeof fetch;
}
interface LlmCallResult {
  text: string;
  usage: { inTok: number; outTok: number; costUsd: number };
}
export async function callLlm(opts: LlmCallOptions): Promise<LlmCallResult>;

export async function callLlmFanOut(
  profiles: ModelProfile[],
  promptFn: (profile: ModelProfile) => string,
  opts?: { jsonMode?: boolean; thinking?: boolean; fetchFn?: typeof fetch }
): Promise<Array<{ profile: ModelProfile; ok: boolean; result?: LlmCallResult; error?: string }>>;
```

- `callLlm` 内部用 `withRetry(fn, { retries: 3, isRetryable })`：`isRetryable` 只对 HTTP 429/5xx 或网络层异常返回 true；4xx（如 401 key 错误）不重试，直接失败——避免重演"provider 配错、白等一圈"的教训（见 §4 的 `models.yaml` provider/model 拼接 bug 修复历史）。
- `callReviewer(profile, prompt, fetchFn?)` 保留原签名，内部改为 `callLlm({ profile, prompt, jsonMode: true, thinking: false, fetchFn })` 的薄封装，返回值取 `.text` 后 `JSON.parse`——`gate/review-gate.ts` 及其测试零改动。
- `callLlmFanOut` 用 `Promise.allSettled`，单个 profile 失败不影响其他；调用方（brainstorm）自行判断"成功数 <2 则失败"。

### 3.5 brainstorm Runner (`src/runners/brainstorm.ts`)

```
requirement = readTextFile(artifacts/requirement.md)

round1 = callLlmFanOut(models, p => renderIdeaPrompt(requirement))
successes = round1.filter(r => r.ok)
if successes.length < 2: return { result: "fail", usage: sum(round1) }

if mode == "independent":
  finalRound = round1
else: // debate
  finalRound = round1
  for round in 2..debate_rounds:
    anonymized = finalRound.map((r, i) => ({ label: `Model ${i+1}`, text: r.result.text }))
    finalRound = callLlmFanOut(models, p => renderDebatePrompt(requirement, anonymized_excluding_self))

synthesis = callLlm({ profile: profiles[synthesizer], prompt: renderSynthesisPrompt(requirement, finalRound), thinking: true })
write artifacts/<output> = synthesis.text + appendix(finalRound 原始输出)
return { result: "pass", usage: sum(all calls) }
```

- `debate_rounds` 是硬上限（不做"提前收敛检测"，YAGNI）。
- 每个模型在 debate 轮次里看到的是"除自己以外的其他人上一轮输出"，匿名化为 `Model 1/2/3`（不暴露真实 profile 名，避免模型根据"这是 GPT/Claude"之类先验产生偏见）。
- synthesizer 调用默认开 `thinking: true`（汇总对比是最需要深度推理的一步）。

### 3.6 spec Runner (`src/runners/spec.ts`)

```
input = existsSync(artifacts/brainstorm-report.md) ? read(...) : read(artifacts/requirement.md)
prompt = renderSpecPrompt(input)
agentResult = runAgentTask({ profile: profiles[stage.model], prompt, cwd, timeoutMs, runDir, stage: stage.id, story: "spec" })
if !agentResult.ok or !existsSync(cwd/<output>):
  return { result: "fail", usage: agentResult.usage }
return { result: "pass", usage: agentResult.usage }
```

判定成败以"`spec.md` 文件是否真的被写出来"为准，不单纯信任 agent 的退出码——延续 `ralph_loop`/review-gate "不信任 agent 自述"的一贯原则。

### 3.7 plan Runner (`src/runners/plan.ts`)

```
specText = read(cwd/<input>)
attempt 1: result = callLlm({ profile: profiles[stage.model], prompt: renderPlanPrompt(specText), jsonMode: true })
           parsed = JSON.parse(result.text); validated = PrdSchema.safeParse(parsed)
           if validated.success: write(cwd/<output>, validated.data); return { result: "pass", usage: result.usage }
attempt 2 (重试 1 次，把 validated.error 附加进 prompt): 同上
仍失败: return { result: "fail", usage: sum }
```

需要给 `src/prd.ts` 的 `Prd`/`Story` 接口补一份对应的 zod schema（`PrdSchema`）供这里校验用——目前 `prd.ts` 只有 TS interface，没有运行时校验。这是本设计新增的一处基础设施补丁。

### 3.8 human_gate Runner (`src/runners/human-gate.ts`)

```
// stageState 由 executeStage 传入,即调用前 state.stages[i] 的快照
if stageState.entered_at is undefined:
  appendEvent({ type: "human_gate_waiting", stage: stage.id, prompt: stage.prompt })
  return { result: "waiting_human", entered_at: nowFn().toISOString() }
else:
  if stage.timeout is undefined: return { result: "waiting_human" }   // 一直等,不回传 entered_at
  elapsed = nowFn() - Date.parse(stageState.entered_at)
  if elapsed < stage.timeout * 1000: return { result: "waiting_human" }   // 未超时,同样不回传
  // 超时
  if stage.on_timeout == "approve": return { result: "pass" }
  else: return { result: "aborted", reason: "human_gate_timeout" }
```

`entered_at` 存在 `StageState`（新增可选字段 `entered_at?: string`，ISO 时间戳），只有 `human_gate` 用到，其他 stage 不设置。`nowFn` 复用 `EngineDeps.nowFn`（现有字段，测试里已经在用它来做确定性时间注入），而不是 runner 内部直接调 `new Date()`——保持"时间来源可注入"的现有约定，`human-gate.test.ts` 才能确定性地测试超时分支。

### 3.9 CLI 变更

**`run --requirement <text> | --requirement-file <path>`**（互斥）：
- 非 resume 场景下，运行开始时若 pipeline 含 `brainstorm` 或 `spec` stage：
  - 有 `--requirement`/`--requirement-file`：写入 `runDir/artifacts/requirement.md`，同时把文本（或文件内容）存入 `state.json.requirement`
  - 都没提供：在调度任何 stage 之前直接报错退出（"pipeline requires --requirement or --requirement-file"）
- `EngineState` 新增可选字段 `requirement?: string`

**`aiflow approve [--run-id <id>] [--stage <id>]`**：
- `--run-id` 缺省取最新 run；`--stage` 缺省时要求 state.json 里*恰好*有一个 `waiting_human` 的 stage，否则报错（"no stage awaiting approval" / "多个待批准 stage，请用 --stage 指定"）
- 找到目标 stage 后，直接把 `state.stages[i]` 设为 `{ id, status: "done" }`（清掉 `entered_at`），`writeStateAtomic`，然后调用与 `runResume` 相同的 `runPipelineOnce(..., { resume: true })` 路径继续跑后续 stage
- 复用 `runResume`/`run` 现有的 summary 输出格式

**`aiflow reject [--run-id <id>] [--stage <id>] [--reason <text>]`**：
- 目标定位逻辑同 `approve`
- 把该 stage 设为 `{ id, status: "aborted", reason: "human_rejected" }`，`reason` 文本追加进 `events.jsonl`（新事件类型 `human_gate_rejected`），**不**继续执行后续 stage，直接输出终止 summary

`doctor` 命令本次不改动。

## 4. 错误处理（延续技术设计文档 §7 的表格，新增部分）

| 情况 | 策略 |
|---|---|
| brainstorm 单模型调用失败 | 该模型跳过；成功数 <2 → stage `fail` |
| plan 阶段 JSON 解析/校验失败 | 带错误重试 1 次 → 仍失败 → stage `fail`（无 strict 降级，`prd.json` 是硬依赖） |
| spec 阶段 agent 未实际写出 spec 文件 | stage `fail`，不看 agent 退出码 |
| human_gate 超时且 `on_timeout` 未配置 | 等价于 `on_timeout: abort`（安全默认，schema 层已给默认值） |
| `--requirement`/`--requirement-file` 缺失但 pipeline 需要 | 调度任何 stage 前直接报错退出 |
| LLM 调用 429/5xx | `callLlm` 内部指数退避重试 ≤3 次 |
| LLM 调用 4xx（如 401） | 不重试，直接失败（新增行为，此前 `callReviewer` 对所有错误一视同仁不重试） |

## 5. 测试计划

- **schema 测试**（`config.test.ts` 补充）：discriminated union 对四种新 type 的合法/非法（缺字段、type 拼写错）输入
- **`llm/client.test.ts`（新增）**：`callLlm` 的 jsonMode/thinking 开关、429 重试后成功、401 不重试；`callLlmFanOut` 部分失败仍返回全部结果；`callReviewer` 行为不变（现有测试原样跑）
- **`brainstorm.test.ts`（新增）**：independent 模式全成功/部分失败(<2 成功判 fail)；debate 模式多轮注入内容正确匿名化；synthesizer 调用参数正确
- **`spec.test.ts`（新增）**：agent ok 且文件存在 → pass；agent ok 但文件不存在 → fail；agent 失败 → fail
- **`plan.test.ts`（新增）**：首次即合法 JSON → pass；首次非法、重试后合法 → pass；两次都非法 → fail
- **`human-gate.test.ts`（新增）**：首次调用进入 waiting_human 且写 entered_at；未超时重复调用仍 waiting_human；超时+on_timeout=abort → aborted；超时+on_timeout=approve → pass
- **`engine.test.ts` 更新**：mock 从单一 `runRalphLoop` 字段改造成 `runners` 注册表；补充"未知 stage type 抛错"的测试
- **`test/integration/multi-stage-mocked.test.ts`（新增）**：全 mock 跑通 `brainstorm→spec→human_gate→plan→ralph_loop`，覆盖：
  - `waiting_human` 阻塞 → `aiflow approve` 恢复并继续跑完剩余 stage
  - `waiting_human` → `aiflow reject` → 管线终止，后续 stage 不执行
  - 缺 `--requirement` 时 `run` 提前报错，不产生任何 stage 的 `running` 状态
- 所有新测试一律注入 fake `callLlm`/`runAgentTask`，不发真实网络请求——直接吸取 `resume.test.ts` 那次"unit 测试意外依赖真实 OpenCode 调用"的教训

## 6. 边界情况

| 场景 | 处理 |
|---|---|
| pipeline 只有 `ralph_loop` 一个 stage（现状） | `--requirement` 校验跳过（没有 brainstorm/spec stage），行为与现在完全一致 |
| `human_gate` 是 pipeline 第一个 stage，且从未 resume 过 | 首次 `run` 就直接进入 `waiting_human` 并退出，`iterations`/cost 均为 0 |
| `aiflow approve` 时目标 stage 已经不是 `waiting_human`（比如已经被超时自动 approve） | 报错"stage is not awaiting approval"，不做任何修改 |
| brainstorm 的 `models` 列表里某个 profile 名在 `models.yaml` 里不存在 | 复用现有 `loadModelsConfig`/`profiles[name]` 查找逻辑，找不到时在 stage 开始前直接报错（与 `ralph_loop`/`reviewer` 现有的"profile 不存在"处理方式一致，不新增特殊分支） |
| `plan` 阶段模型的输出里混了 markdown 代码围栏（```json ... ```） | `callLlm({ jsonMode: true })` 沿用 `callReviewer` 现有的"剥离 markdown 围栏后再 `JSON.parse`"逻辑（技术设计文档 §6.2 已提到这一步，需要在通用化时保留，不能在重构中丢失） |

## 7. 不做的事

- 不支持超时自动决议使用 duration 字符串（"30m"/"2h"）——`timeout` 字段是纯数字秒，与项目里已有的 `--stall-timeout <s>` 保持同一约定
- 不支持 `human_gate` reject 后"打回上一阶段重跑"——reject 只终止整个管线
- 不扩展 `doctor` 命令
- 不引入内存态的跨 stage context 对象——所有数据传递走文件（§3.3）
- 不做 brainstorm 的"提前收敛"检测——`debate_rounds` 是硬上限
- 不做预算追踪与超限熔断（留给独立的未来功能）
