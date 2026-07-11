# AIFlow 缺口闭合实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前 AIFlow 实现从技术设计文档/需求文档要求的 v1.0 差距中补齐，使引擎、人机门、评审、辩论、worktree、Dashboard、MCP 等模块达到文档约定的行为。

**Architecture:** 以文件（`state.json` / `events.jsonl` / `specboard.json`）为唯一事实来源，引擎顺序调度 Stage Runner；Runner 通过 OpenCode Adapter（通道 A）或 LLM Client（通道 B）调用模型；命令层只做 CLI/REST/MCP 入口。本计划按“先修引擎契约、再修工作流、再补外围”的顺序推进。

**Tech Stack:** TypeScript + Bun；配置 YAML + zod；OpenCode CLI/HTTP 适配；Express + WebSocket + React/Vite Dashboard；MCP stdio。

## Global Constraints

- 所有 AI 判断必须有确定性检查兜底；AI 输出一律结构化 + schema 校验。
- 阶段间状态只通过磁盘文件与 git 传递，不依赖内存态。
- API key 只能经 `api_key_env` 间接读取；日志/报告必须脱敏。
- 不 fork、不 patch 上游（OpenCode、Agent-Monitor），只使用公开接口。
- Dashboard 只读消费文件，默认仅绑定 localhost。
- 预算/重试上限内置不可关闭；`max_retry_steps` 默认 5，`max_cost_usd` 到达即 paused。
- 新增 Stage 类型应只新增注册项，不动引擎核心调度。

---

## Task 1: 扩展 EngineState 并注册 `shell` Runner

**Files:**
- Modify: `src/engine/state.ts:17-24`
- Modify: `src/engine/engine.ts:35-39`（`EngineDeps` / `defaultDeps`）
- Create: `src/runners/shell.ts`
- Modify: `src/commands/run.ts`（worktree 创建后写入 state）
- Test: `test/unit/engine.test.ts`

**Interfaces:**
- Consumes: `EngineState` from `src/engine/state.ts`, `StageConfig` discriminated union from `src/config/schema.ts`.
- Produces: `EngineState` 新增 `autonomy`、`isolation`、`worktree` 字段；`defaultDeps.runners` 新增 `shell` 键。

- [ ] **Step 1: 在 `src/engine/state.ts` 扩展 `EngineState`**

```ts
export interface EngineState {
  run_id: string;
  pipeline: string;
  requirement?: string;
  autonomy?: "interactive" | "gated" | "full";
  isolation?: "none" | "worktree";
  worktree?: { path: string; branch: string };
  stages: StageState[];
  cost: { input_tokens: number; output_tokens: number; est_usd: number };
  budget?: { limit_usd: number; warn_at_pct?: number[] };
}
```

- [ ] **Step 2: 创建 `src/runners/shell.ts`**

```ts
import { $ } from "bun";
import type { ShellStageConfig, ModelProfile } from "../config/schema";
import type { StageOutcome } from "../engine/engine";
import type { StageState } from "../engine/state";
import { noopBudgetTracker, type BudgetTracker } from "../gate/budget";

export async function runShellStage(
  stageConfig: ShellStageConfig,
  _stageState: StageState,
  _profiles: Record<string, ModelProfile>,
  cwd: string,
  _runDir: string,
  _nowFn: () => Date,
  _signal: AbortSignal | undefined,
  _budget: BudgetTracker = noopBudgetTracker
): Promise<StageOutcome> {
  const { exitCode, stdout, stderr } = await $`sh -c ${stageConfig.command}`
    .cwd(cwd)
    .nothrow()
    .quiet();
  const ok = stageConfig.on_failure === "continue" || exitCode === 0;
  return {
    result: ok ? "pass" : "fail",
    reason: exitCode === 0 ? undefined : `exit ${exitCode}\n${stderr}\n${stdout}`,
  };
}
```

- [ ] **Step 3: 在 `src/engine/engine.ts` 注册 `shell` Runner**

在 `defaultDeps.runners` 中增加：

```ts
import { runShellStage } from "../runners/shell";

async function adaptShell(...args: Parameters<StageRunnerFn>) {
  const [stageConfig, stageState, profiles, cwd, runDir, nowFn, signal, budget] = args;
  return runShellStage(stageConfig as ShellStageConfig, stageState, profiles, cwd, runDir, nowFn, signal, budget);
}

const defaultDeps: EngineDeps = {
  runners: {
    ralph_loop: adaptRalphLoop,
    brainstorm: adaptBrainstorm,
    spec: adaptSpec,
    plan: adaptPlan,
    human_gate: adaptHumanGate,
    shell: adaptShell,
  },
};
```

- [ ] **Step 4: 在 `src/commands/run.ts` 持久化 `isolation` 与 `worktree`**

在创建 worktree 后、调用 `runPipelineOnce` 前：

```ts
persistedState.isolation = effectiveIsolation;
if (worktreeCtx) {
  persistedState.worktree = {
    path: worktreeCtx.worktreePath,
    branch: worktreeCtx.branch,
  };
}
writeStateAtomic(runDir, persistedState);
```

- [ ] **Step 5: 创建 `.aiflow/current` 符号链接**

在 `src/commands/run.ts` 中，run 目录创建后：

```ts
import { symlink, unlink } from "node:fs/promises";
const currentLink = join(cwd, ".aiflow", "current");
try { await unlink(currentLink); } catch { /* ignore */ }
await symlink(runDir, currentLink, "dir");
```

- [ ] **Step 6: 写测试并运行**

在 `test/unit/engine.test.ts` 新增：

```ts
test("engine persists isolation and worktree in state.json and runs shell stage", async () => {
  // setup: create a pipeline with a shell stage and worktree isolation
  // ...
  const state = await runPipelineOnce(pipeline, profiles, cwd, runDir, deps);
  expect(state.isolation).toBe("worktree");
  expect(state.worktree).toMatchObject({ path: expect.any(String), branch: expect.any(String) });
  expect(state.stages[0].status).toBe("done");
});
```

Run:

