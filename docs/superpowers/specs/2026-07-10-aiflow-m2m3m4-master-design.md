# AIFlow M2/M3/M4 全量重规划设计文档

> 对应需求文档：《AIFlow 需求文档 Final v1.0》
> 对应技术设计文档：《AIFlow 技术设计文档 Final v1.0》
> 状态：设计定稿，待拆实施计划
> 基线：当前 `main` 分支已实现 M0/M1（CLI、多 stage 引擎、单 reviewer ralph_loop、预算、事件流、monitor）

---

## 1. 目标与范围

本文档解决当前实现与新需求/技术设计文档之间的全部缺口，按"共享基础设施先行"策略统一规划 M2（核心机制）、M3（执行与集成）、M4（监控 GUI）三阶段的设计与实施顺序。

**不在本文档范围内**：
- M0/M1 已稳定模块的重写（只规定它们需要适配的接口）。
- v2+ 展望（多 story 并行、reviewer 权重自学习、Flutter Desktop GUI、OpenCode 插件形态）。

---

## 2. 总体架构与阶段划分

### 2.1 四层架构

```
┌─────────────────────────────────────────────────────────────┐
│  M4: Web Dashboard (Express + SQLite + WebSocket + React)    │
│  只读消费 events.jsonl + specboard.json；gate 应答写 gate-answer.json │
├─────────────────────────────────────────────────────────────┤
│  M3: WorktreeManager + aiflow-mcp + doctor 增强              │
│  worktree 创建/合并/清理；MCP 薄封装；doctor 自检扩展           │
├─────────────────────────────────────────────────────────────┤
│  M2: Stage Runners 增强                                       │
│  AutonomyPolicy / DebateOrchestrator / ReviewMatrix/Arbitrator │
├─────────────────────────────────────────────────────────────┤
│  P0 基础层（本设计重点）                                       │
│  SpecBoard / 扩展事件模型 / 统一配置 schema / gate-answer.json / OpenSpec Parser │
├─────────────────────────────────────────────────────────────┤
│  M0/M1 已稳定：CLI / Engine / OpenCode Adapter / LLM Client / Budget │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 实施顺序

1. **P0 基础层**：所有后续阶段的共享契约。
2. **P1 M2 核心机制**：核心差异化功能。
3. **P2 M3 执行与集成**：full-auto 安全闭环。
4. **P3 M4 监控 GUI**：可视化与人机交互。
5. **P4 验收**：E2E、文档、调优。

每一层都以前一层为不变契约，不回头改下层协议。

---

## 3. P0 共享基础设施层

### 3.1 SpecBoard（`specboard.json`）

**位置**：`.aiflow/runs/<run_id>/specboard.json`

**用途**：所有阶段的"唯一事实来源入口"。Runner 不直接读取上一阶段的产物文件，而是读 SpecBoard 中登记的索引；Runner 产出新产物后写回 SpecBoard。

**结构**：

```json
{
  "requirement": "为 App 增加离线缓存……",
  "artifacts": {
    "requirement": "artifacts/requirement.md",
    "brainstorm": "artifacts/brainstorm-report.md",
    "spec": "spec.md",
    "prd": "prd.json"
  },
  "spec_hash": "sha256:…",
  "config_hash": "sha256:…",
  "open_questions": [
    {
      "id": "D1",
      "topic": "sqflite 还是 drift",
      "positions": { "anon-A": "…", "anon-B": "…" },
      "resolution": null
    }
  ],
  "decisions": [
    {
      "id": "D0",
      "topic": "缓存失效策略",
      "resolution": "TTL+版本号",
      "by": "debate-round-2"
    }
  ],
  "review_matrix": {
    "T1": { "kimi": "fail", "ds": "pass", "arbitrated": true, "final": "fail" }
  }
}
```

**关键规则**：
- `artifacts` 只存相对 `runDir` 的路径。
- `spec_hash` 和 `config_hash` 在 ralph_loop 每轮门禁前校验，被改则视为篡改。
- `open_questions` 由 DebateOrchestrator/ReviewMatrix 写入，由 AutonomyPolicy/human_gate 消费。
- `review_matrix` 由 ReviewMatrix 写入，Dashboard 读取展示。
- 所有对 SpecBoard 的写入必须原子化（写临时文件 + rename）。

**模块**：`src/specboard/specboard.ts`，暴露：

```ts
interface SpecBoard {
  requirement: string;
  artifacts: Record<string, string>;
  spec_hash?: string;
  config_hash?: string;
  open_questions: OpenQuestion[];
  decisions: Decision[];
  review_matrix: Record<string, ReviewVerdictEntry>;
}

function readSpecBoard(runDir: string): SpecBoard;
function writeSpecBoard(runDir: string, board: SpecBoard): void;
function registerArtifact(runDir: string, name: string, relativePath: string): void;
function addOpenQuestions(runDir: string, questions: OpenQuestion[]): void;
function resolveOpenQuestions(runDir: string, ids: string[], resolution: string, by: string): void;
function recordReviewMatrix(runDir: string, storyId: string, entry: ReviewVerdictEntry): void;

