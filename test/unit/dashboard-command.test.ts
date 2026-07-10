import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDashboard } from "../../src/commands/dashboard";

test("dashboard command starts server on requested port", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "dashboard-cmd-"));
  const runsRoot = join(cwd, ".aiflow", "runs");
  const runDir = join(runsRoot, "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "events.jsonl"),
    JSON.stringify({ ts: "2026-07-10T00:00:00Z", type: "stage_start", stage: "plan" }) + "\n"
  );

  const server = await runDashboard(cwd, 0);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const res = await fetch(`${server.url}/api/runs`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.runs).toHaveLength(1);
  expect(body.runs[0].run_id).toBe("r1");

  await server.close();
});