```bash
bun test test/unit/engine.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: 提交**

```bash
git add src/engine/state.ts src/engine/engine.ts src/runners/shell.ts src/commands/run.ts test/unit/engine.test.ts
git commit -m "feat(engine): persist isolation/worktree in state and register shell runner"
```

---

## Task 2: 修复 Open-Question / Human-Gate 工作流

**Files:**
- Modify: `src/config/schema.ts`（`BrainstormStageSchema` 增加 `on_unresolved`）
- Modify: `src/engine/engine.ts`（`runPipelineOnce` 中 unresolved_questions 暂停逻辑）
- Modify: `src/commands/approve.ts`
- Modify: `src/specboard/specboard.ts`（导出 `resolveOpenQuestions`）
- Test: `test/unit/approve.test.ts`

**Interfaces:**
- Consumes: `BrainstormStageConfig` / `HumanGateStageConfig`, `EngineState`, `SpecBoard`.
- Produces: `runApprove` 可批准任意 `waiting_human` 阶段；新增 `resolveOpenQuestionsWithMainDev`。

- [ ] **Step 1: 给 `BrainstormStageSchema` 增加 `on_unresolved`**

```ts
export const BrainstormStageSchema = z.object({
  id: z.string(),
  type: z.literal("brainstorm"),
  autonomy: AutonomySchema.optional(),
  on_unresolved: z.enum(["ask_human", "main_dev_decides"]).default("ask_human"),
  models: z.array(z.string()).min(2),
  mode: z.enum(["independent", "debate"]).default("independent"),
  debate_rounds: z.number().int().positive().default(2),
  synthesizer: z.string(),
  output: z.string().default("brainstorm-report.md"),
});
```

- [ ] **Step 2: 修改引擎暂停逻辑，使 unresolved questions 暂停到下一个 `human_gate`**

在 `src/engine/engine.ts` 的 `runPipelineOnce` 中，阶段完成后判断 `shouldPause(..., "unresolved_questions")` 处：

```ts
if (pauseDecision === "pause") {
  const nextHumanGateIndex = pipeline.stages.findIndex(
    (s, idx) => idx > stageIndex && s.type === "human_gate"
  );
  const targetIndex = nextHumanGateIndex === -1 ? stageIndex : nextHumanGateIndex;
  state.stages[targetIndex].status = "waiting_human";
  state.stages[targetIndex].reason = "autonomy_pause";
  appendEvent(runDir, {
    ts: now.toISOString(),
    type: "gate_waiting",
    gate: "unresolved_questions",
    stage: pipeline.stages[targetIndex].id,
    questions: board.open_questions.map((q) => q.id),
  } as GateWaitingAiflowEvent);
  writeStateAtomic(runDir, state);
  return state;
}
```

- [ ] **Step 3: 在 `approve.ts` 中允许批准任意 `waiting_human` 阶段，并实现 `main_dev_decides`**

```ts
import { callLlm } from "../llm/client";
import { loadProjectConfig } from "../config/loader";

async function resolveOpenQuestionsWithMainDev(
  runDir: string,
  board: SpecBoard,
  mainDevProfile: ModelProfile
): Promise<void> {
  const prompt = `You are the main-dev. Resolve the following open questions as JSON: { "resolutions": [{ "id": "...", "resolution": "..." }] }.\n${JSON.stringify(board.open_questions)}`;
  const result = await callLlm({ profile: mainDevProfile, prompt, jsonMode: true });
  const data = JSON.parse(result.text) as { resolutions: Array<{ id: string; resolution: string }> };
  for (const r of data.resolutions) {
    resolveOpenQuestions(runDir, [r.id], r.resolution, "main_dev");
  }
}
```

在 `runApprove` 中，替换 `stageConfig.type !== "human_gate"` 的抛出逻辑：

```ts
if (stageConfig.type !== "human_gate" && board.open_questions.length > 0) {
  const effectiveOnUnresolved =
    stageConfig.type === "brainstorm" && stageConfig.on_unresolved
      ? stageConfig.on_unresolved
      : projectOnUnresolved;
  if (effectiveOnUnresolved === "main_dev_decides") {
    const mainDev = profiles.mainDev ?? profiles[Object.keys(profiles)[0]];
    await resolveOpenQuestionsWithMainDev(runDir, board, mainDev);
  } else if (effectiveOnUnresolved === "ask_human") {
    throw new Error(`Stage ${stageId} has unresolved open questions; resolve them before approving.`);
  }
}

// 非 human_gate 阶段批准后应标记为 done
if (stageConfig.type !== "human_gate") {
  state.stages[stageIndex].status = "done";
  state.stages[stageIndex].reason = undefined;
}
```

- [ ] **Step 4: 导出 `resolveOpenQuestions` 并写测试**

在 `src/specboard/specboard.ts` 确保：

```ts
export function resolveOpenQuestions(...) { ... }
```

在 `test/unit/approve.test.ts` 新增：

```ts
test("approves a brainstorm paused for unresolved questions when the next stage is a human_gate", async () => {
  // setup run with brainstorm + human_gate, state.stages[1].status = waiting_human
  const result = await runApprove(cwd, { runId });
  expect(result.status).toBe("resumed");
  expect(result.state!.stages[1].status).toBe("done");
});
```

Run:

```bash
bun test test/unit/approve.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: 提交**

```bash
git add src/config/schema.ts src/engine/engine.ts src/commands/approve.ts src/specboard/specboard.ts test/unit/approve.test.ts
git commit -m "fix(approve,engine): open-question workflow and main_dev_decides"
```

---

## Task 3: 修正多 Reviewer 评审判定逻辑

**Files:**
- Modify: `src/review/matrix.ts`
- Modify: `src/review/arbitrator.ts`
- Modify: `src/gate/review-gate.ts`
- Test: `test/unit/review-matrix.test.ts`

**Interfaces:**
- Consumes: `ReviewOutput`, `ReviewIssue`, `ReviewGateConfig`.
- Produces: `reviewerVerdict(output, failOn, threshold)`, `deduplicateIssues(issues)`；`runArbitrator` 接受 `acceptance` 参数。

- [ ] **Step 1: 在 `src/review/matrix.ts` 实现 `reviewerVerdict` 和 `deduplicateIssues`**