interface OpenQuestion {
  id: string;
  topic: string;
  positions: Record<string, string>;
  resolution?: string;
  resolved_by?: string;
}

interface Decision {
  id: string;
  topic: string;
  resolution: string;
  by: string;
}

interface ReviewVerdictEntry {
  [profile: string]: "pass" | "fail" | "skipped";
  arbitrated: boolean;
  arbitrator?: string;
  final: "pass" | "fail";
}
```

### 3.1.1 目录与文件布局调整

为对齐技术设计文档 §4，每个 run 目录结构扩展为：

```
.aiflow/runs/<run_id>/
├── state.json
├── events.jsonl
├── specboard.json
├── gate-answer.json
├── run-report.md
├── artifacts/
│   ├── brainstorm-report.md
│   ├── debate/round-1.json …
│   ├── reviews/T1-round-1.json …
│   ├── fix_list.md
│   ├── progress.md
│   └── opencode/          # 保留，兼容现有 M1 产物
├── transcripts/           # OpenCode 会话记录 + 子进程 stdout/stderr 全量
└── current -> runs/…      # .aiflow/current 符号链接，指向进行中 run
```

- `transcripts/`：从 `artifacts/opencode/` 迁出，与 `artifacts/` 同级；`artifacts/opencode/` 保留作为兼容路径，新调用优先写入 `transcripts/`。
- `.aiflow/current`：引擎启动 run 时创建/更新，指向当前 run 目录；run 到达 terminal 状态时移除或保持最后一次指向。

### 3.2 扩展事件模型（`events.jsonl`）

在现有事件类型基础上新增/补齐以下类型。所有新增事件都必须能被现有 monitor 向后兼容渲染（未知 type 走 generic 分支）。

| 事件类型 | 字段 | 说明 |
|---|---|---|
| `stage_start` | `stage` | 阶段开始 |
| `stage_done` | `stage`, `result` | 阶段结束 |
| `debate_round` | `stage`, `round`, `resolved`, `remaining` | 第 N 轮辩论统计 |
| `debate_end` | `stage`, `reason`, `open_questions` | 辩论终止原因 |
| `review_verdict` | `stage`, `story`, `reviewers`, `arbitrated`, `final` | 多 reviewer 结论矩阵 |
| `review_arbitrated` | `stage`, `story`, `arbitrator`, `verdict` | 仲裁结论 |
| `gate_answered` | `stage`, `by`, `action` | CLI/GUI 应答 |
| `worktree` | `action`, `branch`, `path` | worktree 创建/合并/冲突/移除 |
| `merge_conflict_unarbitrable` | `stage`, `files` | 合并冲突上交人类 |
| `story_suspended` | `story`, `reason` | story 挂起原因细化 |
| `llm_retry` | `stage`, `attempt`, `error` | LLM 重试记录 |

**事件接口扩展**：在 `src/events/events.ts` 中追加类型并导出。

### 3.3 统一配置 schema

改造 `src/config/schema.ts` 中的 `PipelineConfigSchema`、`ReviewGateConfigSchema`、`ModelsConfigSchema`，对齐新文档。

**PipelineConfigSchema 新增字段**：

```ts
const PipelineConfigSchema = z.object({
  name: z.string(),
  autonomy: z.enum(["interactive", "gated", "full"]).default("gated"),
  isolation: z.enum(["none", "worktree"]).optional(),
  budget: BudgetConfigSchema.optional(),
  stages: z.array(StageConfigSchema).min(1),
});
```

**BudgetConfigSchema 新增字段**：

```ts
const BudgetConfigSchema = z.object({
  max_cost_usd: z.number().positive(),
  max_retry_steps: z.number().int().positive().default(5),
  max_token_cost: z.number().positive().optional(),
  warn_at_pct: z.array(z.number().positive().max(1)).optional(),
});
```

- `max_cost_usd`：单 run 总成本上限，由 `BudgetTracker` 在 engine 层累计并熔断。
- `max_retry_steps`：全局最大重试步数，目前主要约束 LLM 解析失败后的重试次数。
- `max_token_cost`：单次 LLM/OpenCode 调用成本上限，由 `LLM Client` 和 `OpenCode Adapter` 在每次调用后检查；若单调用估算成本超过此值，立即失败并记录 `budget_warning`。
- `warn_at_pct`：成本预警阈值数组。

**ReviewGateConfigSchema 改造**：

```ts
const ReviewGateConfigSchema = z.object({
  checks: z.array(z.string()),
  ai_review: z.object({
    enabled: z.boolean(),
    reviewers: z.array(z.string()).min(1).max(2),
    fail_on: z.array(z.enum(["blocker", "major", "minor", "nit"])),
    fail_threshold: z.record(z.string(), z.number()).optional(),
    strict: z.boolean().default(false),
  }),
});
```

**ModelProfileSchema 改造**：

```ts
const PriceSchema = z.object({
  in_per_m: z.number().nonnegative(),
  out_per_m: z.number().nonnegative(),
});

