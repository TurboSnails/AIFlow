import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { revParseHead, stageAll, diffCached, commit, isClean, checkoutClean, checkoutConfigOnly } from "../../src/git";

async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-git-test-"));
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} config user.email "test@example.com"`;
  await $`git -C ${dir} config user.name "Test"`;
  writeFileSync(join(dir, "a.txt"), "hello\n");
  await $`git -C ${dir} add -A`;
  await $`git -C ${dir} commit -q -m "initial"`;
  return dir;
}

test("revParseHead returns the current HEAD sha", async () => {
  const dir = await makeTempRepo();
  try {
    const sha = await revParseHead(dir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stageAll + diffCached shows staged changes including new files", async () => {
  const dir = await makeTempRepo();
  try {
    writeFileSync(join(dir, "b.txt"), "new file\n");
    await stageAll(dir);
    const diff = await diffCached(dir);
    expect(diff).toContain("b.txt");
    expect(diff).toContain("new file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit creates a new commit with the given message on top of HEAD", async () => {
  const dir = await makeTempRepo();
  try {
    const before = await revParseHead(dir);
    writeFileSync(join(dir, "c.txt"), "content\n");
    await stageAll(dir);
    await commit(dir, "feat: add c.txt");
    const after = await revParseHead(dir);
    expect(after).not.toBe(before);
    const log = await $`git -C ${dir} log -1 --pretty=%s`.text();
    expect(log.trim()).toBe("feat: add c.txt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isClean returns true for a freshly-committed repo and false after an edit", async () => {
  const dir = await makeTempRepo();
  try {
    expect(await isClean(dir)).toBe(true);
    writeFileSync(join(dir, "a.txt"), "changed\n");
    expect(await isClean(dir)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isClean returns false when there's an untracked file", async () => {
  const dir = await makeTempRepo();
  try {
    writeFileSync(join(dir, "untracked.txt"), "new\n");
    expect(await isClean(dir)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkoutClean discards a modification to a tracked file", async () => {
  const dir = await makeTempRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "changed\n");
    await checkoutClean(dir);
    expect(await isClean(dir)).toBe(true);
    const content = await Bun.file(join(dir, "a.txt")).text();
    expect(content).toBe("hello\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkoutClean discards a modification that has already been staged (git add -A)", async () => {
  const dir = await makeTempRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "changed\n");
    await stageAll(dir);
    await checkoutClean(dir);
    expect(await isClean(dir)).toBe(true);
    const content = await Bun.file(join(dir, "a.txt")).text();
    expect(content).toBe("hello\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkoutClean removes an untracked file", async () => {
  const dir = await makeTempRepo();
  try {
    writeFileSync(join(dir, "untracked.txt"), "new\n");
    await checkoutClean(dir);
    expect(await isClean(dir)).toBe(true);
    expect(await Bun.file(join(dir, "untracked.txt")).exists()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkoutClean preserves untracked files inside .aiflow while still removing untracked files elsewhere", async () => {
  const dir = await makeTempRepo();
  try {
    mkdirSync(join(dir, ".aiflow", "runs", "run-1"), { recursive: true });
    writeFileSync(join(dir, ".aiflow", "runs", "run-1", "events.jsonl"), '{"type":"started"}\n');
    writeFileSync(join(dir, "untracked.txt"), "new\n");

    await checkoutClean(dir);

    expect(await Bun.file(join(dir, ".aiflow", "runs", "run-1", "events.jsonl")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "untracked.txt")).exists()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkoutConfigOnly is a no-op when .aiflow/config is not tracked in git", async () => {
  const dir = await makeTempRepo();
  try {
    mkdirSync(join(dir, ".aiflow", "config"), { recursive: true });
    writeFileSync(join(dir, ".aiflow", "config", "models.yaml"), "original content\n");

    // The file is untracked; modifying it should still be preserved.
    writeFileSync(join(dir, ".aiflow", "config", "models.yaml"), "tampered content\n");

    await expect(checkoutConfigOnly(dir)).resolves.toBeUndefined();

    const content = await Bun.file(join(dir, ".aiflow", "config", "models.yaml")).text();
    expect(content).toBe("tampered content\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkoutConfigOnly restores .aiflow/config to HEAD without touching other tracked files", async () => {
  const dir = await makeTempRepo();
  try {
    mkdirSync(join(dir, ".aiflow", "config"), { recursive: true });
    writeFileSync(join(dir, ".aiflow", "config", "models.yaml"), "profiles: {}\n");
    await $`git -C ${dir} add -A`;
    await $`git -C ${dir} commit -q -m "add config"`;

    writeFileSync(join(dir, ".aiflow", "config", "models.yaml"), "profiles:\n  tampered: true\n");
    writeFileSync(join(dir, "a.txt"), "also changed\n");

    await checkoutConfigOnly(dir);

    const configContent = await Bun.file(join(dir, ".aiflow", "config", "models.yaml")).text();
    expect(configContent).toBe("profiles: {}\n");
    const aContent = await Bun.file(join(dir, "a.txt")).text();
    expect(aContent).toBe("also changed\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
