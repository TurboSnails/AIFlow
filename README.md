# AIFlow

本地优先的多智能体研发流水线编排器。自身**不写代码**，把读、写、执行命令全部委托给 [OpenCode](https://github.com/sst/opencode) CLI；多模型头脑风暴 + 多模型交叉互审是核心差异化。

AIFlow 只做**编排 / 门禁 / 路由 / 监控**：

- 把工作建模成有序的 **stage**（`brainstorm` / `spec` / `plan` / `human_gate` / `ralph_loop` / `shell`），由 YAML 流水线声明。
- Stage 之间只通过磁盘文件 + git 提交传递状态，可审计、可恢复。
- **两层门禁**：先确定性检查（lint / test / build），再结构化 AI 互审。
- **只读 Monitor / Dashboard** 通过 `state.json` + `events.jsonl` 渲染实时状态，与引擎解耦，可独立关闭/重启。

完整设计见 [`需求文档`](./需求文档) + [`技术设计文档`](./技术设计文档)。

---

## 仓库速览

| | |
|---|---|
| 运行时 | [Bun](https://bun.sh) ≥ 1.3 |
| 语言 | TypeScript（strict） |
| 入口 | `src/cli.ts`（commander，注册 14 个子命令） |
| 测试 | [bun test](https://bun.sh/docs/cli/test)，67 个测试文件，~330 用例 |
| 命令行 | `aiflow`（`bun run src/cli.ts`） |
| 内置流水线 | `ralph-only` / `superpowers` / `spec-superflow` / `openspec` |
| GUI | `aiflow dashboard` → Express + WebSocket + React/Vite |
| MCP | `src/mcp/server.ts`（stdio），4 个 tool |

---

## 前置依赖

| 依赖 | 说明 |
|---|---|
| Bun ≥ 1.3 | 运行时 + 包管理 + 测试 |
| OpenCode CLI | 在 `PATH` 中可执行 `opencode --version`，否则用 `AIFLOW_OPENCODE_BIN=/abs/path/to/opencode` 显式指定 |
| 一个 git 仓库 | AIFlow 在仓库内工作 |
| 至少一个 LLM API key | 走环境变量（`api_key_env` 间接引用），**绝不**写进 YAML |

---

## 安装

```bash
git clone <this-repo> aiflow
cd aiflow
bun install
bun run src/cli.ts --help     # 验证安装
```

如果你要把 `aiflow` 暴露到全局：

```bash
bun link                       # 然后 aiflow 直接可用
```

---

## 在你的项目里启用 AIFlow（一次性）

```bash
cd your-project                # 必须是有 git 的目录
aiflow init                    # 生成 .aiflow/ + 改 .gitignore
```

`init` 不会覆盖已有目录。生成内容：

```
.aiflow/config/
├── models.yaml                # 模型 profile（main-dev / reviewer / alt-reviewer…）
├── project.yaml               # 项目级默认（autonomy / on_unresolved / dashboard）
└── pipelines/
    ├── ralph-only.yaml
    ├── superpowers.yaml
    ├── spec-superflow.yaml
    └── openspec.yaml
```

并在 `.gitignore` 追加一行：

```
.aiflow/runs/
```

### 填 `models.yaml`

`aiflow init` 默认生成的骨架：

```yaml
profiles:
  main-dev:
    channel: opencode
    provider: opencode
    model: deepseek-v4-flash-free

  reviewer:
    channel: http
    provider: minimax
    model: REPLACE_ME_VERIFY_VIA_DOCTOR   # 跑 doctor 拿到推荐的 model id
    base_url: REPLACE_ME_VERIFY_VIA_DOCTOR
    api_key_env: MINIMAX_API_KEY

  alt-reviewer:
    channel: http
    provider: REPLACE_ME_VERIFY_VIA_DOCTOR
    model: REPLACE_ME_VERIFY_VIA_DOCTOR
    base_url: REPLACE_ME_VERIFY_VIA_DOCTOR
    api_key_env: ALT_REVIEWER_API_KEY
```

- **`opencode` channel**：每次调用 `opencode run --format json`，凭据走 OpenCode 自己的 provider registry。
- **`http` channel**：直接打 OpenAI 兼容 `/chat/completions`，key 全部来自 `api_key_env` 引用的环境变量。
- **先 `aiflow doctor`** —— 它会告诉你哪个 profile 不通以及最常见的 `base_url` 错配。

设置环境变量：

```bash
export MINIMAX_API_KEY=sk-cp-...
export ALT_REVIEWER_API_KEY=...
```

> **`main-dev` / `reviewer` / `alt-reviewer` 是模板默认 profile 名**。`superpowers` / `spec-superflow` 的 brainstorm 阶段会用到 `["reviewer", "alt-reviewer"]`，所以至少要有两个 http channel。

---

## 命令清单（共 14 个）

| 命令 | 说明 |
|---|---|
| `aiflow doctor` | 环境体检：OpenCode 版本、git 仓库、配置 schema、reviewer API 连通性、stale worktree |
| `aiflow init` | 生成 `.aiflow/config/` 脚手架，幂等（拒绝覆盖） |
| `aiflow run --pipeline <n>` | 启动一条流水线，`--once` 跑一轮就退出 |
| `aiflow resume` | 从 `state.json` 续跑（崩溃 / Ctrl+C / 重启后） |
| `aiflow approve` | 应答 `human_gate`，绕开等待继续流水 |
| `aiflow reject` | 应答 `human_gate`，中止流水线（标 `aborted`） |
| `aiflow abort` | 强制中止跑：标记 `running` / `waiting_human` / `pending` 为 `aborted` |
| `aiflow status` | 一次性渲染最新 run（`--run-id` / `--tail N` / `--stall-timeout S`） |
| `aiflow watch` | 每秒刷一次 `status`，Ctrl+C 退出（`--interval MS`） |
| `aiflow cost` | token 与 USD 成本分解（`--run-id` / `--all` / `--json` / `--csv`） |
| `aiflow runs` | 历史 run 列表（`--json` / `--csv` / `--no-color`），标 `*` 为活动 |
| `aiflow clean` | 清理已完成 run 与 stale worktree（`--runs` / `--before` / `--status` / `--keep` / `--worktrees` / `--dry-run` / `--yes`） |
| `aiflow report` | 打印 `run-report.md`（`--run-id`） |
| `aiflow dashboard` | 启动 Web Dashboard（默认 `127.0.0.1:3000`，`--port`） |

所有写操作（`run` / `resume` / `approve` / `reject` / `abort`）都会**自动获取 run lock**，避开并发覆盖。Ctrl+C 是"安全暂停"：等当前步结束后状态落 `paused`，下次 `aiflow resume` 续上，不需要 `--force`。

### 启动一条流水线

```bash
# 最常用：brainstorm → spec → 确认 → plan → ralph_loop
aiflow run --pipeline superpowers --requirement "为 App 增加离线缓存"

# 需求很长：
aiflow run --pipeline superpowers --requirement-file ./req.md

# 调试单条 Ralph Loop（需要手写 spec.md + prd.json）
aiflow run --pipeline ralph-only --once

# Full-Auto 过夜：worktree 隔离 + autonomy: full
aiflow run --pipeline openspec --requirement "..."
```

### 内置流水线模板

| 模板 | Stages | 适用场景 |
|---|---|---|
| `ralph-only` | `ralph_loop` | 只跑"取任务→编码→门禁→提交"循环 |
| `superpowers` | `brainstorm → spec → human_gate(confirm-spec) → plan → ralph_loop(develop)` | OpenSpec + 多模型头脑风暴 + 评审矩阵（本项目主推） |
| `spec-superflow` | `brainstorm(exploring) → spec(specifying) → human_gate(bridging-review) → plan(tasks) → ralph_loop(executing)` | 同拓扑，术语更接近的 team 偏好 |
| `openspec` | `spec → plan → ralph_loop` | 最轻：不开 brainstorm，不开 human_gate |

每个 stage 都可覆盖 `autonomy: interactive | gated | full`、`on_unresolved: ask_human | main_dev_decides`（仅 brainstorm / spec）、`on_failure: fail | continue`（仅 shell）等字段。

---

## Stage 类型（v1）

| 类型 | 干什么 |
|---|---|
| `brainstorm` | 多模型 fan-out（`independent` 或 `debate`）→ 合成器汇总 → 写 `artifacts/brainstorm-report.md`；debate 有 `debate_rounds` 硬上限（默认 2、最大 4）和收敛提前终止 |
| `spec` | 把需求 + brainstorm 报告转成 OpenSpec 格式 `spec.md`（YAML frontmatter + Markdown + `<task>` 块），解析 + lint |
| `plan` | `spec.md` → `prd.json`（`{ branchName, stories[] }`），zod 校验；可走 `http` channel，由模型生成 |
| `ralph_loop` | 每轮全新上下文：选最高优先级 story → OpenCode 执行 → 确定性 checks → AI reviewer 互审（reviewer ≠ 作者）→ 通过就 git commit，失败进 `fix_list.md` |
| `human_gate` | 落 `waiting_human`；CLI 用 `aiflow approve` / `aiflow reject` 应答，Dashboard 用 `/api/runs/:id/gates/:stage/answer` |
| `shell` | 跑任意 shell 命令，`on_failure: fail|continue` 控制失败语义；用于"安装依赖 / 打 stub / 发通知"等场景 |

> 每个 stage 都先经过**确定性 gate**（任意非零退出 → fail，不进 AI），再走 AI review（结构化 JSON，schema 校验后才生效）。

---

## 每跑一次产出什么

每次 `aiflow run` 创建 `.aiflow/runs/<run-id>/`（默认 git-ignored）：

| 文件 / 目录 | 用途 |
|---|---|
| `state.json` | 引擎快照，**原子写**（`writeStateAtomic`），`resume` 读它继续 |
| `events.jsonl` | append-only 结构化事件流（`status` / `watch` / Dashboard 都消费这一份） |
| `specboard.json` | SpecBoard：阶段间决策、open_questions、artifacts 索引、spec/config hash |
| `run-report.md` | 跑结束后的成本 + 阶段结果汇总 |
| `artifacts/brainstorm-report.md` | brainstorm 阶段产物（含对比矩阵 + 推荐方案） |
| `artifacts/spec.md` | spec 阶段产物（OpenSpec 格式） |
| `artifacts/prd.json` | plan 阶段产物 |
| `artifacts/debate/round-N.json` | debate 模式每轮原始产物（含 `stance_changes` + `critiques`） |
| `artifacts/opencode/<call>.jsonl` | 每次 OpenCode 调用的 JSONL 原文 |
| `artifacts/fix_list.md` | 未通过 story 的门禁反馈累积 |
| `artifacts/progress.md` | 通过的 story 追加在此 |
| `artifacts/merge-guide.md` | worktree 模式合并冲突时人工合并步骤 |

并维持一个**符号链接** `.aiflow/current → runs/<latest>`（仅 `aiflow run` 维护）。

---

## Web Dashboard

```bash
aiflow dashboard             # 默认 127.0.0.1:3000
aiflow dashboard --port 8080
```

- **数据源唯一**：单 SQLite `.aiflow/dashboard.db`，`startCollector` 后台 `chokidar` 监听 `.aiflow/runs/`，推到 WebSocket。
- **页面**：Pipeline Kanban / Debate 视图 / Review 视图 / Timeline / 成本面板 / human_gate 应答 + pause/resume/abort。
- **`POST /api/runs/:id/gates/:stage/answer`**：在 GUI 内 approve / reject，**会同步调 `runApprove` 续跑**（含 run lock + CLI fallback 路径）。
- **默认仅绑定 `127.0.0.1`**，需对外暴露请改 `project.yaml` 的 `dashboard.host`。
- 生产模式由 Express 直接 serve React 构建产物；开发模式用 Vite dev server。

---

## MCP（stdio）

`src/mcp/server.ts` 是独立的 stdio MCP server（用作 OpenCode / Claude Code 的"可用入口之一"，**不是总线**）。注册 4 个 tool：

| Tool | 行为 |
|---|---|
| `aiflow_status` | 调 `aiflow status [--run-id ...]` |
| `aiflow_run` | 调 `aiflow run --pipeline <n>` |
| `aiflow_brainstorm` | 调 `aiflow run --pipeline <n> --requirement <prompt>` |
| `aiflow_review_diff` | 调 `aiflow review-diff --diff <text> [--reviewers a,b]` |

> `aiflow review-diff` 命令本身尚未注册到 CLI，对应分支落地后此 tool 即可用。

启动方式：在 OpenCode / Claude Code 的 MCP 配置里加 stdio server：

```jsonc
{
  "mcpServers": {
    "aiflow": {
      "command": "bun",
      "args": ["run", "<absolute>/aiflow/src/mcp/server.ts"]
    }
  }
}
```

---

## 安全模型

| 保证 | 实现 |
|---|---|
| API key 永不落盘 | `models.yaml` 只写 `api_key_env`，运行时从环境变量读 |
| 日志/报告脱敏 | `sanitizeSecrets` 替换 `sk-…` 与 `*_API_KEY=...` |
| 流水线配置只读 | Ralph Loop 每轮对 `spec.md` 与 `.aiflow/config/` 做 hash；改动即 fail |
| 文件即接口 | 引擎、CLI、GUI、Dashboard、MCP 全部读同一份 `state.json` + `events.jsonl` |
| Run lock | 写操作自动获取，stale 自动 reclaim |
| 工作目录隔离 | `isolation: worktree` 把执行手丢到 `../<repo>-aiflow-<runid>`，主脑留在主分支 |
| AI 评审防自利 | reviewer profile ≠ implementer profile（自动从评审矩阵排除） |

---

## 跑测试

```bash
bun test ./test
```

| 目录 | 内容 |
|---|---|
| `test/unit/` | 67 个文件，覆盖每个模块的契约；纯函数优先 |
| `test/integration/ralph-loop-mocked.test.ts` | 注入 mock 跑完整条流水线 |
| `test/integration/ralph-loop-real.test.ts` | 真实 OpenCode + reviewer；缺 `MINIMAX_API_KEY` 时自动 skip |
| `test/integration/{multi-stage-mocked,auto-clean,budget-warnings,runs-clean,cli-lock}.test.ts` | 端到端场景 |
| `test/e2e/{full-auto,dashboard}.test.ts` | 完整自动化跑 + Dashboard |

---

## 配置参考（project.yaml 示例）

```yaml
# .aiflow/config/project.yaml
autonomy: gated                      # interactive | gated | full（默认 gated）
on_unresolved: ask_human            # brainstorm/spec 阶段产物含未决分歧时，ask_human | main_dev_decides
dashboard:
  host: 127.0.0.1
  port: 3000
budget:
  max_cost_usd: 20
  warn_at_pct: [0.5, 0.8, 1.0]       # 预算触达百分比时贴 warn 事件
  max_retry_steps: 5
  max_token_cost: 200000             # 单次调用 token 上限
```

环境变量：

| 变量 | 含义 |
|---|---|
| `AIFLOW_OPENCODE_BIN` | 自定义 OpenCode 可执行路径 |
| `MINIMAX_API_KEY` 等 | 仅当 `models.yaml` 中 `api_key_env` 引用时才读 |

---

## 项目结构

```
src/
├── adapters/          # OpenCode subprocess + JSONL 事件解析（通道 A）
├── cli.ts             # commander 入口，14 个子命令
├── commands/          # doctor / init / run / resume / approve / reject / abort / monitor / cost / runs / clean / report / dashboard
│   └── init-templates/  # 4 个内置流水线模板
├── config/            # zod schema + YAML 加载 + 配置目录 hash
├── dashboard/         # server (Express + ws + sqlite) + client (React + Vite)
├── debate/            # debate 编排 + schemas
├── engine/            # 状态机：brainstorm/spec/plan/human_gate/ralph_loop/shell
├── events/            # events.jsonl 的 read/append
├── gate/              # check-runner + review-gate + 预算跟踪
├── gate-answer/       # Dashboard / CLI gate-answer 落地
├── llm/               # 直接 HTTP LLM client（通道 B）
├── lock.ts            # run lock（写操作排他 + stale 回收）
├── mcp/               # stdio MCP server + tools
├── opencode/          # 通道 A 适配器
├── policy/            # autonomy / on_unresolved 决策
├── prd.ts             # prd.json 读写 + story 状态机
├── review/            # 多 reviewer 矩阵 + 仲裁
├── runs/              # run 目录索引 + 元数据
├── spec/              # OpenSpec 解析器（frontmatter + <task> 块）
├── specboard/         # specboard.json 黑板读写
├── worktree/          # git worktree 隔离 + AI 冲突裁决 + merge guide
└── runners/           # 6 个 stage runner
test/
├── unit/              # 模块单测（67 文件）
├── integration/       # mock + 真实环境跑全流程
└── e2e/               # 完整自动化 + Dashboard
```

---

## 已知未实现 / v2+

- `aiflow review-diff` 命令本体（MCP `aiflow_review_diff` tool 依赖它）
- 跨多 story 并发（多 worktree 并发）—— run_id 隔离已为此预留
- Reviewer 权重自学习（依赖 v1 落盘的 review-issue 分布数据）
- Flutter Desktop 原生 GUI（Dashboard 已按"只读文件源"设计，迁移零改核心）
- 下沉为 OpenCode 插件形态
- Debate 分歧演化图表

详见 `docs/superpowers/plans/2026-07-10-aiflow-m2m3m4-master-plan.md` 与 `2026-07-11-aiflow-gap-closure.md`。

---

## License

OpenCode CLI（依赖的底座）是 MIT。AIFlow 本身目前无 LICENSE（私有项目），在显式 LICENSE 文件落地前按"all rights reserved"对待。
