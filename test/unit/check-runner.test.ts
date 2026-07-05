import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks } from "../../src/gate/check-runner";

test("runChecks passes when all commands exit 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-checks-test-"));
  try {
    const result = await runChecks(["true", "true"], dir);
    expect(result.pass).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runChecks stops at the first failing command and reports it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-checks-test-"));
  try {
    const result = await runChecks(["echo first-ok", "false", "echo should-not-run"], dir);
    expect(result.pass).toBe(false);
    expect(result.failedCommand).toBe("false");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runChecks truncates very long failure output to the last MAX_CHECK_OUTPUT_CHARS characters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-checks-test-"));
  try {
    const result = await runChecks(["node -e \"process.stdout.write('x'.repeat(10000)); process.exit(1)\""], dir);
    expect(result.pass).toBe(false);
    expect(result.output.length).toBeLessThanOrEqual(4000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
