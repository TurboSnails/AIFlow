import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { revParseHead, stageAll, diffCached, commit } from "../../src/git";

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
