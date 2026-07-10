import chokidar from "chokidar";
import type { WatchOptions } from "chokidar";
import { createDb, tailRun } from "./db";

export interface Collector {
  close: () => Promise<void>;
}

function isEventsJsonl(path: string): boolean {
  return path.endsWith("/events.jsonl");
}

function runDirFromEventsPath(path: string): string {
  return path.slice(0, -"/events.jsonl".length);
}

export function startCollector(runsRoot: string, dbPath: string, options?: WatchOptions): Collector {
  const db = createDb(dbPath);
  const watcher = chokidar.watch(runsRoot, {
    ignored: dbPath,
    ignoreInitial: false,
    depth: 2,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
    ...options,
  });

  const ingest = (eventsPath: string) => {
    if (!isEventsJsonl(eventsPath)) return;
    const runDir = runDirFromEventsPath(eventsPath);
    tailRun(db, runDir);
  };

  watcher.on("add", ingest).on("change", ingest);

  return {
    close: async () => {
      await watcher.close();
      db.close();
    },
  };
}
