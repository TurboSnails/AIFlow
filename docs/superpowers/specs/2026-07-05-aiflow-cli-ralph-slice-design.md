# AIFlow CLI — First Vertical Slice: OpenCode Integration + Single Ralph Loop Iteration

Status: Approved (design phase)
Supersedes/refines: sections of the original "AIFlow 技术设计文档 v1.0" (referred to below as "the parent tech design") relevant to the OpenCode Adapter, Ralph Loop Runner, and Review Gate, grounded in real, verified OpenCode CLI behavior.

## 1. Context and Decomposition

AIFlow is a CLI that orchestrates multi-stage AI development pipelines (brainstorm → spec → plan → develop/ralph_loop → review), using OpenCode for agentic code execution and direct LLM API calls for text-only tasks. A companion GUI (Web/Desktop) was also proposed via an HTML prototype.

This project is too large for one design-and-build cycle. It decomposes into:

1. **This spec: CLI core, one vertical slice** — Pipeline Engine + OpenCode Adapter + `ralph_loop` Stage Runner + Review Gate + minimal LLM Client, validated end-to-end against a throwaway sample project with **real** OpenCode and reviewer-model calls.
2. **Future: CLI completeness** — remaining stage types (brainstorm, spec, plan, human_gate), multi-story/multi-round Ralph looping, budget tracking, `resume`, `status`/`watch` monitor.
3. **Future: GUI** — a separate brainstorming round, once this slice produces real `events.jsonl`/`state.json` files the GUI can consume. The provided HTML prototype is retained as visual reference for that round, not implemented now.

**Why this slice first:** the biggest unvalidated risk in the parent tech design is whether/how OpenCode's headless mode actually works (documented as "开放问题 1"). This slice resolves that risk with real, hands-on verification (recorded in §3) rather than assumption, and produces production code — not a throwaway spike — because it's built directly on the real Pipeline Engine architecture (Approach A, see §2).

## 2. Scope

