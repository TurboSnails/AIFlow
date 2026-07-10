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

