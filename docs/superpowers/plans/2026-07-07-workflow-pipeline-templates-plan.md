# Workflow Pipeline Template Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `aiflow init` scaffold four ready-to-run pipeline templates (`ralph-only`, `superpowers`, `spec-superflow`, `openspec`) instead of just one, so a user can pick a development methodology with `aiflow run --pipeline <name>` — no new CLI surface.

**Architecture:** Move pipeline YAML templates out of `src/commands/init.ts`'s embedded TS string constants into standalone files under `src/commands/init-templates/`, read at scaffold time via `import.meta.dir`. Add a second `http`-channel profile (`alt-reviewer`) to the models.yaml scaffold so `brainstorm`'s `.min(2)` models requirement is satisfiable out of the box.

**Tech Stack:** TypeScript, Bun, zod, yaml (all already in use — no new dependencies).

## Global Constraints

- No new npm dependencies.
- No new CLI commands or flags — template selection is `aiflow run --pipeline <name>`, already existing.
- `brainstorm`/`plan` stages may only reference `channel: http` profiles; `spec`/`ralph_loop` stages may only reference `channel: opencode` profiles (see design doc §3.1). Every new template must respect this.
- Every task must leave `bun test ./test` fully green before moving to the next task.
- `MODELS_YAML_TEMPLATE`/`PROJECT_YAML_TEMPLATE` stay as embedded TS strings in `init.ts` — only the pipeline templates move to files (design doc §3.2 explicitly scopes this out).

---

### Task 1: Move the `ralph-only` pipeline template to a standalone file

This task changes the *mechanism* only — no new template content yet. Isolating the refactor from the new content means a failure here can't be confused with a content bug in Task 3.

**Files:**
- Create: `src/commands/init-templates/ralph-only.yaml`
- Modify: `src/commands/init.ts`
- Test: `test/unit/init-templates.test.ts` (new)

**Interfaces:**
- Produces: `src/commands/init.ts` exports `PIPELINE_TEMPLATE_NAMES: string[]` (module-level, not exported — internal to the file, but later tasks append to this array) and reads each named template from `join(import.meta.dir, "init-templates", "<name>.yaml")`.

- [ ] **Step 1: Create the template file**

Create `src/commands/init-templates/ralph-only.yaml` with exactly this content (identical to the current `RALPH_ONLY_YAML_TEMPLATE` string in `src/commands/init.ts`):

```yaml
name: ralph-only
stages:
  - id: develop
    type: ralph_loop
    model: main-dev
    per_story_fix_limit: 3
    gate:
      checks:
        - "npm run lint"
        - "npm run test"
      ai_review:
        enabled: true
        model: reviewer
        fail_on: ["blocker"]
        fail_threshold:
          major: 3
        strict: false
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/init-templates.test.ts`:

```ts
import { test, expect } from "bun:test";
import { join } from "node:path";
import { loadPipelineConfig } from "../../src/config/loader";

const TEMPLATES_DIR = join(process.cwd(), "src", "commands", "init-templates");

test("ralph-only.yaml template parses against the real pipeline schema", () => {
  const config = loadPipelineConfig(join(TEMPLATES_DIR, "ralph-only.yaml"));
  expect(config.name).toBe("ralph-only");
  expect(config.stages.map((s) => s.type)).toEqual(["ralph_loop"]);
});
```

- [ ] **Step 3: Run test to verify it passes (the file already exists from Step 1, so this should already pass)**

Run: `bun test test/unit/init-templates.test.ts`
Expected: PASS — this test only reads the static file, it doesn't depend on `init.ts` yet.

- [ ] **Step 4: Refactor `src/commands/init.ts` to read the template from disk**

Replace the `RALPH_ONLY_YAML_TEMPLATE` constant and the `runInit` function body. The full new file:

```ts
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export interface InitResult {
  created: boolean;
  reason?: string;
}

const MODELS_YAML_TEMPLATE = `profiles:
  main-dev:
    channel: opencode
    provider: opencode
    model: deepseek-v4-flash-free
  reviewer:
    channel: http
    provider: minimax
    model: REPLACE_ME_VERIFY_VIA_DOCTOR
    base_url: REPLACE_ME_VERIFY_VIA_DOCTOR
    api_key_env: MINIMAX_API_KEY