const ModelProfileSchema = z.object({
  channel: z.enum(["opencode", "http"]),
  provider: z.string(),
  model: z.string(),
  agent: z.string().nullable().optional(),
  variant: z.string().nullable().optional(),
  thinking: z.boolean().optional(),
  dangerously_skip_permissions: z.boolean().optional(),
  base_url: z.string().optional(),
  api_key_env: z.string().optional(),
  price: PriceSchema.optional(),
  // 兼容性字段
  input_cost_per_1m: z.number().nonnegative().optional(),
  output_cost_per_1m: z.number().nonnegative().optional(),
});
```

读取时：若 `price` 不存在但旧字段存在，自动转换到 `price`。写入/渲染时统一使用 `price`。

**新增 Stage 类型**：`shell`（执行任意 shell 命令的阶段）。

```ts
const ShellStageSchema = z.object({
  id: z.string(),
  type: z.literal("shell"),
  command: z.string(),
  on_failure: z.enum(["fail", "continue"]).default("fail"),
});
```

**`project.yaml` Schema**（项目级设置，被 doctor 校验，被 engine/runners 读取）：

```ts
const ProjectConfigSchema = z.object({
  max_drift_files: z.number().int().positive().default(50),
  default_checks: z.array(z.string()).optional(),
  dashboard: z.object({
    port: z.number().int().positive().default(3000),
    host: z.string().default("127.0.0.1"),
  }).optional(),
});
```

- `max_drift_files`：worktree 合并前主分支漂移阈值。
- `default_checks`：当 pipeline stage 未显式配置 checks 时的默认命令（可选）。
- `dashboard`：Dashboard 启动默认绑定地址/端口。

### 3.4 `gate-answer.json` 应答协议

**位置**：`.aiflow/runs/<run_id>/gate-answer.json`

**等待状态**：

```json
{
  "stage": "confirm-spec",
  "prompt": "请确认 spec.md 后继续",
  "status": "waiting",
  "answered_at": null,
  "action": null,
  "reason": null
}
```

**应答后状态**（由 `aiflow approve/reject` 或 Dashboard POST 写入）：

```json
{
  "stage": "confirm-spec",
  "prompt": "请确认 spec.md 后继续",
  "status": "answered",
  "answered_at": "2026-07-10T12:00:00Z",
  "action": "approve",
  "reason": null
}
```

**规则**：
- human_gate runner 首次进入等待时创建/覆盖 `gate-answer.json`，状态为 `waiting`。
- 引擎 resume 时，human_gate runner 先读 `gate-answer.json`；若已应答，直接返回 `pass`/`aborted`，不再重复触发 `human_gate_waiting` 事件。
- `aiflow approve` 不直接改 `state.json`，而是原子写 `gate-answer.json` 后再 resume。
- 并发安全：多个客户端同时应答同一 gate 时，`run.lock` 保证串行；`gate-answer.json` 的写操作采用"写临时文件 + rename"原子化。
- timeout：若 stage 配置了 `timeout`，引擎 resume 时检查 `gate-answer.json` 的 `answered_at`；超时未应答则按 `on_timeout`（`approve` 或 `abort`）自动推进，并把超时动作写入 `gate-answer.json`。

### 3.5 OpenSpec Parser

**位置**：`src/openspec/parser.ts`

**职责**：
1. 解析 `spec.md` 的 YAML frontmatter。
2. 用正则切出 `<task id="T1" ...>` 块。
3. 校验：frontmatter schema、task id 唯一、每个 task 含验收标准。
4. 生成 Plan Runner 可用的结构，不直接写 `prd.json`。

**数据结构**：

```ts
interface OpenSpecMeta {
  spec_id: string;
  version: number;
  branch: string;
  verify_all: string[];
  depends: string[];
}

interface OpenSpecTask {
  id: string;
  priority: number;
  depends: string[];
  files: string[];
  title: string;
  acceptance: string[];
  body: string;
}

interface OpenSpec {
  meta: OpenSpecMeta;
  body: string;
  tasks: OpenSpecTask[];
}

function parseOpenSpec(text: string): { success: true; spec: OpenSpec } | { success: false; error: string };
function lintOpenSpec(spec: OpenSpec): string[]; // 返回错误列表，空表示通过
```

**输入示例**（来自需求文档）：

```markdown
---
spec_id: offline-cache-001
version: 1
branch: feat/offline-cache
verify_all: ["flutter analyze", "flutter test"]
depends: []
---

# 离线缓存设计
（人类可读正文）