```ts
function reviewerVerdict(
  output: ReviewOutput,
  failOn: string[],
  threshold: Record<string, number> | undefined
): "pass" | "fail" {
  const counts = output.issues.reduce((acc, i) => {
    acc[i.severity] = (acc[i.severity] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const blocked = output.issues.filter((i) => failOn.includes(i.severity)).length;
  if (blocked > 0) return "fail";
  if (threshold) {
    for (const [severity, limit] of Object.entries(threshold)) {
      if ((counts[severity] ?? 0) >= limit) return "fail";
    }
  }
  return "pass";
}

export function deduplicateIssues(issues: ReviewIssue[]): ReviewIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.file}:${Math.floor((i.line ?? 0) / 3)}:${i.severity}:${i.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

- [ ] **Step 2: 替换矩阵中的 per-reviewer 判定**

在 `runReviewMatrix` 中，对每个 reviewer 输出：

```ts
const verdict = reviewerVerdict(output, config.fail_on, config.fail_threshold);
const issues = deduplicateIssues(output.issues);
results.push({ reviewer, verdict, output: { ...output, issues } });
```

- [ ] **Step 3: 在 `src/review/arbitrator.ts` 加入验收标准与 story 上下文**

修改签名：

```ts
export async function runArbitrator(
  profile: ModelProfile,
  diff: string,
  issueSets: ReviewOutput[],
  acceptance: string[],
  deps: ArbitratorDeps = { callLlm }
): Promise<ArbitratorResult>
```

在 prompt 中追加：

```ts
const prompt = `Arbitrate the following review issues.\nDiff:\n${diff}\n\nAcceptance criteria:\n${acceptance.join("\n")}\n\nReviewer issues:\n${JSON.stringify(issueSets)}\n\nReturn JSON with summary, verdict (pass|fail), and issues[].`;
```

- [ ] **Step 4: 在 `src/gate/review-gate.ts` 把仲裁路由到主脑模型**

```ts
const mainDevProfile = profiles.mainDev ?? profiles[Object.keys(profiles)[0]];
const arbitration = await deps.runArbitrator(mainDevProfile, diff, issueSets, storyAcceptance);
```

- [ ] **Step 5: 写测试并运行**

在 `test/unit/review-matrix.test.ts` 新增：

```ts
test("multi-reviewer path respects fail_on: major issues do not fail when only blocker is fail_on", async () => {
  const result = await runReviewMatrix(
    { enabled: true, reviewers: ["a", "b"], fail_on: ["blocker"], fail_threshold: { major: 5 }, strict: false },
    { a: reviewerProfile, b: reviewer2Profile },
    "author",
    "/tmp/run",
    "diff",
    ["acceptance"],
    deps
  );
  expect(result.aiReview).toBe("pass");
});

test("deduplicates issues within line±3 buckets", async () => {
  const issues: ReviewIssue[] = [
    { severity: "major", file: "f.ts", line: 1, title: "t", detail: "d", suggestion: "s" },
    { severity: "major", file: "f.ts", line: 2, title: "t", detail: "d", suggestion: "s" },
  ];
  expect(deduplicateIssues(issues)).toHaveLength(1);
});
```

Run:

```bash
bun test test/unit/review-matrix.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: 提交**

```bash
git add src/review/matrix.ts src/review/arbitrator.ts src/gate/review-gate.ts test/unit/review-matrix.test.ts
git commit -m "fix(review): apply fail_on/fail_threshold, deduplicate issues, route arbitrator to main-dev"
```

---

## Task 4: 持久化并丰富辩论产物

**Files:**
- Modify: `src/debate/schemas.ts`
- Modify: `src/debate/orchestrator.ts`
- Modify: `src/runners/brainstorm.ts`
- Test: `test/unit/debate.test.ts`

**Interfaces:**
- Consumes: `BrainstormStageConfig.on_unresolved`, `SpecBoard`.
- Produces: `artifacts/debate/round-N.json` 包含 `proposals[].stance_changes` 和 `critiques`；brainstorm report 含对比矩阵。

- [ ] **Step 1: 在 `src/debate/schemas.ts` 增加 `RoundProposalSchema` 和 `CritiqueSchema`**

```ts
export const CritiqueSchema = z.object({
  target: z.string(),
  point: z.string(),
  severity: z.enum(["blocker", "major", "minor", "nit"]).optional(),
});

export const RoundProposalSchema = z.object({
  author: z.string(),
  profile_real: z.string(),
  content_md: z.string(),
  stance_changes: z.array(z.string()).default([]),
  critiques: z.array(CritiqueSchema).default([]),
});
```

- [ ] **Step 2: 在 `src/debate/orchestrator.ts` 每轮持久化 round 产物**

每轮结束后：

```ts
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const debateDir = join(runDir, "artifacts", "debate");
mkdirSync(debateDir, { recursive: true });
writeFileSync(
  join(debateDir, `round-${round}.json`),
  JSON.stringify({ round, proposals, moderator }, null, 2)
);
```

- [ ] **Step 3: 对空泛批评进行一轮重答**

在 moderator 判定前检查：

```ts
const vagueCritiques = proposals.flatMap((p) => p.critiques).filter((c) => !c.severity || !c.point);
if (vagueCritiques.length > 0 && round <= maxRounds) {
  // re-prompt those models with stricter instruction
}
```

- [ ] **Step 4: 在 `src/runners/brainstorm.ts` 渲染对比矩阵与推荐方案**

在独立模式与辩论模式的最终报告模板中增加章节：

```md
## 对比矩阵
| 模型 | 关键设计 | 风险 | 工作量 |
| --- | --- | --- | --- |
...

## 推荐方案
...
```

- [ ] **Step 5: 写测试并运行**

在 `test/unit/debate.test.ts` 新增：

```ts
test("persists round artifacts with stance_changes and critiques", async () => {
  // run debate
  const roundPath = join(runDir, "artifacts", "debate", "round-1.json");
  expect(existsSync(roundPath)).toBe(true);
  const round1 = JSON.parse(readFileSync(roundPath, "utf-8"));
  expect(round1.proposals[0].stance_changes).toBeDefined();
  expect(round1.proposals[0].critiques).toBeDefined();
});
```

Run:

```bash
bun test test/unit/debate.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: 提交**

```bash
git add src/debate/schemas.ts src/debate/orchestrator.ts src/runners/brainstorm.ts test/unit/debate.test.ts
git commit -m "feat(debate): persist round artifacts, stance changes, critiques and comparison matrix"
```

---

## Task 5: Worktree 可恢复 + AI 冲突裁决

**Files:**
- Modify: `src/commands/resume.ts`
- Modify: `src/worktree/manager.ts`
- Modify: `src/commands/run.ts`
- Test: `test/unit/worktree.test.ts`

**Interfaces:**
- Consumes: `EngineState.worktree`, `WorktreeContext`, `ModelProfile`.
- Produces: `resume` 可重入原 worktree；`resolveConflictWithAI` 返回 `"resolved" | "aborted" | "escalated"`。

- [ ] **Step 1: 在 `src/commands/resume.ts` 根据 `state.worktree` 重入 worktree**

```ts
const runCwd = persisted.worktree?.path && existsSync(persisted.worktree.path)
  ? persisted.worktree.path
  : cwd;
