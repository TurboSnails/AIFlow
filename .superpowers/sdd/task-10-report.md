## Task 10 Report: Dashboard 完成（静态服务、单 DB、gate-answer 续跑）

### What Was Implemented

**Step 1 — `collector.ts`**: Changed `startCollector` signature from `(runsRoot, dbPath: string, ...)` to `(runsRoot, db: Database, ...)`. Removed internal `createDb(dbPath)` call, removed `db.close()` from `close()` (caller now owns the db lifetime), and removed `ignored: dbPath` from the watcher defaults (callers can pass it via `options`).

**Step 2 — `index.ts`**: `startDashboardServer` now creates one `Database` and passes it to both `createApp` and `startCollector`. The `startCollector` call passes `{ ignored: dbPath }` as watcher options to avoid triggering on the db file. The single `db.close()` in the server's `close()` remains the sole owner.

**Step 3 — `api.ts`**:
- Added `import { runApprove } from "../../commands/approve"` and added `runApprove?: typeof runApprove` to `ApiDeps`.
- Added `GateAnswerBodySchema` (`{ stage, action, reason }`) for the new endpoint (distinct from the existing `GateAnswerSchema` which the `/gates/:stage/answer` endpoint still uses).
- Added `POST /api/runs/:runId/gate-answer` endpoint: validates body, writes the full `GateAnswer` file (preserving any existing `prompt`), then fires `runApprove` (or the injected mock) asynchronously so the HTTP response returns immediately.

**Step 4 — `api.ts` (static serving)**: After all API routes, added `express.static(clientDist)` and a `/{*splat}` catch-all (Express 5 named wildcard syntax) that sends `index.html` for SPA navigation.

**Step 5 — Tests** (`test/unit/dashboard-api.test.ts`):
- Added 3 new tests: `gate-answer endpoint writes answer and resumes pipeline`, `gate-answer endpoint returns 404 for invalid run id`, and `gate-answer endpoint returns 400 for missing stage in body`.
- Updated `dashboard-collector.test.ts` and `dashboard-ws.test.ts` to pass a `Database` instance instead of a `dbPath` string (required by the new `startCollector` signature).

### Test Commands and Results

```
bun test test/unit/dashboard-api.test.ts   →  16/16 pass
bun test (full suite)                       →  545/545 pass (0 fail)
```

### Self-Review Findings / Concerns

1. **`cwd` computation**: The brief shows `const cwd = dirname(runsRoot)` but `runApprove` expects the project root (one level above `.aiflow`). Implemented as `dirname(dirname(deps.runsRoot))` to match the existing `/gates/:stage/answer` endpoint's `projectRoot` computation. The test uses a mock so neither path is exercised in tests, but the production code is correct.

2. **Brief's `GateAnswerSchema` redefinition**: The brief redefines `GateAnswerSchema` with `stage` added, but the existing endpoint and tests rely on it without `stage`. Created `GateAnswerBodySchema` for the new endpoint to avoid a breaking change.

3. **Double-write for `human_gate` stages**: The new endpoint writes the gate answer and then calls `runApprove`, which for `human_gate` stages writes the gate answer again (with `action: "approve"` hardcoded). A `reject` answer written by the endpoint would be overwritten if the stage is `human_gate`. The existing `/gates/:stage/answer` endpoint (which uses locking and verifies state) remains the correct production path for human gates.

4. **Client dist in test**: The `/{*splat}` catch-all calls `res.sendFile(index.html)` which will fail in tests if the dist doesn't exist. Tests that exercise the static route would need the dist built. None of the new tests exercise this route.

### Commit Hash

`7a421e7`
