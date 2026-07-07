import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function setupProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-cli-lock-"));
  mkdirSync(join(dir, ".aiflow", "config", "pipelines"), { recursive: true });
  writeFileSync(
    join(dir, ".aiflow", "config", "models.yaml"),
    `profiles:\n  main-dev:\n    channel: opencode\n    provider: opencode\n    model: deepseek-v4-flash-free\n  reviewer:\n    channel: http\n    provider: y\n    model: z\n`
  );
  writeFileSync(
    join(dir, ".aiflow", "config", "pipelines", "cheap.yaml"),
    `name: cheap\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    per_story_fix_limit: 3\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: []\n`
  );
  writeFileSync(
    join(dir, "prd.json"),
    JSON.stringify({ branchName: "fix/us-1", stories: [{ id: "US-1", title: "t", acceptance: [], priority: 1, passes: false, fixCount: 0 }] })
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), `export const value = 1;\n`);
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} config user.email "test@example.com"`;
  await $`git -C ${dir} config user.name "Test"`;
  await $`git -C ${dir} add -A`;
  await $`git -C ${dir} commit -q -m "initial"`;
  return dir;
}

function createFakeOpencodeBin(dir: string): string {
  const binDir = mkdtempSync(join(tmpdir(), "aiflow-fake-opencode-bin-"));
  const scriptPath = join(binDir, "opencode");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const dirIdx = args.indexOf("--dir");
const cwd = dirIdx >= 0 ? args[dirIdx + 1] : process.cwd();

// Make a trivial code change so the ralph_loop commit succeeds.
const srcDir = path.join(cwd, "src");
fs.mkdirSync(srcDir, { recursive: true });
fs.writeFileSync(path.join(srcDir, "implemented.ts"), "export const done = true;\\n");

// Emit a step_finish event so the adapter records zero-cost usage.
console.log(JSON.stringify({
  type: "step_finish",
  timestamp: Date.now(),
  sessionID: "fake-session",
  part: {
    type: "step-finish",
    reason: "done",
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
    cost: 0,
  },
}));
`,
    { mode: 0o755 }
  );
  return binDir;
}

async function runCli(cwd: string, binDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI_PATH, "run", "--pipeline", "cheap"], {
    cwd,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

test("CLI reclaims a stale lock with a dead PID and a second run is not blocked", async () => {
  const dir = await setupProject();
  const binDir = createFakeOpencodeBin(dir);
  try {
    mkdirSync(join(dir, ".aiflow"), { recursive: true });
    writeFileSync(
      join(dir, ".aiflow", "run.lock"),
      JSON.stringify({ pid: 999999, run_id: "stale-dead", started_at: new Date().toISOString() })
    );

    const first = await runCli(dir, binDir);
    // The first CLI run reclaims the stale lock and then executes the pipeline.
    // With a fake opencode agent, the run should succeed, but the lock release is the key check.
    expect(existsSync(join(dir, ".aiflow", "run.lock"))).toBe(false);

    const second = await runCli(dir, binDir);
    expect(second.code).toBe(0);
    expect(first.stderr).toContain("Reclaimed stale lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
}, 60_000);