**In scope:**
- `aiflow doctor` — environment self-check (OpenCode version/models/auth, reviewer API key reachability, git repo status)
- Pipeline Engine state machine, minimal: single-stage flow, atomic `state.json` writes, graceful SIGINT handling (kill the OpenCode subprocess tree, mark the run `aborted`; full resumability is explicitly out of scope below)
- OpenCode Adapter, built on verified real CLI behavior (§3)
- `ralph_loop` Stage Runner, single story, single iteration (`aiflow run --pipeline ralph-only --once`)
- Review Gate: deterministic checks layer **and** AI review layer (both included per explicit decision — see §5)
- Minimal LLM Client (direct HTTP channel): chat completion + JSON-mode output + zod validation; no brainstorm fan-out
- `fixtures/sample-project`: a disposable, minimal validation target (isolated from AIFlow's own source)
- `aiflow init`: minimal `.aiflow/` scaffold generator

**Explicitly out of scope (deferred):**
- brainstorm / spec / plan / human_gate Stage types
- Budget tracking + pause, `aiflow resume`, `aiflow status` / `watch` monitor TUI
- Multi-story full runs, stall detection, `per_story_fix_limit` edge cases beyond a single suspend check
- The GUI (separate future brainstorming round)

## 3. Real OpenCode Verification (grounds §4)

Verified directly against an installed OpenCode `1.17.11` in this environment (not assumed from docs):

- `opencode run "<msg>" --model <provider/model> --format json` runs non-interactively and streams **newline-delimited JSON**, one event object per line: `{"type": ..., "timestamp": ..., "sessionID": ..., "part": {...}}`.
- Observed `type` values: `step_start`, `tool_use`, `text`, `step_finish`.
- `tool_use` events carry the tool name, input, output, and status (e.g., a `write` tool call or a `bash` tool call each appeared as a `tool_use` event with `part.tool`, `part.state.input`, `part.state.output`).
- `step_finish` events carry `part.tokens` (`total`/`input`/`output`/`reasoning`/`cache`) **and `part.cost`** — OpenCode computes cost itself; AIFlow does not need its own token→USD table for the OpenCode channel.
- **Tool calls (file write, shell exec) executed automatically without `--dangerously-skip-permissions`** in this environment's default config — no interactive approval prompt, no hang. `--dangerously-skip-permissions` is therefore treated as an optional, explicit, user-controlled override (default off), not a required flag for headless operation.
- `opencode auth list` shows credentials already stored for OpenCode's own use (e.g., a MiniMax credential) in `~/.local/share/opencode/auth.json` — a private, internal format. AIFlow's direct-HTTP LLM Client does **not** read this file; it requires its own separately configured API key via env var, even for the same underlying provider account.
- `opencode models --verbose` exposes cost metadata per model; `opencode agent list/create` exposes user-defined "agents" (bundled model + tool policy + system prompt) referenceable via `--agent <name>`.

These findings directly shape the Adapter and model-profile design below.

## 4. OpenCode Adapter

Subprocess invocation:
```
opencode run "<rendered prompt>" --model <provider/model> --format json --dir <project-cwd>
```
`--dangerously-skip-permissions` is a per-profile opt-in config flag, default `false`.

Interface (matches parent tech design §6.1 shape):
```ts
interface AgentTask { profile: ModelProfile; prompt: string; cwd: string; timeoutMs: number }
interface AgentResult { ok: boolean; transcriptPath: string; usage: { inTok: number; outTok: number; costUsd: number } }
runAgentTask(task: AgentTask): Promise<AgentResult>
```

Behavior:
- Reads subprocess stdout line-by-line as it arrives (not buffered until exit), parses each JSON line, and immediately appends a corresponding entry to the run's `events.jsonl` (see §6) — this gives future `watch`/GUI consumers real-time visibility, not just post-hoc.
- Full raw JSONL stream is archived verbatim to `runs/<id>/artifacts/opencode/<call-id>.jsonl`.
- `step_finish` events accumulate into the returned `usage` (tokens + `costUsd` taken directly from `part.cost`).
- Non-zero process exit, subprocess timeout (kill process tree), or an abnormal `step_finish.reason` all resolve `AgentResult.ok = false`; the Ralph Runner treats this as a failed iteration attempt.

**Model profile shape** (extends parent tech design's `models.yaml`):
```yaml
profiles:
  main-dev:
    channel: opencode
    provider: anthropic
    model: claude-sonnet-4-6
    agent: null                      # optional: reference a predefined OpenCode agent via --agent, overrides model
    variant: null                    # optional: reasoning effort passthrough (high/max/minimal)
    thinking: false                  # optional: passthrough --thinking, captured in transcript
    dangerously_skip_permissions: false
  reviewer:
    channel: http
    provider: minimax                # or moonshot/kimi — exact model id confirmed via doctor at setup time
    model: TBD-verify-at-setup
    base_url: TBD-verify-at-setup
    api_key_env: MINIMAX_API_KEY     # or MOONSHOT_API_KEY — independent of OpenCode's own auth.json
```
The reviewer profile's exact `model`/`base_url` values are intentionally left as placeholders here; `aiflow doctor` will perform a live connectivity check once the user exports the real key, and the values get filled in during implementation, not guessed now.

**Deliberate non-use of OpenCode sessions:** Ralph Loop does not use `--continue`/`--session`/`--fork`. Each iteration is a fresh `opencode run` call with no session continuity — cross-iteration context is carried explicitly through `progress.md` and `fix_list.md` text injected into the next prompt, matching the parent design's "fresh context per iteration" principle. This is now a confirmed, deliberate choice (not an oversight) given that OpenCode does support session continuation.

## 5. Ralph Loop Runner + Review Gate (single iteration)

```
1. Read prd.json, select the (single, in this slice) story where passes = false
2. Render prompt: story description + spec.md excerpt + tail of progress.md + fix_list.md (if present)
3. Record git rev-parse HEAD as the pre-iteration baseline (manual-rollback reference only in this slice)
4. OpenCodeAdapter.runAgentTask(main-dev profile, prompt, cwd = fixtures/sample-project)
   → streamed event parsing into events.jsonl as described in §4
5. Review Gate:
   a. Deterministic checks: run configured shell commands in order (sample project: `eslint .`, `vitest run`).
      Any non-zero exit → fail immediately, skip AI review (saves cost); truncated failure output appended to fix_list.md
   b. If checks pass → AI Review: assemble `git diff` + story acceptance criteria, call LLM Client (reviewer profile,
      direct HTTP channel), require pure JSON output, validate against the review schema (parent design §5.4);
      on parse failure, retry once with the error appended; judge pass/fail via fail_on / fail_threshold
6. Outcome:
   - Pass → prd.json story.passes = true; git commit (message includes story id); append progress.md entry
   - Fail → append fix_list.md entry; story.fixCount += 1; if fixCount > per_story_fix_limit → story status = suspended
7. Atomic state.json write (temp file + rename)
```

Both gate layers are included in this slice (not deferred), per explicit decision — this pulls the minimal LLM Client into scope now rather than as a separate follow-on increment.

**Boundary:** single story, single iteration only. No stall detection, no automatic multi-round retry loop — that is the next increment ("run `ralph-only` pipeline to completion across many iterations"). This slice proves every step of *one* iteration is real and working end-to-end.

## 6. File Formats and Directory Layout

Builds on parent design §4/§5, made concrete for this slice:

```
.aiflow/
├── config/
│   ├── models.yaml              # main-dev (opencode) + reviewer (http, minimax/kimi)
│   ├── pipelines/ralph-only.yaml
│   └── project.yaml             # checks commands, per_story_fix_limit, etc.
├── runs/<run_id>/
│   ├── state.json               # single-stage state machine snapshot
│   ├── events.jsonl             # see schema below
│   ├── artifacts/
│   │   ├── opencode/<call-id>.jsonl        # raw OpenCode event stream archive
│   │   ├── progress.md
│   │   ├── fix_list.md
│   │   └── reviews/story-<id>-round-<n>.json  # raw AI review JSON
│   └── run-report.md            # minimal for this slice: duration + cost + pass/fail
```

**events.jsonl schema** (AIFlow's own event types, mapped from real OpenCode events):
```json
{"ts":"...","type":"opencode_tool_use","stage":"develop","story":"US-1","tool":"write","summary":"wrote lib/foo.ts"}
{"ts":"...","type":"opencode_step_finish","stage":"develop","in_tok":10910,"out_tok":120,"cost_usd":0.0031}
{"ts":"...","type":"gate_result","stage":"develop","story":"US-1","checks":"pass","ai_review":"fail","blockers":1}
{"ts":"...","type":"story_result","story":"US-1","result":"pass|fail|suspended"}
```

**prd.json** (hand-authored for this slice; no `plan` stage exists yet to generate it):
```json
{ "branchName": "feat/us-1", "stories": [{ "id": "US-1", "title": "...", "acceptance": ["..."], "priority": 1, "passes": false, "fixCount": 0 }] }
```

## 7. Sample Project Fixture, CLI Surface, Repo Scaffold

**`fixtures/sample-project/`** — disposable validation target, isolated from AIFlow's own source:
```
fixtures/sample-project/
├── package.json          # eslint + vitest
├── src/math.ts           # deliberately incomplete function for the story to implement
├── test/math.test.ts     # tests matching the story's acceptance criteria
├── .aiflow/config/...    # this fixture's own models.yaml / pipeline config
├── spec.md               # hand-written
└── prd.json              # hand-written, one story: implement `clamp(value, min, max)`
```
The story is deliberately designed so the deterministic checks fail on the first attempt (e.g., a missing edge case), so the slice exercises **both** the checks-fail path and the checks-pass → AI-review path, not just a single happy pass.

**CLI surface (this slice):**
```
aiflow doctor                              # probe opencode version/models/auth, reviewer key connectivity, git status
aiflow init                                # generate .aiflow/ scaffold
aiflow run --pipeline ralph-only --once    # run exactly one iteration; --once bounds this slice's scope
```

**Repository scaffold** (TypeScript + Bun, single package — no monorepo; GUI will be a separate future project/repo):
```
aiflow/
├── package.json / bun.lock / tsconfig.json
├── src/
│   ├── cli.ts                       # CLI entry point
│   ├── engine/                      # Pipeline Engine state machine
│   ├── runners/ralph-loop.ts        # Stage Runner registry entry
│   ├── adapters/opencode.ts         # OpenCode Adapter
│   ├── llm/client.ts                # LLM Client (direct HTTP channel)
│   ├── gate/review-gate.ts          # Check Runner + AI Review
│   └── config/{models,pipeline}.ts  # zod schemas + loaders
├── fixtures/sample-project/
├── docs/superpowers/specs/
└── test/                            # unit tests + integration (one real call + mocked branch coverage)
```

## 8. Testing Strategy

- **Unit**: state machine transitions, config schema validation, review pass/fail judgment rules, JSON parse-retry-fallback logic, cost accumulation from `step_finish` events.
- **Integration (mocked)**: fake OpenCode Adapter + fake LLM Client exercising the full single-iteration flow, including the checks-fail and ai-review-fail branches.
- **Integration (real, gated)**: one real `aiflow run --pipeline ralph-only --once` against `fixtures/sample-project`, requiring OpenCode + a configured reviewer API key; skipped in CI if the reviewer key isn't present, but run manually during this slice's implementation to confirm real end-to-end behavior.

## 9. Open Items to Resolve During Implementation

1. Exact MiniMax/Kimi direct-HTTP model id and base URL — verify via `aiflow doctor`'s HTTP-channel check once the user exports the real API key (not guessed in this spec).
2. Whether `opencode agent create` can be scripted non-interactively enough to be worth wiring into `aiflow doctor`'s validation, or whether referencing pre-existing agents (`opencode agent list`) is sufficient for now.
3. Precise truncation limits for check-failure output and `git diff` size fed into AI review (needs a sensible default, e.g. a token-budget-based truncation, refined once real diffs are observed).
