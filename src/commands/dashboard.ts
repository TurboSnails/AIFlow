import { join } from "node:path";
import { existsSync } from "node:fs";
import { startDashboardServer } from "../dashboard/server/index";
import { loadProjectConfig } from "../config/loader";

function defaultProjectConfig() {
  return { dashboard: { port: 8080, host: "127.0.0.1" } };
}

function loadDashboardProjectConfig(cwd: string) {
  const path = join(cwd, ".aiflow", "config", "project.yaml");
  if (existsSync(path)) {
    return loadProjectConfig(path);
  }
  return defaultProjectConfig();
}

export async function runDashboard(cwd: string, port?: number): Promise<ReturnType<typeof startDashboardServer>> {
  const projectConfig = loadDashboardProjectConfig(cwd);
  const runsRoot = join(cwd, ".aiflow", "runs");
  const dbPath = join(cwd, ".aiflow", "dashboard.db");
  const effectivePort = port ?? projectConfig.dashboard?.port ?? 8080;
  const host = projectConfig.dashboard?.host ?? "127.0.0.1";
  return startDashboardServer(runsRoot, dbPath, effectivePort, host);
}
