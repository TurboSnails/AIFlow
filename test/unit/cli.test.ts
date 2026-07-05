import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("cli --help lists doctor, init, run, status, watch commands", async () => {
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
