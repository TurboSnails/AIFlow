import chokidar from "chokidar";
import { createDb, ingestEvents } from "./db";

export function startCollector(runsRoot: string, dbPath: string): void {
  const db = createDb(dbPath);
  chokidar.watch(`${runsRoot}/*/events.jsonl`).on("change", (path) => {
    const runDir = path.replace("/events.jsonl", "");
    ingestEvents(db, runDir);
  });
}
