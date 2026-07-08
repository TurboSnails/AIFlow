# 运维命令 aiflow runs + aiflow clean — 设计

**日期**:2026-07-08
**状态**:已批准设计,待写实现计划

## 背景

AIFlow 每次 `run` 都在 `.aiflow/runs/<run_id>/` 落一份 state.json + events.jsonl,且从不清理。跑得越久,`.aiflow/runs` 无限增长:磁盘占用上涨,`status`/`cost` 的 `--all` 遍历变慢,用户也没有一个入口纵览历史 run。同时 monitor.ts 与 cost.ts 各自实现了一份"列举所有 run 目录、mtime 倒序、读回 state"的逻辑,已经重复。

本轮新增两个运维命令:`aiflow runs`(只读纵览历史 run)与 `aiflow clean`(按条件清理终态 run 目录),并借机把重复的 run 读取逻辑抽成一个共享模块,三处复用。

## 目标

1. **`aiflow runs`**:列出全部历史 run —— run_id、pipeline、整体状态、成本、时间,并标记活跃 run。默认人读表格,`--json`/`--csv`/`--no-color`(与 `cost` 命令一致)。
2. **`aiflow clean`**:按条件删除终态 run 目录,解决无限增长。默认不带条件什么都不删;只删终态 run;活跃 run 永不删;`--dry-run` 预览;实删默认需确认。
3. **共享读取层**:抽出 `src/runs/store.ts`(列举 + 读回 state + 活跃判定 + 状态摘要),`runs`/`clean` 使用,并把 cost.ts、monitor.ts 的重复逻辑改为复用。

## 非目标

- 不改 run/state/events 盘上格式。两命令只读 state.json / run.lock;`clean` 只删整个 run 目录,不改文件内容。
- 不引入成本趋势/时间序列(YAGNI;归 cost 命令未来的方向)。
- 不获取运行锁:`runs` 纯只读;`clean` 读 run.lock 判活跃但不 acquire。
- `clean` 不做"释放空间字节数"统计(YAGNI;先只报删除数量)。
- 不改 cost / monitor 的输出行为(复用以"行为不变 + 现有测试全绿"为准绳)。

## 组件设计

### 组件 1:共享读取层(`src/runs/store.ts`)

纯 I/O + 纯判定,无渲染、无锁获取。

```ts
import type { EngineState } from "../engine/state";

export interface LoadedRun {
  runId: string;
  state: EngineState;
  mtimeMs: number;
}

/** 列出 .aiflow/runs 下所有 run 目录,mtime 倒序;每目录只 stat 一次;根不存在返回 []。 */
export function listRunIdsByMtimeDesc(cwd: string): string[];

/** 读回 state.json;缺失/损坏(JSON.parse 抛)→ undefined,不抛。带回目录 mtime。 */
export function loadRun(cwd: string, runId: string): LoadedRun | undefined;

/** 双重保护:state 有任何非终态 stage,或 .aiflow/run.lock 的 run_id 指向该 run。 */
export function isRunActive(cwd: string, runId: string, state: EngineState): boolean;

/** 紧凑整体状态 token:failed | aborted | paused | waiting_human | running | pending | done。 */
export function summarizeRunStatus(state: EngineState): string;
```

- **`listRunIdsByMtimeDesc`**:`readdirSync` 后对每个条目 `statSync` 一次映射为 `{id, mtimeMs}`,过滤出目录,按 `mtimeMs` 降序,返回 id 数组。根不存在 → `[]`(先 `existsSync` 判)。
- **`loadRun`**:`join(runsRoot, runId, "state.json")`,不存在 → undefined;`readFileSync`+`JSON.parse` 包 try/catch,失败(损坏)→ undefined。mtime 取自 run 目录 `statSync().mtimeMs`。
- **`isRunActive`**:
  - state 侧:`state.stages.some(s => !TERMINAL_STATUSES.has(s.status))`(复用 engine 的 `TERMINAL_STATUSES`)。
  - 锁侧:读 `.aiflow/run.lock`(store 内部自建小 helper:`existsSync` → `readFileSync`+`JSON.parse` 包 try/catch,失败视作无锁),比对其 `run_id === runId`。lock.ts 的 `lockPath`/`defaultReadLock` 是模块私有,不复用,避免耦合并发逻辑。
  - 任一为真即活跃。
- **`summarizeRunStatus`**:取第一个非终态 stage 的 status;若全终态,则存在 `failed` → `"failed"`,存在 `aborted` → `"aborted"`,否则 `"done"`。给列表用紧凑词;不复用 `summarizePipelineOutcome`(那返回整句 `{line, exitCode}`,是给 run/resume 结束语用的)。

### 组件 2:`aiflow runs`(`src/commands/runs.ts`)

```ts
export interface RunRow {
  runId: string;
  pipeline: string;
  status: string;   // summarizeRunStatus(state)
  estUsd: number;   // state.cost.est_usd
  mtimeMs: number;
  active: boolean;  // isRunActive
}

/** 纯聚合:列举 + 读回 + 组装行(可单测)。损坏 state 的 run 跳过。 */
export function buildRunRows(cwd: string): RunRow[];

export function runRuns(cwd: string, opts: {
  json?: boolean; csv?: boolean; color?: boolean;
  write?: (s: string) => void; writeErr?: (s: string) => void;
}): number;
```