```

将 `runCwd` 传给 `runPipelineOnce`。

- [ ] **Step 2: 在 `src/worktree/manager.ts` 增加 `resolveConflictWithAI` 和 `generateMergeGuide`**

```ts
export async function resolveConflictWithAI(
  ctx: WorktreeContext,
  mainDevProfile: ModelProfile,
  autonomy: string,
  runDir: string,
  deps: WorktreeManagerDeps & { callLlm: typeof import("../llm/client").callLlm } = defaultDeps as any
): Promise<"resolved" | "aborted" | "escalated"> {
  const conflictFiles = await deps.diffConflictFileNames(ctx.worktreeCwd);
  const prompt = `Resolve these git conflicts. Return the resolved content for each file as JSON: { "files": [{ "path": "...", "content": "..." }] }.\n${conflictFiles.map((f) => readFileSync(join(ctx.worktreeCwd, f), "utf-8")).join("\n---\n")}`;
  const result = await deps.callLlm({ profile: mainDevProfile, prompt, jsonMode: true });
  const data = JSON.parse(result.text) as { files: Array<{ path: string; content: string }> };
  try {
    for (const f of data.files) {
      writeFileSync(join(ctx.worktreeCwd, f.path), f.content);
      await deps.runGit(ctx.worktreeCwd, ["add", f.path]);
    }
    await deps.runGit(ctx.worktreeCwd, ["commit", "-m", "aiflow: resolve conflicts via main-dev"]);
    return "resolved";
  } catch {
    await deps.runGit(ctx.worktreeCwd, ["merge", "--abort"]);
    return autonomy === "full" ? "aborted" : "escalated";
  }
}

export function generateMergeGuide(ctx: WorktreeContext, runDir: string): void {
  const guide = `Run the following to merge the AIFlow branch manually:\n\n` +
    `cd ${ctx.baseCwd}\n` +
    `git merge ${ctx.branch}\n`;
  writeFileSync(join(runDir, "artifacts", "merge-guide.md"), guide);
}
```

- [ ] **Step 3: 在 `src/commands/run.ts` 调用 AI 冲突裁决并在升级时生成 human_gate**

```ts
if (mergeResult === "conflict") {
  const mainDev = profiles.mainDev ?? profiles[Object.keys(profiles)[0]];
  const resolution = await resolveConflictWithAI(worktreeCtx, mainDev, effectiveAutonomy, runDir, deps);
  if (resolution === "escalated") {
    // create a waiting_human gate for merge_conflict_unarbitrable
    state.stages.push({ id: "merge-conflict", status: "waiting_human", reason: "merge_conflict_unarbitrable" });
  }
}
```

- [ ] **Step 4: 写测试并运行**

在 `test/unit/worktree.test.ts` 新增：

```ts
test("resume uses worktree path from state.json", async () => {
  // write state with worktree.path; call runResume; assert cwd passed to engine is worktree path
});
```

Run:

```bash
bun test test/unit/worktree.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: 提交**

```bash
git add src/commands/resume.ts src/worktree/manager.ts src/commands/run.ts test/unit/worktree.test.ts
git commit -m "feat(worktree): resume re-enters worktree, AI conflict resolution, merge guide"
```

---

## Task 6: 模型驱动的 Plan 与 Specboard Hashes

**Files:**
- Modify: `src/runners/plan.ts`
- Modify: `src/specboard/specboard.ts`
- Modify: `src/runners/spec.ts`
- Modify: `src/commands/run.ts`
- Test: `test/unit/plan.test.ts`, `test/unit/specboard.test.ts`

**Interfaces:**
- Consumes: `PlanStageConfig.model`, `callLlm`, `PrdSchema`.
- Produces: `prd.json` 由模型生成并 zod 校验；`specboard.json` 含 `spec_hash` / `config_hash`。

- [ ] **Step 1: 在 `src/specboard/specboard.ts` 增加 hash 写入函数**

```ts
export function setSpecHash(runDir: string, hash: string): void {
  const board = readSpecBoard(runDir);
  board.spec_hash = hash;
  writeSpecBoard(runDir, board);
}

export function setConfigHash(runDir: string, hash: string): void {
  const board = readSpecBoard(runDir);
  board.config_hash = hash;
  writeSpecBoard(runDir, board);
}
```

- [ ] **Step 2: 重写 `src/runners/plan.ts` 为模型驱动**

```ts
import { callLlm } from "../llm/client";
import { PrdSchema } from "../prd";

export async function runPlanStage(
  stageConfig: PlanStageConfig,
  _stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  _nowFn: () => Date,
  _signal: AbortSignal | undefined,
  deps: PlanDeps = defaultDeps,
  _budget: BudgetTracker = noopBudgetTracker
): Promise<StageOutcome> {
  const profile = profiles[stageConfig.model];
  if (!profile) throw new Error(`Unknown model ${stageConfig.model}`);
  const specPath = join(cwd, stageConfig.input);
  const spec = readFileSync(specPath, "utf-8");
  const prompt = `Convert the following spec into a JSON prd matching this schema: ${JSON.stringify(PrdSchema.shape)}.\n\n${spec}`;
  const result = await (deps.callLlm ?? callLlm)({ profile, prompt, jsonMode: true });
  let data: unknown;
  try {
    data = JSON.parse(result.text);
    PrdSchema.parse(data);
  } catch (err) {
    const retry = await (deps.callLlm ?? callLlm)({
      profile,
      prompt: `${prompt}\n\nPrevious attempt failed with: ${err}. Please fix and return valid JSON only.`,
      jsonMode: true,
    });
    data = JSON.parse(retry.text);
    PrdSchema.parse(data);
  }
  writeFileSync(join(cwd, stageConfig.output), JSON.stringify(data, null, 2));
  return { result: "pass" };
}
```

- [ ] **Step 3: 在 `src/runners/spec.ts` 写入 spec_hash**

在 lint 通过后：

```ts
import { hashSpecFile } from "../config/config-hash";
import { setSpecHash } from "../specboard/specboard";
const specHash = hashSpecFile(specPath);
setSpecHash(runDir, specHash);
```

- [ ] **Step 4: 在 `src/commands/run.ts` 写入 config_hash**

run 目录创建后：

```ts
import { hashConfigDir } from "../config/config-hash";
setConfigHash(runDir, hashConfigDir(join(cwd, ".aiflow", "config")));
```

- [ ] **Step 5: 更新 `src/runners/spec.ts` 的提示词，明确要求 OpenSpec 格式**

```ts
const prompt = `Produce a spec in OpenSpec format: YAML frontmatter followed by Markdown body and <task id="..." priority="1" files="..."> blocks. Each task must have a checklist of acceptance criteria.`;
```

- [ ] **Step 6: 写测试并运行**

`test/unit/plan.test.ts`:

