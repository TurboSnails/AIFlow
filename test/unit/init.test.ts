import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/commands/init";
import { loadModelsConfig } from "../../src/config/loader";

test("runInit creates the .aiflow/config scaffold with default files", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-init-test-"));
  try {
    const result = runInit(dir);
    expect(result.created).toBe(true);
    expect(existsSync(join(dir, ".aiflow", "config", "models.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".aiflow", "config", "pipelines", "ralph-only.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".aiflow", "config", "pipelines", "superpowers.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".aiflow", "config", "pipelines", "spec-superflow.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".aiflow", "config", "pipelines", "openspec.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".aiflow", "config", "project.yaml"))).toBe(true);
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".aiflow/runs/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runInit appends to an existing .gitignore instead of overwriting it", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-init-test-"));
  try {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    runInit(dir);
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain(".aiflow/runs/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runInit refuses to overwrite an existing .aiflow/config directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-init-test-"));
  try {
    mkdirSync(join(dir, ".aiflow", "config"), { recursive: true });
    writeFileSync(join(dir, ".aiflow", "config", "models.yaml"), "profiles: { custom: true }\n");

    const result = runInit(dir);

    expect(result.created).toBe(false);
    expect(result.reason).toContain("already exists");
    const content = readFileSync(join(dir, ".aiflow", "config", "models.yaml"), "utf-8");
    expect(content).toBe("profiles: { custom: true }\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runInit is idempotent: calling it twice does not duplicate .gitignore entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-init-test-"));
  try {
    // First call to runInit
    const result1 = runInit(dir);
    expect(result1.created).toBe(true);

    // Second call to runInit on the same directory
    const result2 = runInit(dir);
    expect(result2.created).toBe(false);
    expect(result2.reason).toContain("already exists");

    // Verify .gitignore contains .aiflow/runs/ exactly once
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
    const matches = gitignore.match(/\.aiflow\/runs\//g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runInit's models.yaml scaffold has at least 2 http-channel profiles for brainstorm's models list", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-init-test-"));
  try {
    runInit(dir);
    const config = loadModelsConfig(join(dir, ".aiflow", "config", "models.yaml"));
    const httpProfiles = Object.values(config.profiles).filter((p) => p.channel === "http");
    expect(httpProfiles.length).toBeGreaterThanOrEqual(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
