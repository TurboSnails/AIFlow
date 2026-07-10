import { join } from "node:path";
import { startDashboardServer } from "../dashboard/server/index";

export async function runDashboard(cwd: string, port = 8080): Promise<ReturnType<typeof startDashboardServer>> {
  const runsRoot = join(cwd, ".aiflow", "runs");
  const dbPath = join(cwd, ".aiflow", "dashboard.db");
  return startDashboardServer(runsRoot, dbPath, port);
}
