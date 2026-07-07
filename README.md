# AIFlow

A lightweight, file-driven pipeline orchestrator that delegates every code-level agent task to **[OpenCode](https://github.com/sst/opencode)**.

AIFlow is not an "agent". It is an **orchestrator + gate-keeper + monitor**:

- It models work as ordered **stages** (`ralph_loop`, `spec`, `brainstorm`, `human_gate`, …) declared in a YAML pipeline.
- Stages emit files and git commits; everything is auditable and resumable.
- A **two-layer Review Gate** sits between agent output and progress: deterministic checks (lint / test / build) first, structured AI review second.
- A read-only **Monitor** renders live state by tailing `events.jsonl` + `state.json`.

For the full design rationale see [`文档设计`](./文档设计).

---

## Why this exists (TL;DR)

| | AIFlow (this repo) | Hand-rolled agent scripts | Ruflo / similar |
| --- | --- | --- | --- |
| Resume after crash | Yes (atomic `state.json`) | No | Partial |
| Deterministic gate before AI | Yes | Maybe | Configurable |
| External verification | Yes (reviewer ≠ implementer) | No | Partial — see their open verification issue |
| Artifact lineage | Yes (per-run directory) | No | Yes |
| Stays small | Yes (<2k LoC TS) | N/A | No |

The design is deliberately small: **every** AI judgment is preceded by a deterministic check, and every AI output is schema-validated before it is allowed to advance state. See §6.7 of `文档设计` for why we never trust agent self-reports.

---

## Quick start

AIFlow is a [Bun](https://bun.sh) (≥1.3) TypeScript CLI.

```bash
bun install
bun run src/cli.ts --help
```

The first vertical slice runs **one** Ralph Loop iteration end-to-end (spec → plan → ralph_loop → review gate → git commit). Use it as a reference for a real run:

```bash
cd fixtures/sample-project
# fill in the reviewer model + base_url + api key (once per machine)
# see "Configuration" below
MINIMAX_API_KEY=sk-cp-... bun run ../../src/cli.ts run --pipeline ralph-only --once
MINIMAX_API_KEY=sk-cp-... bun run ../../src/cli.ts status
```

### Commands

| Command | What it does |
| --- | --- |
| `aiflow doctor` | Check OpenCode version, git repo, reviewer API reachability |
| `aiflow init` | Scaffold a `.aiflow/config/` directory in the current project |
| `aiflow run --pipeline <name>` | Run a pipeline (with optional `--once` to stop after one iteration) |
| `aiflow resume` | Resume an in-flight or previously-aborted run from its `state.json` (`--run-id`, `--pipeline`, `--force`) |
| `aiflow approve` | Approve a stage that is `waiting_human` and resume the pipeline (`--run-id`, `--stage`) |
| `aiflow reject` | Reject a stage that is `waiting_human`, aborting the pipeline (`--run-id`, `--stage`, `--reason`) |
| `aiflow status` | Render a one-shot read-only snapshot of the latest run |
| `aiflow watch` | Re-render the same snapshot every second (Ctrl+C to exit) |

`aiflow status` and `aiflow watch` accept `--run-id <id>`, `--tail <n>`, and (for `status`) `--stall-timeout <s>` and `--no-color`.

`aiflow run` also accepts `--requirement <text>` (inline requirement text) or `--requirement-file <path>` (path to a file with the requirement text) — mutually exclusive — for pipelines whose first stage is `brainstorm` or `spec`.

`aiflow run`, `aiflow resume`, and `aiflow approve` handle Ctrl+C gracefully: they wait for the current step to finish, mark the remaining stages `paused` in `state.json`, and exit — a later `aiflow resume` picks the pipeline back up normally, without needing `--force`.

---

## Configuration

Each project that wants AIFlow to drive its work gets a `.aiflow/` directory. `aiflow init` scaffolds it and writes `.aiflow/runs/` into `.gitignore`.

`.aiflow/config/models.yaml` declares named **profiles**. Two channels are supported:

```yaml
profiles:
  main-dev:                      # implements code changes via OpenCode
    channel: opencode
    provider: minimax-cn-coding-plan
    model: MiniMax-M3
  reviewer:                      # structured AI review over the diff
    channel: http
    provider: minimax
    model: MiniMax-M3
    base_url: https://api.minimaxi.com/v1
    api_key_env: MINIMAX_API_KEY
```

- The **opencode** channel runs `opencode run --format json` per iteration; it relies on OpenCode's own provider registry.
- The **http** channel hits the model's OpenAI-compatible `/chat/completions` endpoint directly. All API keys are sourced from environment variables referenced by `api_key_env` — never hard-coded.

`.aiflow/config/pipelines/<name>.yaml` declares the stages. The bundled `ralph-only` pipeline is a one-stage loop suitable for dev iteration; a pipeline can now declare any ordered combination of the following stage types:

- `brainstorm` — fans a requirement out to multiple models (`independent` or `debate` mode) and synthesizes a report
- `spec` — turns a requirement/brainstorm report into a `spec.md` with verifiable acceptance criteria
- `plan` — turns a spec into `prd.json` (the story backlog `ralph_loop` consumes)
- `human_gate` — pauses the pipeline in `waiting_human` until `aiflow approve`/`aiflow reject` is run, or `timeout` elapses
- `ralph_loop` — the implement/gate/commit loop described below

A `full-auto` pipeline (`brainstorm → spec → confirm-spec(human_gate) → plan → develop(ralph_loop)`) is a typical composition of these.

### Bundled pipeline templates

`aiflow init` scaffolds four ready-to-run pipelines into `.aiflow/config/pipelines/`, each approximating a different development methodology using the stage types above. Pick one with `aiflow run --pipeline <name>`:

| Template | Stages | Approximates |
| --- | --- | --- |
| `ralph-only` | `ralph_loop` | Just the implement/gate/commit loop, against a hand-authored `spec.md`/`prd.json` |
| `superpowers` | `brainstorm → spec → human_gate → plan → ralph_loop` | This repo's own brainstorm→spec→plan→execute→review workflow |
| `spec-superflow` | `brainstorm → spec → human_gate → plan → ralph_loop` | Same stage topology as `superpowers` (AIFlow has no dedicated stage for its execution-contract bridging layer or forced debug protocol), different stage IDs/prompts reflecting its own vocabulary |
| `openspec` | `spec → plan → ralph_loop` | The leanest one — no `brainstorm`, no `human_gate`, matching OpenSpec's "lightweight, no mandatory gates" philosophy |

`superpowers`/`spec-superflow`/`openspec` all start with a `brainstorm` or `spec` stage, so they need `aiflow run --pipeline <name> --requirement "..."` (or `--requirement-file`) — see `docs/superpowers/specs/2026-07-07-workflow-pipeline-templates-design.md` for the full methodology research and what each template deliberately does not attempt to replicate from the original tools.

A `ralph_loop` stage keeps selecting the highest-priority pending story from `prd.json` and retrying until every story is done or suspended, until `max_iterations` (default 10) is reached, or until `stall_limit` (default 3) consecutive iterations make no progress. A story that fails more than `per_story_fix_limit` (default 3) times is marked `suspended` in `prd.json` and skipped in favor of the next pending story — it does not stop the whole stage. When a stage stops without finishing every story, `state.json`'s `stages[i].reason` (and the corresponding `ralph_loop_result` event in `events.jsonl`) records why: `"max_iterations"`, `"stall"`, or `"stories_suspended"`.

Setting `auto_clean: true` on a `ralph_loop` stage reverts the working tree to `HEAD` whenever a story is newly suspended, discarding that story's uncommitted, unfinished edits before moving on to the next one. It requires a clean working tree at run start.

### How to find the right model id and base_url

Run `aiflow doctor`. If it reports `Reviewer reachable: false` with an error like `JSON parse error` or `HTTP 401`, the most likely cause is an incorrect `base_url`. Re-check the provider's current documentation — different regions often have different base URLs.

---

## Per-run artifacts

Every `aiflow run` creates `.aiflow/runs/<run-id>/`:

| File / dir | Purpose |
| --- | --- |
| `state.json` | Atomic engine snapshot — used by `aiflow resume` and the monitor |
| `events.jsonl` | Append-only structured event stream (consumed by `status` / `watch`) |
| `run-report.md` | Final summary — stages, cost, event counts, story outcomes |
| `artifacts/opencode/<call>.jsonl` | Verbatim OpenCode JSONL transcript per agent call |
| `artifacts/fix_list.md` | Accumulated gate feedback between iterations |
| `artifacts/progress.md` | Appended on each passed story |

`.aiflow/runs/` is git-ignored per project.

---

## Running the tests

```bash
bun test ./test
```

The full suite (≈85 tests) covers:

- `test/unit/` — every module's contract; pure-function tests where possible.
- `test/integration/ralph-loop-mocked.test.ts` — full pipeline with `runAgentTask` and `callReviewer` injected as mocks.
- `test/integration/ralph-loop-real.test.ts` — live OpenCode + live reviewer; skipped if `MINIMAX_API_KEY` is unset.

---

## Security

- All API keys flow through environment variables referenced by `api_key_env`. Logs and reports run through a redaction pass before write.
- `.aiflow/runs/` is in `.gitignore` so per-run artifacts never reach the repo.
- Pipeline config is treated as **read-only at runtime**; gate checks compare a hash of `.aiflow/config/` before and after each iteration, blocking any modification from a stage's own code.

---

## Project layout

```
src/
├── adapters/         # OpenCode subprocess + JSONL event parser
├── cli.ts            # commander entry point
├── commands/         # doctor / init / run / resume / approve / reject / monitor / report
├── config/           # zod schemas + YAML loader
├── engine/           # pipeline state machine (multi-stage: brainstorm/spec/plan/human_gate/ralph_loop)
├── events/           # events.jsonl read/append
├── gate/             # check-runner + review-gate + LLM client
├── git.ts            # thin rev-parse / stageAll / diffCached / commit helpers
├── prd.ts            # prd.json read/write + story state machines
├── runners/          # stage runners: ralph-loop.ts, brainstorm.ts, spec.ts, plan.ts, human-gate.ts
└── llm/              # direct-HTTP LLM client for the reviewer channel

test/
├── unit/             # per-module unit tests
└── integration/      # full-pipeline mocked + real e2e
```

---

## Status

The first vertical slice (Tasks 1–18 of the implementation plan in `docs/superpowers/plans/2026-07-05-aiflow-cli-ralph-slice-plan.md`) shipped `ralph-only` end-to-end: real event stream ingestion, deterministic + AI review gate, git commit, monitor, and report, against a real OpenCode agent and a real reviewer API.

A subsequent plan (`docs/superpowers/specs/2026-07-06-multi-stage-pipeline-runners-design.md`) added multi-stage pipeline support: the `brainstorm`, `spec`, `plan`, and `human_gate` stage types, `aiflow approve`/`aiflow reject`, and `run --requirement`/`--requirement-file`. Pipelines can now compose any ordered mix of these stage types alongside `ralph_loop`, and `aiflow resume` picks up an in-flight or aborted run from any stage.

A follow-up (`docs/superpowers/specs/2026-07-07-workflow-pipeline-templates-design.md`) added the `superpowers`/`spec-superflow`/`openspec` pipeline templates to `aiflow init`, alongside the existing `ralph-only`.

Not yet implemented: budget tracking/auto-pause on `budget.max_cost_usd`, re-running a prior stage after a `human_gate` rejection (reject currently just aborts the pipeline), and `doctor` connectivity checks for the newer profile/stage types — see `docs/superpowers/` for the full roadmap.

---

## License

The OpenCode CLI that AIFlow orchestrates is MIT-licensed. AIFlow itself is currently unlicensed (private). Treat it as "all rights reserved" pending an explicit LICENSE file.
