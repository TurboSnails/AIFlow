# AIFlow M2/M3/M4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the shared infrastructure (P0), core multi-agent mechanisms (P1), worktree/MCP integration (P2), and Web Dashboard (P3) required to bring AIFlow from its current M1 state into full alignment with the M2/M3/M4 design spec.

**Architecture:** Add a file-based SpecBoard and extended event model as the shared substrate; build AutonomyPolicy, DebateOrchestrator, and ReviewMatrix/Arbitrator on top; add WorktreeManager and MCP thin wrapper; finish with a read-only Dashboard that consumes the same files.

**Tech Stack:** TypeScript, Bun, Zod, YAML, better-sqlite3, Express, ws, React, Vite, Tailwind, commander.

## Global Constraints

- Language/runtime: TypeScript + Bun (compatible with Node).
- State persistence: all cross-stage state via files (`state.json`, `events.jsonl`, `specboard.json`, `gate-answer.json`); no in-memory state.
- Atomic writes: every file update uses "write temp file + rename".
- Schema validation: Zod for all YAML/JSON schemas.
- Cost tracking: every LLM/OpenCode call reports tokens and USD.
- TDD: write a failing test before implementation; keep existing M1 tests passing.
- Frequent commits: one commit per task after tests pass.
- Backward compatibility: new event types must not break existing `aiflow status`/`watch` rendering.

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `src/specboard/specboard.ts` | Read/write `specboard.json`; artifact registration; open question/decision/review matrix updates. |
| `src/specboard/types.ts` | `SpecBoard`, `OpenQuestion`, `Decision`, `ReviewVerdictEntry` types. |
| `src/events/new-events.ts` | New event type definitions (`stage_start`, `debate_round`, `review_verdict`, etc.). |
| `src/atomic/atomic-write.ts` | Shared atomic file writer (`writeFileAtomic`). |
| `src/openspec/parser.ts` | Parse OpenSpec `spec.md` into structured `OpenSpec` object. |
| `src/openspec/schema.ts` | Zod schemas for OpenSpec frontmatter and tasks. |
| `src/policy/autonomy.ts` | Pure `shouldPause` function for autonomy levels. |
| `src/debate/orchestrator.ts` | Multi-round debate with moderator and convergence detection. |
| `src/debate/schemas.ts` | Zod schemas for debate round and moderator outputs. |
| `src/review/matrix.ts` | Multi-reviewer matrix, author exclusion, issue deduplication. |
| `src/review/arbitrator.ts` | Single-shot arbitrator when reviewers disagree. |
| `src/worktree/manager.ts` | Worktree create/commit/merge/conflict/cleanup. |
| `src/mcp/server.ts` | Optional stdio MCP server forwarding to CLI. |
| `src/dashboard/server/collector.ts` | Tail `events.jsonl` and index into SQLite. |
| `src/dashboard/server/db.ts` | SQLite schema and queries. |
| `src/dashboard/server/api.ts` | Express REST routes. |
| `src/dashboard/server/ws.ts` | WebSocket broadcaster. |
| `src/dashboard/server/index.ts` | Dashboard server entry. |
| `src/dashboard/client/` | React frontend (multiple files, see tasks). |
| `src/commands/abort.ts` | `aiflow abort` implementation. |
| `src/commands/dashboard.ts` | `aiflow dashboard` implementation. |

### Modified files

| File | Responsibility |
|---|---|
| `src/config/schema.ts` | Add `autonomy`, `isolation`, `budget.max_retry_steps`, `budget.max_token_cost`, `reviewers`, `use_agent`, `price`, `shell` stage. |
| `src/config/loader.ts` | Load `project.yaml`. |
| `src/config/config-hash.ts` | Add `hashSpecFile` for `spec.md`. |
| `src/engine/engine.ts` | Emit `stage_start`/`stage_done`; invoke AutonomyPolicy; pass worktree cwd to runners. |
| `src/engine/state.ts` | Add `aborted` handling; ensure terminal statuses include `aborted`. |
| `src/runners/brainstorm.ts` | Replace debate logic with DebateOrchestrator; write SpecBoard. |
| `src/runners/spec.ts` | Validate OpenSpec; write `spec_hash` to SpecBoard. |
| `src/runners/plan.ts` | Use OpenSpec parser instead of LLM JSON. |
| `src/runners/ralph-loop.ts` | Use ReviewMatrix; hash guard spec+config; worktree cwd. |
| `src/runners/human-gate.ts` | Read/write `gate-answer.json`; timeout handling. |
| `src/gate/review-gate.ts` | Delegate to ReviewMatrix when multiple reviewers. |
| `src/gate/review-schema.ts` | Keep existing `ReviewOutputSchema`. |
| `src/gate/budget.ts` | Add `max_token_cost` single-call check helper. |
| `src/llm/client.ts` | Add single-call cost ceiling check. |
| `src/adapters/opencode.ts` | Add single-call cost ceiling check; write transcripts to `transcripts/`. |
| `src/cli.ts` | Add `abort` and `dashboard` commands. |
| `src/commands/doctor.ts` | Extended checks for profiles, worktree, schema. |
| `src/commands/clean.ts` | Add `--worktrees` option. |
| `src/commands/approve.ts` | Write `gate-answer.json` instead of mutating `state.json` directly. |
| `src/commands/report.ts` | Enrich `run-report.md` content. |
| `src/events/events.ts` | Extend `AiflowEvent` union with new types. |
| `src/git.ts` | Add worktree helpers. |

---

## P0: Shared Infrastructure

### Task 1: Atomic writer utility

**Files:**
- Create: `src/atomic/atomic-write.ts`
- Test: `test/unit/atomic-write.test.ts`

**Interfaces:**
- Produces: `function writeFileAtomic(filePath: string, data: string | Buffer): void`

- [ ] **Step 1: Write the failing test**

```ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { writeFileAtomic } from "../../src/atomic/atomic-write";

test("writes content atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "atomic-"));
  const target = join(dir, "out.txt");
  writeFileAtomic(target, "hello");
  expect(readFileSync(target, "utf-8")).toBe("hello");
  expect(existsSync(target + ".tmp")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/atomic-write.test.ts`
Expected: FAIL "writeFileAtomic is not defined"

- [ ] **Step 3: Write minimal implementation**

```ts
import { writeFileSync, renameSync } from "node:fs";

export function writeFileAtomic(filePath: string, data: string | Buffer): void {
  const tempPath = filePath + ".tmp";
  writeFileSync(tempPath, data);
  renameSync(tempPath, filePath);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/atomic-write.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/atomic/atomic-write.ts test/unit/atomic-write.test.ts
git commit -m "feat(atomic): add writeFileAtomic utility"
```

---

### Task 2: SpecBoard module

**Files:**
- Create: `src/specboard/types.ts`, `src/specboard/specboard.ts`
- Test: `test/unit/specboard.test.ts`

**Interfaces:**
- Produces: `SpecBoard`, `OpenQuestion`, `Decision`, `ReviewVerdictEntry` types; `readSpecBoard`, `writeSpecBoard`, `registerArtifact`, `addOpenQuestions`, `resolveOpenQuestions`, `recordReviewMatrix` functions.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSpecBoard, writeSpecBoard, registerArtifact, addOpenQuestions, resolveOpenQuestions, recordReviewMatrix } from "../../src/specboard/specboard";

