import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LockInfo {
  pid: number;
  run_id: string;
  started_at: string;
}

export interface RunLock {
  release(): void;
}

export class LockWaitAbortedError extends Error {
  constructor() {
    super("Aborted while waiting for run lock");
  }
}

export interface AcquireLockOptions {
  signal?: AbortSignal;
  pollMs?: number;
  onWaiting?: (info: LockInfo) => void;
  onStaleReclaimed?: (info: LockInfo) => void;
  sleepFn?: (ms: number) => Promise<void>;
  isPidAliveFn?: (pid: number) => boolean;
}

function lockPath(cwd: string): string {
  return join(cwd, ".aiflow", "run.lock");
}

function isPidAliveReal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function acquireRunLock(
  cwd: string,
  runId: string,
  opts: AcquireLockOptions = {}
): Promise<RunLock> {
  const {
    signal,
    pollMs = 1000,
    onWaiting,
    onStaleReclaimed,
    sleepFn = defaultSleep,
    isPidAliveFn = isPidAliveReal,
  } = opts;
  const path = lockPath(cwd);
  mkdirSync(join(cwd, ".aiflow"), { recursive: true });

  let announced = false;
  while (true) {
    if (signal?.aborted) throw new LockWaitAbortedError();

    const info: LockInfo = { pid: process.pid, run_id: runId, started_at: new Date().toISOString() };
    try {
      writeFileSync(path, JSON.stringify(info), { flag: "wx" });
      return {
        release: () => {
          try {
            unlinkSync(path);
          } catch {
            // already gone (released twice, or reclaimed by someone else) — fine.
          }
        },
      };
    } catch (err) {
      const code = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
      if (code !== "EEXIST") throw err;
    }

    if (!existsSync(path)) continue; // raced with a concurrent release; retry immediately
    const existing = JSON.parse(readFileSync(path, "utf-8")) as LockInfo;
    if (!isPidAliveFn(existing.pid)) {
      onStaleReclaimed?.(existing);
      try {
        unlinkSync(path);
      } catch {
        // another process reclaimed it first — loop around and try again
      }
      continue;
    }

    if (!announced) {
      onWaiting?.(existing);
      announced = true;
    }
    await sleepFn(pollMs);
  }
}
