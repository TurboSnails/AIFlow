# AIFlow 项目优化审查报告

日期：2026-07-07
范围：结合《文档设计》（技术设计文档）、`README.md`（现状自述）、`AIFlow UI - standalone.html`（v2 GUI 设计稿，已解包）与 `src/` 现有实现（~3001 行 TS，34 个测试文件），对照用户提出的四个目标——**稳定、可商业化、交互人性化、可扩展**——逐项找差距。

本报告只做审查，不改代码。结尾给出优先级建议，供下一步挑选 1-2 项进入 brainstorming → spec → plan 正式开工。

---

## 现状速览

- v1 是一个纯 CLI、文件+git 驱动的 pipeline 编排器：`brainstorm → spec → confirm-spec(human_gate) → plan → develop(ralph_loop)`，五种 stage 类型均已实现并有测试覆盖。
- GUI（README/设计文档称为"v2"）尚未开始实现；`AIFlow UI - standalone.html` 是一份独立的前端设计稿（Runs 列表/详情、Fix List 时间线、Pipeline 配置、模型档案管理、Reports），其中包含一个当前代码库里完全没有对应实现的新特性：**`human_gate` 的"自动确认"开关**（关闭时人工确认会一直等待；开启后由 LLM 依据业务判断自动放行）。
- README 自己列出的已知缺口：预算超限自动暂停未实现、`human_gate` 被拒绝后无法重跑前序阶段、`doctor` 对新 stage 类型缺少体检。审查确认了这些，并补充了下面的发现。

---

## 1. 稳定性（Stability）

1. **并发运行无锁保护**（高）
   `engine.ts` / `commands/run.ts` 没有任何 lock/pid 文件机制。同一项目下两次 `aiflow run`（或 `run` 与 `resume` 并发）会在同一 git 工作区里同时执行 `stageAll`/`commit`/`checkoutClean`，可能相互踩踏，导致提交损坏，或 `auto_clean` 误删另一个 run 尚未提交的改动。
   建议：`runDir` 或 `.aiflow/current` 加文件锁（`O_EXCL` pidfile 即可），启动时检测到已有活跃 run 就拒绝。

2. **HTTP 通道成本恒为 0**（高）
   `src/llm/client.ts:77` `costUsd: 0` — 只要走 http 通道（brainstorm/spec/plan/review 全部如此），`state.json` 里的 `cost.est_usd` 永远只统计 OpenCode 通道（`step_finish` 事件）的花费，账不准。而设计文档承诺的 `budget.max_cost_usd` 熔断机制本身在 `PipelineConfigSchema`（`src/config/schema.ts`）里根本没有 `budget` 字段，`engine.ts` 也没有超限检测/暂停逻辑——这是 README 已承认的缺口，审查确认代码层面确实完全空白。

3. **配置防篡改校验缺失**（中高）
   设计文档 §8 承诺"每轮门禁前校验配置文件 hash 未被本轮 diff 修改"，但全仓库 `grep -rn "hash" src/` 无一处相关实现。`ralph_loop` 每轮把整个工作区交给 agent 编辑，理论上 agent 可以顺手改宽 `.aiflow/config/` 里的门禁标准（如清空 `fail_on`），而门禁本身检测不到。

4. **密钥/敏感信息脱敏缺失**（中）
   README 和设计文档都声明"日志/报告输出前经统一脱敏函数"，但代码里没有任何 redact/mask 实现。API Key 本身确实只经环境变量、不落盘，但 `events.jsonl`、`run-report.md`、OpenCode transcript 都是明文落盘，一旦这些产物被打包分享，`base_url`、模型名、内部路径、diff 内容都会明文暴露。文档承诺与实现不一致，需要要么补上脱敏函数，要么更新文档不要做虚假承诺。

5. **`auto_clean` 历史脆弱**（低，已缓解）
   近期 4 次连续修复提交（hash 排除 `.aiflow`、必须从 HEAD 而非 index 恢复、suspended 状态需要重新持久化、脏工作区拒绝启动）说明这块曾经很脆弱。现状已修复且有测试，但"agent 同时改动了 `.aiflow/config/`"这类边界情况的测试覆盖需要确认（与第 3 点配置防篡改相关联）。

6. **Agent 子进程失败与代码质量失败不加区分**（低）
   `runAgentTask` 非零退出直接判定 story fail、消耗 `fix_count`。OpenCode 子进程偶发崩溃（网络抖动/自身 bug）与"代码确实写错了"在门禁里被一视同仁，可能过早把一个本可正常完成的 story 挂起（suspended）。设计文档本身认可当前行为，但对"无人值守稳定性"而言值得加一层区分：基础设施类失败不消耗 `fix_count`。

---

## 2. 商业化（Commercialization readiness）

1. **单机单用户模型，无鉴权/多租户/审计**（阻断级）
   目前是纯本地 CLI，状态全部落在文件系统，没有用户/组织概念、没有 License 或订阅校验、团队多人在同一项目上并发跑 run 会直接冲突（见"稳定性 1"）。如果目标是 SaaS 或团队协作工具，这是最大的差距，需要专门立项设计。

2. **预算熔断没有落地**（高，见"稳定性 2"）
   没有它就无法兑现"预算保护"这一 To B 场景的关键信任承诺——客户最担心的就是"AI 无人值守失控烧钱"。

3. **计费与真实成本脱节**（高，见"稳定性 2"）
   HTTP 通道 `costUsd` 恒 0，导致任何"按 token 计费"或"展示真实花费"给客户看的功能目前都不可信。

