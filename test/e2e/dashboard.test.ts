import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboardServer } from "../../src/dashboard/server/index";

test("dashboard server returns runs list on /api/runs", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "dashboard-e2e-"));
  const dbPath = join(runsRoot, "dashboard.db");
  const runDir = join(runsRoot, "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "events.jsonl"),
    JSON.stringify({ ts: "2026-07-10T00:00:00Z", type: "stage_start", stage: "plan" }) + "\n"
  );

  const server = await startDashboardServer(runsRoot, dbPath, 0, "127.0.0.1");
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));

    const res = await fetch(`${server.url}/api/runs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].run_id).toBe("r1");
  } finally {
    await server.close();
  }
});
