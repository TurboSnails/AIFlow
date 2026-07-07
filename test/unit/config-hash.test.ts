import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashConfigDir } from "../../src/config/config-hash";

function projectWithConfig(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-confighash-"));
  mkdirSync(join(dir, ".aiflow", "config", "pipelines"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, ".aiflow", "config", rel), content);
  }
  return dir;
}

test("hashConfigDir returns the same hash for unchanged content across two calls", () => {
  const dir = projectWithConfig({ "models.yaml": "profiles:\n  a: {}\n" });
  try {
    expect(hashConfigDir(dir)).toBe(hashConfigDir(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hashConfigDir changes when a file's content changes", () => {
  const dir = projectWithConfig({ "models.yaml": "profiles:\n  a: {}\n" });
  try {
    const before = hashConfigDir(dir);
    writeFileSync(join(dir, ".aiflow", "config", "models.yaml"), "profiles:\n  a: { changed: true }\n");
    expect(hashConfigDir(dir)).not.toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hashConfigDir changes when a nested file is added", () => {
  const dir = projectWithConfig({ "models.yaml": "profiles: {}\n" });
  try {
    const before = hashConfigDir(dir);
    writeFileSync(join(dir, ".aiflow", "config", "pipelines", "new.yaml"), "name: new\nstages: []\n");
    expect(hashConfigDir(dir)).not.toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hashConfigDir is stable regardless of filesystem directory-listing order", () => {
  const dirA = projectWithConfig({ "a.yaml": "1", "b.yaml": "2" });
  const dirB = projectWithConfig({ "b.yaml": "2", "a.yaml": "1" });
  try {
    expect(hashConfigDir(dirA)).toBe(hashConfigDir(dirB));
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});
