import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const FIXTURE_DIR = join(process.cwd(), "fixtures", "sample-project");

test("fixture files exist", () => {
  expect(existsSync(join(FIXTURE_DIR, "package.json"))).toBe(true);
  expect(existsSync(join(FIXTURE_DIR, "src", "math.ts"))).toBe(true);
  expect(existsSync(join(FIXTURE_DIR, "test", "math.test.ts"))).toBe(true);
  expect(existsSync(join(FIXTURE_DIR, "spec.md"))).toBe(true);
  expect(existsSync(join(FIXTURE_DIR, "prd.json"))).toBe(true);
  expect(existsSync(join(FIXTURE_DIR, ".aiflow", "config", "models.yaml"))).toBe(true);
  expect(existsSync(join(FIXTURE_DIR, ".aiflow", "config", "pipelines", "ralph-only.yaml"))).toBe(true);
});

test("fixture is its own independent git repository", async () => {
  const out = await $`git -C ${FIXTURE_DIR} rev-parse --is-inside-work-tree`.text();
  expect(out.trim()).toBe("true");
});

test("fixture's initial code genuinely fails npm test (clamp is not yet implemented)", async () => {
  await $`cd ${FIXTURE_DIR} && npm install --silent`.quiet();
  const proc = Bun.spawn(["npm", "run", "test"], { cwd: FIXTURE_DIR, stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  expect(exitCode).not.toBe(0);
});
