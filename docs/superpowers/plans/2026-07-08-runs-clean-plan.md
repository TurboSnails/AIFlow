# 运维命令 aiflow runs + aiflow clean Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增只读的 `aiflow runs`(纵览历史 run)与破坏性的 `aiflow clean`(按条件清理终态 run 目录),并抽出共享 run 读取层供 runs/clean/cost/monitor 复用。

**Architecture:** 新建 `src/runs/store.ts`(纯读取 + 纯活跃判定 + 状态摘要),`runs`/`clean` 命令建在其上;clean 的选择逻辑是纯函数 `selectRunsToClean`,活跃 run 与非终态 run 永不入候选;cost.ts/monitor.ts 的重复列举/读取逻辑改为复用 store。

**Tech Stack:** Bun + TypeScript,commander(CLI),bun:test。

## Global Constraints

- 不新增 npm 依赖。
- `runs` 只读、不获取锁;`clean` 读 run.lock 判活跃但不 acquire 运行锁。
- 盘上格式不变:只读 state.json / run.lock;`clean` 只 `rmSync` 整个 run 目录,不改文件内容。
- 共享 store 为纯读取 + 纯判定(无渲染、无锁获取);渲染为纯函数;I/O 隔离在命令入口与 store 读取函数。
- `clean` 破坏性安全:默认无条件(before/status/keep 全空)不删,退出 1;活跃 run(非终态 state 或 run.lock 指向)永不删;非终态状态永不删;实删默认需交互确认(`--yes` 跳过);`--dry-run` 预览;非 TTY 无 `--yes` 拒绝退出 1。
- CSV 用 RFC 4180 转义(`/[",\r\n]/` → 双引号包裹、内部 `"`→`""`);表格/JSON/CSV/`--no-color` 与 `cost` 命令风格一致。
- 复用改造以"行为不变 + cost/monitor 现有测试全绿"为准绳,不改这两个命令的输出。
- `summarizeRunStatus` 状态 token 取值域:`failed | aborted | suspended | paused | waiting_human | running | pending | done`(`suspended` 独立成 token,不并入 `done`,以免 `clean --status done` 误删挂起 run)。
- 终态集合(engine `TERMINAL_STATUSES`):`done | failed | aborted | suspended`。`--status` 仅接受 `done | failed | aborted`。

---

### Task 1: 共享读取层 `src/runs/store.ts`

**Files:**
- Create: `src/runs/store.ts`
- Test: `test/unit/runs-store.test.ts`

**Interfaces:**
- Consumes: `EngineState`, `StageStatus` from `../engine/state`; `TERMINAL_STATUSES` from `../engine/engine`.
- Produces:
  - `interface LoadedRun { runId: string; state: EngineState; mtimeMs: number }`
  - `function runsRoot(cwd: string): string`
  - `function listRunIdsByMtimeDesc(cwd: string): string[]`
  - `function loadRun(cwd: string, runId: string): LoadedRun | undefined`
  - `function isRunActive(cwd: string, runId: string, state: EngineState): boolean`
  - `function summarizeRunStatus(state: EngineState): string`

- [ ] **Step 1: Write the failing tests**

`test/unit/runs-store.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listRunIdsByMtimeDesc,
  loadRun,
  isRunActive,
  summarizeRunStatus,
} from "../../src/runs/store";
import type { EngineState } from "../../src/engine/state";

function makeState(overrides: Partial<EngineState> = {}): EngineState {
  return {
    run_id: "r",
    pipeline: "p",
    stages: [{ id: "s1", status: "done" }],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    ...overrides,
  };
}

function writeRun(root: string, runId: string, state: EngineState): string {
  const dir = join(root, ".aiflow", "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  return dir;
}

test("listRunIdsByMtimeDesc returns run dirs newest-first; empty when root missing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-store-"));
  try {
    expect(listRunIdsByMtimeDesc(cwd)).toEqual([]);
    writeRun(cwd, "run-a", makeState());
    // ensure run-b has a strictly later mtime
    const dirB = writeRun(cwd, "run-b", makeState());
    const later = Date.now() / 1000 + 5;
    require("node:fs").utimesSync(dirB, later, later);
    expect(listRunIdsByMtimeDesc(cwd)).toEqual(["run-b", "run-a"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadRun reads state + mtime; returns undefined for missing or corrupt state", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-store-"));
  try {
    writeRun(cwd, "good", makeState({ pipeline: "demo" }));
    const loaded = loadRun(cwd, "good");
    expect(loaded?.state.pipeline).toBe("demo");
    expect(typeof loaded?.mtimeMs).toBe("number");

    expect(loadRun(cwd, "missing")).toBeUndefined();

    const badDir = join(cwd, ".aiflow", "runs", "corrupt");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "state.json"), "{ not json");
    expect(loadRun(cwd, "corrupt")).toBeUndefined();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("isRunActive: non-terminal state is active", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-store-"));
  try {
    const state = makeState({ stages: [{ id: "s1", status: "running" }] });
    writeRun(cwd, "r1", state);
    expect(isRunActive(cwd, "r1", state)).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("isRunActive: all-terminal with no lock is inactive", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-store-"));
  try {
    const state = makeState({ stages: [{ id: "s1", status: "done" }] });
    writeRun(cwd, "r1", state);
    expect(isRunActive(cwd, "r1", state)).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("isRunActive: all-terminal but run.lock points to it is active; other run is not", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-store-"));
  try {
    const state = makeState({ stages: [{ id: "s1", status: "done" }] });
    writeRun(cwd, "r1", state);
    writeRun(cwd, "r2", state);
    writeFileSync(
      join(cwd, ".aiflow", "run.lock"),
      JSON.stringify({ pid: 999, run_id: "r1", started_at: "2026-07-08T00:00:00.000Z" }),
    );
    expect(isRunActive(cwd, "r1", state)).toBe(true);
    expect(isRunActive(cwd, "r2", state)).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("summarizeRunStatus tokens", () => {
  expect(summarizeRunStatus(makeState({ stages: [{ id: "a", status: "done" }] }))).toBe("done");
  expect(summarizeRunStatus(makeState({ stages: [{ id: "a", status: "done" }, { id: "b", status: "failed" }] }))).toBe("failed");
  expect(summarizeRunStatus(makeState({ stages: [{ id: "a", status: "done" }, { id: "b", status: "aborted" }] }))).toBe("aborted");
  expect(summarizeRunStatus(makeState({ stages: [{ id: "a", status: "done" }, { id: "b", status: "suspended" }] }))).toBe("suspended");
  expect(summarizeRunStatus(makeState({ stages: [{ id: "a", status: "done" }, { id: "b", status: "paused" }] }))).toBe("paused");
  expect(summarizeRunStatus(makeState({ stages: [{ id: "a", status: "running" }] }))).toBe("running");
  expect(summarizeRunStatus(makeState({ stages: [{ id: "a", status: "pending" }] }))).toBe("pending");
  expect(summarizeRunStatus(makeState({ stages: [{ id: "a", status: "waiting_human" }] }))).toBe("waiting_human");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/runs-store.test.ts`
