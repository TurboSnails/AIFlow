# Task 12 Report: Integrate ReviewMatrix into ReviewGate

## What was implemented

Wired the multi-reviewer `runReviewMatrix` (Task 10) and `runArbitrator` (Task 11) into the existing `runReviewGate` in `src/gate/review-gate.ts`.

- Added an optional `reviewers?: Record<string, ModelProfile>` parameter to `runReviewGate` so callers can supply the reviewer profile map when `config.ai_review.reviewers` has multiple entries.
- Added `runReviewMatrix` and `runArbitrator` to `ReviewGateDeps` (both optional, defaulting to the real implementations) so the gate stays testable via dependency injection.
- After checks pass and AI review is enabled:
  - If `config.ai_review.reviewers` has length > 1 **and** a reviewer map is supplied, delegate to `runReviewMatrix`.
  - If the matrix returns `needs_arbitration`, call `runArbitrator` with the diff and the matrix's `issueSets`, then use the arbitrator's `verdict` as the gate's `aiReview`.
  - For matrix results `pass`, `fail`, or `skipped`, use the matrix result directly.
  - Otherwise fall back to the existing single-reviewer retry loop.
- Preserved the existing `ReviewGateOutcome` shape. For arbitration results, `reviewOutput` is set to the arbitrator output (structurally compatible with `ReviewOutput`). For direct matrix results, `reviewOutput` is left undefined and `blockers` are counted from the matrix issues.

## TDD evidence

### RED

Running the focused test file before implementation:

```
bun test test/unit/review-gate.test.ts
...
 5 pass
 2 fail
```

The two new tests failed because:
- The gate ignored the configured multi-reviewer list and invoked `callReviewer` instead of `runReviewMatrix`.
- The gate returned `aiReview: "pass"` instead of arbitrating the mixed matrix verdict.

### GREEN

After implementation:

```
bun test test/unit/review-gate.test.ts
 7 pass
 0 fail
```

Full suite:

```
bun test
 380 pass
 1 skip
 0 fail
 Ran 381 tests across 52 files.
```

## Files changed

- `src/gate/review-gate.ts`
- `test/unit/review-gate.test.ts`

## Self-review findings / concerns

1. **Reviewer map is optional.** If `config.ai_review.reviewers` has length > 1 but no `reviewers` map is passed, the gate falls back to the single-reviewer path. This keeps existing callers in `src/runners/ralph-loop.ts` and `src/commands/run.ts` working unchanged, but those callers will not benefit from multi-reviewer arbitration until they are updated to load and pass the models profile map.
2. **Author profile ambiguity.** `runReviewMatrix` expects an `authorProfile` string to exclude self-review. The integration passes `reviewerProfile.model`, which is the configured single-reviewer model name. In tests this model is not one of the reviewer keys, so all configured reviewers run. Real callers may need to pass the actual author profile when they start supplying the reviewer map.
3. **`reviewOutput` for matrix results.** The brief allowed leaving `reviewOutput` undefined for matrix results. For arbitration the arbitrator output (which includes `summary` and `issues`) is assigned, which is structurally compatible with `ReviewOutput`. No public type changes were needed.
4. **Type-check status.** `tsc --noEmit` has many pre-existing errors in the repo (test globals, unrelated source files). The new code in `src/gate/review-gate.ts` itself has no type errors.
5. **Unused imports removed.** Initially imported `ArbitrationOutputSchema` from `review-schema` but never used it; removed to keep the import list clean.

## Fix report

Addressed the review findings from Task 12.

### Findings fixed

1. **Always delegate to the matrix when `config.ai_review.reviewers` has length > 1.**
   - Moved the reviewer profile map and author profile into `ReviewGateDeps` as optional fields: `reviewers?: Record<string, ModelProfile>` and `authorProfile?: string`.
   - Removed the extra positional `reviewers` parameter from `runReviewGate`, restoring the original positional signature.
   - The gate now delegates to `runReviewMatrix` whenever `config.ai_review.reviewers.length > 1`, regardless of whether the caller passed a map.
2. **Fail loudly when the reviewers map is missing for multi-reviewer configs.**
   - If delegating but `deps.reviewers` is absent, `runReviewGate` throws `Error("Multi-reviewer AI review requires a reviewers map")`.
3. **Use the correct author profile for matrix self-review exclusion.**
   - `runReviewMatrix` is now called with `deps.authorProfile ?? reviewerProfile.model` instead of always `reviewerProfile.model`.
4. **Updated the two new multi-reviewer tests.**
   - Tests now pass `reviewers` (and optionally `authorProfile`) inside the `deps` object instead of as a positional argument.
   - Added a focused test verifying the missing-map error path.
   - Existing single-reviewer tests remain unchanged.
5. **Left blocker counting for arbitration as-is.**
   - `countBlockers(arbitration, ...)` continues to work because `ArbitrationOutput` still provides an `issues` array.

### Commands run

```bash
bun test test/unit/review-gate.test.ts
```

Result:

```
 8 pass
 0 fail
 26 expect() calls
 Ran 8 tests across 1 file.
```

```bash
bun test
```

Result:

```
 381 pass
 1 skip
 0 fail
 954 expect() calls
 Ran 382 tests across 52 files.
```

### Notes

- No changes were needed to `.superpowers/sdd/task-12-brief.md` because it does not document a specific function signature.
- The full suite grew by one test from the previous report (382 vs 381) because of the added missing-map error test; all previously passing tests still pass.