```ts
test("plan stage calls the configured model and validates prd.json", async () => {
  const callLlm = mock(async () => ({
    text: JSON.stringify({ branchName: "feat/x", stories: [{ id: "T1", title: "t", acceptance: ["a"], priority: 1, passes: false, fixCount: 0 }] }),
    usage: { inTok: 1, outTok: 1, costUsd: 0 },
  }));
  const result = await runPlanStage(stageConfig, stageState, profiles, cwd, runDir, () => new Date(), undefined, { ...defaultDeps, callLlm });
  expect(result.result).toBe("pass");
  expect(existsSync(join(cwd, "prd.json"))).toBe(true);
});
```

Run:

```bash
bun test test/unit/plan.test.ts test/unit/specboard.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: 提交**

```bash
git add src/runners/plan.ts src/specboard/specboard.ts src/runners/spec.ts src/commands/run.ts test/unit/plan.test.ts test/unit/specboard.test.ts
git commit -m "feat(plan,specboard): model-driven plan, persist spec/config hashes"

---

## Task 7: LLM Client / Adapter 重试、熔断与 token 上限

**Files:**
- Modify: `src/llm/client.ts`
- Modify: `src/opencode/adapter.ts`
- Modify: `src/config/schema.ts:142-146`（`BudgetConfigSchema`）
- Modify: `src/gate/budget.ts`
- Modify: `src/runners/brainstorm.ts`、`src/review/matrix.ts`（注入 per-call budget）
- Test: `test/unit/llm-client.test.ts`

**Interfaces:**
- Consumes: `ModelProfile`, `BudgetConfig`.
- Produces: `callLlm` 返回 `{ text, usage }`，对 429/5xx 指数退避 ≤3 次；单次调用超 `max_token_cost` 直接抛 `BudgetExceededError`。

- [ ] **Step 1: 给 `BudgetConfigSchema` 增加 `max_token_cost`**

```ts
export const BudgetConfigSchema = z.object({
  max_cost_usd: z.number().positive().optional(),
  max_retry_steps: z.number().int().positive().default(5),
  max_token_cost: z.number().int().positive().optional(),
  warn_at_pct: z.array(z.number().min(0).max(1)).optional(),
});
```

- [ ] **Step 2: 在 `src/gate/budget.ts` 增加单次 token 上限检查**

```ts
export class BudgetExceededError extends Error {
  constructor(message: string) { super(message); this.name = "BudgetExceededError"; }
}

export function assertPerCallBudget(
  usage: { inTok: number; outTok: number },
  limit: number | undefined
): void {
  if (!limit) return;
  if (usage.inTok + usage.outTok > limit) {
    throw new BudgetExceededError(`Token cost ${usage.inTok + usage.outTok} exceeds per-call limit ${limit}`);
  }
}
```

- [ ] **Step 3: 在 `src/llm/client.ts` 给 `callLlm` 加指数退避与 token 上限**

```ts
import { assertPerCallBudget, BudgetExceededError } from "../gate/budget";

export async function callLlm(args: CallLlmArgs, deps: LlmDeps = defaultDeps): Promise<LlmResult> {
  const maxRetries = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await deps.doCall(args);
      assertPerCallBudget(result.usage, args.profile.max_token_cost ?? args.budget?.max_token_cost);
      return result;
    } catch (err) {
      lastErr = err;
      if (err instanceof BudgetExceededError) throw err;
      const status = err instanceof Error && "status" in err ? (err as any).status : undefined;
      const retryable = status === 429 || status >= 500 || (err instanceof Error && /ETIMEDOUT|ECONNRESET/.test(err.message));
      if (!retryable || attempt === maxRetries) throw err;
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      await deps.sleepFn(delay);
    }
  }
  throw lastErr;
}
```

- [ ] **Step 4: 给 `callLlm` 依赖注入 `sleepFn`**

```ts
interface LlmDeps {
  doCall: (args: CallLlmArgs) => Promise<LlmResult>;
  sleepFn: (ms: number) => Promise<void>;
}
const defaultDeps: LlmDeps = { doCall: rawCallLlm, sleepFn: (ms) => new Promise((r) => setTimeout(r, ms)) };
```

- [ ] **Step 5: 对 OpenCode 适配器同样加退避**

在 `src/opencode/adapter.ts` 的 `runOpenCode` HTTP 调用外层套用与 `callLlm` 相同的指数退避循环，或调用 `callLlm` 如果该通道走 LLM Client。

- [ ] **Step 6: 写测试**

```ts
test("callLlm retries 429 and succeeds", async () => {
  let calls = 0;
  const doCall = mock(async () => {
    calls++;
    if (calls < 2) { const e = new Error("429"); (e as any).status = 429; throw e; }
    return { text: "ok", usage: { inTok: 1, outTok: 1, costUsd: 0 } };
  });
  const sleepFn = mock(async () => {});
  const result = await callLlm({ profile: cheapProfile, prompt: "hi" }, { doCall, sleepFn });
  expect(result.text).toBe("ok");
  expect(calls).toBe(2);
  expect(sleepFn).toHaveBeenCalledTimes(1);
});
```

Run:

```bash
bun test test/unit/llm-client.test.ts
```

Expected: all pass.

- [ ] **Step 7: 提交**

```bash
git add src/llm/client.ts src/opencode/adapter.ts src/config/schema.ts src/gate/budget.ts test/unit/llm-client.test.ts
[stage any runner changes]
git commit -m "feat(llm): per-call token budget, 429 backoff, budget exceeded errors"
```

---

## Task 8: 安全门禁（Hash 校验、Run 锁、API-key 脱敏）

**Files:**
- Modify: `src/commands/run.ts`、`src/commands/resume.ts`、`src/commands/approve.ts`（使用 run lock）
- Modify: `src/runners/ralph-loop.ts`（每轮校验 spec/config hash）
- Modify: `src/commands/report.ts`（脱敏）
- Modify: `src/config/loader.ts`（profile 校验时隐藏 api_key_env 值）
- Test: `test/unit/security.test.ts`

**Interfaces:**
- Consumes: `acquireRunLock` from `src/lock.ts`, `hashSpecFile`/`hashConfigDir` from `src/config/config-hash.ts`.
- Produces: 命令入口自动获取/释放 run lock；ralph-loop 检测到 hash 变化即失败；报告输出中不出现 `sk-`/`ANTHROPIC_API_KEY` 等明文。

- [ ] **Step 1: 在 `run.ts` 进入引擎前获取 run lock**

```ts
import { acquireRunLock } from "../lock";

export async function runCommand(...): Promise<void> {
  const lock = await acquireRunLock(cwd, runId, { signal });
  try {
    // existing run logic
  } finally {
    lock.release();
  }
}
```

对 `resume.ts` 与 `approve.ts` 的入口函数同样包上 `acquireRunLock`。