- 渲染纯函数 `renderRunsTable/renderRunsJson/renderRunsCsv`,沿用 cost.ts 的表格风格与 RFC 4180 CSV 转义。
- 表格列:`Run | Pipeline | Status | Cost | Age`。`Cost` = `$est.toFixed(4)`;`Age` = mtime 相对现在(复用/仿 monitor 的相对时间风格,或简单 `<Nd>/<Nh>/<Nm>` 前缀)。活跃行尾标 ` *`,末尾脚注 `* active (running or lock-held)`。
- `--json`:序列化 `RunRow[]`(mtimeMs 保留数值)。`--csv`:表头 `run_id,pipeline,status,est_usd,mtime_ms,active`,字段转义。
- 无 run:`No runs found in <root>`,退出码 1。成功退出 0。只读,不获取锁。
- `--json`/`--csv` 互斥 → 报错退出 1(与 cost 一致)。

### 组件 3:`aiflow clean`(`src/commands/clean.ts`)

```ts
export interface CleanOptions {
  before?: string;   // "7d" 相对天数,或 ISO 日期;删 mtime 早于此的
  status?: string;   // done | failed | aborted(仅终态集合)
  keep?: number;     // 在候选中保留最新 N 个
  dryRun?: boolean;
  yes?: boolean;     // 跳过交互确认
  color?: boolean;
  write?: (s: string) => void;
  writeErr?: (s: string) => void;
  confirm?: () => boolean;   // 注入式确认(测试用;默认读 stdin TTY)
}

/** 纯选择逻辑(可单测):从行集筛出可删/保留。 */
export function selectRunsToClean(
  rows: RunRow[],
  opts: { before?: Date; status?: string; keep?: number },
): { toDelete: RunRow[]; kept: RunRow[] };

export function runClean(cwd: string, opts: CleanOptions): number;
```

**`selectRunsToClean` 纯逻辑**:
1. 起点 = 全部 `rows`。
2. **硬排除活跃**:`active === true` 的行永不进候选(优先于一切条件)。
3. **硬排除非终态**:`status` 非 done/failed/aborted 的行永不进候选(paused/waiting_human/running/pending 天然排除;与活跃排除多数重叠,但显式保留双保险)。
4. 应用条件(对剩余候选取交集):
   - `--status s`:只保留 `status === s` 的候选。
   - `--before date`:只保留 `mtimeMs < date.getTime()` 的候选。
   - `--keep N`:候选按 mtime 降序排序后,前 N 个移入 `kept`,其余留在 `toDelete`。
5. 返回 `{ toDelete, kept }`。

**`runClean` 命令入口**:
- 解析并校验:`--status` 非终态值 → 报错退出 1;`--before` 无法解析(既非 `Nd` 也非合法 ISO)→ 报错退出 1;`--keep` 非非负整数 → 报错退出 1。
- **无任何条件(before/status/keep 全空)→ 报错退出 1**:`clean requires at least one of --before, --status, --keep`,什么都不删。
- 读 `buildRunRows(cwd)`(损坏 state 的 run 不在 rows 中,天然不删);调 `selectRunsToClean`。
- 无可删:打印 `Nothing to clean` 退出 0。
- 打印将删清单(run_id + status + age)。
- `--dry-run`:打印 `Would delete N run(s)`,不删,退出 0。
- 实删:除非 `--yes`,否则确认(`opts.confirm ?? (读 stdin TTY)`);非 TTY 且无 `--yes` 且无 `confirm` 注入 → 拒绝并提示 `refusing to delete without --yes (non-interactive)`,退出 1。确认为否 → `Aborted` 退出 0。
- 确认通过:逐个 `rmSync(join(runsRoot, runId), { recursive: true, force: true })`,打印 `Deleted N run(s)`,退出 0。

### 组件 4:CLI 接线(`src/cli.ts`)

紧随 `cost`/`watch` 注册:

```
aiflow runs  [--json] [--csv] [--no-color]
aiflow clean [--before <7d|ISO>] [--status <done|failed|aborted>] [--keep <N>] [--dry-run] [--yes] [--no-color]
```

action 里 `await import("./commands/runs")` / `"./commands/clean")`,`process.exitCode = runRuns(...)` / `runClean(...)`。两者均只读注册(不 acquire 运行锁)。

### 组件 5:cost.ts / monitor.ts 复用改造

- **cost.ts**:删除自有 `runsRoot`/`listRunIdsByMtimeDesc`/`loadRun`/`LoadedRun`,改 import `src/runs/store.ts`。cost 需要 events 的地方(单 run 与 `--all` 聚合)在 cost.ts 内保留一个薄 `loadRunEvents(cwd, runId): AiflowEvent[]`(events 读取不进通用 store —— runs/clean 不需要 events,YAGNI)。store 的 `loadRun` 只带 state+mtime;cost 组装时按 runId 单独取 events。现有 cost 测试须全绿。
- **monitor.ts**:`pickLatestRun(cwd)` 改为 `listRunIdsByMtimeDesc(cwd)[0]`(复用 store);`readRunSnapshot` 仍留在 monitor(读 state+events 组装 snapshot 是 monitor 专属)。仅替换列举那一处,monitor 行为不变。
- 准绳:行为不变 + cost/monitor 现有测试全绿;不趁机改这两个命令的输出。