`;

const PROJECT_YAML_TEMPLATE = `{}
`;

const TEMPLATES_DIR = join(import.meta.dir, "init-templates");
const PIPELINE_TEMPLATE_NAMES = ["ralph-only"];

export function runInit(cwd: string): InitResult {
  const configDir = join(cwd, ".aiflow", "config");
  if (existsSync(configDir)) {
    return { created: false, reason: ".aiflow/config already exists; refusing to overwrite" };
  }

  mkdirSync(join(configDir, "pipelines"), { recursive: true });
  writeFileSync(join(configDir, "models.yaml"), MODELS_YAML_TEMPLATE);
  for (const name of PIPELINE_TEMPLATE_NAMES) {
    const content = readFileSync(join(TEMPLATES_DIR, `${name}.yaml`), "utf-8");
    writeFileSync(join(configDir, "pipelines", `${name}.yaml`), content);
  }
  writeFileSync(join(configDir, "project.yaml"), PROJECT_YAML_TEMPLATE);

  const gitignorePath = join(cwd, ".gitignore");
  const ignoreLine = ".aiflow/runs/";
  if (existsSync(gitignorePath)) {
    const existing = readFileSync(gitignorePath, "utf-8");
    if (!existing.includes(ignoreLine)) {
      appendFileSync(gitignorePath, `\n${ignoreLine}\n`);
    }
  } else {
    writeFileSync(gitignorePath, `${ignoreLine}\n`);
  }

  return { created: true };
}
```

- [ ] **Step 5: Run the existing init test suite to confirm no regression**

Run: `bun test test/unit/init.test.ts`
Expected: PASS — all 4 pre-existing tests in this file still pass unchanged. This is the proof that the refactor didn't change `runInit`'s observable behavior.

- [ ] **Step 6: Run the full suite**

Run: `bun test ./test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/commands/init.ts src/commands/init-templates/ralph-only.yaml test/unit/init-templates.test.ts
git commit -m "refactor: move ralph-only pipeline template from init.ts to a standalone yaml file"
```

---

### Task 2: Add the `alt-reviewer` http profile to the models.yaml scaffold

**Files:**
- Modify: `src/commands/init.ts`
- Test: `test/unit/init.test.ts`

**Interfaces:**
- Consumes: `loadModelsConfig` from `src/config/loader.ts` (existing, unchanged).

- [ ] **Step 1: Write the failing test**

Add to `test/unit/init.test.ts` (add `loadModelsConfig` to the existing imports — the top of the file currently imports only from `node:fs`/`node:path`/`../../src/commands/init`; add `import { loadModelsConfig } from "../../src/config/loader";`), then append this new test at the end of the file:

```ts
test("runInit's models.yaml scaffold has at least 2 http-channel profiles for brainstorm's models list", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-init-test-"));
  try {
    runInit(dir);
    const config = loadModelsConfig(join(dir, ".aiflow", "config", "models.yaml"));
    const httpProfiles = Object.values(config.profiles).filter((p) => p.channel === "http");
    expect(httpProfiles.length).toBeGreaterThanOrEqual(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/init.test.ts`
Expected: FAIL — the current scaffold has exactly one `http`-channel profile (`reviewer`).

- [ ] **Step 3: Add the `alt-reviewer` profile**

In `src/commands/init.ts`, replace `MODELS_YAML_TEMPLATE` with:

```ts
const MODELS_YAML_TEMPLATE = `profiles:
  main-dev:
    channel: opencode
    provider: opencode
    model: deepseek-v4-flash-free
  reviewer:
    channel: http
    provider: minimax
    model: REPLACE_ME_VERIFY_VIA_DOCTOR
    base_url: REPLACE_ME_VERIFY_VIA_DOCTOR
    api_key_env: MINIMAX_API_KEY
  alt-reviewer:
    channel: http
    provider: REPLACE_ME_VERIFY_VIA_DOCTOR
    model: REPLACE_ME_VERIFY_VIA_DOCTOR
    base_url: REPLACE_ME_VERIFY_VIA_DOCTOR
    api_key_env: ALT_REVIEWER_API_KEY
`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/init.test.ts`
Expected: PASS (all tests, including the new one).