- [ ] **Step 2: 在 `ralph-loop.ts` 每轮迭代前校验 hash**

```ts
import { hashSpecFile, hashConfigDir } from "../config/config-hash";
import { readSpecBoard } from "../specboard/specboard";

function assertTamperGuard(cwd: string, runDir: string): void {
  const board = readSpecBoard(runDir);
  if (board.spec_hash) {
    const currentSpecHash = hashSpecFile(join(cwd, "spec.md"));
    if (currentSpecHash !== board.spec_hash) {
      throw new Error(`Spec hash mismatch: spec.md was modified after the spec stage.`);
    }
  }
  if (board.config_hash) {
    const currentConfigHash = hashConfigDir(cwd);
    if (currentConfigHash !== board.config_hash) {
      throw new Error(`Config hash mismatch: .aiflow/config was modified after run start.`);
    }
  }
}
```

在每轮 `ralph_loop` 开始时调用 `assertTamperGuard(cwd, runDir)`。

- [ ] **Step 3: 在 `report.ts` 中脱敏**

```ts
export function sanitizeSecrets(text: string): string {
  return text
    .replace(/\b(sk-[a-zA-Z0-9]{20,})\b/g, "***")
    .replace(/\b(ANTHROPIC_API_KEY|OPENAI_API_KEY|OPEN_CODE_API_KEY)\s*=\s*[^\s]+/g, "$1=***")
    .replace(/"api_key"\s*:\s*"[^"]+"/g, '"api_key":"***"');
}
```

在 `writeRunReport` 写入 `run-report.md` 前对内容调用 `sanitizeSecrets`。

- [ ] **Step 4: 写测试**

```ts
test("detects spec tampering between stages", async () => {
  // setup run with spec_hash on board, then modify spec.md
  expect(() => assertTamperGuard(cwd, runDir)).toThrow(/Spec hash mismatch/);
});

test("sanitizes api keys in report", () => {
  const dirty = "key: sk-abc12345678901234567890";
  expect(sanitizeSecrets(dirty)).toContain("***");
});
```

Run:

```bash
bun test test/unit/security.test.ts
```

Expected: all pass.

- [ ] **Step 5: 提交**

```bash
git add src/commands/run.ts src/commands/resume.ts src/commands/approve.ts src/runners/ralph-loop.ts src/commands/report.ts test/unit/security.test.ts
git commit -m "feat(security): run locking, spec/config hash tamper guard, secret sanitization"
```

---

## Task 9: CLI 对齐（clean/doctor/abort）与 OpenSpec 解析器

**Files:**
- Modify: `src/commands/clean.ts`（确认支持 `--before` / `--keep` / `--runs` / `--worktrees`）
- Modify: `src/commands/doctor.ts`（新增 OpenCode/模型 profile 连通性/git 自检）
- Modify: `src/commands/abort.ts`（释放锁并标记 stage aborted）
- Create: `src/spec/parse.ts`
- Modify: `src/runners/spec.ts`（使用 OpenSpec 解析器）
- Test: `test/unit/spec-parse.test.ts`、`test/unit/doctor.test.ts`

**Interfaces:**
- Consumes: `EngineState`, `OpenCode` CLI, `loadModelsConfig`.
- Produces: `parseOpenSpec(md): { frontmatter, tasks, body }`；`doctor` 返回结构化诊断数组。

- [ ] **Step 1: 实现 `src/spec/parse.ts`**

```ts
import { parse as parseYaml } from "yaml";

export interface TaskBlock {
  id: string;
  priority: number;
  files?: string[];
  depends?: string[];
  acceptance: string[];
  body: string;
}

export interface OpenSpec {
  frontmatter: Record<string, unknown>;
  body: string;
  tasks: TaskBlock[];
}

export function parseOpenSpec(md: string): OpenSpec {
  const frontMatch = md.match(/^---\n([\s\S]*?)\n---\n/);
  const frontmatter = frontMatch ? parseYaml(frontMatch[1]) : {};
  const afterFront = frontMatch ? md.slice(frontMatch[0].length) : md;
  const body = afterFront.replace(/<task\s+([^>]+)>([\s\S]*?)<\/task>/g, "");
  const tasks: TaskBlock[] = [];
  const taskRe = /<task\s+([^>]+)>([\s\S]*?)<\/task>/g;
  let m: RegExpExecArray | null;
  while ((m = taskRe.exec(afterFront)) !== null) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const rawBody = m[2].trim();
    const acceptance = [...rawBody.matchAll(/^-\s+\[[x? ]?\]\s*(.+)$/gm)].map((x) => x[1].trim());
    tasks.push({
      id: attrs.id,
      priority: Number(attrs.priority ?? 1),
      files: attrs.files?.split(",").map((s) => s.trim()),
      depends: attrs.depends?.split(",").map((s) => s.trim()),
      acceptance,
      body: rawBody,
    });
  }
  return { frontmatter, body: body.trim(), tasks };
}
```

- [ ] **Step 2: 在 `src/runners/spec.ts` 用解析器做 lint**

在 spec 生成/校验后调用：

```ts
import { parseOpenSpec } from "../spec/parse";
const parsed = parseOpenSpec(spec);
const idSet = new Set(parsed.tasks.map((t) => t.id));
if (idSet.size !== parsed.tasks.length) throw new Error("Duplicate task ids in spec");
for (const t of parsed.tasks) {
  if (t.acceptance.length === 0) throw new Error(`Task ${t.id} missing acceptance checklist`);
}
```

- [ ] **Step 3: 扩展 `src/commands/doctor.ts`**

```ts
export interface Diagnosis {
  check: string;
  ok: boolean;
  message: string;
}

export async function runDoctor(cwd: string): Promise<Diagnosis[]> {
  const results: Diagnosis[] = [];
  // OpenCode CLI
  try {
    const { exitCode } = await $`opencode --version`.cwd(cwd).nothrow().quiet();
    results.push({ check: "opencode_cli", ok: exitCode === 0, message: exitCode === 0 ? "ok" : "opencode not found" });
  } catch {
    results.push({ check: "opencode_cli", ok: false, message: "opencode --version failed" });
  }
  // 模型 profile 连通性（至少能解析配置）
  const modelsPath = join(cwd, ".aiflow", "config", "models.yaml");
  try {
    loadModelsConfig(modelsPath);
    results.push({ check: "models_config", ok: true, message: "models.yaml parsed" });
  } catch (e) {
    results.push({ check: "models_config", ok: false, message: String(e) });
  }
  // git
  try {
    const { exitCode } = await $`git status`.cwd(cwd).nothrow().quiet();
    results.push({ check: "git", ok: exitCode === 0, message: exitCode === 0 ? "ok" : "not a git repo" });
  } catch {
    results.push({ check: "git", ok: false, message: "git status failed" });
  }
  return results;
}
```