<task id="T1" priority="1" files="lib/cache/**">
## 实现 CacheStore 接口与 sqflite 落地
验收:
- [ ] `flutter test test/cache/store_test.dart` 通过
- [ ] 并发写入有锁保护
</task>
```

---

## 4. P1 M2 核心机制

### 4.1 AutonomyPolicy

**位置**：`src/policy/autonomy.ts`

**实现为纯函数策略层**，引擎在每个"潜在停点"调用。

```ts
type Autonomy = "interactive" | "gated" | "full";

type GatePoint =
  | "after_brainstorm"
  | "after_spec"
  | "unresolved_questions"
  | "review_dispute_exceeded"
  | "after_story"
  | "run_end"
  | "merge_conflict_unarbitrable";

interface PolicyContext {
  on_unresolved?: "ask_human" | "main_dev_decides";
  open_questions_count?: number;
}

function shouldPause(
  autonomy: Autonomy,
  point: GatePoint,
  ctx: PolicyContext
): "pause" | "proceed";
```

**行为矩阵**（与需求文档 FR6.1 一致）：

| 场景 | interactive | gated | full |
|---|---|---|---|
| brainstorm 后 | 停 | 停 | 不停（open_questions 非空除外） |
| spec 后 | 停 | 停 | 不停 |
| open_questions 非空 | 停 | 停 | 停（除非 on_unresolved: main_dev_decides） |
| review 分歧/修复超限 | 停 | 停 | 挂起 story 继续 |
| 每个 story 完成后 | 停 | 不停 | 不停 |
| 合并冲突主脑裁决失败 | 停 | 停 | 停 |
| run 结束 | 人工合并 | 人工合并 | 自动 commit（worktree 时留分支） |

**关键规则**：
- `unresolved_questions` 三档默认都停，唯一豁免是显式 `on_unresolved: main_dev_decides`。
- human_gate 等待时引擎不空转：状态置 `waiting_human` 后进程可安全退出。
- `autonomy` 可在 stage 级别覆盖 pipeline 级别。

### 4.2 DebateOrchestrator

**位置**：`src/debate/orchestrator.ts`

把当前 `src/runners/brainstorm.ts` 中的 debate 逻辑抽离为独立模块。

**流程**：

```text
round 1: 并行 fan-out 独立提案（通道 B）
loop round 2..debate_rounds:
    每个模型收到：自己上轮提案 + 他人匿名化提案 + moderator 上轮 remaining_disputes
    要求输出：具体批驳（含 severity）+ 修正后提案 + stance_changes
    moderator（主脑）输出结构化 JSON：{ resolved: [...], remaining_disputes: [...] }
    if len(remaining_disputes) == 0: break                    # 收敛
    if len(remaining_disputes) >= len(上轮 disputes): break    # 不再收敛，止损
fan-in: 主脑产出对比矩阵 + 推荐方案 + open_questions
```

**结构化输出 schema**（moderator）：

```ts
const ModeratorOutputSchema = z.object({
  resolved: z.array(z.object({ id: z.string(), topic: z.string(), resolution: z.string() })),
  remaining_disputes: z.array(z.object({
    id: z.string(),
    topic: z.string(),
    positions: z.record(z.string(), z.string()),
  })),
});
```

**工程约束**：
- **匿名化**：模型名用 `anon-A`、`anon-B` 替代；真实映射只写 debug 附录。
- 每轮每模型一次无状态调用，上下文全部显式注入，天然可重放/断点续跑。
- dispute 用稳定 id（D1/D2）跨轮追踪，收敛判定基于 id 集合而非文本相似度。
- moderator 对空泛批评（无 file/点位/severity）打回重答一次。
- 单模型失败标注跳过；成功数 < 2 则 Stage 失败。
- 所有轮次落盘 `artifacts/debate/round-N.json`。

**产物**：
- `artifacts/brainstorm-report.md`：正文 = 对比矩阵 + 推荐方案 + open_questions；附录 = 各模型各轮原始输出。
- SpecBoard：写入 `artifacts.brainstorm`、把 `resolved` 转入 `decisions`、把 `remaining_disputes` 转入 `open_questions`。
- 事件：每轮发 `debate_round`，结束发 `debate_end`。

### 4.3 ReviewMatrix + Arbitrator

**位置**：`src/review/matrix.ts`、`src/review/arbitrator.ts`

把当前 `src/gate/review-gate.ts` 从"单 reviewer"升级为"矩阵 + 仲裁"。

**流程**：

```text
step0 确定性附加规则：
      校验 diff 未触碰 spec.md / .aiflow/config（hash 比对）
      task.files 越界检查（v1 先 warning 计入 review 上下文）
step1 确定性 checks：任一失败直接返回（不调 AI，省成本）
step2 AI review：并行调用 reviewers（自动排除本轮代码作者 profile）
      每个 reviewer 输出 JSON schema，解析失败重试 1 次