- [ ] **Step 5: Run the full suite**

Run: `bun test ./test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/init.ts test/unit/init.test.ts
git commit -m "feat: add a second http-channel profile (alt-reviewer) to the models.yaml scaffold"
```

---

### Task 3: Add the `superpowers`, `spec-superflow`, and `openspec` pipeline templates

**Files:**
- Create: `src/commands/init-templates/superpowers.yaml`
- Create: `src/commands/init-templates/spec-superflow.yaml`
- Create: `src/commands/init-templates/openspec.yaml`
- Modify: `src/commands/init.ts`
- Modify: `test/unit/init.test.ts`
- Modify: `test/unit/init-templates.test.ts`

**Interfaces:**
- Consumes: `PIPELINE_TEMPLATE_NAMES` (Task 1), `loadModelsConfig`/`loadPipelineConfig` (existing), `runInit` (Task 1/2).

- [ ] **Step 1: Create the three template files**

Create `src/commands/init-templates/superpowers.yaml`:

```yaml
name: superpowers
stages:
  - id: ideate
    type: brainstorm
    models: ["reviewer", "alt-reviewer"]
    synthesizer: reviewer
    output: brainstorm-report.md
  - id: spec
    type: spec
    model: main-dev
  - id: confirm-spec
    type: human_gate
    prompt: "Review spec.md and the brainstorm synthesis. Approve to proceed to planning, or reject to send this back for rework."
  - id: plan
    type: plan
    model: reviewer
  - id: develop
    type: ralph_loop
    model: main-dev
    per_story_fix_limit: 3
    gate:
      checks:
        - "npm run lint"
        - "npm run test"
      ai_review:
        enabled: true
        model: reviewer
        fail_on: ["blocker"]
        fail_threshold:
          major: 3
        strict: false
```

Create `src/commands/init-templates/spec-superflow.yaml`:

```yaml
name: spec-superflow
stages:
  - id: exploring
    type: brainstorm
    models: ["reviewer", "alt-reviewer"]
    synthesizer: reviewer
    output: brainstorm-report.md
  - id: specifying
    type: spec
    model: main-dev
  - id: bridging-review
    type: human_gate
    prompt: "Confirm spec.md captures a complete execution contract (scope, acceptance criteria, and constraints) before implementation begins. Reject to send this back for another planning pass."
  - id: tasks
    type: plan
    model: reviewer
  - id: executing
    type: ralph_loop
    model: main-dev
    per_story_fix_limit: 3
    gate:
      checks:
        - "npm run lint"
        - "npm run test"
      ai_review:
        enabled: true
        model: reviewer
        fail_on: ["blocker"]
        fail_threshold:
          major: 3
        strict: false
```

Create `src/commands/init-templates/openspec.yaml`:

```yaml
name: openspec
stages:
  - id: proposal
    type: spec
    model: main-dev
  - id: tasks
    type: plan
    model: reviewer
  - id: apply
    type: ralph_loop
    model: main-dev
    per_story_fix_limit: 3
    gate:
      checks:
        - "npm run lint"
        - "npm run test"
      ai_review:
        enabled: true
        model: reviewer
        fail_on: ["blocker"]
        fail_threshold:
          major: 3
        strict: false
```

- [ ] **Step 2: Write the failing tests**

Append to `test/unit/init-templates.test.ts`:

```ts
test("superpowers.yaml template parses with the expected stage sequence", () => {
  const config = loadPipelineConfig(join(TEMPLATES_DIR, "superpowers.yaml"));
  expect(config.name).toBe("superpowers");
  expect(config.stages.map((s) => s.type)).toEqual(["brainstorm", "spec", "human_gate", "plan", "ralph_loop"]);
});

test("spec-superflow.yaml template parses with the expected stage sequence", () => {
  const config = loadPipelineConfig(join(TEMPLATES_DIR, "spec-superflow.yaml"));
  expect(config.name).toBe("spec-superflow");
  expect(config.stages.map((s) => s.type)).toEqual(["brainstorm", "spec", "human_gate", "plan", "ralph_loop"]);
});

test("openspec.yaml template parses with the expected stage sequence", () => {
  const config = loadPipelineConfig(join(TEMPLATES_DIR, "openspec.yaml"));
  expect(config.name).toBe("openspec");
  expect(config.stages.map((s) => s.type)).toEqual(["spec", "plan", "ralph_loop"]);
});
```

