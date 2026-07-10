### Task 10: ReviewMatrix

**Files:**
- Create: `src/review/matrix.ts`
- Test: `test/unit/review-matrix.test.ts`

**Interfaces:**
- Produces: `function runReviewMatrix(config: ReviewGateConfig["ai_review"], reviewers: Record<string, ModelProfile>, authorProfile: string, cwd: string, diff: string, acceptance: string[], deps: ReviewMatrixDeps): Promise<ReviewMatrixResult>`.

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

