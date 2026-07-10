import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { createApp } from "./api";
import { createDb } from "./db";
import { startCollector } from "./collector";
import { broadcastEvent } from "./ws";

export interface DashboardServer {
  url: string;
  close: () => Promise<void>;
}

export async function startDashboardServer(
  runsRoot: string,
  dbPath: string,
  port = 3000,
  host = "127.0.0.1",
): Promise<DashboardServer> {
  const db = createDb(dbPath);
  const app = createApp({ db, runsRoot });
  const server = createServer(app);
  const wss = new WebSocketServer({ server });
  const collector = startCollector(runsRoot, dbPath, undefined, {
    broadcast: (event: object) => broadcastEvent(wss, event),
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address() as { port: number };

  return {
    url: `http://${host}:${address.port}`,
    close: async () => {
      await collector.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}