Also append this cross-check test to the same file (it needs `runInit`, `loadModelsConfig`, and filesystem temp-dir helpers — add these imports to the top of `test/unit/init-templates.test.ts`: `import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { runInit } from "../../src/commands/init"; import { loadModelsConfig } from "../../src/config/loader"; import type { PipelineConfig } from "../../src/config/schema";`):

```ts
test("every profile referenced by a bundled pipeline template exists in the default models.yaml scaffold", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-init-templates-test-"));
  try {
    runInit(dir);
    const modelsConfig = loadModelsConfig(join(dir, ".aiflow", "config", "models.yaml"));
    const knownProfiles = new Set(Object.keys(modelsConfig.profiles));

    function assertStageProfilesKnown(stage: PipelineConfig["stages"][number]) {
      if (stage.type === "ralph_loop" || stage.type === "spec" || stage.type === "plan") {
        expect(knownProfiles.has(stage.model)).toBe(true);
      }
      if (stage.type === "brainstorm") {
        for (const modelName of stage.models) expect(knownProfiles.has(modelName)).toBe(true);
        expect(knownProfiles.has(stage.synthesizer)).toBe(true);
      }
      if (stage.type === "ralph_loop" && stage.gate.ai_review.enabled) {
        expect(knownProfiles.has(stage.gate.ai_review.model)).toBe(true);
      }
    }

    for (const templateName of ["ralph-only", "superpowers", "spec-superflow", "openspec"]) {
      const pipeline = loadPipelineConfig(join(TEMPLATES_DIR, `${templateName}.yaml`));
      for (const stage of pipeline.stages) assertStageProfilesKnown(stage);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Extend `test/unit/init.test.ts`'s scaffold test (this is the step that produces a genuine RED)**

In `test/unit/init.test.ts`, find the test `"runInit creates the .aiflow/config scaffold with default files"` and add these three assertions right after the existing `expect(existsSync(join(dir, ".aiflow", "config", "pipelines", "ralph-only.yaml"))).toBe(true);` line:

```ts
    expect(existsSync(join(dir, ".aiflow", "config", "pipelines", "superpowers.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".aiflow", "config", "pipelines", "spec-superflow.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".aiflow", "config", "pipelines", "openspec.yaml"))).toBe(true);
```

- [ ] **Step 4: Run tests to verify the new assertions fail**

Run: `bun test test/unit/init.test.ts`
Expected: FAIL on the three new assertions — `runInit` only copies `ralph-only.yaml` into the scaffolded output today (`PIPELINE_TEMPLATE_NAMES` doesn't list the three new templates yet), even though the raw template files already exist under `src/commands/init-templates/` from Step 1. The three direct-parse tests and the cross-check test in `init-templates.test.ts` will already pass at this point (they read `src/commands/init-templates/` directly, not the scaffolded output) — that's expected; the RED signal to look for is specifically in `init.test.ts`.

- [ ] **Step 5: Register the three new templates in `init.ts`**

In `src/commands/init.ts`, change:

```ts
const PIPELINE_TEMPLATE_NAMES = ["ralph-only"];
```

to:

```ts
const PIPELINE_TEMPLATE_NAMES = ["ralph-only", "superpowers", "spec-superflow", "openspec"];
```

- [ ] **Step 6: Run tests to verify everything passes**

Run: `bun test test/unit/init.test.ts test/unit/init-templates.test.ts`
Expected: PASS (all tests in both files).

- [ ] **Step 7: Run the full suite**

Run: `bun test ./test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/commands/init.ts src/commands/init-templates/superpowers.yaml src/commands/init-templates/spec-superflow.yaml src/commands/init-templates/openspec.yaml test/unit/init.test.ts test/unit/init-templates.test.ts
git commit -m "feat: add superpowers/spec-superflow/openspec pipeline templates to aiflow init"
```

---

### Task 4: Document the bundled pipeline templates in the README

**Files:**
- Modify: `README.md`

**Interfaces:** None (docs-only task).

- [ ] **Step 1: Add a "Bundled pipeline templates" subsection**

In `README.md`, find this existing paragraph (in the `## Configuration` section, right after the stage-type bullet list):

