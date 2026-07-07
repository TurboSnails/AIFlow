import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

test("cli --help lists doctor, init, run, resume, status, watch commands", async () => {
  const proc = Bun.spawn(["bun", "run", join(process.cwd(), "src", "cli.ts"), "--help"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  expect(output).toContain("doctor");
  expect(output).toContain("init");
  expect(output).toContain("run");
  expect(output).toContain("resume");
  expect(output).toContain("status");
  expect(output).toContain("watch");
});

test("cli status prints non-zero exit when no runs exist", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-cli-status-"));
  const repoRoot = process.cwd();
  const proc = Bun.spawn(["bun", "run", join(repoRoot, "src", "cli.ts"), "status", "--no-color"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  rmSync(cwd, { recursive: true, force: true });
  expect(exitCode).toBe(1);
  expect(stdout + stderr).toContain("No run found");
});

test("cli status renders run header when a run exists", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiflow-cli-status2-"));
  const runDir = join(cwd, ".aiflow", "runs", "run-cli");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      run_id: "run-cli",
      pipeline: "ralph-only",
      stages: [{ id: "develop", status: "done" }],
      cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
    })
  );
  const proc = Bun.spawn(["bun", "run", join(process.cwd(), "src", "cli.ts"), "status", "--no-color", "--tail", "3"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  rmSync(cwd, { recursive: true, force: true });
  expect({ stdout, stderr, exitCode }).toEqual({ stdout: expect.stringContaining("run_id:    run-cli"), stderr: "", exitCode: 0 });
  expect(stdout).toContain("pipeline:  ralph-only");
  expect(stdout).toContain("develop");
  expect(stdout).toContain("done");
});

test("aiflow run refuses immediately is not required — a stale lock is reclaimed and the run proceeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-cli-lock-test-"));
  try {
    mkdirSync(join(dir, ".aiflow", "config", "pipelines"), { recursive: true });
    writeFileSync(
      join(dir, ".aiflow", "config", "models.yaml"),
      "profiles:\n  main-dev:\n    channel: opencode\n    provider: x\n    model: y\n  reviewer:\n    channel: http\n    provider: y\n    model: z\n"
    );
    writeFileSync(
      join(dir, ".aiflow", "config", "pipelines", "ralph-only.yaml"),
      'name: ralph-only\nstages:\n  - id: develop\n    type: ralph_loop\n    model: main-dev\n    per_story_fix_limit: 3\n    gate:\n      checks: []\n      ai_review:\n        enabled: false\n        model: reviewer\n        fail_on: ["blocker"]\n'
    );
    writeFileSync(join(dir, "prd.json"), JSON.stringify({ branchName: "x", stories: [] }));
    await $`git -C ${dir} init -q`;
    await $`git -C ${dir} config user.email "test@example.com"`;
    await $`git -C ${dir} config user.name "Test"`;
    await $`git -C ${dir} add -A`;
    await $`git -C ${dir} commit -q -m "initial"`;

    // A lock file left behind by pid 1 (guaranteed to exist on any POSIX box,
    // but never equal to this test process's own pid) simulates a crash.
    mkdirSync(join(dir, ".aiflow"), { recursive: true });
    writeFileSync(
      join(dir, ".aiflow", "run.lock"),
      JSON.stringify({ pid: 999999999, run_id: "stale-run", started_at: new Date().toISOString() })
    );

    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "..", "src", "cli.ts"), "run", "--pipeline", "ralph-only"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(stderr).toContain("stale");
    expect(exitCode).toBe(0);
    expect(existsSync(join(dir, ".aiflow", "run.lock"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
