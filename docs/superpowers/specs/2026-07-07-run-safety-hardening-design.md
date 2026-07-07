# Run 安全加固 — 设计文档

日期：2026-07-07
状态：已批准，待写实现计划
关联审查：`docs/reviews/2026-07-07-project-optimization-review.md`（P0 项 1-3：并发锁 / 预算熔断+真实成本统计 / 配置防篡改）

## 1. 背景与目标

三个此前审查发现的 P0 稳定性缺口都围绕"一次 run 的生命周期"展开，且相互依赖（例如预算熔断依赖真实成本统计；并发锁保护的正是同一批会写 git 工作区的命令），因此合并为一个 spec：

1. **并发运行无锁保护**：同一项目下两次 `aiflow run`/`resume`/`approve`/`reject` 并发执行会在同一 git 工作区里互相踩踏。
2. **预算熔断未实现 + HTTP 通道成本恒为 0**：无法兑现"预算超限自动暂停"的承诺，且 `state.json` 里的成本统计本身不可信。
3. **配置防篡改校验缺失**：`ralph_loop` 的 agent 理论上可以在编辑代码的同时改宽 `.aiflow/config/` 里的门禁标准，而门禁本身检测不到。

## 2. 并发锁

### 数据结构

`.aiflow/run.lock`（项目级单锁，与具体 run-id 无关——一个项目同时只允许一个活跃 run）：

```json
{ "pid": 12345, "run_id": "2026-07-07_1200_ab12", "started_at": "2026-07-07T12:00:00.000Z" }
```

### 行为

- 受影响命令：`run`、`resume`、`approve`、`reject`（会修改 state.json / git 工作区的命令）。不受影响：`status`、`watch`、`doctor`、`init`（只读或与 run 生命周期无关）。
- 获取锁时序：
  1. 若 `.aiflow/run.lock` 不存在 → 原子创建（`O_EXCL` 方式写入，避免竞态）并继续执行。
  2. 若存在 → 读出 `pid`，用 `process.kill(pid, 0)` 判活：
     - 进程已不存在（崩溃/断电等留下的残留锁）→ 打印一行提示（"检测到残留锁（pid 已不存在），自动回收"）后覆盖锁并继续，无需 `--force`。
     - 进程仍存活 → 阻塞轮询等待（每 1s 重试一次 `O_EXCL` 创建），期间打印一次"等待中：run <run_id> 正在进行（pid <pid>），排队等待…"；用户可 Ctrl+C 取消等待（此时直接退出，不写任何 state）。
- 释放：命令执行结束（正常结束 / 抛异常 / SIGINT 优雅退出）统一在最外层 `finally` 里删除锁文件，保证锁不会因为异常路径而永久残留。

### 边界情况

- 轮询等待期间，被等待的 run 本身可能因为其它原因（预算熔断、SIGINT）转入 paused 状态并退出——此时锁会被释放，等待中的命令自然拿到锁继续。
- 两个不同项目目录（不同 `cwd`）互不影响，锁只在各自的 `.aiflow/` 下。

## 3. 预算熔断 + 真实成本统计

### 3.1 HTTP 通道真实成本

`ModelProfileSchema`（`src/config/schema.ts`）新增两个可选字段：

```yaml
reviewer:
  channel: http
  ...
  input_cost_per_1m: 0.6   # 美元 / 每百万 input token
  output_cost_per_1m: 2.4  # 美元 / 每百万 output token
```

`src/llm/client.ts` 的 `callLlm` 用 `usage.prompt_tokens` / `usage.completion_tokens` 乘以对应单价算出 `costUsd`，替换现在写死的 `costUsd: 0`。未配置单价的 profile 保持 `costUsd: 0`（不报错，因为这是可选信息），但 `aiflow doctor` 对这类 profile 额外提示一行"未配置单价，该模型的花费不计入预算/账单"。

### 3.2 Budget 配置与状态

`PipelineConfigSchema` 顶层新增可选字段：

```yaml
budget:
  max_cost_usd: 20
```

`EngineState`（`src/engine/state.ts`）新增：

```ts
budget?: { limit_usd: number };
```

`runPipelineOnce` 在非 resume 的首次运行时，若 `pipeline.budget` 存在，把 `limit_usd` 写入初始 state；resume 时沿用 state 里已有的值（除非 `--raise-budget` 覆盖，见 3.4）。

### 3.3 检查粒度与熔断行为

检查发生在**每一次**计入成本的调用之后（而不是每个 stage 结束后）：

- `ralph_loop`：每轮迭代里，agent 调用（`runAgentTask`）和 reviewer 调用（`runReviewGate` 内部）各自完成后都检查。
- `brainstorm`：fan-out 阶段每个模型的调用完成后检查；synthesizer 调用完成后也检查。
- `spec` / `plan`：各自的单次调用完成后检查。