Expected: FAIL —— `src/runs/store` module does not exist.

- [ ] **Step 3: Implement `src/runs/store.ts`**

```ts
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EngineState, StageStatus } from "../engine/state";
import { TERMINAL_STATUSES } from "../engine/engine";

export interface LoadedRun {
  runId: string;
  state: EngineState;
  mtimeMs: number;
}

export function runsRoot(cwd: string): string {
  return join(cwd, ".aiflow", "runs");
}

/** List run dirs under .aiflow/runs newest-first; stat each dir once; [] when root missing. */
export function listRunIdsByMtimeDesc(cwd: string): string[] {
  const root = runsRoot(cwd);
  if (!existsSync(root)) return [];
  const entries = readdirSync(root)
    .map((id) => ({ id, stat: statSync(join(root, id)) }))
    .filter((e) => e.stat.isDirectory());
  entries.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return entries.map((e) => e.id);
}

/** Read a run's state.json + dir mtime; undefined when missing or corrupt (never throws). */
export function loadRun(cwd: string, runId: string): LoadedRun | undefined {
  const runDir = join(runsRoot(cwd), runId);
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) return undefined;
  let state: EngineState;
  try {
    state = JSON.parse(readFileSync(statePath, "utf-8")) as EngineState;
  } catch {
    return undefined;
  }
  const mtimeMs = statSync(runDir).mtimeMs;
  return { runId, state, mtimeMs };
}

/** Read the run.lock's run_id, or undefined when absent/unreadable. Local read-only
 *  helper — does not depend on lock.ts internals (avoids coupling to concurrency logic). */
function lockedRunId(cwd: string): string | undefined {
  const lockPath = join(cwd, ".aiflow", "run.lock");
  if (!existsSync(lockPath)) return undefined;
  try {
    const info = JSON.parse(readFileSync(lockPath, "utf-8")) as { run_id?: string };
    return info.run_id;
  } catch {
    return undefined;
  }
}

/** Active when the state has any non-terminal stage OR run.lock points to this run. */
export function isRunActive(cwd: string, runId: string, state: EngineState): boolean {
  const hasNonTerminal = state.stages.some((s) => !TERMINAL_STATUSES.has(s.status));
  if (hasNonTerminal) return true;
  return lockedRunId(cwd) === runId;
}

/** Compact overall status token for list views. suspended stays its own token
 *  (not folded into "done") so `clean --status done` never sweeps a suspended run. */
export function summarizeRunStatus(state: EngineState): string {
  const firstNonTerminal = state.stages.find((s) => !TERMINAL_STATUSES.has(s.status));
  if (firstNonTerminal) return firstNonTerminal.status;
  if (state.stages.some((s) => s.status === "failed")) return "failed";
  if (state.stages.some((s) => s.status === "aborted")) return "aborted";
  if (state.stages.some((s) => s.status === "suspended")) return "suspended";
  return "done";
}
```

> Note: `TERMINAL_STATUSES` is exported from `src/engine/engine.ts` as `ReadonlySet<StageStatus>` (values: done/failed/aborted/suspended). `StageStatus` import may be unused if TypeScript infers types; keep it only if needed to compile (remove otherwise to keep output pristine).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/runs-store.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runs/store.ts test/unit/runs-store.test.ts
git commit -m "feat: add shared run store (list, load, active-check, status)"
```

---

### Task 2: `aiflow runs` 命令 + CLI 接线

**Files:**
- Create: `src/commands/runs.ts`
- Modify: `src/cli.ts`(在 `cost` 命令注册之后新增 `runs` 命令)
- Test: `test/unit/runs.test.ts`

**Interfaces:**
- Consumes: `listRunIdsByMtimeDesc`, `loadRun`, `isRunActive`, `summarizeRunStatus`, `runsRoot`, `LoadedRun` from `../runs/store`.
- Produces:
  - `interface RunRow { runId: string; pipeline: string; status: string; estUsd: number; mtimeMs: number; active: boolean }`
  - `function buildRunRows(cwd: string, now?: number): RunRow[]`
  - `function renderRunsTable(rows: RunRow[], now: number, opts?: { color?: boolean }): string`
  - `function renderRunsJson(rows: RunRow[]): string`
  - `function renderRunsCsv(rows: RunRow[]): string`
  - `function runRuns(cwd: string, opts: RunsOptions): number`

- [ ] **Step 1: Write the failing tests**

`test/unit/runs.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunRows, renderRunsTable, renderRunsJson, renderRunsCsv, runRuns } from "../../src/commands/runs";
import type { EngineState } from "../../src/engine/state";