4. **`human_gate` 自动确认未实现**（高，商业化关键卖点缺口）
   `src/runners/human-gate.ts` 只支持"一直等"或"超时后固定 approve/abort"两种模式。UI 设计稿明确设想了"由 LLM 依据常规商业化判断自动放行"的第三种模式——这恰恰是"无人值守又不想彻底跳过人工把关"的核心卖点，目前完全空白，值得优先立项。

5. **`doctor` 体检覆盖不全**（中）
   `src/commands/doctor.ts` 只体检名为 `reviewer` 的 profile 连通性，`main-dev`（走 opencode 通道）等其它 profile 完全没有体检。客户环境没配好时只能等真正跑 pipeline 才发现，专业度不够。

6. **无归集的用量/账单视图**（中）
   `events.jsonl` 里有逐次调用的 cost，但没有归集到"按项目/按月"的账单视图；UI 设计稿的 Reports 页（各阶段成本分布）目前没有对应的数据管道可以支撑（前提是先修好第 3 点的 cost 恒 0 问题）。

---

## 3. 交互人性化（Humanized interaction）

1. **GUI 完全未落地**（最大落差）
   目前只有 CLI + 一次性 `status` / 轮询式 `watch` 终端渲染。UI 设计稿设想了完整的 Web Dashboard：Runs 列表/详情（含"agent 正在编辑哪个文件"的实时提示）、Fix List 时间线、Pipeline 可视化配置、模型档案管理、Reports——这些在当前代码里完全不存在。如果"人性化交互"是主要目标，GUI 落地会是下一阶段的重头戏，且需要先决定架构（见"可扩展性 3"）。

2. **`human_gate` 交互粗糙**（中）
   目前只有 `aiflow approve`/`aiflow reject` 两个裸命令，"为什么暂停、需要确认什么"这个 prompt 文本只写进了 `events.jsonl`，用户要靠 CLI monitor 自己去翻，对非技术用户不友好。

3. **错误提示未分级**（中）
   `cli.ts` 多处直接把 `err.message` 透传给 `console.error`，没有区分"配置错误/网络错误/内部 bug"，也没有像 `aiflow doctor` 那样给出可操作的下一步建议。

4. **无主动通知机制**（中）
   `ralph_loop` 可能持续几十分钟到几小时，用户只能人肉盯着 `watch`，没有完成/失败/等待人工确认时的通知渠道（邮件/webhook/系统通知）。值得先在事件层预留订阅接口，为后续通知功能打基础。

---

## 4. 可扩展性（Extensibility）

**做得好的地方**：`StageRunner` 通过注册表挂载（`engine.ts` 的 `EngineDeps.runners`），新增 stage 类型只需要注册一个 runner + 扩展 discriminated union schema，这个设计已经验证支撑了 5 种 stage 类型，是全仓库最值得保留的架构决策。Adapter 层也把 OpenCode 细节隔离得很干净。

**差距**：

1. **Adapter 层没有做成插件化注册表**（中）
   `AgentTask`/`opencode.ts` 的 `buildArgs` 是唯一的 agent 通道实现。未来如果要接入除 OpenCode 之外的 agent runtime，需要同时改接口和实现，没有复用 `engine.runners` 那种"注册表挂载"的设计，是架构上的不一致。

2. **Stage schema 是封闭的 discriminated union**（中）
   `StageConfigSchema`（`src/config/schema.ts`）只认 5 种硬编码 `type`，第三方/客户想扩展自定义 stage 类型没有官方机制，只能 fork 改 schema。如果要做插件生态，需要重新设计为"开放式注册 schema"。

3. **GUI 缺少服务层**（高，直接卡住"人性化"落地）
   设计文档 §10 说"GUI 只需读取 `events.jsonl`/`state.json`"，但没有说明谁来把这些文件 serve 给远程/浏览器场景。如果 GUI 走本地 Electron/Tauri 直接读文件还行得通；但凡想做成 Web/SaaS，就必须先补一层"读文件 + 暴露 REST/WS 接口"的后端服务，这块当前架构完全没有覆盖，是 GUI 落地前必须先做的架构决策点。

---

## 优先级建议

**P0（阻断商业化 / 有隐患，建议优先解决）**
- 并发运行加锁（稳定性 1）
- 预算熔断 + 真实成本统计打通（稳定性 2 / 商业化 2、3）
- 密钥与敏感信息脱敏（稳定性 4）

**P1（体验与信任，紧随 P0）**
- `doctor` 全 profile 体检（商业化 5）
- `human_gate` LLM 自动确认（商业化 4 / 人性化，UI 设计稿已经画出交互）
- 配置防篡改校验（稳定性 3）

**P2（下一阶段大项，需要单独立项）**
- GUI Dashboard 落地 + 后端服务层设计（人性化 1 / 可扩展性 3）
- Adapter / Stage 类型插件化扩展机制（可扩展性 1、2）

**P3（锦上添花）**
- 通知渠道（webhook/邮件）（人性化 4）
- 错误分级与可操作提示（人性化 3）
- agent 子进程失败与代码质量失败的 `fix_count` 区分（稳定性 6）

---

## 下一步

这是一份审查报告，不包含任何代码改动。建议从 P0/P1 中挑 1-2 项（个人推荐：**预算熔断+真实成本统计** 和 **`human_gate` LLM 自动确认**，两者都直接对应"可商业化"和 UI 设计稿里已经画出来的交互，且相对独立、范围可控），走 brainstorming → spec → plan 流程正式开工。