检查逻辑：`累计花费（state.cost.est_usd + 本次调用 costUsd） >= budget.limit_usd` → 立即停止，不再发起任何后续调用（哪怕当前 stage/iteration 还没跑完）。具体表现为该 runner 提前返回一个新的 outcome：

```ts
{ result: "paused", reason: "budget_exceeded" }
```

`StageStopReason`（`src/engine/state.ts`）新增 `"budget_exceeded"`。engine 收到这个 outcome 后，把该 stage 标记为 `paused` 并停止整个 pipeline（复用现有"非 done 即 break"的循环逻辑，无需改 `runPipelineOnce` 的主循环）。

### 3.4 恢复：`aiflow resume --raise-budget <n>`

`aiflow resume` 新增 `--raise-budget <n>` 选项：读取 state 后，若提供了该选项，用 `n` 覆盖 `state.budget.limit_usd`（原地提升，不清零已花费的 `cost.est_usd`），再走正常的 resume 流程。不提供该选项、且当前 run 是因为 `budget_exceeded` 暂停的，`resume` 正常执行仍会在下一次调用后立刻再次触发熔断（因为已经超限）——这是预期行为，提示用户必须显式提升预算才能继续。

## 4. 配置防篡改校验（仅 `ralph_loop`）

范围只覆盖 `ralph_loop`（唯一有反复迭代改代码机会的阶段；`spec` 阶段虽也走 agent 通道但没有门禁循环，改了也不影响自身是否通过）。

### 流程（嵌入 `runRalphLoopOnce`）

1. agent 调用前：对 `.aiflow/config/` 目录下所有文件按路径排序后拼接内容，算 sha256，记为 `preHash`。
2. agent 调用后、跑门禁前：用同样方法算 `postHash`。
3. `postHash !== preHash`：
   - 立即执行 `git checkout HEAD -- .aiflow/config/`，把配置目录恢复到本轮开始前的状态（与 `auto_clean` 开关无关，始终执行，防止被削弱的门禁标准影响判定）。
   - 不再调用门禁（`runReviewGate`），直接按门禁失败处理：走 `recordStoryFailure`，计入 `fix_count`；`fix_list.md` 追加明确说明："检测到 `.aiflow/config/` 在本轮被修改，已自动恢复并记为门禁失败。"
   - `events.jsonl` 追加一条 `gate_result`，`checks: "fail"`，并带 `reason: "config_tampered"` 字段，便于事后审计区分于普通门禁失败。
4. hash 相同：走原有的门禁流程不变。

## 5. 错误处理

| 场景 | 行为 |
| --- | --- |
| 锁文件存在但 pid 判活时进程恰好瞬间退出 | 视为已死亡，正常回收（判活失败即回收，不追加额外重试） |
| budget 检查触发时正处于 `stageAll`/`commit` 等 git 操作中途 | 检查点只设在"调用返回后、写入 PRD/git 之前"，不会在 git 操作执行到一半时中断 |
| 用户配置了 `input_cost_per_1m` 但 API 未返回 `usage` 字段 | 该次调用记为 0 成本，不报错（保持现有"最佳努力"统计风格） |
| `.aiflow/config/` 在 `git checkout HEAD --` 时因为本身就没有任何提交历史而失败 | 不会发生：`aiflow init` 生成的配置文件在项目初始化时就已随首次提交入库，属前置假设 |

## 6. 测试策略

- **单元测试**：
  - 锁模块：获取/释放、僵尸锁自动回收、并发获取时的轮询与超时取消。
  - 成本换算：`input_cost_per_1m`/`output_cost_per_1m` 缺省与存在两种情况下 `callLlm` 的 `costUsd` 计算。
  - 预算熔断：模拟累计成本跨过 `limit_usd` 时，runner 返回 `paused`/`budget_exceeded`，且不再发起下一次调用。
  - `--raise-budget`：resume 时正确覆盖 `state.budget.limit_usd` 并保留已有 `cost.est_usd`。
  - 配置防篡改：hash 前后不一致时触发门禁失败 + 自动 `git checkout HEAD -- .aiflow/config/`；hash 一致时门禁正常执行。
- **集成测试**：在 `test/integration/multi-stage-mocked.test.ts` 追加一条场景，验证并发锁、预算熔断、配置防篡改三者协同工作互不干扰（例如熔断发生时锁被正常释放，排队等待的另一次调用能正常获取）。

## 7. 范围之外（本次不做）

- 队列服务化（这次选择的是 CLI 前台阻塞轮询，不引入后台守护进程）。
- 价格 API 自动拉取（本次选择手写单价）。
- `spec`/`brainstorm`/`plan` 阶段的配置防篡改校验（范围明确限定在 `ralph_loop`）。
