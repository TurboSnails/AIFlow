# Task 14: Plan Runner OpenSpec integration

## What was implemented

Converted `src/runners/plan.ts` from an LLM-based spec-to-PRD converter into a deterministic OpenSpec transformer:

- Reads `spec.md` from the configured input path.
- Parses it with `parseOpenSpec`.
- Maps the parsed OpenSpec to the `Prd` shape:
  - `branchName = spec.meta.branch`
  - `stories = spec.tasks.map(...)` with `passes: false` and `fixCount: 0`.
- Validates the result with `PrdSchema.safeParse`.
- Writes `prd.json` to the configured output path.
- Registers the artifact via `registerArtifact(runDir, "prd", stageConfig.output)`.
- Emits a `plan_result` event and returns `result: "pass"` with zero usage.
- On any parse or validation failure, emits `plan_result` with `result: "fail"` and returns zero usage.
- **No LLM call** is made in the plan stage.

Dependencies were changed from `callLlm` to `parseOpenSpec` and `registerArtifact`, with real implementations as defaults. Callers in `src/commands/run.ts` and the integration test were updated to rely on the defaults instead of passing an LLM override.

Unit tests in `test/unit/plan.test.ts` were replaced to cover the new deterministic behavior:

1. Valid OpenSpec -> pass, correct `prd.json`, and artifact registered.
2. Missing `spec.md` -> stage fail.
3. Invalid OpenSpec content -> parse fails -> stage fail.
4. PRD validation failure (mocked missing branch) -> stage fail.

## TDD evidence (RED / GREEN)

RED: After writing the new tests but before changing the implementation, `bun test test/unit/plan.test.ts` failed because the old `runPlanStage` still called `deps.callLlm`, which was no longer provided by the new `PlanDeps`.

```
4 fail
TypeError: deps.callLlm is not a function
```

GREEN: After rewriting `src/runners/plan.ts` to use `parseOpenSpec` and `registerArtifact`, the focused file passed:

```
4 pass
0 fail
```

Full suite: `bun test` -> `384 pass, 1 skip, 0 fail`.

## Files changed

- `src/runners/plan.ts` — replaced LLM conversion with deterministic OpenSpec parsing and PRD generation.
- `test/unit/plan.test.ts` — added new tests for the OpenSpec-based plan stage.
- `src/commands/run.ts` — plan runner no longer receives a `callLlm` override.
- `test/integration/multi-stage-mocked.test.ts` — removed the plan LLM override; only `ralph_loop` is mocked now.

Commit: `e4e8b32 feat(plan): generate prd.json from OpenSpec`

## Self-review findings / concerns

- The `budget` parameter is accepted for API consistency but is never consumed because the plan stage is now token-free. This is intentional and documented in the code by prefixing the parameter with `_`.
- The PRD-validation-failure test uses a mocked `parseOpenSpec` that returns a malformed OpenSpec object because a valid OpenSpec currently always produces a valid PRD. This keeps the validation branch covered, but if the OpenSpec schema later relaxes `branch` or adds optional fields, a real fixture-based test would be preferable.
- The integration test now depends on the spec stage producing a valid OpenSpec file, which the existing fixture already does. This makes the test more realistic and removes the need for a fake LLM in the plan stage.
- No concerns that would block shipping.

## Fix report

### Changes made

1. **Atomic write for `prd.json`** (`src/runners/plan.ts`)
   - Replaced `writeFileSync` with `writeFileAtomic` from `../atomic/atomic-write` when persisting `prd.json`.
   - Preserved the existing JSON formatting: `JSON.stringify(validated.data, null, 2)`.
   - Removed the now-unused `writeFileSync` import from `node:fs`.

2. **Corrected misleading test name** (`test/unit/plan.test.ts`)
   - Renamed test `"missing spec.md -> parse fails -> stage fail"` to `"missing spec.md -> stage fail"` because the failure path is triggered by the missing file before `parseOpenSpec` is ever called.

### Verification

Focused test file:

```bash
bun test test/unit/plan.test.ts
```

Result: `4 pass, 0 fail`.

Full test suite:

```bash
bun test
```

Result: all tests pass with no new failures.

### Notes

- No behavior changes beyond the atomic-write guarantee and the test rename.