## 数据流

```
.aiflow/runs/<id>/state.json  +  .aiflow/run.lock
        │
        ▼
  store: listRunIdsByMtimeDesc / loadRun / isRunActive / summarizeRunStatus
        │
   ┌────┴─────────────────────────┐
   ▼                              ▼
 runs: buildRunRows            clean: buildRunRows → selectRunsToClean
   │                              │ (硬排除活跃/非终态 → 应用 before/status/keep)
   ▼                              ▼
 renderTable/Json/Csv          dry-run 预览 / 确认 / rmSync
   │                              │
 stdout                        stdout + 删除终态 run 目录

 (cost.ts / monitor.ts 复用 store 的列举与 loadRun)
```

## 错误处理

- `.aiflow/runs` 不存在或空:`runs` → `No runs found in <root>` 退出 1;`clean` → 同样"无可操作对象"退出 1。
- `runs`:`--json` 与 `--csv` 同给 → 报错退出 1。
- `clean`:`--status` 非法值 → 退出 1;`--before` 不可解析 → 退出 1;`--keep` 非非负整数 → 退出 1;无任何条件 → 退出 1(不删)。
- 单 run 的 state.json 损坏:`loadRun` 返回 undefined → 在 `runs` 列表中跳过该 run;在 `clean` 中天然不入 rows(无法判活跃就不删),保守不删。
- 非 TTY 且无 `--yes`(且无注入 confirm)执行实删:拒绝并提示加 `--yes`,退出 1。
- `--dry-run`:恒退出 0(即使有可删项)。

## 测试策略

全 bun:test,纯函数(store 判定、selectRunsToClean、渲染)优先:

1. **store**(`test/unit/runs-store.test.ts`):真建临时 `.aiflow/runs` 多目录 —— `listRunIdsByMtimeDesc` mtime 倒序、根不存在返回 `[]`;`loadRun` 正常/缺失/损坏 state;`isRunActive` 四路(非终态 state=活跃;全终态+无锁=非活跃;全终态但 run.lock 指向它=活跃;锁指向别的 run=非活跃);`summarizeRunStatus` 覆盖 done/failed/aborted/paused/running/pending。
2. **runs 聚合+渲染**(`test/unit/runs.test.ts`):`buildRunRows` 正确跳过损坏 state;表格含活跃 `*` 与脚注;JSON/CSV 结构;CSV RFC 4180 转义(pipeline 名带逗号/引号);无 run 退出 1;`--json`/`--csv` 互斥退出 1。
3. **clean 选择逻辑**(`test/unit/clean.test.ts`,核心):`selectRunsToClean` —— 活跃 run 永不入候选;非终态永不入候选;`--status` 只选对应终态;`--before` 相对天数(`7d`)与 ISO 各一;`--keep N` 保留最新 N;`status`+`before` 组合取交集。
4. **clean 执行**(`test/unit/clean.test.ts`):无条件 → 报错退出 1 且不删;`--dry-run` 不删且列清单退出 0;注入 `confirm: () => true` 实删后目录真消失、活跃 run 仍在;注入 `confirm: () => false` → Aborted 不删;非 TTY 无 `--yes` 无 confirm → 拒绝退出 1。
5. **复用回归**:cost 与 monitor 现有测试全绿(证明复用未改行为);对 store 抽出的函数与 cost 旧行为一致(单 run/`--all` 数字不变)。
6. **集成(推荐)**(`test/integration/runs-clean.test.ts`):建若干真 run(混合 done/failed/paused/活跃持锁),跑 `runs` 断言列表与活跃标记;跑 `clean --status done --yes`(或注入 confirm)断言只删 done 目录、活跃与非 done 保留。

## 全局约束

- 不新增 npm 依赖。
- `runs` 只读、不获取锁;`clean` 读 run.lock 判活跃但不 acquire 运行锁。
- 盘上格式不变:只读 state.json / run.lock;`clean` 只 `rmSync` 整个 run 目录,不改文件内容。
- 共享 store 为纯读取 + 纯判定(无渲染、无锁获取);渲染为纯函数;I/O 隔离在命令入口与 store 读取函数。
- `clean` 破坏性安全:默认无条件不删;活跃 run(非终态 state 或 run.lock 指向)永不删;非终态状态永不删;实删默认需交互确认(`--yes` 跳过);`--dry-run` 预览;非 TTY 无 `--yes` 拒绝。
- CSV 沿用 cost.ts 的 RFC 4180 转义;表格/JSON/CSV/`--no-color` 与 `cost` 命令风格一致。
- 复用改造以"行为不变 + cost/monitor 现有测试全绿"为准绳,不改这两个命令的输出。