step3 判定：
      全体 pass → pass
      全体 fail → fail（issues 按 file+line±3+severity 粗合并去重进 fix_list）
      分歧 → Arbitrator（主脑）一次性仲裁：输入=diff+双方 issues，输出终局 verdict+理由
step4 循环控制：
      story.fix_count++
      超 per_story_fix_limit → suspended
      执行手连续 2 轮对同一 blocker 回复"不认可" → 跳过修复循环，升级 gate
```

**作者排除规则**：
- 从 `reviewers` 列表中移除与 `stageConfig.model`（执行手）同名的 profile。
- 若移除后列表为空，则根据 `ai_review.strict` 决定：strict=true 时 gate 失败；strict=false 时跳过 AI review（仅 checks）。

**仲裁输出 schema**：

```ts
const ArbitrationOutputSchema = z.object({
  summary: z.string(),
  verdict: z.enum(["pass", "fail"]),
  reason: z.string(),
  issues: z.array(ReviewIssueSchema),
});
```

**关键规则**：
- 仲裁不进入循环，任何分歧最多"两审一裁"三步。
- 全部 review 与仲裁原始 JSON 存档 `artifacts/reviews/T1-round-2.json`。
- `review_matrix` 写入 SpecBoard。
- 新增事件：`review_verdict`、`review_arbitrated`、`story_suspended`。

### 4.4 Spec Runner 改造

**位置**：`src/runners/spec.ts`

- 走通道 A（OpenCode 读代码库）。
- 提示词明确要求产出符合 OpenSpec 格式的 `spec.md`。
- 生成后跑确定性 lint：frontmatter schema、task id 唯一、每 task 必含验收。
- 成功后把 `spec_hash`、`artifacts.spec` 写入 SpecBoard，发 `spec_result` 事件。
- 失败时发 `spec_result: fail`，Stage 结束。

### 4.5 Plan Runner 改造

**位置**：`src/runners/plan.ts`

- 用 OpenSpec Parser 解析 `spec.md`（路径来自 SpecBoard）。
- 生成 `prd.json`：`{branchName, stories:[{id,title,acceptance,priority,passes,fix_count}]}`。
- 成功后把 `artifacts.prd` 写入 SpecBoard，发 `plan_result` 事件。
- 不再依赖 LLM 直接输出 JSON；LLM 只负责生成人类可读的 spec。

### 4.6 Ralph Loop 改造

**位置**：`src/runners/ralph-loop.ts`

- 读取 SpecBoard 获取 `spec.md` 路径和 `spec_hash`。
- 每轮迭代前校验 `spec_hash` 和 `config_hash` 未被修改。
- 使用 ReviewMatrix 而非单 reviewer。
- 根据 AutonomyPolicy 决定 story 完成后是否暂停。
- 当 review 分歧升级或合并冲突仲裁失败时，走 human_gate。
- worktree 模式下 `cwd` 由 WorktreeManager 注入。

---

## 5. P2 M3 执行与集成

### 5.1 WorktreeManager

**位置**：`src/worktree/manager.ts`

**默认行为**：
- `isolation` 未配置时：
  - `autonomy=interactive` 或 `gated` → `none`（在当前工作区执行）。
  - `autonomy=full` → `worktree`（自动创建影子工作区）。
- 任何 stage 可通过 `isolation` 字段覆盖 pipeline 默认值。

**接口**：

```ts
interface WorktreeContext {
  originalCwd: string;
  worktreePath: string;
  branch: string;
}

function createWorktree(cwd: string, runId: string): Promise<WorktreeContext>;
function commitStory(ctx: WorktreeContext, storyId: string, title: string): Promise<void>;
function tryMergeBack(ctx: WorktreeContext, autonomy: Autonomy): Promise<"merged" | "conflict" | "skipped">;
function resolveConflict(ctx: WorktreeContext, arbitratorProfile: ModelProfile, diff: string): Promise<boolean>;
function removeWorktree(ctx: WorktreeContext): Promise<void>;
function listStaleWorktrees(cwd: string): string[];
```

**运行期行为**：

```text
run 开始：
    git worktree add ../<repo>-aiflow-<runid> -b aiflow/<runid>
    ralph_loop 在 worktreePath 执行
每个 story commit：
    提交到影子分支 aiflow/<runid>
run 结束：
    autonomy=full → 仅保留分支 + 生成合并指引（不自动 merge 主干）
    gated/interactive → 尝试 git merge --no-ff 回主干
```

**冲突处理路径**：

```text
git diff --name-only --diff-filter=U
    ↓
封装冲突上下文（文件路径 + 冲突块 + 双方最近提交信息）
    ↓
主脑裁决（通道 A，允许改文件解冲突）
    ↓
主脑失败 或 autonomy≠full → gate: merge_conflict_unarbitrable
    ↓