function writeRun(cwd: string, runId: string, state: Partial<EngineState>): void {
  const dir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const full: EngineState = {
    run_id: runId,
    pipeline: "p",
    stages: [{ id: "s1", status: "done" }],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    ...state,
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(full));
}

test("buildRunRows skips corrupt state and fills fields", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-runs-"));
  try {
    writeRun(cwd, "r1", { pipeline: "demo", cost: { input_tokens: 0, output_tokens: 0, est_usd: 1.5 } });
    const badDir = join(cwd, ".aiflow", "runs", "bad");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "state.json"), "{ broken");
    const rows = buildRunRows(cwd);
    expect(rows.map((r) => r.runId)).toEqual(["r1"]);
    expect(rows[0]).toMatchObject({ pipeline: "demo", status: "done", estUsd: 1.5, active: false });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("renderRunsTable marks active runs with * and includes a footnote", () => {
  const rows = [
    { runId: "r1", pipeline: "p", status: "running", estUsd: 0.5, mtimeMs: Date.now(), active: true },
    { runId: "r2", pipeline: "p", status: "done", estUsd: 0.25, mtimeMs: Date.now(), active: false },
  ];
  const out = renderRunsTable(rows, Date.now(), { color: false });
  expect(out).toContain("r1");
  expect(out).toContain("*");
  expect(out.toLowerCase()).toContain("active");
});

test("renderRunsCsv escapes commas per RFC 4180", () => {
  const rows = [{ runId: "r1", pipeline: "a,b", status: "done", estUsd: 1, mtimeMs: 1234, active: false }];
  const csv = renderRunsCsv(rows);
  const lines = csv.trim().split("\n");
  expect(lines[0]).toBe("run_id,pipeline,status,est_usd,mtime_ms,active");
  expect(lines[1]).toBe('r1,"a,b",done,1,1234,false');
});

test("renderRunsJson emits the row array", () => {
  const rows = [{ runId: "r1", pipeline: "p", status: "done", estUsd: 1, mtimeMs: 1234, active: false }];
  expect(JSON.parse(renderRunsJson(rows))).toEqual(rows);
});