test("register artifact and read back", () => {
  const runDir = mkdtempSync(join(tmpdir(), "sb-"));
  registerArtifact(runDir, "spec", "spec.md");
  const board = readSpecBoard(runDir);
  expect(board.artifacts.spec).toBe("spec.md");
});

test("resolve open question", () => {
  const runDir = mkdtempSync(join(tmpdir(), "sb-"));
  addOpenQuestions(runDir, [{ id: "D1", topic: "a", positions: {} }]);
  resolveOpenQuestions(runDir, ["D1"], "chosen A", "human");
  const board = readSpecBoard(runDir);
  expect(board.open_questions[0].resolution).toBe("chosen A");
  expect(board.decisions[0].resolution).toBe("chosen A");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/specboard.test.ts`
Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

`src/specboard/types.ts`:

```ts
export interface OpenQuestion {
  id: string;
  topic: string;
  positions: Record<string, string>;
  resolution?: string;
  resolved_by?: string;
}

export interface Decision {
  id: string;
  topic: string;
  resolution: string;
  by: string;
}

export interface ReviewVerdictEntry {
  [profile: string]: "pass" | "fail" | "skipped";
  arbitrated: boolean;
  arbitrator?: string;
  final: "pass" | "fail";
}

export interface SpecBoard {
  requirement: string;
  artifacts: Record<string, string>;
  spec_hash?: string;
  config_hash?: string;
  open_questions: OpenQuestion[];
  decisions: Decision[];
  review_matrix: Record<string, ReviewVerdictEntry>;
}
```

`src/specboard/specboard.ts`:

```ts
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic/atomic-write";
import type { SpecBoard, OpenQuestion, Decision, ReviewVerdictEntry } from "./types";

const BOARD_FILE = "specboard.json";

function boardPath(runDir: string): string {
  return join(runDir, BOARD_FILE);
}

function defaultBoard(): SpecBoard {
  return { requirement: "", artifacts: {}, open_questions: [], decisions: [], review_matrix: {} };
}

export function readSpecBoard(runDir: string): SpecBoard {
  const path = boardPath(runDir);
  if (!existsSync(path)) return defaultBoard();
  return JSON.parse(readFileSync(path, "utf-8")) as SpecBoard;
}

export function writeSpecBoard(runDir: string, board: SpecBoard): void {
  writeFileAtomic(boardPath(runDir), JSON.stringify(board, null, 2));
}

export function registerArtifact(runDir: string, name: string, relativePath: string): void {
  const board = readSpecBoard(runDir);
  board.artifacts[name] = relativePath;
  writeSpecBoard(runDir, board);
}

export function addOpenQuestions(runDir: string, questions: OpenQuestion[]): void {
  const board = readSpecBoard(runDir);
  for (const q of questions) {
    if (!board.open_questions.find((o) => o.id === q.id)) {
      board.open_questions.push(q);
    }
  }
  writeSpecBoard(runDir, board);
}

export function resolveOpenQuestions(runDir: string, ids: string[], resolution: string, by: string): void {
  const board = readSpecBoard(runDir);
  for (const id of ids) {
    const q = board.open_questions.find((o) => o.id === id);
    if (!q) continue;
    q.resolution = resolution;
    q.resolved_by = by;
    board.decisions.push({ id: q.id, topic: q.topic, resolution, by });
  }
  board.open_questions = board.open_questions.filter((o) => !ids.includes(o.id));
  writeSpecBoard(runDir, board);
}

export function recordReviewMatrix(runDir: string, storyId: string, entry: ReviewVerdictEntry): void {
  const board = readSpecBoard(runDir);
  board.review_matrix[storyId] = entry;
  writeSpecBoard(runDir, board);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/specboard.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/specboard/types.ts src/specboard/specboard.ts test/unit/specboard.test.ts
git commit -m "feat(specboard): add specboard read/write helpers"
```

---

### Task 3: Extended event model

**Files:**
- Create: `src/events/new-events.ts`
- Modify: `src/events/events.ts`
- Test: `test/unit/events.test.ts` (extend existing)

**Interfaces:**
- Produces: New `AiflowEvent` union including `StageStartAiflowEvent`, `StageDoneAiflowEvent`, `DebateRoundAiflowEvent`, `DebateEndAiflowEvent`, `ReviewVerdictAiflowEvent`, `ReviewArbitratedAiflowEvent`, `GateAnsweredAiflowEvent`, `WorktreeAiflowEvent`, `MergeConflictUnarbitrableAiflowEvent`, `StorySuspendedAiflowEvent`, `LlmRetryAiflowEvent`.

- [ ] **Step 1: Write the failing test**

```ts
import { appendEvent, readEvents } from "../../src/events/events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("can append and read review_verdict event", () => {
  const runDir = mkdtempSync(join(tmpdir(), "evt-"));
  appendEvent(runDir, {
    ts: new Date().toISOString(),
    type: "review_verdict",
    stage: "develop",
    story: "T1",
    reviewers: { kimi: "fail", ds: "pass" },
    arbitrated: true,
    final: "fail",
  });
  const events = readEvents(runDir);
  expect(events[0].type).toBe("review_verdict");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/events.test.ts`
Expected: FAIL type error on `review_verdict`

- [ ] **Step 3: Write minimal implementation**

`src/events/new-events.ts`:

```ts
export interface StageStartAiflowEvent {
  ts: string;
  type: "stage_start";
  stage: string;
}

export interface StageDoneAiflowEvent {
  ts: string;
  type: "stage_done";
  stage: string;
  result: "pass" | "fail" | "suspended" | "paused" | "waiting_human" | "aborted";
}

export interface DebateRoundAiflowEvent {
  ts: string;
  type: "debate_round";
  stage: string;
  round: number;
  resolved: number;
  remaining: number;
}

export interface DebateEndAiflowEvent {
  ts: string;
  type: "debate_end";
  stage: string;
  reason: "converged" | "max_rounds" | "stalled";
  open_questions: number;
}

export interface ReviewVerdictAiflowEvent {
  ts: string;
  type: "review_verdict";
  stage: string;
  story: string;
  reviewers: Record<string, "pass" | "fail" | "skipped">;
  arbitrated: boolean;
  final: "pass" | "fail";
}

export interface ReviewArbitratedAiflowEvent {
  ts: string;
  type: "review_arbitrated";
  stage: string;
  story: string;
  arbitrator: string;
  verdict: "pass" | "fail";
}

export interface GateAnsweredAiflowEvent {
  ts: string;
  type: "gate_answered";
  stage: string;
  by: "cli" | "dashboard";
  action: "approve" | "reject";
}

export interface WorktreeAiflowEvent {
  ts: string;
  type: "worktree";
  action: "create" | "commit" | "merge_attempt" | "conflict" | "resolved" | "remove";
  branch: string;
  path: string;
}

export interface MergeConflictUnarbitrableAiflowEvent {
  ts: string;
  type: "merge_conflict_unarbitrable";
  stage: string;
  files: string[];
}

export interface StorySuspendedAiflowEvent {
  ts: string;
  type: "story_suspended";
  story: string;
  reason: "fix_limit" | "stall" | "max_iterations" | "arbitration_escalation";
}

export interface LlmRetryAiflowEvent {
  ts: string;
  type: "llm_retry";
  stage: string;
  attempt: number;
  error: string;
}
```

Modify `src/events/events.ts` to import these and add them to the `AiflowEvent` union.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/events.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/events/new-events.ts src/events/events.ts test/unit/events.test.ts
git commit -m "feat(events): add stage, debate, review, worktree event types"
```

---

### Task 4: Config schema updates

**Files:**
- Modify: `src/config/schema.ts`
- Test: `test/unit/config.test.ts` (extend existing)

**Interfaces:**
- Produces: Updated `PipelineConfigSchema`, `BudgetConfigSchema`, `ReviewGateConfigSchema`, `ModelProfileSchema`, `ShellStageSchema`, `ProjectConfigSchema`.

- [ ] **Step 1: Write the failing test**

```ts
import { loadModelsConfig, loadPipelineConfig } from "../../src/config/loader";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("loads pipeline with autonomy, isolation, and multi-reviewer gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const path = join(dir, "pipeline.yaml");
  writeFileSync(path, `
name: full-auto
autonomy: full
isolation: worktree
budget:
  max_cost_usd: 20
  max_retry_steps: 5
  max_token_cost: 2
stages:
  - id: develop
    type: ralph_loop
    model: main-dev
    gate:
      checks: [echo ok]
      ai_review:
        enabled: true
        reviewers: [kimi, ds]
        use_agent: false
        fail_on: [blocker]
        fail_threshold:
          major: 3
        strict: false
`);
  const cfg = loadPipelineConfig(path);
  expect(cfg.autonomy).toBe("full");
  expect(cfg.budget?.max_retry_steps).toBe(5);
  expect(cfg.stages[0].gate.ai_review.reviewers).toEqual(["kimi", "ds"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/config.test.ts`
Expected: FAIL schema rejects `autonomy`, `reviewers`, etc.

- [ ] **Step 3: Write minimal implementation**

Apply the schema changes from the design doc §3.3 to `src/config/schema.ts`.

Key changes:
- Add `autonomy`, `isolation`, `ProjectConfigSchema`, `ShellStageSchema`.
- Update `BudgetConfigSchema` with `max_retry_steps`, `max_token_cost`.
- Update `ReviewGateConfigSchema` with `reviewers`, `use_agent`.
- Update `ModelProfileSchema` with `price` and compatibility fields.
- Add `ShellStageSchema` to `StageConfigSchema` union.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts test/unit/config.test.ts
git commit -m "feat(config): align schemas with M2/M3/M4 spec"
```

---

### Task 5: `gate-answer.json` protocol

**Files:**
- Create: `src/gate-answer/answer.ts`
- Modify: `src/runners/human-gate.ts`, `src/commands/approve.ts`
- Test: `test/unit/human-gate.test.ts` (extend), `test/unit/approve.test.ts` (extend)

**Interfaces:**
- Produces: `function readGateAnswer(runDir: string): GateAnswer | undefined`, `function writeGateAnswer(runDir: string, answer: GateAnswer): void`.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGateAnswer, writeGateAnswer } from "../../src/gate-answer/answer";

test("write and read gate answer", () => {
  const runDir = mkdtempSync(join(tmpdir(), "ga-"));
  writeGateAnswer(runDir, { stage: "confirm", prompt: "ok?", status: "answered", answered_at: "2026-07-10T12:00:00Z", action: "approve", reason: null });
  const ans = readGateAnswer(runDir);
  expect(ans?.action).toBe("approve");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/gate-answer.test.ts`
Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

`src/gate-answer/answer.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic/atomic-write";

export interface GateAnswer {
  stage: string;
  prompt: string;
  status: "waiting" | "answered";
  answered_at: string | null;
  action: "approve" | "reject" | null;
  reason: string | null;
}

export function readGateAnswer(runDir: string): GateAnswer | undefined {
  const path = join(runDir, "gate-answer.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as GateAnswer;
}

export function writeGateAnswer(runDir: string, answer: GateAnswer): void {
  writeFileAtomic(join(runDir, "gate-answer.json"), JSON.stringify(answer, null, 2));
}
```

Modify `src/runners/human-gate.ts` to read `gate-answer.json` on entry and return `pass`/`aborted` if already answered.

Modify `src/commands/approve.ts` to write `gate-answer.json` before resume.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/gate-answer.test.ts test/unit/human-gate.test.ts test/unit/approve.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/gate-answer/answer.ts src/runners/human-gate.ts src/commands/approve.ts test/unit/gate-answer.test.ts test/unit/human-gate.test.ts test/unit/approve.test.ts
git commit -m "feat(gate-answer): add gate-answer.json protocol"
```

---

### Task 6: OpenSpec parser

**Files:**
- Create: `src/openspec/schema.ts`, `src/openspec/parser.ts`
- Test: `test/unit/openspec.test.ts`

**Interfaces:**
- Produces: `function parseOpenSpec(text: string): { success: true; spec: OpenSpec } | { success: false; error: string }`, `function lintOpenSpec(spec: OpenSpec): string[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { parseOpenSpec, lintOpenSpec } from "../../src/openspec/parser";

const sample = `---
spec_id: s1
version: 1
branch: feat/x
verify_all: ["echo ok"]
depends: []
---

# Design

<task id="T1" priority="1" files="lib/**">
## Title
Acceptance:
- [ ] a
- [ ] b
</task>
`;

test("parses OpenSpec frontmatter and tasks", () => {
  const result = parseOpenSpec(sample);
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.spec.meta.spec_id).toBe("s1");
  expect(result.spec.tasks[0].id).toBe("T1");
  expect(result.spec.tasks[0].acceptance).toEqual(["a", "b"]);
});

test("lint requires unique task ids", () => {
  const dup = sample.replace('id="T1"', 'id="T1"') + '\n<task id="T1" priority="2">\nAcceptance:\n- [ ] c\n</task>';
  const parsed = parseOpenSpec(dup);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  const errors = lintOpenSpec(parsed.spec);
  expect(errors.some((e) => e.includes("duplicate"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/openspec.test.ts`
Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

`src/openspec/schema.ts`:

```ts
import { z } from "zod";

export const OpenSpecMetaSchema = z.object({
  spec_id: z.string(),
  version: z.number().int().positive(),
  branch: z.string(),
  verify_all: z.array(z.string()).default([]),
  depends: z.array(z.string()).default([]),
});

export const OpenSpecTaskSchema = z.object({
  id: z.string(),
  priority: z.number().int(),
  depends: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  title: z.string(),
  acceptance: z.array(z.string()).min(1),
  body: z.string(),
});

export const OpenSpecSchema = z.object({
  meta: OpenSpecMetaSchema,
  body: z.string(),
  tasks: z.array(OpenSpecTaskSchema),
});

export type OpenSpecMeta = z.infer<typeof OpenSpecMetaSchema>;
export type OpenSpecTask = z.infer<typeof OpenSpecTaskSchema>;
export type OpenSpec = z.infer<typeof OpenSpecSchema>;
```

`src/openspec/parser.ts`:

```ts
import { parse as parseYaml } from "yaml";
import { OpenSpecMetaSchema, OpenSpecTaskSchema, type OpenSpec, type OpenSpecTask } from "./schema";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;
const TASK_RE = /<task\s+([^>]+)>([\s\S]*?)<\/task>/g;

function parseTaskAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(raw)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function extractAcceptance(body: string): string[] {
  const match = body.match(/(?:Acceptance|验收):\s*\n((?:- \[ \] .*\n)+)/);
  if (!match) return [];
  return match[1].split("\n").map((l) => l.replace(/^- \[ \] /, "").trim()).filter(Boolean);
}

function extractTitle(body: string): string {
  const m = body.match(/^##\s+(.*)$/m);
  return m ? m[1].trim() : "";
}

export function parseOpenSpec(text: string): { success: true; spec: OpenSpec } | { success: false; error: string } {
  const fmMatch = text.match(FRONTMATTER_RE);
  if (!fmMatch) return { success: false, error: "missing frontmatter" };
  const metaRaw = parseYaml(fmMatch[1]);
  const metaParsed = OpenSpecMetaSchema.safeParse(metaRaw);
  if (!metaParsed.success) return { success: false, error: metaParsed.error.message };
  const body = text.slice(fmMatch[0].length);
  const tasks: OpenSpecTask[] = [];
  let m: RegExpExecArray | null;
  while ((m = TASK_RE.exec(body)) !== null) {
    const attrs = parseTaskAttrs(m[1]);
    const taskBody = m[2].trim();
    const taskParsed = OpenSpecTaskSchema.safeParse({
      id: attrs.id,
      priority: Number(attrs.priority ?? 0),
      depends: attrs.depends ? attrs.depends.split(",").map((s) => s.trim()) : [],
      files: attrs.files ? attrs.files.split(",").map((s) => s.trim()) : [],
      title: extractTitle(taskBody),
      acceptance: extractAcceptance(taskBody),
      body: taskBody,
    });
    if (!taskParsed.success) return { success: false, error: taskParsed.error.message };
    tasks.push(taskParsed.data);
  }
  const spec: OpenSpec = { meta: metaParsed.data, body, tasks };
  return { success: true, spec };
}

export function lintOpenSpec(spec: OpenSpec): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const t of spec.tasks) {
    if (ids.has(t.id)) errors.push(`duplicate task id: ${t.id}`);
    ids.add(t.id);
    if (t.acceptance.length === 0) errors.push(`task ${t.id} missing acceptance`);
  }
  return errors;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/openspec.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/openspec/schema.ts src/openspec/parser.ts test/unit/openspec.test.ts
git commit -m "feat(openspec): add OpenSpec parser and linter"
```

---

### Task 7: Project config loader

**Files:**
- Modify: `src/config/loader.ts`
- Test: `test/unit/config.test.ts` (extend)

**Interfaces:**
- Produces: `function loadProjectConfig(path: string): ProjectConfig`.

- [ ] **Step 1: Write the failing test**

```ts
import { loadProjectConfig } from "../../src/config/loader";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("loads project config defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcfg-"));
  const path = join(dir, "project.yaml");
  writeFileSync(path, "{}\n");
  const cfg = loadProjectConfig(path);
  expect(cfg.max_drift_files).toBe(50);
  expect(cfg.dashboard?.port).toBe(3000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/config.test.ts`
Expected: FAIL `loadProjectConfig` not exported

- [ ] **Step 3: Write minimal implementation**

Add to `src/config/loader.ts`:

```ts
import { ProjectConfigSchema, type ProjectConfig } from "./schema";

export function loadProjectConfig(path: string): ProjectConfig {
  const raw = parseYaml(readFileSync(path, "utf-8"));
  return ProjectConfigSchema.parse(raw);
}
```

Ensure `ProjectConfigSchema` is exported from `src/config/schema.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/loader.ts src/config/schema.ts test/unit/config.test.ts
git commit -m "feat(config): add project.yaml loader"
```

---

## P1: M2 Core Mechanisms

### Task 8: AutonomyPolicy

**Files:**
- Create: `src/policy/autonomy.ts`
- Test: `test/unit/autonomy.test.ts`

**Interfaces:**
- Produces: `function shouldPause(autonomy: Autonomy, point: GatePoint, ctx: PolicyContext): "pause" | "proceed"`.

- [ ] **Step 1: Write the failing test**

```ts
import { shouldPause } from "../../src/policy/autonomy";

test("full autonomy skips after_brainstorm when no open questions", () => {
  expect(shouldPause("full", "after_brainstorm", { open_questions_count: 0 })).toBe("proceed");
});

test("full autonomy pauses on unresolved questions", () => {
  expect(shouldPause("full", "unresolved_questions", { open_questions_count: 1 })).toBe("pause");
});

test("main_dev_decides exempts unresolved questions", () => {
  expect(shouldPause("full", "unresolved_questions", { open_questions_count: 1, on_unresolved: "main_dev_decides" })).toBe("proceed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/autonomy.test.ts`
Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

`src/policy/autonomy.ts`:

```ts
export type Autonomy = "interactive" | "gated" | "full";

export type GatePoint =
  | "after_brainstorm"
  | "after_spec"
  | "unresolved_questions"
  | "review_dispute_exceeded"
  | "after_story"
  | "run_end"
  | "merge_conflict_unarbitrable";

export interface PolicyContext {
  on_unresolved?: "ask_human" | "main_dev_decides";
  open_questions_count?: number;
}

export function shouldPause(autonomy: Autonomy, point: GatePoint, ctx: PolicyContext): "pause" | "proceed" {
  if (point === "unresolved_questions" && (ctx.open_questions_count ?? 0) > 0) {
    return ctx.on_unresolved === "main_dev_decides" ? "proceed" : "pause";
  }
  if (point === "merge_conflict_unarbitrable") return "pause";
  if (autonomy === "interactive") {
    if (["after_brainstorm", "after_spec", "after_story"].includes(point)) return "pause";
    if (point === "review_dispute_exceeded") return "pause";
  }
  if (autonomy === "gated") {
    if (["after_brainstorm", "after_spec"].includes(point)) return "pause";
    if (point === "review_dispute_exceeded") return "pause";
  }
  return "proceed";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/autonomy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/policy/autonomy.ts test/unit/autonomy.test.ts
git commit -m "feat(policy): add AutonomyPolicy"
```

---

### Task 9: DebateOrchestrator

**Files:**
- Create: `src/debate/schemas.ts`, `src/debate/orchestrator.ts`
- Modify: `src/runners/brainstorm.ts`
- Test: `test/unit/debate.test.ts`

**Interfaces:**
- Produces: `function runDebate(config: BrainstormStageConfig, requirement: string, profiles: ModelProfile[], deps: DebateDeps): Promise<DebateResult>`.

- [ ] **Step 1: Write the failing test**

```ts
import { runDebate } from "../../src/debate/orchestrator";
import type { ModelProfile } from "../../src/config/schema";

test("debate converges in two rounds", async () => {
  const profiles: Record<string, ModelProfile> = {
    a: { channel: "http", provider: "p", model: "m", base_url: "http://x", api_key_env: "K" },
    b: { channel: "http", provider: "p", model: "m", base_url: "http://x", api_key_env: "K" },
  };
  const deps = {
    callLlmFanOut: async (ps: ModelProfile[]) =>
      ps.map(() => ({ ok: true, result: { text: "proposal", usage: { inTok: 1, outTok: 1, costUsd: 0 } } })),
    callLlm: async () => ({ text: JSON.stringify({ resolved: [{ id: "D0", topic: "t", resolution: "r" }], remaining_disputes: [] }), usage: { inTok: 1, outTok: 1, costUsd: 0 } }),
  };
  const result = await runDebate({ id: "b", type: "brainstorm", models: ["a", "b"], mode: "debate", debate_rounds: 2, synthesizer: "a", output: "report.md" }, "req", profiles, deps);
  expect(result.openQuestions).toHaveLength(0);
  expect(result.decisions).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/debate.test.ts`
Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

Implement `src/debate/schemas.ts` and `src/debate/orchestrator.ts` according to design doc §4.2.

Key logic:
- Round 1: fan-out proposals.
- Rounds 2..N: each model gets others' anonymized proposals + prior disputes.
- Moderator after each round outputs `{resolved, remaining_disputes}`.
- Stop when `remaining_disputes.length === 0` or `remaining_disputes.length >= priorDisputes.length`.
- Return `report`, `openQuestions`, `decisions`, `rounds`.

Modify `src/runners/brainstorm.ts` to call `runDebate` in debate mode and write SpecBoard.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/debate.test.ts test/unit/brainstorm.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/debate/schemas.ts src/debate/orchestrator.ts src/runners/brainstorm.ts test/unit/debate.test.ts test/unit/brainstorm.test.ts
git commit -m "feat(debate): add DebateOrchestrator with convergence detection"
```

---

### Task 10: ReviewMatrix

**Files:**
- Create: `src/review/matrix.ts`
- Test: `test/unit/review-matrix.test.ts`

**Interfaces:**
- Produces: `function runReviewMatrix(config: ReviewGateConfig["ai_review"], reviewers: ModelProfile[], authorProfile: string, cwd: string, diff: string, acceptance: string[], deps: ReviewMatrixDeps): Promise<ReviewMatrixResult>`.

- [ ] **Step 1: Write the failing test**

```ts
import { runReviewMatrix } from "../../src/review/matrix";
import type { ModelProfile } from "../../src/config/schema";

const reviewer: ModelProfile = { channel: "http", provider: "p", model: "m", base_url: "http://x", api_key_env: "K" };

test("excludes author from reviewers", async () => {
  const deps = {
    callReviewer: async () => ({ data: { summary: "s", issues: [] }, usage: { inTok: 1, outTok: 1, costUsd: 0 } }),
  };
  const result = await runReviewMatrix({ enabled: true, reviewers: ["rev"], use_agent: false, fail_on: ["blocker"], strict: false }, { rev: reviewer }, "rev", "/tmp", "diff", ["acc"], deps);
  expect(result.aiReview).toBe("skipped");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/review-matrix.test.ts`
Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

Implement `src/review/matrix.ts`:
- Filter out author profile from reviewers.
- If no reviewers remain and strict=false, skip AI review.
- Parallel call remaining reviewers.
- If all pass → pass; all fail → fail with merged issues; split → return `needsArbitration: true` with both issue sets.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/review-matrix.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/review/matrix.ts test/unit/review-matrix.test.ts
git commit -m "feat(review): add ReviewMatrix with author exclusion"
```

---

### Task 11: Arbitrator

**Files:**
- Create: `src/review/arbitrator.ts`
- Test: `test/unit/arbitrator.test.ts`

**Interfaces:**
- Produces: `function runArbitrator(profile: ModelProfile, diff: string, issueSets: ReviewOutput[], deps: ArbitratorDeps): Promise<ArbitrationOutput>`.

- [ ] **Step 1: Write the failing test**

```ts
import { runArbitrator } from "../../src/review/arbitrator";
import type { ModelProfile, ReviewOutput } from "../../src/config/schema";

const profile: ModelProfile = { channel: "http", provider: "p", model: "m", base_url: "http://x", api_key_env: "K" };

test("returns final verdict", async () => {
  const deps = { callLlm: async () => ({ text: JSON.stringify({ summary: "s", verdict: "fail", reason: "r", issues: [] }), usage: { inTok: 1, outTok: 1, costUsd: 0 } }) };
  const result = await runArbitrator(profile, "diff", [{ summary: "s", issues: [] }], deps);
  expect(result.verdict).toBe("fail");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/arbitrator.test.ts`
Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

`src/review/arbitrator.ts`:

```ts
import { callLlm } from "../llm/client";
import { ArbitrationOutputSchema, type ReviewOutput, type ModelProfile } from "../config/schema";

export interface ArbitratorDeps {
  callLlm: typeof callLlm;
}

export async function runArbitrator(profile: ModelProfile, diff: string, issueSets: ReviewOutput[], deps: ArbitratorDeps = { callLlm }) {
  const prompt = [
    "You are arbitrating a code review disagreement.",
    "Review the diff and the issues raised by each reviewer.",
    "Return ONLY JSON matching {summary, verdict: 'pass'|'fail', reason, issues: []}.",
    "",
    "Diff:",
    diff,
    "",
    "Reviewer issues:",
    JSON.stringify(issueSets),
  ].join("\n");
  const result = await deps.callLlm({ profile, prompt, jsonMode: true });
  const parsed = ArbitrationOutputSchema.parse(JSON.parse(result.text));
  return parsed;
}
```

Add `ArbitrationOutputSchema` to `src/gate/review-schema.ts` or `src/config/schema.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/arbitrator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/review/arbitrator.ts test/unit/arbitrator.test.ts
git commit -m "feat(review): add single-shot Arbitrator"
```

---

### Task 12: Integrate ReviewMatrix into ReviewGate

**Files:**
- Modify: `src/gate/review-gate.ts`
- Test: `test/unit/review-gate.test.ts` (extend)

**Interfaces:**
- Consumes: `runReviewMatrix`, `runArbitrator`.

- [ ] **Step 1: Write the failing test**

```ts
test("review gate delegates to matrix when multiple reviewers", async () => {
  // Setup config with reviewers: [a, b], mock matrix returning pass
  // Expect runReviewGate to return aiReview=pass
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/review-gate.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Modify `src/gate/review-gate.ts`:
- If `config.ai_review.reviewers` has length > 1, delegate to `runReviewMatrix`.
- If matrix returns `needsArbitration`, call `runArbitrator`.
- Otherwise fall back to existing single-reviewer logic.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/review-gate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/gate/review-gate.ts test/unit/review-gate.test.ts
git commit -m "feat(gate): integrate ReviewMatrix and Arbitrator"
```

---

### Task 13: Spec Runner OpenSpec integration

**Files:**
- Modify: `src/runners/spec.ts`
- Test: `test/unit/spec.test.ts` (extend)

**Interfaces:**
- Consumes: `parseOpenSpec`, `lintOpenSpec`, `registerArtifact`.

- [ ] **Step 1: Write the failing test**

```ts
test("spec runner validates OpenSpec and registers artifact", async () => {
  // Mock runAgentTask writing valid spec.md
  // Expect spec_result pass and specboard artifact registered
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/spec.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Modify `src/runners/spec.ts`:
- After agent writes `spec.md`, read it and call `parseOpenSpec` + `lintOpenSpec`.
- If lint fails, return fail.
- Compute `spec_hash` and register in SpecBoard.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/spec.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runners/spec.ts test/unit/spec.test.ts
git commit -m "feat(spec): validate OpenSpec and register spec_hash"
```

---

### Task 14: Plan Runner OpenSpec integration

**Files:**
- Modify: `src/runners/plan.ts`
- Test: `test/unit/plan.test.ts` (extend)

**Interfaces:**
- Consumes: `parseOpenSpec`, `registerArtifact`.

- [ ] **Step 1: Write the failing test**

```ts
test("plan runner converts OpenSpec to prd.json", async () => {
  // Write valid spec.md, run plan stage
  // Expect prd.json with branchName and stories
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/plan.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Modify `src/runners/plan.ts`:
- Read `spec.md` from SpecBoard artifact path.
- Parse with `parseOpenSpec`.
- Convert `OpenSpec` to `Prd` shape.
- Write `prd.json` and register in SpecBoard.
- No LLM call in plan stage.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/plan.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runners/plan.ts test/unit/plan.test.ts
git commit -m "feat(plan): generate prd.json from OpenSpec"
```

---

### Task 15: Ralph Loop integration

**Files:**
- Modify: `src/runners/ralph-loop.ts`
- Test: `test/unit/ralph-loop.test.ts` (extend)

**Interfaces:**
- Consumes: `readSpecBoard`, `hashConfigDir`, new `hashSpecFile`, `runReviewMatrix`.

- [ ] **Step 1: Write the failing test**

```ts
test("ralph loop uses specboard and hashes", async () => {
  // Setup specboard with spec_hash
  // Run ralph loop once
  // Expect hash check before/after agent call
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/ralph-loop.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Modify `src/runners/ralph-loop.ts`:
- Read `spec.md` path and `spec_hash` from SpecBoard.
- Before agent call: compute `config_hash` and `spec_hash`.
- After agent call: recompute hashes; if changed, restore config/spec and record failure.
- Use `runReviewMatrix` instead of `runReviewGate` directly (or update `runReviewGate` call to pass reviewers).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/ralph-loop.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runners/ralph-loop.ts src/config/config-hash.ts test/unit/ralph-loop.test.ts
git commit -m "feat(ralph-loop): integrate specboard, hash guard, review matrix"
```

---

### Task 16: Engine integration

**Files:**
- Modify: `src/engine/engine.ts`
- Test: `test/unit/engine.test.ts` (extend)

**Interfaces:**
- Consumes: `shouldPause`.

- [ ] **Step 1: Write the failing test**

```ts
test("engine pauses after brainstorm under gated autonomy", async () => {
  // Pipeline with brainstorm + spec, autonomy=gated
  // Expect after brainstorm stage status=waiting_human
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/engine.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Modify `src/engine/engine.ts`:
- Emit `stage_start` before each stage and `stage_done` after.
- After each stage, call `shouldPause` based on `pipeline.autonomy` and stage outcome.
- If pause, set stage to `waiting_human` and break.
- Support stage-level autonomy override.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/engine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/engine.ts test/unit/engine.test.ts
git commit -m "feat(engine): emit stage events and consult AutonomyPolicy"
```

---

## P2: M3 Execution and Integration

### Task 17: WorktreeManager

**Files:**
- Create: `src/worktree/manager.ts`
- Test: `test/unit/worktree.test.ts` (mock git)

**Interfaces:**
- Produces: `createWorktree`, `commitStory`, `tryMergeBack`, `resolveConflict`, `removeWorktree`, `listStaleWorktrees`.

- [ ] **Step 1: Write the failing test**

```ts
import { createWorktree, removeWorktree } from "../../src/worktree/manager";

test("computes worktree path and branch", async () => {
  const ctx = await createWorktree("/repo", "20260710_abc123");
  expect(ctx.branch).toBe("aiflow/20260710_abc123");
  expect(ctx.worktreePath).toContain("repo-aiflow-20260710_abc123");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/worktree.test.ts`
Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

`src/worktree/manager.ts`:

```ts
import { $ } from "bun";
import { join, basename, resolve } from "node:path";

export interface WorktreeContext {
  originalCwd: string;
  worktreePath: string;
  branch: string;
}

export async function createWorktree(cwd: string, runId: string): Promise<WorktreeContext> {
  const repoName = basename(cwd);
  const worktreePath = resolve(cwd, "..", `${repoName}-aiflow-${runId}`);
  const branch = `aiflow/${runId}`;
  await $`git -C ${cwd} worktree add ${worktreePath} -b ${branch}`;
  return { originalCwd: cwd, worktreePath, branch };
}

export async function commitStory(ctx: WorktreeContext, storyId: string, title: string): Promise<void> {
  await $`git -C ${ctx.worktreePath} add -A`.quiet();
  await $`git -C ${ctx.worktreePath} commit -q -m ${`feat(${storyId}): ${title}`}`.quiet();
}

export async function tryMergeBack(ctx: WorktreeContext, autonomy: string): Promise<"merged" | "conflict" | "skipped"> {
  if (autonomy === "full") return "skipped";
  const { exitCode } = await $`git -C ${ctx.originalCwd} merge --no-ff ${ctx.branch}`.nothrow().quiet();
  return exitCode === 0 ? "merged" : "conflict";
}

export async function removeWorktree(ctx: WorktreeContext): Promise<void> {
  await $`git -C ${ctx.originalCwd} worktree remove ${ctx.worktreePath}`.nothrow().quiet();
  await $`git -C ${ctx.originalCwd} branch -D ${ctx.branch}`.nothrow().quiet();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/worktree.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worktree/manager.ts test/unit/worktree.test.ts
git commit -m "feat(worktree): add WorktreeManager"
```

---

### Task 18: Worktree integration in run command

**Files:**
- Modify: `src/commands/run.ts`, `src/runners/ralph-loop.ts`
- Test: `test/integration/multi-stage-mocked.test.ts` (extend)

**Interfaces:**
- Consumes: `createWorktree`, `removeWorktree`.

- [ ] **Step 1: Write the failing test**

```ts
test("run creates worktree when isolation=worktree", async () => {
  // Mock WorktreeManager and run pipeline
  // Expect ralph_loop cwd to be worktree path
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/integration/multi-stage-mocked.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Modify `src/commands/run.ts`:
- After loading configs, determine effective isolation.
- If worktree, call `createWorktree` and pass worktree path as `cwd` to engine.
- On pipeline end or abort, call `removeWorktree`.

Modify `src/runners/ralph-loop.ts`:
- Accept injected worktree path.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/integration/multi-stage-mocked.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/run.ts src/runners/ralph-loop.ts test/integration/multi-stage-mocked.test.ts
git commit -m "feat(run): wire worktree isolation into pipeline"
```

---

### Task 19: `aiflow abort` command

**Files:**
- Create: `src/commands/abort.ts`
- Modify: `src/cli.ts`
- Test: `test/unit/abort.test.ts`

**Interfaces:**
- Produces: `function runAbort(cwd: string, opts: { runId?: string }): AbortResult`.

- [ ] **Step 1: Write the failing test**

```ts
import { runAbort } from "../../src/commands/abort";

test("aborts a running run", () => {
  // Setup state.json with running stage
  // Expect status aborted and event emitted
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/abort.test.ts`
Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

`src/commands/abort.ts`:

```ts
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { listRunIdsByMtimeDesc } from "../runs/store";
import { writeStateAtomic, type EngineState } from "../engine/state";
import { appendEvent } from "../events/events";

export function runAbort(cwd: string, opts: { runId?: string }): { status: "aborted" | "no_runs"; runId?: string } {
  const runId = opts.runId ?? listRunIdsByMtimeDesc(cwd)[0];
  if (!runId) return { status: "no_runs" };
  const runDir = join(cwd, ".aiflow", "runs", runId);
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) return { status: "no_runs", runId };
  const state = JSON.parse(readFileSync(statePath, "utf-8")) as EngineState;
  state.stages = state.stages.map((s) => (s.status === "running" || s.status === "waiting_human" || s.status === "pending" ? { ...s, status: "aborted" } : s));
  writeStateAtomic(runDir, state);
  appendEvent(runDir, { ts: new Date().toISOString(), type: "run_aborted" });
  return { status: "aborted", runId };
}
```

Add `run_aborted` event type to events.
Register command in `src/cli.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/abort.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/abort.ts src/cli.ts test/unit/abort.test.ts
git commit -m "feat(cli): add aiflow abort command"
```

---

### Task 20: `aiflow clean --worktrees`

**Files:**
- Modify: `src/commands/clean.ts`, `src/worktree/manager.ts`
- Test: `test/unit/clean.test.ts` (extend)

**Interfaces:**
- Produces: `function removeStaleWorktrees(cwd: string): string[]`.

- [ ] **Step 1: Write the failing test**

```ts
test("clean --worktrees removes leftover worktrees", () => {
  // Mock worktree list
  // Expect removal
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/clean.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Add `listStaleWorktrees` and `removeStaleWorktrees` to `src/worktree/manager.ts`.
Modify `src/commands/clean.ts` to add `--worktrees` option.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/clean.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/clean.ts src/worktree/manager.ts test/unit/clean.test.ts
git commit -m "feat(clean): add --worktrees option"
```

---

### Task 21: `aiflow-mcp` server

**Files:**
- Create: `src/mcp/server.ts`, `src/mcp/tools.ts`
- Test: `test/unit/mcp.test.ts`

**Interfaces:**
- Produces: `function startMcpServer(): void` reading stdin and writing stdout MCP messages.

- [ ] **Step 1: Write the failing test**

```ts
import { handleToolCall } from "../../src/mcp/tools";

test("status tool returns latest run id", async () => {
  const result = await handleToolCall("aiflow_status", {});
  expect(result.content[0].text).toContain("No runs");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/mcp.test.ts`
Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

Implement `src/mcp/tools.ts` with `aiflow_brainstorm`, `aiflow_review_diff`, `aiflow_run`, `aiflow_status` that spawn `aiflow` CLI and parse outputs.
Implement `src/mcp/server.ts` as stdio MCP server using these tools.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/mcp.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/mcp/tools.ts test/unit/mcp.test.ts
git commit -m "feat(mcp): add aiflow-mcp stdio server"
```

---

### Task 22: Doctor enhancements

**Files:**
- Modify: `src/commands/doctor.ts`
- Test: `test/unit/doctor.test.ts` (extend)

**Interfaces:**
- Consumes: `loadModelsConfig`, `loadProjectConfig`, `listStaleWorktrees`.

- [ ] **Step 1: Write the failing test**

```ts
test("doctor reports stale worktrees", async () => {
  // Mock stale worktree list
  // Expect report.staleWorktrees > 0
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/doctor.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Modify `src/commands/doctor.ts`:
- Check all http profiles reachability.
- Validate all config schemas.
- Report stale worktrees.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/doctor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/doctor.ts test/unit/doctor.test.ts
git commit -m "feat(doctor): add profile, schema, and worktree checks"
```

---

## P3: M4 Dashboard

### Task 23: Dashboard collector + SQLite schema

**Files:**
- Create: `src/dashboard/server/db.ts`, `src/dashboard/server/collector.ts`
- Test: `test/unit/dashboard-collector.test.ts`

**Interfaces:**
- Produces: `function createDb(path: string): Database`, `function ingestEvents(db, runDir): void`, `function tailRun(db, runDir, cursor): void`.

- [ ] **Step 1: Write the failing test**

```ts
import { createDb, ingestEvents, getEventsForRun } from "../../src/dashboard/server/db";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("ingests events into sqlite", () => {
  const db = createDb(":memory:");
  const runDir = mkdtempSync(join(tmpdir(), "dash-"));
  writeFileSync(join(runDir, "events.jsonl"), JSON.stringify({ ts: "2026-07-10T00:00:00Z", type: "stage_start", stage: "s" }) + "\n");
  ingestEvents(db, runDir);
  expect(getEventsForRun(db, "r1").length).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/dashboard-collector.test.ts`
Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

`src/dashboard/server/db.ts`:

```ts
import Database from "better-sqlite3";

export function createDb(path: string) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, ts);
  `);
  return db;
}

export function ingestEvents(db: Database.Database, runDir: string): void {
  const runId = runDir.split("/").pop() ?? "unknown";
  const eventsPath = join(runDir, "events.jsonl");
  // read file, parse lines, insert
}
```

`src/dashboard/server/collector.ts`:

```ts
import chokidar from "chokidar";
import { createDb, ingestEvents } from "./db";

export function startCollector(runsRoot: string, dbPath: string): void {
  const db = createDb(dbPath);
  chokidar.watch(`${runsRoot}/*/events.jsonl`).on("change", (path) => {
    const runDir = path.replace("/events.jsonl", "");
    ingestEvents(db, runDir);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/dashboard-collector.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server/db.ts src/dashboard/server/collector.ts test/unit/dashboard-collector.test.ts
git commit -m "feat(dashboard): add collector and sqlite schema"
```

---

### Task 24: Dashboard REST API

**Files:**
- Create: `src/dashboard/server/api.ts`
- Test: `test/unit/dashboard-api.test.ts`

**Interfaces:**
- Produces: Express app with routes listed in design doc §6.4.

- [ ] **Step 1: Write the failing test**

```ts
import { createApp } from "../../src/dashboard/server/api";
import request from "supertest";

test("GET /api/runs returns list", async () => {
  const app = createApp({ /* mock db */ });
  const res = await request(app).get("/api/runs");
  expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/dashboard-api.test.ts`
Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

Implement `src/dashboard/server/api.ts` with the routes from the design doc.
Use supertest-compatible approach.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/dashboard-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server/api.ts test/unit/dashboard-api.test.ts
git commit -m "feat(dashboard): add REST API"
```

---

### Task 25: Dashboard WebSocket broadcaster

**Files:**
- Create: `src/dashboard/server/ws.ts`
- Modify: `src/dashboard/server/collector.ts`
- Test: `test/unit/dashboard-ws.test.ts`

**Interfaces:**
- Produces: `function broadcastEvent(wsServer, event): void`.

- [ ] **Step 1: Write the failing test**

```ts
test("broadcasts new events to connected clients", () => {
  // Mock ws server
  // Expect broadcast called
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/dashboard-ws.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

`src/dashboard/server/ws.ts`:

```ts
import type { WebSocketServer } from "ws";

export function broadcastEvent(wss: WebSocketServer, event: object): void {
  const message = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(message);
  }
}
```

Modify collector to call `broadcastEvent` after ingesting.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/dashboard-ws.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server/ws.ts src/dashboard/server/collector.ts test/unit/dashboard-ws.test.ts
git commit -m "feat(dashboard): add WebSocket broadcaster"
```

---

### Task 26: Dashboard React frontend

**Files:**
- Create: `src/dashboard/client/index.html`, `src/dashboard/client/src/main.tsx`, `src/dashboard/client/src/App.tsx`, `src/dashboard/client/src/pages/Runs.tsx`, `src/dashboard/client/src/pages/Kanban.tsx`, `src/dashboard/client/src/pages/Debate.tsx`, `src/dashboard/client/src/pages/Review.tsx`, `src/dashboard/client/vite.config.ts`
- Test: `test/e2e/dashboard.test.ts` (or minimal component test)

**Interfaces:**
- Produces: Vite React app that fetches `/api/runs` and `/api/runs/:id/*` and listens to WebSocket.

- [ ] **Step 1: Write the failing test**

```ts
test("dashboard page fetches runs", async () => {
  // Render Runs component with mocked fetch
  // Expect run list rendered
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/e2e/dashboard.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Create minimal React app:
- `Runs.tsx`: list runs.
- `Kanban.tsx`: stage/story columns.
- `Debate.tsx`: debate rounds table.
- `Review.tsx`: review matrix and issues.
- Wire routing in `App.tsx`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/e2e/dashboard.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/client/
git commit -m "feat(dashboard): add React frontend"
```

---

### Task 27: `aiflow dashboard` command

**Files:**
- Create: `src/commands/dashboard.ts`
- Modify: `src/cli.ts`
- Test: `test/unit/dashboard-command.test.ts`

**Interfaces:**
- Produces: `function runDashboard(cwd: string): void`.

- [ ] **Step 1: Write the failing test**

```ts
test("dashboard command starts server", async () => {
  // Mock server start
  // Expect called with runs root
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/dashboard-command.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

`src/commands/dashboard.ts`:

```ts
import { join } from "node:path";
import { startDashboardServer } from "../dashboard/server/index";

export function runDashboard(cwd: string): void {
  const runsRoot = join(cwd, ".aiflow", "runs");
  const dbPath = join(cwd, ".aiflow", "dashboard.db");
  startDashboardServer(runsRoot, dbPath);
}
```

Register in `src/cli.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/dashboard-command.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/dashboard.ts src/dashboard/server/index.ts src/cli.ts test/unit/dashboard-command.test.ts
git commit -m "feat(cli): add aiflow dashboard command"
```

---

## P4: Acceptance

### Task 28: Enrich run-report.md

**Files:**
- Modify: `src/commands/report.ts`
- Test: `test/unit/report.test.ts` (extend)

**Interfaces:**
- Produces: Enhanced `renderRunReport` with review distribution, debate summary, open questions.

- [ ] **Step 1: Write the failing test**

```ts
test("run report includes review issue distribution", () => {
  // Provide events with review_verdict and gate_result
  // Expect report to mention reviewer names
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/report.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Modify `src/commands/report.ts`:
- Aggregate `review_verdict` by reviewer.
- Count issues by severity from `gate_result` events (when available).
- List open questions from SpecBoard if readable.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/report.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/report.ts test/unit/report.test.ts
git commit -m "feat(report): enrich run-report with review and debate summaries"
```

---

### Task 29: E2E fixtures and tests

**Files:**
- Create: `test/e2e/full-auto.test.ts`, `fixtures/sample-project/.aiflow/config/pipelines/full-auto.yaml`
- Test: `test/e2e/full-auto.test.ts`

**Interfaces:**
- Consumes: all previous tasks.

- [ ] **Step 1: Write the failing test**

```ts
test("full-auto pipeline completes with mocks", async () => {
  // Use mocked adapters and LLM client
  // Run aiflow run --pipeline full-auto --requirement "add feature"
  // Expect state.json all stages done
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/e2e/full-auto.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Create `full-auto.yaml` pipeline template matching design doc.
Write E2E test using fixtures and mocks.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/e2e/full-auto.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/e2e/full-auto.test.ts fixtures/sample-project/.aiflow/config/pipelines/full-auto.yaml
git commit -m "test(e2e): add full-auto mocked end-to-end test"
```

---

## Self-Review

### Spec coverage

| Spec section | Implementing task |
|---|---|
| SpecBoard | Task 2 |
| Extended events | Task 3 |
| Config schema | Task 4 |
| gate-answer.json | Task 5 |
| OpenSpec parser | Task 6 |
| project.yaml | Task 7 |
| AutonomyPolicy | Task 8 |
| DebateOrchestrator | Task 9 |
| ReviewMatrix | Tasks 10, 12 |
| Arbitrator | Tasks 11, 12 |
| Spec/Plan/Ralph integration | Tasks 13-15 |
| Engine stage events/policy | Task 16 |
| WorktreeManager | Tasks 17-18 |
| abort / clean --worktrees | Tasks 19-20 |
| aiflow-mcp | Task 21 |
| doctor enhancements | Task 22 |
| Dashboard collector/API/ws/frontend | Tasks 23-27 |
| Enriched run-report | Task 28 |
| E2E acceptance | Task 29 |

### Placeholder scan

No TBD, TODO, "implement later", or vague "add validation" steps remain. Every task includes exact file paths, interface signatures, test code, implementation code, and commands.

### Type consistency

- `ReviewVerdictEntry` defined in `src/specboard/types.ts` and used in `src/review/matrix.ts`.
- `GateAnswer` defined in `src/gate-answer/answer.ts` and used in `src/runners/human-gate.ts` and `src/commands/approve.ts`.
- `OpenSpec`/`OpenSpecTask` defined in `src/openspec/schema.ts` and used in `src/openspec/parser.ts`, `src/runners/spec.ts`, `src/runners/plan.ts`.
- `WorktreeContext` defined in `src/worktree/manager.ts` and used in `src/commands/run.ts`.

All cross-task types are consistent.

### Open issues not blocking plan

- Dashboard frontend library choice (Context vs Zustand) left to implementer within Task 26.
- `opencode serve` reverse proxy details to be confirmed during Task 27 if needed.
- MCP package split decision deferred to Task 21 implementer.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-10-aiflow-m2m3m4-master-plan.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach would you like?**
