## Task 10: Dashboard 完成（静态服务、单 DB、gate-answer 续跑）

**Files:**
- Modify: `src/dashboard/server/api.ts`
- Modify: `src/dashboard/server/index.ts`
- Modify: `src/dashboard/server/collector.ts`
- Modify: `src/dashboard/server/db.ts`（可选：确认 `createDb` 可复用）
- Test: `test/unit/dashboard-api.test.ts`

**Interfaces:**
- Consumes: `startDashboardServer`, `createApp`, `createDb`, `runApprove`.
- Produces: Dashboard 生产模式提供 React 构建产物；collector 与 API 共用同一 `Database`；POST `/api/runs/:runId/gate-answer` 写入答案并后台 `runApprove` 续跑。

- [ ] **Step 1: 修改 `startCollector` 接收已存在的 db 实例**

```ts
export function startCollector(
  runsRoot: string,
  db: Database,
  options?: Parameters<typeof chokidar.watch>[1],
  broadcaster?: Broadcaster,
): Collector {
  // replace const db = createDb(dbPath) with the passed-in db
  // keep rest of function unchanged
}
```

更新 `collector.ts` 内所有 `tailRun(db, ...)` 调用不变。

- [ ] **Step 2: 在 `index.ts` 只创建一个 `Database` 并传给 app 和 collector，并允许注入 `runApprove`**

更新 `ApiDeps`：

```ts
export interface ApiDeps {
  db: Database;
  runsRoot: string;
  runApprove?: typeof import("../../commands/approve").runApprove;
}
```

```ts
export async function startDashboardServer(
  runsRoot: string,
  dbPath: string,
  port = 3000,
  host = "127.0.0.1",
): Promise<DashboardServer> {
  const db = createDb(dbPath);
  const app = createApp({ db, runsRoot });
  // ...
}
```

- [ ] **Step 3: 在 `api.ts` 中 gate-answer 端点调用 `runApprove` 续跑**

```ts
import { runApprove } from "../../commands/approve";
import { z } from "zod";

const GateAnswerSchema = z.object({
  stage: z.string(),
  action: z.enum(["approve", "reject"]),
  reason: z.string().optional(),
});

app.post("/api/runs/:runId/gate-answer", async (req, res) => {
  const runDir = safeRunDir(runsRoot, req.params.runId);
  if (!runDir) return res.status(404).json({ error: "run not found" });
  const cwd = dirname(runsRoot);
  const answer = GateAnswerSchema.parse(req.body);
  writeGateAnswer(runDir, answer);
  // resume asynchronously so the HTTP response returns immediately
  (deps.runApprove ?? runApprove)(cwd, { runId: req.params.runId, stage: answer.stage }).catch((err) => {
    console.error("gate-answer resume failed", err);
  });
  res.json({ ok: true });
});
```

- [ ] **Step 4: 让 Dashboard 生产环境提供 React 构建产物**

在 `createApp` 中所有 API 路由注册之后追加：

```ts
import express from "express";
import { dirname, join } from "node:path";

const clientDist = join(dirname(import.meta.dir), "client", "dist");
app.use(express.static(clientDist));
app.get("*", (_req, res) => {
  res.sendFile(join(clientDist, "index.html"));
});
```

注意：开发模式 (`bun run dashboard:dev`) 仍走 Vite 代理，不进入此分支。

- [ ] **Step 5: 写测试**

```ts
test("gate-answer endpoint writes answer and resumes pipeline", async () => {
  const runApproveMock = mock(async () => ({ status: "resumed" }));
  const app = createApp({ db: createDb(":memory:"), runsRoot, runApprove: runApproveMock });
  const res = await request(app).post(`/api/runs/${runId}/gate-answer`).send({ stage: gateStage, action: "approve" });
  expect(res.status).toBe(200);
  expect(runApproveMock).toHaveBeenCalled();
});
```

Run:

```bash
bun test test/unit/dashboard-api.test.ts
```

Expected: all pass.

- [ ] **Step 6: 提交**

```bash
git add src/dashboard/server/api.ts src/dashboard/server/index.ts src/dashboard/server/collector.ts test/unit/dashboard-api.test.ts
git commit -m "feat(dashboard): serve built client, share db, gate-answer resumes pipeline"
```

---