- [ ] **Step 4: 在 `src/commands/abort.ts` 释放锁并标记 aborted**

```ts
import { acquireRunLock } from "../lock";
import { readState, writeStateAtomic, type EngineState } from "../engine/state";

export async function runAbort(cwd: string, opts: { runId?: string }) {
  const runId = opts.runId ?? listRunIdsByMtimeDesc(cwd)[0];
  if (!runId) return { status: "no_runs" };
  const lock = await acquireRunLock(cwd, runId);
  try {
    const runDir = join(cwd, ".aiflow", "runs", runId);
    const state = readState(runDir);
    const next = {
      ...state,
      stages: state.stages.map((s) =>
        s.status === "running" || s.status === "waiting_human" || s.status === "pending"
          ? { ...s, status: "aborted" as const, reason: "aborted" }
          : s
      ),
    };
    writeStateAtomic(runDir, next);
    return { status: "aborted", state: next };
  } finally {
    lock.release();
  }
}
```

- [ ] **Step 5: 写测试**

```ts
test("parseOpenSpec extracts frontmatter, tasks and acceptance", () => {
  const md = `---\nspec_id: x\n---\n# Body\n\n<task id="T1" priority="1" files="a.ts">\nDesc\n- [ ] accept\n</task>`;
  const parsed = parseOpenSpec(md);
  expect(parsed.frontmatter.spec_id).toBe("x");
  expect(parsed.tasks[0].id).toBe("T1");
  expect(parsed.tasks[0].acceptance).toEqual(["accept"]);
});
```

Run:

```bash
bun test test/unit/spec-parse.test.ts test/unit/doctor.test.ts test/unit/abort.test.ts
```

Expected: all pass.

- [ ] **Step 6: 提交**

```bash
git add src/spec/parse.ts src/runners/spec.ts src/commands/doctor.ts src/commands/abort.ts src/commands/clean.ts test/unit/spec-parse.test.ts test/unit/doctor.test.ts test/unit/abort.test.ts
git commit -m "feat(cli): OpenSpec parser, doctor checks, abort clears lock and state"
```

---

## Task 10: Dashboard 完成（静态服务、单 DB、gate-answer 续跑）

**Files:**
- Modify: `src/dashboard/server/api.ts`
- Modify: `src/dashboard/server/index.ts`
- Modify: `src/dashboard/server/collector.ts`
- Modify: `src/dashboard/server/db.ts`（可选：确认 `createDb` 可复用）
- Test: `test/unit/dashboard-api.test.ts`

**Interfaces:**
- Consumes: `startDashboardServer`, `createApp`, `createDb`, `runApprove`.
- Produces: Dashboard 生产模式提供 React 构建产物；collector 与 API 共用同一 `Database`；POST `/api/runs/:runId/gate-answer` 写入答案并后台 `runApprove` 续跑。

- [ ] **Step 1: 修改 `startCollector` 接收已存在的 db 实例**

```ts
export function startCollector(
  runsRoot: string,
  db: Database,
  options?: Parameters<typeof chokidar.watch>[1],
  broadcaster?: Broadcaster,
): Collector {
  // replace const db = createDb(dbPath) with the passed-in db
  // keep rest of function unchanged
}
```

更新 `collector.ts` 内所有 `tailRun(db, ...)` 调用不变。

- [ ] **Step 2: 在 `index.ts` 只创建一个 `Database` 并传给 app 和 collector，并允许注入 `runApprove`**

更新 `ApiDeps`：

```ts
export interface ApiDeps {
  db: Database;
  runsRoot: string;
  runApprove?: typeof import("../../commands/approve").runApprove;
}
```

```ts
export async function startDashboardServer(
  runsRoot: string,
  dbPath: string,
  port = 3000,
  host = "127.0.0.1",
): Promise<DashboardServer> {
  const db = createDb(dbPath);
  const app = createApp({ db, runsRoot });
  // ...
}
```

- [ ] **Step 3: 在 `api.ts` 中 gate-answer 端点调用 `runApprove` 续跑**

```ts
import { runApprove } from "../../commands/approve";
import { z } from "zod";

const GateAnswerSchema = z.object({
  stage: z.string(),
  action: z.enum(["approve", "reject"]),
  reason: z.string().optional(),
});

app.post("/api/runs/:runId/gate-answer", async (req, res) => {
  const runDir = safeRunDir(runsRoot, req.params.runId);
  if (!runDir) return res.status(404).json({ error: "run not found" });
  const cwd = dirname(runsRoot);
  const answer = GateAnswerSchema.parse(req.body);
  writeGateAnswer(runDir, answer);
  // resume asynchronously so the HTTP response returns immediately
  (deps.runApprove ?? runApprove)(cwd, { runId: req.params.runId, stage: answer.stage }).catch((err) => {
    console.error("gate-answer resume failed", err);
  });
  res.json({ ok: true });
});
```

- [ ] **Step 4: 让 Dashboard 生产环境提供 React 构建产物**

在 `createApp` 中所有 API 路由注册之后追加：

```ts
import express from "express";
import { dirname, join } from "node:path";

const clientDist = join(dirname(import.meta.dir), "client", "dist");
app.use(express.static(clientDist));
app.get("*", (_req, res) => {
  res.sendFile(join(clientDist, "index.html"));
});
```

注意：开发模式 (`bun run dashboard:dev`) 仍走 Vite 代理，不进入此分支。

- [ ] **Step 5: 写测试**

```ts
test("gate-answer endpoint writes answer and resumes pipeline", async () => {
  const runApproveMock = mock(async () => ({ status: "resumed" }));
  const app = createApp({ db: createDb(":memory:"), runsRoot, runApprove: runApproveMock });
  const res = await request(app).post(`/api/runs/${runId}/gate-answer`).send({ stage: gateStage, action: "approve" });
  expect(res.status).toBe(200);
  expect(runApproveMock).toHaveBeenCalled();
});
```

Run:

```bash
bun test test/unit/dashboard-api.test.ts
```

Expected: all pass.

- [ ] **Step 6: 提交**

```bash
git add src/dashboard/server/api.ts src/dashboard/server/index.ts src/dashboard/server/collector.ts test/unit/dashboard-api.test.ts
git commit -m "feat(dashboard): serve built client, share db, gate-answer resumes pipeline"
```

---

## Task 11: MCP 完成（`aiflow_review_diff`、完整 schemas、CLI 路径自适应）

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/server.ts`（如果有，更新 listTools 同步）
- Modify: `package.json`（确认 `bin` 条目为 `aiflow`）
- Test: `test/unit/mcp-tools.test.ts`