human_gate 等待用户裁决
```

**漂移保护**：
- 合并前 `git merge-base` 检查主分支漂移量。
- 超阈值（默认 >50 文件，可在 `project.yaml` 中配置 `max_drift_files`）直接上交人类。

**清理**：
- `aiflow clean` 扩展：删除 worktree 目录 + 对应分支。
- doctor 检测残留 worktree/分支并提示。

**事件**：
- `worktree`：action=`create|commit|merge_attempt|conflict|resolved|remove`
- `merge_conflict_unarbitrable`

### 5.2 `aiflow-mcp`（可选薄封装）

**位置**：`src/mcp/server.ts`（或独立包 `packages/aiflow-mcp`）

**实现原则**：
- 核心编排不依赖 MCP；MCP 只是入口之一。
- stdio 模式，4 个 tool 全部 spawn 转发 `aiflow CLI`。

| tool | 参数 | 行为 |
|---|---|---|
| `aiflow_brainstorm` | `topic`, `profiles?` | spawn `aiflow run --pipeline brainstorm-only ...`，返回 report 路径 + 摘要 |
| `aiflow_review_diff` | `diff` 或 `ref范围`, `reviewers?` | spawn 临时 review-only pipeline，返回 verdict + issues |
| `aiflow_run` | `pipeline`, `requirement` | spawn `aiflow run ...`，返回 run_id（异步不阻塞） |
| `aiflow_status` | `run_id` | spawn `aiflow status ...`，返回状态摘要 |

**核心零污染**：所有 tool 通过 spawn + 文件读取返回结果，不直接调用内部 API。

### 5.3 doctor 增强

**位置**：`src/commands/doctor.ts`

扩展检查项：

| 检查项 | 说明 |
|---|---|
| OpenCode 版本 | 已存在 |
| Git 仓库状态 | 已存在 |
| 各 profile 连通性 | 检查 models.yaml 中所有 http profile |
| OpenCode profile 可用性 | spawn 轻量 `opencode run` 验证 |
| worktree 残留 | 列出 `../<repo>-aiflow-*` 残留目录 |
| 配置 schema 校验 | 校验 models.yaml + pipelines/*.yaml + project.yaml |
| 价格字段完整性 | 检查所有 profile 的 `price` 或旧字段 |

输出保持人类可读；任一关键项失败则 exitCode=1。

### 5.4 CLI 新增命令

- `aiflow abort [--run-id <id>]`：把任意运行中、waiting_human 或 paused 的 run 强制标记为 `aborted`，释放锁，发 `run_aborted` 事件。与 `aiflow reject` 的区别：`reject` 仅作用于当前处于 `waiting_human` 的 gate 并把它拒绝（Stage 变 `aborted`）；`abort` 是全局终止整个 run，无论它在哪个阶段。
- `aiflow clean` 扩展：增加 `--worktrees` 选项，删除残留 worktree + 分支。

---

## 6. P3 M4 Web Dashboard

### 6.1 设计原则

- **只读消费文件**：Dashboard 不直接接收 Runner POST；`events.jsonl` + `specboard.json` 是唯一数据源。
- **引擎挂了 Dashboard 照样显示**：collector 与 engine 完全解耦。
- **只有 gate 应答和 run 控制是写操作**：写 `gate-answer.json`，不碰代码。

### 6.2 架构

```
┌─────────────┐     chokidar tail     ┌─────────────────┐
│ runs/*/     │ ────────────────────▶ │ collector       │
│ events.jsonl│                       │ better-sqlite3  │
└─────────────┘                       │ (WAL, 只读索引) │
                                      └────────┬────────┘
                                               │
                                      ┌────────▼────────┐
                                      │ Express REST    │
                                      │ + ws 广播增量    │
                                      └────────┬────────┘
                                               │
                                      ┌────────▼────────┐
                                      │ React + Vite    │
                                      │ Tailwind        │
                                      └─────────────────┘
```

### 6.3 Collector

**位置**：`src/dashboard/server/collector.ts`

- 监听 `runs/*/events.jsonl` 增量行。
- 行号游标持久化到 SQLite，保证幂等。
- 重启时全量重扫；SQLite 仅作缓存，可随时删除。
- 读取 `specboard.json` 作为补充数据源。

### 6.4 REST API

| 端点 | 说明 |
|---|---|
| `GET /api/runs` | 运行列表 |
| `GET /api/runs/:id` | 单个 run 状态 + events |
| `GET /api/runs/:id/stages` | stage 列表 |
| `GET /api/runs/:id/stories` | story Kanban 数据 |
| `GET /api/runs/:id/debates` | debate 轮次 + 分歧演化 |
| `GET /api/runs/:id/reviews` | review 矩阵 + issues |
| `GET /api/runs/:id/cost` | 成本/token 分布 |
| `POST /api/runs/:id/gates/:stage/answer` | gate 应答 approve/reject |
| `POST /api/runs/:id/control` | pause / resume / abort |

### 6.5 WebSocket

- 服务端通过 `ws` 推送新增事件。
- 客户端监听后增量更新 UI，避免轮询。

### 6.6 前端页面

| 页面 | 对应 Agent-Monitor | 说明 |
|---|---|---|
| Pipeline Kanban | Kanban | Stage/Story 按状态分列；Waiting 列 = human_gate 待办 |
| Run Detail | Session Detail | 显示 run 状态、events feed、成本 |
| Debate 视图 | 新增 | 按轮次展示方案、分歧演化、open_questions |
| Review 视图 | 新增 | diff 与 issues 并排、仲裁结论、severity 分布 |
| Timeline / Activity Feed | Feed | events.jsonl 实时流，多维过滤 |
| 成本面板 | Analytics | 按模型/阶段/token/费用 |

### 6.7 执行手会话详情

- ralph_loop 当前用 `opencode run` 子进程，会话记录落盘 `transcripts/`。
- Dashboard 通过反向代理 `opencode serve` API 拉取/深链会话详情（只读展示）。
- v2 可改走 `opencode serve` 模式实现打字机级实况；v1.5 只展示已完成会话记录。

### 6.8 安全

- Dashboard 默认绑定 `localhost`。
- Gate 应答与 run 控制需要 same-origin。
- 不暴露 API key 和原始 transcript 中的敏感内容。

---

## 7. 数据流、错误处理与恢复策略

### 7.1 一次 full-auto 的数据流

```text
需求输入
   │
   ▼ 写入 SpecBoard.artifacts.requirement
