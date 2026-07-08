# resume/approve 一致性加固 — 设计

**日期**:2026-07-08
**状态**:已批准设计，待写实现计划

## 背景

上一轮"Run 安全加固"(已合并至 `main`，head `180d48d`)引入了三项安全机制：并发锁、预算熔断、`.aiflow/config` 防篡改。最终整分支评审的子代理在跨文件追踪时发现三个**跨路径遗留漏洞** —— 安全机制在主入口(`aiflow run`)正确生效，但在恢复入口(`resume`/`approve`)或早返回分支上被绕过。本设计把这三个漏洞一次性补齐。

三个漏洞彼此独立，都属于"同一机制在部分代码路径上未覆盖"，体量都小，适合放在同一个实现计划里分任务完成。

## 目标

1. **脏树守卫共享化**:`resume`/`approve` 在 `auto_clean` 管道下遇到脏工作区时，与 `aiflow run` 行为一致 —— 报错拒绝，避免 `checkoutClean` 误删用户未提交/未跟踪的工作。
2. **lock.release() 归属校验**:`release()` 只删除仍属于本持有者的锁文件，防止缓慢退出的原持有者误删已被回收的新锁。
3. **失败/篡改路径 budget 记账**:`ralph_loop` 中 agent 调用失败或篡改配置的早返回路径，也把已产生的成本计入 budget tracker（记账但不提前熔断）。

## 非目标

- 不改并发锁的获取语义（poll/stale 回收/abort 都保持不变）。
- 不改预算熔断的触发时机或阈值语义。
- 不新增 CLI 标志（脏树守卫遇脏即拒绝，不提供 `--allow-dirty` 绕过开关）。
- 不重构 resume/approve 的其它逻辑，只插入守卫调用。

## 组件设计

### 组件 1:共享脏树守卫 `src/commands/dirty-guard.ts`

**现状**:`src/commands/run.ts` 内联了这段逻辑（约 64-69 行）：

```ts
const hasAutoClean = pipelineConfig.stages.some((s) => s.type === "ralph_loop" && s.auto_clean);
if (hasAutoClean && !(await isClean(cwd))) {
  throw new Error(
    `Pipeline "${pipelineName}" has auto_clean enabled on a ralph_loop stage, but the working tree at ${cwd} is not clean. Commit or stash your changes before running (auto_clean cannot distinguish your uncommitted work from a failed agent attempt).`
  );
}
```

**新模块**导出：

```ts
export async function assertCleanIfAutoClean(
  cwd: string,
  pipeline: PipelineConfig,
  pipelineName: string,
  isCleanFn: (cwd: string) => Promise<boolean> = isClean
): Promise<void>;
```

行为：若 `pipeline.stages` 任一为 `ralph_loop` 且 `auto_clean === true`，调用 `isCleanFn(cwd)`；返回 `false` 则 throw 上述**同一条错误信息**（文案原样搬迁，保证三处一致）。否则静默返回。

- `isCleanFn` 依赖注入，默认 `isClean`（来自 `src/git.ts`），便于测试脏/干净两态而不依赖真实 git 状态。
- `pipelineName` 参数仅用于错误信息插值。

**接入点**：

- `run.ts`:删除内联守卫，改调 `await assertCleanIfAutoClean(cwd, pipelineConfig, pipelineName)`，位置不变（仍在 `mkdirSync(runDir)` 等副作用之前）。行为完全等价。
- `resume.ts`:在 `loadPipelineConfig(...)` 之后、`runPipelineOnce(...)` 之前调用。注意 `resume` 会因 `--raise-budget` 先写 `state.json`（当前在加载 config 之前）；守卫应放在**所有盘上写入之前**，即把守卫（连同它依赖的 `pipelineConfig` 加载）提到 `raiseBudget` 的 `writeFileSync` 之前。实现计划需明确这个重排。
- `approve.ts`:在把目标 stage 置为 `done` 并 `writeStateAtomic(runDir, state)` **之前**调用。当前 approve 先改 state 再加载 config；守卫需要 `pipelineConfig`，因此实现计划要把 `loadModelsConfig`/`loadPipelineConfig` 提到 `writeStateAtomic` 之前，先加载 config → 跑守卫 → 再落 approval 状态。

**错误信息一致性**:三处 throw 的文本完全相同（就是上面那条），只是 `pipelineName` 与 `cwd` 按实际值插值。

### 组件 2:lock.release() 归属校验 `src/lock.ts`

**现状**（75-81 行）：

```ts
return {
  release: () => {
    try {
      unlinkSync(path);
    } catch { /* already gone — fine */ }
  },
};
```

无条件删除。竞态：原持有者 A 缓慢退出期间，其锁被判 stale 并被 B 回收（B 写入自己的 `LockInfo`），A 的 `release()` 会删掉 B 的活动锁。

**改法**:release 前读锁校验归属。release 闭包捕获本次写入的 `info`（`{ pid, run_id, started_at }`）：

```ts
release: () => {
  let current: LockInfo;
  try {
    current = readLockFn(path);
  } catch {
    return; // 文件已不存在或损坏 — 不是我们的锁了，静默返回
  }
  if (
    current.pid !== info.pid ||
    current.run_id !== info.run_id ||
    current.started_at !== info.started_at
  ) {
    return; // 已被他人回收，不删
  }
  try {
    unlinkSync(path);
  } catch { /* 最后的竞态兜底 */ }
},
```