test("runRuns returns 1 and errors when there are no runs", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-runs-"));
  try {
    let err = "";
    const code = runRuns(cwd, { writeErr: (s) => { err += s; }, write: () => {} });
    expect(code).toBe(1);
    expect(err).toContain("No runs found");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runRuns rejects --json with --csv", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-runs-"));
  try {
    let err = "";
    const code = runRuns(cwd, { json: true, csv: true, writeErr: (s) => { err += s; }, write: () => {} });
    expect(code).toBe(1);
    expect(err).toContain("mutually exclusive");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/runs.test.ts`
Expected: FAIL —— `src/commands/runs` does not exist.

- [ ] **Step 3: Implement `src/commands/runs.ts`**

```ts
import {
  listRunIdsByMtimeDesc,
  loadRun,
  isRunActive,
  summarizeRunStatus,
  runsRoot,
} from "../runs/store";

export interface RunRow {
  runId: string;
  pipeline: string;
  status: string;
  estUsd: number;
  mtimeMs: number;
  active: boolean;
}

export interface RunsOptions {
  json?: boolean;
  csv?: boolean;
  color?: boolean;
  write?: (s: string) => void;
  writeErr?: (s: string) => void;
}

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", gray: "\x1b[90m" } as const;
function paint(code: keyof typeof ANSI, on: boolean, text: string): string {
  return on ? `${ANSI[code]}${text}${ANSI.reset}` : text;
}
function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}
function escapeCsv(field: string): string {
  if (/[",\r\n]/.test(field)) return `"${field.replace(/"/g, '""')}"`;
  return field;
}
function relAge(mtimeMs: number, now: number): string {
  const s = Math.max(0, Math.round((now - mtimeMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function buildRunRows(cwd: string): RunRow[] {
  const rows: RunRow[] = [];
  for (const runId of listRunIdsByMtimeDesc(cwd)) {
    const loaded = loadRun(cwd, runId);
    if (!loaded) continue;
    rows.push({
      runId,
      pipeline: loaded.state.pipeline,
      status: summarizeRunStatus(loaded.state),
      estUsd: loaded.state.cost.est_usd,
      mtimeMs: loaded.mtimeMs,
      active: isRunActive(cwd, runId, loaded.state),
    });
  }
  return rows;
}

export function renderRunsTable(rows: RunRow[], now: number, opts: { color?: boolean } = {}): string {
  const color = opts.color !== false;
  const lines: string[] = [];
  lines.push(paint("bold", color, "Runs"));
  lines.push("");
  const runW = Math.max(20, ...rows.map((r) => r.runId.length));
  const pipeW = Math.max(10, ...rows.map((r) => r.pipeline.length));
  const statusW = Math.max(8, ...rows.map((r) => r.status.length));
  const header = `  ${"Run".padEnd(runW)}  ${"Pipeline".padEnd(pipeW)}  ${"Status".padEnd(statusW)}  ${"Cost".padStart(10)}  ${"Age".padStart(6)}`;
  lines.push(paint("bold", color, header));
  let anyActive = false;
  for (const r of rows) {
    if (r.active) anyActive = true;
    const mark = r.active ? " *" : "";
    lines.push(`  ${r.runId.padEnd(runW)}  ${r.pipeline.padEnd(pipeW)}  ${r.status.padEnd(statusW)}  ${usd(r.estUsd).padStart(10)}  ${relAge(r.mtimeMs, now).padStart(6)}${mark}`);
  }
  if (anyActive) {
    lines.push(paint("gray", color, "  * active (running or lock-held)"));
  }
  return lines.join("\n");
}

export function renderRunsJson(rows: RunRow[]): string {
  return JSON.stringify(rows, null, 2);
}

export function renderRunsCsv(rows: RunRow[]): string {
  const lines: string[] = ["run_id,pipeline,status,est_usd,mtime_ms,active"];
  for (const r of rows) {
    lines.push(`${escapeCsv(r.runId)},${escapeCsv(r.pipeline)},${escapeCsv(r.status)},${r.estUsd},${r.mtimeMs},${r.active}`);
  }
  return lines.join("\n") + "\n";
}

export function runRuns(cwd: string, opts: RunsOptions): number {
  const write = opts.write ?? ((s) => process.stdout.write(s));
  const writeErr = opts.writeErr ?? ((s) => process.stderr.write(s));
  const color = opts.color !== false;

  if (opts.json && opts.csv) {
    writeErr("--json and --csv are mutually exclusive\n");
    return 1;
  }

  const rows = buildRunRows(cwd);
  if (rows.length === 0) {
    writeErr(`No runs found in ${runsRoot(cwd)}\n`);
    return 1;
  }

  if (opts.json) write(renderRunsJson(rows) + "\n");
  else if (opts.csv) write(renderRunsCsv(rows));
  else write(renderRunsTable(rows, Date.now(), { color }) + "\n");
  return 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/runs.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Register the CLI command**

In `src/cli.ts`, after the `cost` command block (ends around line 276) and before `watch`, add:

```ts
program
  .command("runs")
  .description("List all runs (read-only): id, pipeline, status, cost, age")
  .option("--json", "output structured JSON", false)
  .option("--csv", "output CSV", false)
  .option("--no-color", "disable ANSI colors")
  .action(async (opts: { json: boolean; csv: boolean; color: boolean }) => {
    const { runRuns } = await import("./commands/runs");
    process.exitCode = runRuns(process.cwd(), { json: opts.json, csv: opts.csv, color: opts.color });
  });
```

- [ ] **Step 6: Verify CLI compiles + smoke test**

Run: `bunx tsc --noEmit 2>&1 | grep -E "runs\.ts|cli\.ts" || echo "runs/cli clean"`
Expected: `runs/cli clean`.

Run: `bun src/cli.ts runs --help`
Expected: help text listing `--json`, `--csv`, `--no-color`.

- [ ] **Step 7: Commit**

```bash
git add src/commands/runs.ts src/cli.ts test/unit/runs.test.ts
git commit -m "feat: add aiflow runs command listing all runs"
```

---

### Task 3: `aiflow clean` 命令 + CLI 接线

**Files:**
- Create: `src/commands/clean.ts`
- Modify: `src/cli.ts`(在 `runs` 命令之后新增 `clean` 命令)
- Test: `test/unit/clean.test.ts`

**Interfaces:**
- Consumes: `RunRow`, `buildRunRows` from `../commands/runs`; `runsRoot` from `../runs/store`.
- Produces:
  - `function selectRunsToClean(rows: RunRow[], filters: { before?: Date; status?: string; keep?: number }): { toDelete: RunRow[]; kept: RunRow[] }`
  - `function parseBefore(value: string, now: Date): Date | undefined`
  - `function runClean(cwd: string, opts: CleanOptions): number`
  - `interface CleanOptions { before?: string; status?: string; keep?: number; dryRun?: boolean; yes?: boolean; color?: boolean; write?; writeErr?; confirm?: () => boolean }`

- [ ] **Step 1: Write the failing tests**

`test/unit/clean.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectRunsToClean, parseBefore, runClean } from "../../src/commands/clean";
import type { RunRow } from "../../src/commands/runs";
import type { EngineState } from "../../src/engine/state";

function row(over: Partial<RunRow>): RunRow {
  return { runId: "r", pipeline: "p", status: "done", estUsd: 0, mtimeMs: 1000, active: false, ...over };
}

test("selectRunsToClean never selects active runs", () => {
  const rows = [row({ runId: "a", active: true, status: "done" }), row({ runId: "b", status: "done" })];
  const { toDelete } = selectRunsToClean(rows, { status: "done" });
  expect(toDelete.map((r) => r.runId)).toEqual(["b"]);
});

test("selectRunsToClean never selects non-terminal status even without active flag", () => {
  const rows = [row({ runId: "a", status: "paused" }), row({ runId: "b", status: "done" })];
  const { toDelete } = selectRunsToClean(rows, { status: "done" });
  expect(toDelete.map((r) => r.runId)).toEqual(["b"]);
});

test("selectRunsToClean --status filters to that terminal status", () => {
  const rows = [row({ runId: "a", status: "done" }), row({ runId: "b", status: "failed" })];
  const { toDelete } = selectRunsToClean(rows, { status: "failed" });
  expect(toDelete.map((r) => r.runId)).toEqual(["b"]);
});

test("selectRunsToClean --before keeps only older-than", () => {
  const rows = [row({ runId: "old", mtimeMs: 1000, status: "done" }), row({ runId: "new", mtimeMs: 5000, status: "done" })];
  const { toDelete } = selectRunsToClean(rows, { before: new Date(3000) });
  expect(toDelete.map((r) => r.runId)).toEqual(["old"]);
});

test("selectRunsToClean --keep retains newest N candidates", () => {
  const rows = [
    row({ runId: "a", mtimeMs: 3000, status: "done" }),
    row({ runId: "b", mtimeMs: 2000, status: "done" }),
    row({ runId: "c", mtimeMs: 1000, status: "done" }),
  ];
  const { toDelete, kept } = selectRunsToClean(rows, { keep: 2 });
  expect(kept.map((r) => r.runId)).toEqual(["a", "b"]);
  expect(toDelete.map((r) => r.runId)).toEqual(["c"]);
});

test("selectRunsToClean combines status + before (intersection)", () => {
  const rows = [
    row({ runId: "a", status: "done", mtimeMs: 1000 }),
    row({ runId: "b", status: "failed", mtimeMs: 1000 }),
    row({ runId: "c", status: "done", mtimeMs: 5000 }),
  ];
  const { toDelete } = selectRunsToClean(rows, { status: "done", before: new Date(3000) });
  expect(toDelete.map((r) => r.runId)).toEqual(["a"]);
});

test("parseBefore accepts Nd relative and ISO date", () => {
  const now = new Date("2026-07-08T00:00:00.000Z");
  const sevenDaysAgo = parseBefore("7d", now)!;
  expect(sevenDaysAgo.getTime()).toBe(now.getTime() - 7 * 86400_000);
  const iso = parseBefore("2026-07-01T00:00:00.000Z", now)!;
  expect(iso.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  expect(parseBefore("garbage", now)).toBeUndefined();
});

// --- runClean command-entry tests ---

function writeRun(cwd: string, runId: string, state: Partial<EngineState>): string {
  const dir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const full: EngineState = {
    run_id: runId, pipeline: "p",
    stages: [{ id: "s1", status: "done" }],
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    ...state,
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(full));
  return dir;
}

test("runClean with no filters errors and deletes nothing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-clean-"));
  try {
    writeRun(cwd, "r1", {});
    let err = "";
    const code = runClean(cwd, { writeErr: (s) => { err += s; }, write: () => {} });
    expect(code).toBe(1);
    expect(err).toContain("requires at least one");
    expect(existsSync(join(cwd, ".aiflow", "runs", "r1"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runClean --dry-run lists but does not delete", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-clean-"));
  try {
    writeRun(cwd, "r1", { stages: [{ id: "s1", status: "done" }] });
    let out = "";
    const code = runClean(cwd, { status: "done", dryRun: true, write: (s) => { out += s; }, writeErr: () => {} });
    expect(code).toBe(0);
    expect(out.toLowerCase()).toContain("would delete");
    expect(existsSync(join(cwd, ".aiflow", "runs", "r1"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runClean deletes terminal runs on confirm and keeps active ones", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-clean-"));
  try {
    writeRun(cwd, "done1", { stages: [{ id: "s1", status: "done" }] });
    writeRun(cwd, "live1", { stages: [{ id: "s1", status: "running" }] });
    const code = runClean(cwd, { status: "done", confirm: () => true, write: () => {}, writeErr: () => {} });
    expect(code).toBe(0);
    expect(existsSync(join(cwd, ".aiflow", "runs", "done1"))).toBe(false);
    expect(existsSync(join(cwd, ".aiflow", "runs", "live1"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runClean aborts (deletes nothing) when confirm returns false", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-clean-"));
  try {
    writeRun(cwd, "done1", { stages: [{ id: "s1", status: "done" }] });
    const code = runClean(cwd, { status: "done", confirm: () => false, write: () => {}, writeErr: () => {} });
    expect(code).toBe(0);
    expect(existsSync(join(cwd, ".aiflow", "runs", "done1"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runClean rejects an invalid --status value", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-clean-"));
  try {
    writeRun(cwd, "r1", {});
    let err = "";
    const code = runClean(cwd, { status: "paused", writeErr: (s) => { err += s; }, write: () => {} });
    expect(code).toBe(1);
    expect(err.toLowerCase()).toContain("status");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/unit/clean.test.ts`
Expected: FAIL —— `src/commands/clean` does not exist.

- [ ] **Step 3: Implement `src/commands/clean.ts`**

```ts
import { rmSync } from "node:fs";
import { join } from "node:path";
import { buildRunRows, type RunRow } from "./runs";
import { runsRoot } from "../runs/store";

const CLEANABLE_STATUSES = new Set(["done", "failed", "aborted"]);

export interface CleanOptions {
  before?: string;
  status?: string;
  keep?: number;
  dryRun?: boolean;
  yes?: boolean;
  color?: boolean;
  write?: (s: string) => void;
  writeErr?: (s: string) => void;
  confirm?: () => boolean;
}

/** Parse a --before value: "Nd" relative days, or an ISO date. undefined when unparseable. */
export function parseBefore(value: string, now: Date): Date | undefined {
  const rel = /^(\d+)d$/.exec(value);
  if (rel) {
    return new Date(now.getTime() - Number(rel[1]) * 86400_000);
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) return undefined;
  return new Date(t);
}

/** Pure selection. Active runs and non-cleanable statuses are never candidates. */
export function selectRunsToClean(
  rows: RunRow[],
  filters: { before?: Date; status?: string; keep?: number },
): { toDelete: RunRow[]; kept: RunRow[] } {
  let candidates = rows.filter((r) => !r.active && CLEANABLE_STATUSES.has(r.status));
  if (filters.status) candidates = candidates.filter((r) => r.status === filters.status);
  if (filters.before) candidates = candidates.filter((r) => r.mtimeMs < filters.before!.getTime());

  const kept: RunRow[] = [];
  let toDelete = candidates;
  if (filters.keep !== undefined) {
    const sorted = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs);
    kept.push(...sorted.slice(0, filters.keep));
    toDelete = sorted.slice(filters.keep);
  }
  return { toDelete, kept };
}

function defaultConfirm(): boolean {
  // Non-interactive by default in this codebase's tests; real TTY confirm is
  // gated by --yes at the command layer, so this path is only hit interactively.
  return false;
}

export function runClean(cwd: string, opts: CleanOptions): number {
  const write = opts.write ?? ((s) => process.stdout.write(s));
  const writeErr = opts.writeErr ?? ((s) => process.stderr.write(s));

  // Validate --status
  if (opts.status !== undefined && !CLEANABLE_STATUSES.has(opts.status)) {
    writeErr(`Invalid --status "${opts.status}" (must be one of: done, failed, aborted)\n`);
    return 1;
  }
  // Validate --keep
  if (opts.keep !== undefined && (!Number.isInteger(opts.keep) || opts.keep < 0)) {
    writeErr(`Invalid --keep "${opts.keep}" (must be a non-negative integer)\n`);
    return 1;
  }
  // Parse --before
  let before: Date | undefined;
  if (opts.before !== undefined) {
    before = parseBefore(opts.before, new Date());
    if (!before) {
      writeErr(`Invalid --before "${opts.before}" (use "<N>d" or an ISO date)\n`);
      return 1;
    }
  }
  // Require at least one filter
  if (opts.before === undefined && opts.status === undefined && opts.keep === undefined) {
    writeErr("clean requires at least one of --before, --status, --keep\n");
    return 1;
  }

  const rows = buildRunRows(cwd);
  if (rows.length === 0) {
    writeErr(`No runs found in ${runsRoot(cwd)}\n`);
    return 1;
  }

  const { toDelete } = selectRunsToClean(rows, { before, status: opts.status, keep: opts.keep });
  if (toDelete.length === 0) {
    write("Nothing to clean\n");
    return 0;
  }

  write(`Run(s) to delete:\n`);
  for (const r of toDelete) write(`  ${r.runId}  ${r.status}\n`);

  if (opts.dryRun) {
    write(`Would delete ${toDelete.length} run(s)\n`);
    return 0;
  }

  // Confirmation gate
  if (!opts.yes) {
    const confirmFn = opts.confirm;
    if (!confirmFn) {
      // No injected confirm and not --yes: refuse in non-interactive contexts.
      if (!process.stdin.isTTY) {
        writeErr("refusing to delete without --yes (non-interactive)\n");
        return 1;
      }
    }
    const confirmed = (confirmFn ?? defaultConfirm)();
    if (!confirmed) {
      write("Aborted\n");
      return 0;
    }
  }

  for (const r of toDelete) {
    rmSync(join(runsRoot(cwd), r.runId), { recursive: true, force: true });
  }
  write(`Deleted ${toDelete.length} run(s)\n`);
  return 0;
}
```

> Confirmation semantics: `--yes` skips confirmation entirely. Otherwise, if `opts.confirm` is injected (tests), it decides. With neither `--yes` nor `confirm` and a non-TTY stdin, refuse (exit 1). The `defaultConfirm` returning false is a conservative placeholder for the interactive path; a real interactive prompt is out of scope for unit tests and is guarded by the non-TTY refusal above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/clean.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Register the CLI command**

In `src/cli.ts`, after the `runs` command block, add:

```ts
program
  .command("clean")
  .description("Delete terminal run directories (active runs are never deleted)")
  .option("--before <when>", "delete runs older than this (\"<N>d\" or an ISO date)")
  .option("--status <status>", "only delete runs with this terminal status (done|failed|aborted)")
  .option("--keep <n>", "keep the newest N matching runs", (v) => Number(v))
  .option("--dry-run", "show what would be deleted without deleting", false)
  .option("--yes", "skip the confirmation prompt", false)
  .option("--no-color", "disable ANSI colors")
  .action(async (opts: { before?: string; status?: string; keep?: number; dryRun: boolean; yes: boolean; color: boolean }) => {
    const { runClean } = await import("./commands/clean");
    const confirm = () => {
      if (opts.yes) return true;
      const answer = prompt("Delete these runs? (y/N)");
      return answer?.trim().toLowerCase() === "y";
    };
    process.exitCode = runClean(process.cwd(), {
      before: opts.before,
      status: opts.status,
      keep: opts.keep,
      dryRun: opts.dryRun,
      yes: opts.yes,
      color: opts.color,
      confirm: opts.yes ? undefined : confirm,
    });
  });
```

> `prompt()` is a Bun global for interactive stdin. Passing `confirm` here wires the real prompt; when `--yes` is set, `runClean` skips confirmation before ever calling it.

- [ ] **Step 6: Verify CLI compiles + smoke test**

Run: `bunx tsc --noEmit 2>&1 | grep -E "clean\.ts|cli\.ts" || echo "clean/cli clean"`
Expected: `clean/cli clean`.

Run: `bun src/cli.ts clean --help`
Expected: help text listing `--before`, `--status`, `--keep`, `--dry-run`, `--yes`.

- [ ] **Step 7: Commit**

```bash
git add src/commands/clean.ts src/cli.ts test/unit/clean.test.ts
git commit -m "feat: add aiflow clean command for terminal run cleanup"
```

---

### Task 4: cost.ts / monitor.ts 复用 store

**Files:**
- Modify: `src/commands/cost.ts`(删除自有 `runsRoot`/`listRunIdsByMtimeDesc`/`loadRun`/`LoadedRun`,改用 store + 薄 `loadRunEvents`)
- Modify: `src/commands/monitor.ts`(`pickLatestRun` 改用 store 的 `listRunIdsByMtimeDesc`)
- Test: 复用现有 `test/unit/cost.test.ts`、`test/unit/monitor.test.ts`(不新增;行为不变)

**Interfaces:**
- Consumes: `listRunIdsByMtimeDesc`, `loadRun as loadRunState`, `runsRoot` from `../runs/store`.
- Produces: 无新公共接口;cost 内部新增 `loadRunEvents(cwd, runId): AiflowEvent[]`。

- [ ] **Step 1: Establish the green baseline**

Run: `bun test test/unit/cost.test.ts test/unit/monitor.test.ts`
Expected: PASS (record the counts; these must stay identical after refactor).

- [ ] **Step 2: Refactor `src/commands/cost.ts`**

Replace the block currently at lines ~188-222 (the local `LoadedRun` interface, `runsRoot`, `listRunIdsByMtimeDesc`, `loadRun`) with a reuse of the store plus a thin events reader. The store's `loadRun` returns `{ runId, state, mtimeMs }` (no events); cost needs events, so keep a local events loader and assemble cost's own `LoadedRun` shape.

Remove these local definitions:

```ts
interface LoadedRun {
  runId: string;
  state: EngineState;
  events: AiflowEvent[];
}

function runsRoot(cwd: string): string {
  return join(cwd, ".aiflow", "runs");
}

function listRunIdsByMtimeDesc(cwd: string): string[] { /* ... */ }

function loadRun(cwd: string, runId: string): LoadedRun | undefined { /* ... */ }
```

Add near the top imports:

```ts
import { listRunIdsByMtimeDesc, loadRun as loadRunState, runsRoot } from "../runs/store";
```

And re-add cost's own combined loader (keeping the same `LoadedRun` name/shape cost's renderers already use):

```ts
interface LoadedRun {
  runId: string;
  state: EngineState;
  events: AiflowEvent[];
}

function loadRunEvents(cwd: string, runId: string): AiflowEvent[] {
  const eventsPath = join(runsRoot(cwd), runId, "events.jsonl");
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AiflowEvent);
}

function loadRun(cwd: string, runId: string): LoadedRun | undefined {
  const loaded = loadRunState(cwd, runId);
  if (!loaded) return undefined;
  return { runId, state: loaded.state, events: loadRunEvents(cwd, runId) };
}
```

Leave the rest of cost.ts (`runCost`, renderers, aggregation) unchanged — it still calls the local `loadRun`/`listRunIdsByMtimeDesc`/`runsRoot` names, now backed by the store. Ensure `readdirSync`/`statSync` imports are dropped if no longer used, keeping `existsSync`/`readFileSync` (still used by `loadRunEvents`); remove any now-unused imports so `tsc` stays clean.

- [ ] **Step 3: Refactor `src/commands/monitor.ts`**

Replace the local `pickLatestRun` (lines ~110-120) body to delegate to the store. Change:

```ts
function pickLatestRun(cwd: string): string | undefined {
  const runsRoot = join(cwd, ".aiflow", "runs");
  if (!existsSync(runsRoot)) return undefined;
  const entries = readdirSync(runsRoot).filter((name) => {
    const full = join(runsRoot, name);
    return statSync(full).isDirectory();
  });
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => statSync(join(runsRoot, b)).mtimeMs - statSync(join(runsRoot, a)).mtimeMs);
  return entries[0];
}
```

to:

```ts
function pickLatestRun(cwd: string): string | undefined {
  return listRunIdsByMtimeDesc(cwd)[0];
}
```

Add the import near the top:

```ts
import { listRunIdsByMtimeDesc } from "../runs/store";
```

`readRunSnapshot` stays as-is (it reads state + events + assembles the snapshot — monitor-specific). Remove `readdirSync`/`statSync` from monitor's imports ONLY if no other code in the file uses them (check: `readRunSnapshot` uses `statSync(statePath).birthtime`, and `formatTime`/others may use them — keep `statSync` if still referenced; drop `readdirSync` if now unused). Keep `tsc` clean.

- [ ] **Step 4: Run the reuse regression suites**

Run: `bun test test/unit/cost.test.ts test/unit/monitor.test.ts`
Expected: PASS with the SAME counts as Step 1 (behavior unchanged).

- [ ] **Step 5: Type-check**

Run: `bunx tsc --noEmit 2>&1 | grep -E "cost\.ts|monitor\.ts" || echo "cost/monitor clean"`
Expected: `cost/monitor clean` (no new production errors introduced by the refactor).

- [ ] **Step 6: Commit**

```bash
git add src/commands/cost.ts src/commands/monitor.ts
git commit -m "refactor: reuse shared run store in cost and monitor"
```

---

### Task 5: 端到端集成测试 + 全量校验

**Files:**
- Create: `test/integration/runs-clean.test.ts`
- 验证:全量 `bun test ./test` + `bunx tsc --noEmit`

**Interfaces:**
- Consumes: `runRuns` from `../../src/commands/runs`; `runClean` from `../../src/commands/clean`.

- [ ] **Step 1: Write the end-to-end test**

`test/integration/runs-clean.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRuns } from "../../src/commands/runs";
import { runClean } from "../../src/commands/clean";
import type { EngineState } from "../../src/engine/state";

function writeRun(cwd: string, runId: string, stages: EngineState["stages"]): void {
  const dir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const state: EngineState = {
    run_id: runId, pipeline: "demo", stages,
    cost: { input_tokens: 0, output_tokens: 0, est_usd: 0.1 },
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
}

test("runs lists all runs and marks the lock-held one active; clean --status done removes only done runs", () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-runs-clean-"));
  try {
    writeRun(cwd, "done1", [{ id: "s1", status: "done" }]);
    writeRun(cwd, "failed1", [{ id: "s1", status: "failed" }]);
    writeRun(cwd, "paused1", [{ id: "s1", status: "paused" }]);
    writeRun(cwd, "locked1", [{ id: "s1", status: "done" }]);
    writeFileSync(
      join(cwd, ".aiflow", "run.lock"),
      JSON.stringify({ pid: 4242, run_id: "locked1", started_at: "2026-07-08T00:00:00.000Z" }),
    );

    // runs: JSON output includes all four, locked1 active
    let out = "";
    const runsCode = runRuns(cwd, { json: true, write: (s) => { out += s; }, writeErr: () => {} });
    expect(runsCode).toBe(0);
    const rows = JSON.parse(out) as Array<{ runId: string; active: boolean; status: string }>;
    expect(rows.map((r) => r.runId).sort()).toEqual(["done1", "failed1", "locked1", "paused1"]);
    expect(rows.find((r) => r.runId === "locked1")!.active).toBe(true);
    expect(rows.find((r) => r.runId === "paused1")!.active).toBe(true); // non-terminal

    // clean --status done --yes: removes done1 only; locked1 (active) and others survive
    const cleanCode = runClean(cwd, { status: "done", yes: true, write: () => {}, writeErr: () => {} });
    expect(cleanCode).toBe(0);
    expect(existsSync(join(cwd, ".aiflow", "runs", "done1"))).toBe(false);
    expect(existsSync(join(cwd, ".aiflow", "runs", "locked1"))).toBe(true);
    expect(existsSync(join(cwd, ".aiflow", "runs", "failed1"))).toBe(true);
    expect(existsSync(join(cwd, ".aiflow", "runs", "paused1"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the integration test**

Run: `bun test test/integration/runs-clean.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the full suite**

Run: `bun test ./test`
Expected: 0 fail (all prior tests + the new store/runs/clean/integration tests).

- [ ] **Step 4: Type-check**

Run: `bunx tsc --noEmit`
Expected: only the pre-existing test-file type errors that predate this branch (in `test/integration/multi-stage-mocked.test.ts`, `test/unit/brainstorm.test.ts`, `test/unit/engine.test.ts`); no new production-file or new-test errors.

- [ ] **Step 5: Commit**

```bash
git add test/integration/runs-clean.test.ts
git commit -m "test: end-to-end runs listing and clean filtering"
```

---

## Self-Review

**Spec coverage:**
- 目标1(`aiflow runs`)→ Task 2(命令 + 渲染 + CLI)。
- 目标2(`aiflow clean`)→ Task 3(选择逻辑 + 命令 + CLI)。
- 目标3(共享读取层 + cost/monitor 复用)→ Task 1(store)+ Task 4(复用改造)。
- 组件1 store → Task 1;组件2 runs → Task 2;组件3 clean → Task 3;组件4 CLI 接线 → Task 2/3 内;组件5 复用 → Task 4。
- 错误处理:无 run 退出 1(Task 2/3 测试);--json/--csv 互斥(Task 2);--status/--keep/--before 校验 + 无条件退出 1(Task 3);损坏 state 跳过(Task 1 loadRun + Task 2 buildRunRows 测试);非 TTY 无 --yes 拒绝(Task 3 runClean 逻辑,单测通过注入 confirm 覆盖删除路径)。
- 安全:活跃/非终态永不删 → Task 3 selectRunsToClean 测试(active + paused 两路);--dry-run 不删 → Task 3。
- 集成 → Task 5。

**Placeholder scan:** 无 TBD/TODO;每个改动步骤含完整代码。Task 4 的"drop unused imports if no longer used / keep if still referenced"是精确指令(实现者需按文件实际引用判断),非占位 —— 给出了保留 `existsSync`/`readFileSync`(loadRunEvents 用)、`statSync`(monitor birthtime 用)的具体依据。

**Type consistency:**
- store `loadRun(cwd, runId): LoadedRun | undefined`(store 的 `LoadedRun = {runId, state, mtimeMs}`)Task 1 定义,Task 2 用其 `.state`/`.mtimeMs`,Task 4 以 `loadRunState` 别名导入避免与 cost 自有 `loadRun` 冲突。
- `RunRow { runId, pipeline, status, estUsd, mtimeMs, active }` Task 2 定义,Task 3 `selectRunsToClean` 消费一致。
- `summarizeRunStatus`/`isRunActive`/`listRunIdsByMtimeDesc`/`runsRoot` 签名 Task 1 定义,Task 2/3/4 引用一致。
- `selectRunsToClean(rows, { before?: Date; status?; keep? })` Task 3 定义与测试、runClean 调用一致(runClean 把 `--before` 字符串经 `parseBefore` 转 Date 再传入)。
- CSV 表头 `run_id,pipeline,status,est_usd,mtime_ms,active` Task 2 定义与测试一致。
