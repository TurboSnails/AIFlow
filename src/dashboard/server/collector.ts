import chokidar from "chokidar";
import type { WatchOptions } from "chokidar";
import { basename, dirname } from "node:path";
import { createDb, tailRun } from "./db";

export interface Collector {
  close: () => Promise<void>;
}

function isEventsJsonl(path: string): boolean {
  return basename(path) === "events.jsonl";
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
    const runDir = dirname(eventsPath);
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