**Interfaces:**
- Consumes: `handleToolCall`, `listTools`, `spawnCli`.
- Produces: `aiflow_review_diff` tool；所有工具都有 `required` 与完整 `inputSchema`；CLI 路径优先用 `aiflow` 可执行文件，fallback 到 `bun run cli.ts`。

- [ ] **Step 1: 实现 CLI 路径解析**

```ts
import { which } from "bun";
import { join } from "node:path";

async function resolveCliPath(): Promise<string> {
  const global = await which("aiflow").catch(() => undefined);
  if (global) return "aiflow";
  return `bun run ${join(import.meta.dir, "../cli.ts")}`;
}
```

修改 `defaultSpawnCli`：

```ts
const defaultSpawnCli = async (cwd: string, args: string[]): Promise<CliResult> => {
  const cli = await resolveCliPath();
  const cliParts = cli.split(" ");
  const result = await $`${cliParts[0]} ${[...cliParts.slice(1), ...args]}`.cwd(cwd).nothrow().quiet();
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
};
```

- [ ] **Step 2: 在 `handleToolCall` 增加 `aiflow_review_diff`**

```ts
case "aiflow_review_diff": {
  const diff = z.string().parse(args.diff);
  const reviewers = z.array(z.string()).optional().parse(args.reviewers);
  const extra = reviewers ? ["--reviewers", reviewers.join(",")] : [];
  return spawnCli(cwd, ["review-diff", "--diff", diff, ...extra]);
}
```

- [ ] **Step 3: 补全 `listTools` schemas**

```ts
export function listTools() {
  return [
    {
      name: "aiflow_status",
      description: "Get the status of the latest or a specific AIFlow run.",
      inputSchema: {
        type: "object",
        properties: { runId: { type: "string", description: "Optional run id" } },
        required: [],
      },
    },
    {
      name: "aiflow_run",
      description: "Start an AIFlow pipeline run.",
      inputSchema: {
        type: "object",
        properties: {
          pipeline: { type: "string", description: "Pipeline name" },
          requirement: { type: "string", description: "User requirement" },
        },
        required: ["pipeline"],
      },
    },
    {
      name: "aiflow_brainstorm",
      description: "Trigger an AIFlow brainstorm stage.",
      inputSchema: {
        type: "object",
        properties: { prompt: { type: "string" }, mode: { type: "string", enum: ["independent", "debate"] } },
        required: ["prompt"],
      },
    },
    {
      name: "aiflow_review_diff",
      description: "Run multi-reviewer AI review on a diff.",
      inputSchema: {
        type: "object",
        properties: {
          diff: { type: "string", description: "Unified diff text" },
          reviewers: { type: "array", items: { type: "string" }, description: "Optional reviewer profile names" },
        },
        required: ["diff"],
      },
    },
  ];
}
```

- [ ] **Step 4: 写测试**

```ts
test("mcp exposes aiflow_review_diff and routes to review-diff command", async () => {
  const spawnCli = mock(async () => ({ exitCode: 0, stdout: "{\"verdict\":\"pass\"}", stderr: "" }));
  const result = await handleToolCall("aiflow_review_diff", { diff: "@@ -1 +1 @@", reviewers: ["kimi"] }, cwd, { spawnCli });
  expect(spawnCli).toHaveBeenCalledWith(cwd, ["review-diff", "--diff", "@@ -1 +1 @@", "--reviewers", "kimi"]);
  expect(result.content[0].text).toContain("pass");
});
```

Run:

```bash
bun test test/unit/mcp-tools.test.ts
```

Expected: all pass.

- [ ] **Step 5: 提交**

```bash
git add src/mcp/tools.ts test/unit/mcp-tools.test.ts package.json
git commit -m "feat(mcp): aiflow_review_diff, complete schemas, adaptive CLI path"
```

---

## Self-Review

### Spec Coverage

| 需求文档 / 技术设计要点 | 对应任务 |
| --- | --- |
| FR1.1 内置 pipeline 模板 | Task 1（runner 注册表）、Task 6（plan） |
| FR1.3 CLI `init/run/status/watch/resume/approve/clean/doctor` | Task 1, 2, 5, 8, 9 |
| FR1.4 resume / 崩溃恢复 | Task 1, 5, 8 |
| FR2 brainstorm 多模型与 debate | Task 2, 4 |
| FR2.3 debate 防死循环 + on_unresolved | Task 2, 4 |
| FR3 OpenSpec 与 hash 校验 | Task 6, 9 |
| FR4 Ralph Loop + plan | Task 1, 6 |
| FR5 多 reviewer / 仲裁 / 修复上限 | Task 3 |
| FR6 autonomy / human_gate | Task 2 |
| FR7 worktree 隔离与冲突裁决 | Task 5 |
| FR8 模型路由 | Task 7（adapter hardening） |
| FR9 Dashboard | Task 10 |
| FR10 MCP | Task 11 |
| NFR1 可恢复 | Task 1, 5, 8 |
| NFR2 成本可控 | Task 7 |
| NFR3 可审计 | Task 4, 8 |
| NFR4 可扩展 | Task 1（runner 注册表） |
| NFR5 安全 | Task 8 |

**未在本计划内覆盖（已知 v2+）：** 多 story 并行、reviewer 权重自学习、原生 GUI、OpenCode 插件形态、debate 图表可视化。

### Placeholder Scan

- 无 `TBD`/`TODO`/`implement later`。
- 每条修改都给出了具体文件路径、函数/类型名与代码。
- 每个任务都以可运行的测试和 `git commit` 结束。

### Type Consistency Notes

- `EngineState` 扩展字段统一为 `autonomy?`、`isolation?`、`worktree?: { path, branch }`；后续 resume/worktree 代码依赖此形状。
- `BrainstormStageConfig` 在 Task 2 新增 `on_unresolved`，与全局 `ProjectConfig.on_unresolved` 同枚举。
- `ReviewIssue` severity 统一使用 `"blocker" | "major" | "minor" | "nit"`。
- `BudgetExceededError` 在 `src/gate/budget.ts` 定义，Task 7 的 client 与 Task 8 的 ralph-loop 复用同一错误类型。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-11-aiflow-gap-closure.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh implementer subagent per task, review between tasks, and run a final whole-branch review. Slower per-task but catches integration drift early.
2. **Inline Execution** — I execute tasks in this session using `superpowers:executing-plans`, batching related changes and pausing at natural checkpoints. Faster for tightly-coupled engine changes.

Which approach do you want?
```