```
A `full-auto` pipeline (`brainstorm → spec → confirm-spec(human_gate) → plan → develop(ralph_loop)`) is a typical composition of these.
```

Insert this new subsection immediately after it (before the `A \`ralph_loop\` stage keeps selecting...` paragraph):

```markdown

### Bundled pipeline templates

`aiflow init` scaffolds four ready-to-run pipelines into `.aiflow/config/pipelines/`, each approximating a different development methodology using the stage types above. Pick one with `aiflow run --pipeline <name>`:

| Template | Stages | Approximates |
| --- | --- | --- |
| `ralph-only` | `ralph_loop` | Just the implement/gate/commit loop, against a hand-authored `spec.md`/`prd.json` |
| `superpowers` | `brainstorm → spec → human_gate → plan → ralph_loop` | This repo's own brainstorm→spec→plan→execute→review workflow |
| `spec-superflow` | `brainstorm → spec → human_gate → plan → ralph_loop` | Same stage topology as `superpowers` (AIFlow has no dedicated stage for its execution-contract bridging layer or forced debug protocol), different stage IDs/prompts reflecting its own vocabulary |
| `openspec` | `spec → plan → ralph_loop` | The leanest one — no `brainstorm`, no `human_gate`, matching OpenSpec's "lightweight, no mandatory gates" philosophy |

`superpowers`/`spec-superflow`/`openspec` all start with a `brainstorm` or `spec` stage, so they need `aiflow run --pipeline <name> --requirement "..."` (or `--requirement-file`) — see `docs/superpowers/specs/2026-07-07-workflow-pipeline-templates-design.md` for the full methodology research and what each template deliberately does not attempt to replicate from the original tools.
```

- [ ] **Step 2: Update the `## Status` section**

Find this line:

```
Not yet implemented: budget tracking/auto-pause on `budget.max_cost_usd`, re-running a prior stage after a `human_gate` rejection (reject currently just aborts the pipeline), and `doctor` connectivity checks for the newer profile/stage types — see `docs/superpowers/` for the full roadmap.
```

Replace it with:

```
A follow-up (`docs/superpowers/specs/2026-07-07-workflow-pipeline-templates-design.md`) added the `superpowers`/`spec-superflow`/`openspec` pipeline templates to `aiflow init`, alongside the existing `ralph-only`.

Not yet implemented: budget tracking/auto-pause on `budget.max_cost_usd`, re-running a prior stage after a `human_gate` rejection (reject currently just aborts the pipeline), and `doctor` connectivity checks for the newer profile/stage types — see `docs/superpowers/` for the full roadmap.
```

- [ ] **Step 3: Verify the doc renders sensibly**

Run: `bun test test/unit/init.test.ts` (confirm nothing about docs changes broke anything — this is a pure sanity check since docs changes can't fail tests, but confirms the working tree is otherwise clean)
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document the bundled pipeline templates from aiflow init"
```

---

## Self-Review Notes

- **Spec coverage:** §3.1 (channel constraint) → enforced by Task 2's `alt-reviewer` addition and Task 3's cross-check test. §3.2 (file-based storage) → Task 1. §3.3 (four templates' exact content) → Tasks 1 and 3, YAML copied verbatim from the design doc. §3.4 (README) → Task 4. §4 (test plan: extend init.test.ts, new init-templates.test.ts with schema-parse assertions) → Tasks 1, 2, 3 collectively. §5 (not doing new CLI flags, not doing 1:1 tool parity, not doing e2e real-call tests) → respected throughout; no task adds a flag or a real-LLM test.
- **Placeholder scan:** no TBD/TODO; every YAML file and test has complete, copy-pasteable content.
- **Type consistency:** `PIPELINE_TEMPLATE_NAMES` (Task 1) is the exact identifier Task 3 modifies. `TEMPLATES_DIR` (Task 1, in both `init.ts` and `init-templates.test.ts`) is used consistently. `loadPipelineConfig`/`loadModelsConfig` signatures (existing, `(path: string) => PipelineConfig`/`ModelsConfig`) are used identically across Tasks 1-3's tests — no invented signatures.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-07-workflow-pipeline-templates-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