[brainstorm]
   │ 读取 requirement → fan-out/debate → 写 brainstorm-report.md
   │ 写 SpecBoard.artifacts.brainstorm, open_questions, decisions
   │ 发 debate_round / debate_end 事件
   ▼
AutonomyPolicy 判定：open_questions 非空 → pause（或 main_dev_decides）
   │
   ▼ 用户 approve / 主脑代决
[spec]
   │ 读取 brainstorm-report → OpenCode 写 spec.md
   │ 写 SpecBoard.artifacts.spec, spec_hash
   │ 发 spec_result 事件
   ▼
AutonomyPolicy 判定：autonomy=gated/full 行为
   │
   ▼ 用户 approve
[plan]
   │ OpenSpec Parser 解析 spec.md → 写 prd.json
   │ 写 SpecBoard.artifacts.prd
   │ 发 plan_result 事件
   ▼
[ralph_loop]
   │ 每轮：读 SpecBoard → 选 story → OpenCode 执行 → hash 校验 → ReviewMatrix
   │ 通过：commit（worktree 时提交到影子分支）
   │ 失败：fix_list.md + story.fix_count++
   │ 发 gate_result / story_result / review_verdict 事件
   ▼
[汇总]
   │ 写 run-report.md（含：stage 表、成本、story 完成表、review 问题分布、debate 摘要、open_questions）
   │ autonomy=full + worktree → 保留分支 + 合并指引
   │ autonomy=gated/interactive → 尝试 merge 回主干
