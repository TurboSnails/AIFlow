import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, LockWaitAbortedError } from "../../src/lock";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "aiflow-lock-test-"));
}

test("acquireRunLock creates the lock file and release() removes it", async () => {
  const dir = tmpProject();
  try {
    const lock = await acquireRunLock(dir, "run-1");
    const lockPath = join(dir, ".aiflow", "run.lock");
    expect(existsSync(lockPath)).toBe(true);
    const info = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(info.run_id).toBe("run-1");
    expect(info.pid).toBe(process.pid);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunLock reclaims a stale lock left by a dead pid without waiting", async () => {
  const dir = tmpProject();
  try {
    const first = await acquireRunLock(dir, "run-old", { isPidAliveFn: () => false });
    // Don't release() — simulate a crash that left the lock file behind.
    void first;
    let reclaimedInfo: { pid: number; run_id: string } | undefined;
    const second = await acquireRunLock(dir, "run-new", {
      isPidAliveFn: () => false,
      onStaleReclaimed: (info) => { reclaimedInfo = info; },
    });
    expect(reclaimedInfo?.run_id).toBe("run-old");
    second.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunLock polls and waits while the pid is alive, then succeeds once released", async () => {
  const dir = tmpProject();
  try {
    const held = await acquireRunLock(dir, "run-holder", { isPidAliveFn: () => true });
    let sleeps = 0;
    const waiter = acquireRunLock(dir, "run-waiter", {
      isPidAliveFn: () => true,
      pollMs: 5,
      sleepFn: async (ms) => {
        sleeps += 1;
        if (sleeps === 2) held.release();
        return new Promise((resolve) => setTimeout(resolve, ms));
      },
    });
    const lock = await waiter;
    expect(sleeps).toBeGreaterThanOrEqual(2);
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunLock throws LockWaitAbortedError when the signal aborts while waiting", async () => {
  const dir = tmpProject();
  try {
    const held = await acquireRunLock(dir, "run-holder", { isPidAliveFn: () => true });
    const controller = new AbortController();
    let firstSleep = true;
    const promise = acquireRunLock(dir, "run-waiter", {
      isPidAliveFn: () => true,
      signal: controller.signal,
      sleepFn: async () => {
        if (firstSleep) {
          firstSleep = false;
          controller.abort();
        }
      },
    });
    await expect(promise).rejects.toThrow(LockWaitAbortedError);
    held.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("onWaiting fires exactly once even across multiple poll iterations", async () => {
  const dir = tmpProject();
  try {
    const held = await acquireRunLock(dir, "run-holder", { isPidAliveFn: () => true });
    let waitingCalls = 0;
    let sleeps = 0;
    const waiter = acquireRunLock(dir, "run-waiter", {
      isPidAliveFn: () => true,
      onWaiting: () => { waitingCalls += 1; },
      sleepFn: async () => {
        sleeps += 1;
        if (sleeps === 3) held.release();
      },
    });
    const lock = await waiter;
    expect(waitingCalls).toBe(1);
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireRunLock handles TOCTOU race: file deleted between check and read", async () => {
  const dir = tmpProject();
  try {
    const held = await acquireRunLock(dir, "run-holder", { isPidAliveFn: () => true });
    let readAttempts = 0;
    let sleeps = 0;
    const waiter = acquireRunLock(dir, "run-waiter", {
      isPidAliveFn: () => true,
      pollMs: 5,
      readLockFn: (path) => {
        readAttempts += 1;
        if (readAttempts === 1) {
          // First read attempt: simulate file deleted between existsSync and readFileSync
          throw new Error("ENOENT: no such file or directory");
        }
        // Subsequent attempts: return valid lock info
        const content = readFileSync(path, "utf-8");
        return JSON.parse(content);
      },
      sleepFn: async (ms) => {
        sleeps += 1;
        if (sleeps === 2) held.release();
        return new Promise((resolve) => setTimeout(resolve, ms));
      },
    });
    const lock = await waiter;
    expect(readAttempts).toBeGreaterThanOrEqual(2); // Should retry after race
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release() does not delete a lock that has been reclaimed by another holder", async () => {
  const dir = tmpProject();
  try {
    const lock = await acquireRunLock(dir, "run-A", { isPidAliveFn: () => true });
    const lockPath = join(dir, ".aiflow", "run.lock");
    // 模拟：原锁被判 stale 并被 B 回收 —— 文件内容现在是 B 的 info（不同 pid/run_id/started_at）。
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid + 1, run_id: "run-B", started_at: new Date(Date.now() + 1000).toISOString() })
    );
    lock.release(); // A 的 release 不应删掉 B 的锁
    expect(existsSync(lockPath)).toBe(true);
    const stillB = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(stillB.run_id).toBe("run-B");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release() silently returns when the lock file is already gone", async () => {
  const dir = tmpProject();
  try {
    const lock = await acquireRunLock(dir, "run-A", { isPidAliveFn: () => true });
    const lockPath = join(dir, ".aiflow", "run.lock");
    unlinkSync(lockPath); // 锁已被外部删除
    expect(() => lock.release()).not.toThrow();
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
