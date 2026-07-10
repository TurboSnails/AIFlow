# Task 10: ReviewMatrix Report

## What was implemented

Created `src/review/matrix.ts` exporting `runReviewMatrix`, a multi-reviewer AI review matrix that:

- Accepts `ReviewGateConfig["ai_review"]` and a `Record<string, ModelProfile>` of candidate reviewers.
- Excludes the reviewer whose name matches `authorProfile`.
- Returns `aiReview: "skipped"` when no reviewers remain and `strict` is `false`; returns `"fail"` when `strict` is `true`.
- Calls remaining reviewers in parallel via `Promise.all`.
- Validates each reviewer's output with `ReviewOutputSchema` (Zod) and treats any returned issue as a reviewer-level failure.
- Aggregates verdicts into `Record<string, "pass" | "fail" | "skipped">`.
- Merges issue lists from failing reviewers.
- Returns `aiReview: "pass"` when all non-skipped reviewers pass, `"fail"` when all non-skipped reviewers fail, and `"needs_arbitration"` on a split verdict.
- Aggregates token/cost usage across all reviewer calls.
- Handles reviewer exceptions by treating the failed reviewer as a fail with no issues, allowing the matrix to complete.
- Handles `enabled: false` by returning `skipped` with zero usage.

Created `test/unit/review-matrix.test.ts` with 10 unit tests covering author exclusion, pass/fail/arbitration verdicts, strict mode, disabled review, thrown reviewer calls, and usage aggregation.

## TDD evidence

### Red phase (module not found)

Command:

```bash
bun test test/unit/review-matrix.test.ts
```

Output:

```
bun test v1.3.12 (700fc117)

test/unit/review-matrix.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module '../../src/review/matrix' from '/Users/hassan/Documents/workspace/aiFile/CodeFlow/.claude/worktrees/feature+aiflow-m2m3m4/test/unit/review-matrix.test.ts'
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [9.00ms]
```

### Green phase (focused test)

Command:

```bash
bun test test/unit/review-matrix.test.ts
```

Output:

```
bun test v1.3.12 (700fc117)

 10 pass
 0 fail
 27 expect() calls
Ran 10 tests across 1 file. [20.00ms]
```

## Full test suite result

Command:

```bash
bun test
```

Output:

```
bun test v1.3.12 (700fc117)
...
 370 pass
 1 skip
 0 fail
 913 expect() calls
Ran 371 tests across 51 files. [30.14s]
```

All existing tests continue to pass; no regressions introduced.

## Files changed

- `src/review/matrix.ts` (created)
- `test/unit/review-matrix.test.ts` (created)

## Self-review findings / concerns

- **Interface mismatch in the brief**: The brief's stated function signature lists `reviewers: ModelProfile[]`, but the provided test passes `{ rev: reviewer }`, i.e. `Record<string, ModelProfile>`. I implemented the record form because the test is the executable contract. Future consumers should pass a name-to-profile map.
- **Verdict semantics**: Per the ambiguity resolution, a reviewer is marked `fail` if it returns any issues at all, regardless of `fail_on` severity. `fail_on` is part of the config but is intentionally not used for individual reviewer verdicts in this matrix; it may be used later by the arbitrator or gate integration.
- **Missing profile handling**: If a reviewer name in `config.reviewers` has no entry in the reviewers map, it is marked `skipped` rather than throwing.
- **Reviewer exceptions**: Throws are caught and treated as a `fail` verdict with zero usage, so the matrix remains robust against transient LLM errors.
- **No persistence yet**: The matrix returns a result; integration with `specboard.recordReviewMatrix` is left for the downstream Arbitrator / ReviewGate integration tasks.

## Fix report

Addressed the review findings from Task 10 (ReviewMatrix):

1. **Aligned the documented public contract** — Updated `.superpowers/sdd/task-10-brief.md` so the `runReviewMatrix` interface documents `reviewers: Record<string, ModelProfile>` instead of `ModelProfile[]`, matching the executable contract and implementation.
2. **Preserved per-reviewer issue sets for arbitration** — Added `issueSets: ReviewOutput[]` to `ReviewMatrixResult` in `src/review/matrix.ts`, populated it in reviewer-config order from each successfully parsed, non-skipped reviewer, and kept `issues` as the merged list for fail paths. Updated `emptyResult` to include `issueSets: []`.
3. **Added missing edge-case tests** — Expanded `test/unit/review-matrix.test.ts` with tests for invalid `ReviewOutputSchema` data (counts as fail with usage), missing reviewer profiles (skipped), and all reviewers missing from the map (strict false → skipped, strict true → fail). Updated existing pass/fail/arbitration tests to assert `issueSets`.

### Commands run

Focused test file:

```bash
bun test test/unit/review-matrix.test.ts
```

Result: 14 pass, 0 fail, 53 expect() calls.

Full test suite:

```bash
bun test
```

Result: 374 pass, 1 skip, 0 fail, 939 expect() calls across 51 files.

### Notes

No implementation parameter types were changed; only the brief and result shape were brought into alignment with the existing code. The merged `issues` array remains available for downstream fail-path consumers, while `issueSets` provides the per-reviewer outputs needed by arbitration.