```

**run-report.md 增强内容**：
- Stage 完成表（status、reason、耗时）。
- 成本汇总（总 token、总费用、按 stage 拆分）。
- Story 完成表（pass/fail/suspended 数量及列表）。
- Review 问题分布（按 reviewer、按 severity、按 file）。
- Debate 摘要（收敛轮数、最终 open_questions、关键 decisions）。
- 未决 open_questions 与下一步建议。

### 7.2 错误处理矩阵

| 故障 | 策略 | 落点 |
|---|---|---|
| LLM API 瞬时错误（429/5xx/超时） | 指数退避重试 ≤3 次 | `llm_retry` 事件 |
| AI 输出非法 JSON | 携错误重试 1 次 → strict 决定放行/阻塞 | review/debate 原始 JSON 存档 |
| OpenCode 子进程超时/崩溃 | kill 进程树，本轮迭代记失败进下一轮（计入 stall） | `story_result: fail` |
| 辩论不收敛 | 分歧数不减即提前终止 | `debate_end` + SpecBoard.open_questions |
| reviewer 分歧 | 主脑一次性仲裁 | `review_verdict` + SpecBoard.review_matrix |
| 修复循环超限 | story 挂起 suspended | `story_suspended` |
| 合并冲突 | 主脑裁决 → 失败上交人类 | `merge_conflict_unarbitrable` |
| 进程被 kill / 断电 | state.json 原子写保证一致 | `aiflow resume` |
| 预算超限 | paused + 通知 | `budget_warning` |
| 配置/spec 被篡改 | 自动恢复 + 记门禁失败 | `config_tampered` |
| 用户 Ctrl+C | 优雅暂停（双击强杀） | state.json `paused` |

### 7.3 Resume 规则

- `resume` 读取 `state.json` 从第一个非 terminal 阶段继续。
- human_gate 阶段 resume 时先读 `gate-answer.json`：若已应答，直接消费并继续；若未应答，保持 waiting_human 并退出。
- `--force` 重置所有 terminal 阶段为 pending，用于重跑。
- `--raise-budget <n>` 可在 resume 时提升预算上限。

### 7.4 并发与锁

- 同一项目同时只能有一个 run 持有 `run.lock`。
- Dashboard 读操作不加锁；gate 应答/控制命令通过 `aiflow approve/abort` 间接获取锁后写 `gate-answer.json`。

---

## 8. 测试策略

### 8.1 单元测试

| 模块 | 测试重点 |
|---|---|
| `specboard.ts` | 读写、artifact 注册、open_questions/decisions 更新 |
| `autonomy-policy.ts` | 三档 autonomy × 各 gate point 的行为矩阵 |
| `debate/orchestrator.ts` | 收敛判定、匿名化、轮次上限、dispute id 稳定 |
| `review/matrix.ts` | 作者排除、并行调用、issue 去重 |
| `review/arbitrator.ts` | 分歧判定、仲裁输出 schema |
| `openspec/parser.ts` | frontmatter 解析、`<task>` 切片、lint 规则 |
| `worktree/manager.ts` | worktree 创建/合并/冲突检测/清理（mock git） |
| `events.ts` | 新增事件类型序列化/读取 |
| `config/schema.ts` | 新旧字段兼容 |

### 8.2 集成测试

- fake OpenCode Adapter + fake LLM Client 跑通 full-auto 全流程。
- 覆盖：resume、预算暂停、stall 终止、辩论提前止损、仲裁、story 挂起、gate-answer 消费、worktree 隔离。

### 8.3 端到端验收

对应需求文档 §7：

1. 示例 Flutter/TS 仓库跑通 `aiflow run full-auto`。
2. 构造 debate 分歧验证轮数封顶 + open_questions 上交。
3. 双 reviewer 冲突验证仲裁一次定论。
4. kill 进程后 `resume`、低预算触发 paused、429 重试。
5. worktree 开关模式合并 + 构造冲突验证主脑裁决/上交人类。
6. 构造 AI 篡改 spec/config 的 diff，hash 校验拦截。
7. Dashboard 实时显示 + GUI gate 应答 + pause/resume。
8. doctor 在断网/错 key/缺 OpenCode 下给出准确诊断。

---

## 9. 实施计划与里程碑

### 9.1 阶段划分

| 阶段 | 内容 | 估算 |
|---|---|---|
| **P0 基础层** | SpecBoard、扩展事件、配置 schema 统一、gate-answer.json、OpenSpec Parser | 1 周 |
| **P1 M2 核心** | AutonomyPolicy、DebateOrchestrator、ReviewMatrix/Arbitrator、Spec/Plan/Ralph 改造 | 2 周 |
| **P2 M3 集成** | WorktreeManager、aiflow-mcp、abort 命令、doctor 增强 | 1.5 周 |
| **P3 M4 GUI** | Dashboard collector/server/client、Kanban/Debate/Review/Timeline/成本 | 2~3 周 |
| **P4 验收** | E2E 测试、文档、性能/成本调优 | 1 周 |

### 9.2 关键依赖

- P0 必须先完成；P1/P2/P3 可部分并行，但 P1 要在 P2 的 worktree 合并裁决之前，P2 的 MCP 依赖 P1 的完整事件格式。
- P3 Dashboard 的 Debate/Review 视图依赖 P1 的 debate/review 事件和 SpecBoard 字段。

### 9.3 风险与对策

| 风险 | 对策 |
|---|---|
| 基础层改动导致 M1 功能回归 | P0 完成后跑完整 M1 测试基线；每个后续 PR 必须过原测试 |
| OpenCode headless 参数/输出格式变化 | 全部隔离在 Adapter；doctor 增加自检测 |
| Dashboard 索引与文件不一致 | collector 幂等 + 重启全量重扫 + SQLite 仅缓存 |
| full 模式过夜烧钱死循环 | 四重闸：per_story_fix_limit / stall_limit / max_retry_steps / max_cost_usd |
| worktree 合并冲突主分支漂移 | merge-base 阈值检查，超阈值上交人类 |
| 多人同时 approve 同一 gate | run.lock 保证串行；gate-answer.json 原子写 |

---

## 10. 开放问题

以下问题在本文档定稿时仍有实现选择空间，需在实施计划阶段明确：

1. **Dashboard 技术栈细节**：React 状态管理用原生 Context 还是轻量库（如 Zustand）？
2. **`opencode serve` 反向代理**：当前 OpenCode 版本 serve API 的路径/认证方式需在 M4 开发前实测确认。
3. **aiflow-mcp 包形态**：作为 `src/mcp/server.ts` 内置，还是拆成独立 `packages/aiflow-mcp`？
4. **MCP tool 参数设计**：`aiflow_review_diff` 接收原始 diff 字符串还是 git ref 范围？
5. **Dashboard gate 应答鉴权**：本地单机 localhost + same-origin 是否足够，是否需要 token？
