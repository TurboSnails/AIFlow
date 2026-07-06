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
| `aiflow status` | Render a one-shot read-only snapshot of the latest run |
| `aiflow watch` | Re-render the same snapshot every second (Ctrl+C to exit) |

`aiflow status` and `aiflow watch` accept `--run-id <id>`, `--tail <n>`, and (for `status`) `--stall-timeout <s>` and `--no-color`.

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

`.aiflow/config/pipelines/<name>.yaml` declares the stages. The bundled `ralph-only` pipeline is a one-stage loop suitable for dev iteration; richer pipelines (`full-auto`, `spec-only`) are planned for v1.1.

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
├── commands/         # doctor / init / run / monitor / report
├── config/           # zod schemas + YAML loader
├── engine/           # pipeline state machine (single-stage for the slice)
├── events/           # events.jsonl read/append
├── gate/             # check-runner + review-gate + LLM client
├── git.ts            # thin rev-parse / stageAll / diffCached / commit helpers
├── prd.ts            # prd.json read/write + story state machines
├── runners/          # ralph_loop stage runner
└── llm/              # direct-HTTP LLM client for the reviewer channel

test/
├── unit/             # per-module unit tests
└── integration/      # full-pipeline mocked + real e2e
```

---

## Status

This is the first vertical slice (Tasks 1–18 of the implementation plan in `docs/superpowers/plans/2026-07-05-aiflow-cli-ralph-slice-plan.md`). It covers:

- `ralph-only` pipeline end-to-end against a real OpenCode agent and a real reviewer API.
- Real event stream ingestion, deterministic + AI review gate, git commit, monitor, and report.

Everything in the design spec outside that scope (multi-stage pipelines, brainstorm, human_gate, resume, full e2e with brainstorm) is **not yet implemented** — see `docs/superpowers/` for the full roadmap.

---

## License

The OpenCode CLI that AIFlow orchestrates is MIT-licensed. AIFlow itself is currently unlicensed (private). Treat it as "all rights reserved" pending an explicit LICENSE file.