**为何用 pid + run_id + started_at 三元组**:CLI 的 resume/approve 传占位 run_id（`pending-resume`/`pending-approve`），单靠 run_id 在同进程重复运行时可能撞；加 `pid` 区分进程，加 `started_at`（ISO 8601，含毫秒）区分同进程先后两次获锁。三元组唯一性足够，且**不改 `LockInfo` 结构**，现有测试与盘上格式不受影响。

- release 复用已注入的 `readLockFn`（`AcquireLockOptions.readLockFn`），测试可注入伪造的"锁已被替换"内容。
- 幂等性保持：二次 release、或锁已被别人删除的情况，都走"读失败/不匹配 → 静默返回"，不抛错。

### 组件 3:失败/篡改路径 budget 记账 `src/runners/ralph-loop.ts`

**现状**:agent 调用后有三条早返回路径，只有"成功且未超预算"主路径经过 `budget.record()`：

- **篡改分支**（约 118-140 行）：`agentResult.ok && deps.hashConfigDir(cwd) !== configHashBefore` → 恢复 config、记 story 失败、返回 `fail`/`suspended`。**未记账**。
- **agent 失败分支**（约 142-148 行）：`!agentResult.ok` → 记 story 失败、返回 `fail`。**未记账**。

成本已真实产生（token 已消耗），但未计入累计，导致 `state.cost.est_usd` 少算、下一轮 budget 基线偏低。

**改法**（"记账但不提前熔断"）:在这两条路径各自 `return` 之前插入一次

```ts
budget.record(agentResult.usage.costUsd); // 记账；忽略返回值，本轮不因此熔断
```

- **忽略 `record` 的返回值**：不把返回改成 `paused`。篡改分支仍返回 `fail`/`suspended`，失败分支仍返回 `fail`。
- 位置：放在各自路径现有的 `writePrd`/`appendEvent`/`appendFileSync` 之后、`return` 之前，纯粹把成本灌进 tracker。
- **主路径不动**:主路径当前的 `budget.record(agentResult.usage.costUsd)` 位于篡改检查之后（上一轮评审已修正的顺序），保持原样，避免重复计。篡改分支在主路径 record 之前就返回，所以两者不会对同一次调用重复记账。

**熔断时机**:成本记入后，下一轮迭代**开始时**主路径的 `budget.record()` 会自然拦住。熔断只推迟一轮，不丢失。这是刻意取舍：篡改/失败路径的语义是"本轮因篡改/失败结束"，与熔断语义（paused/budget_exceeded）冲突，故记账而不熔断，保持篡改事件记录清晰。

## 数据流

三个改动都不新增数据结构、不改盘上格式（`state.json`、`run.lock`、`events.jsonl` 结构不变）。

- 脏树守卫：读 `pipelineConfig`（内存）+ git 工作区状态 → throw 或放行。无写入。
- release 校验：读 `run.lock` → 匹配则 unlink。仅删除，不写。
- budget 记账：把已产生成本累加进内存 tracker，最终由既有逻辑写入 `state.cost`。

## 错误处理

- 脏树守卫 throw 的错误，在 CLI 层由 `run`/`resume`/`approve` 各自的 `catch`（已存在）捕获并打印、`process.exitCode = 1`。resume/approve 的守卫在**任何盘上写入之前**触发，保证拒绝时不留半改状态。
- release 校验遇到读失败/不匹配一律静默返回（非错误场景 —— 锁本就不该由我们删）。
- budget 记账不产生新错误路径。

## 测试策略

全部走单元测试 + 依赖注入，避免真实 git/进程竞态：

1. **dirty-guard**（新 `test/unit/dirty-guard.test.ts`）：
   - auto_clean 管道 + `isCleanFn → false` ⇒ throw，错误信息含 pipeline 名与 cwd。
   - auto_clean 管道 + `isCleanFn → true` ⇒ 不 throw。
   - 无 auto_clean 管道 + `isCleanFn → false` ⇒ 不 throw（且不调用 isCleanFn 或调用后不拦，二选一，实现计划定）。
   - 回归：`run.ts` 抽取后现有 run 的 auto_clean 拒绝测试仍通过。
   - `resume.ts`/`approve.ts`:注入脏态，断言在状态写入前 reject，且 `state.json`/approval 未被改动。
2. **lock.release 归属**（扩 `test/unit/lock.test.ts`）：
   - 注入 `readLockFn` 返回"他人的 info"（pid/run_id/started_at 任一不同）⇒ release() 不删文件。
   - 正常归属 ⇒ release() 正常删。
   - 读失败（readLockFn 抛错）⇒ release() 静默返回，不抛。
3. **budget 记账**（扩 `test/unit/ralph-loop.test.ts`）：
   - 失败 agent（`ok:false`, costUsd>0）+ 可观测 tracker ⇒ `record` 被调、累计含该成本、返回值仍 `fail`。
   - 篡改 agent（hash 变、costUsd>0）⇒ `record` 被调、累计含该成本、返回值仍 `fail`/`suspended`，且 `checkoutConfigOnly` 仍被调用。
4. 全量 `bun test ./test` 每个任务后保持绿。

## 全局约束

- 不新增 npm 依赖。
- 不改 `LockInfo` 结构、`state.json`/`run.lock`/`events.jsonl` 盘上格式。
- 保持既有依赖注入约定（`deps`/注入函数作为可选末位参数，默认真实实现）。
- 三处脏树守卫错误信息文本完全一致。
- 每个任务后 `bun test ./test` 必须绿。
