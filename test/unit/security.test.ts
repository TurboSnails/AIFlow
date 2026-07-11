import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSpecFile, hashConfigDir } from "../../src/config/config-hash";
import { writeSpecBoard } from "../../src/specboard/specboard";
import { assertTamperGuard } from "../../src/runners/ralph-loop";
import { sanitizeSecrets } from "../../src/commands/report";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "aiflow-security-"));
}

function makeRunDir(cwd: string, runId = "run-001"): string {
  const runDir = join(cwd, ".aiflow", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

function makeConfigDir(cwd: string, content = "profiles:\n  a: {}\n"): void {
  mkdirSync(join(cwd, ".aiflow", "config"), { recursive: true });
  writeFileSync(join(cwd, ".aiflow", "config", "models.yaml"), content);
}

describe("assertTamperGuard", () => {
  test("passes when no hashes are stored on the board", () => {
    const cwd = makeTempDir();
    try {
      makeConfigDir(cwd);
      const runDir = makeRunDir(cwd);
      writeSpecBoard(runDir, {
        requirement: "",
        artifacts: {},
        open_questions: [],
        decisions: [],
        review_matrix: {},
      });
      // No spec_hash / config_hash on board — should not throw
      expect(() => assertTamperGuard(cwd, runDir)).not.toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("detects spec tampering between stages", () => {
    const cwd = makeTempDir();
    try {
      makeConfigDir(cwd);
      const runDir = makeRunDir(cwd);

      // Write an original spec.md and capture its hash
      const specPath = join(cwd, "spec.md");
      writeFileSync(specPath, "# original spec\n");
      const originalHash = hashSpecFile(specPath)!;

      // Store the original hash on the board
      writeSpecBoard(runDir, {
        requirement: "",
        artifacts: {},
        spec_hash: originalHash,
        open_questions: [],
        decisions: [],
        review_matrix: {},
      });

      // Tamper with spec.md
      writeFileSync(specPath, "# tampered spec\n");

      expect(() => assertTamperGuard(cwd, runDir)).toThrow(/Spec hash mismatch/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("passes when spec.md matches stored hash", () => {
    const cwd = makeTempDir();
    try {
      makeConfigDir(cwd);
      const runDir = makeRunDir(cwd);

      const specPath = join(cwd, "spec.md");
      writeFileSync(specPath, "# original spec\n");
      const originalHash = hashSpecFile(specPath)!;

      writeSpecBoard(runDir, {
        requirement: "",
        artifacts: {},
        spec_hash: originalHash,
        open_questions: [],
        decisions: [],
        review_matrix: {},
      });

      // spec.md not modified — should not throw
      expect(() => assertTamperGuard(cwd, runDir)).not.toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("detects config tampering between stages", () => {
    const cwd = makeTempDir();
    try {
      makeConfigDir(cwd);
      const runDir = makeRunDir(cwd);

      const originalConfigHash = hashConfigDir(cwd);

      writeSpecBoard(runDir, {
        requirement: "",
        artifacts: {},
        config_hash: originalConfigHash,
        open_questions: [],
        decisions: [],
        review_matrix: {},
      });

      // Tamper with the config dir
      writeFileSync(join(cwd, ".aiflow", "config", "models.yaml"), "profiles:\n  tampered: {}\n");

      expect(() => assertTamperGuard(cwd, runDir)).toThrow(/Config hash mismatch/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("passes when config matches stored hash", () => {
    const cwd = makeTempDir();
    try {
      makeConfigDir(cwd);
      const runDir = makeRunDir(cwd);

      const originalConfigHash = hashConfigDir(cwd);

      writeSpecBoard(runDir, {
        requirement: "",
        artifacts: {},
        config_hash: originalConfigHash,
        open_questions: [],
        decisions: [],
        review_matrix: {},
      });

      // Config not modified — should not throw
      expect(() => assertTamperGuard(cwd, runDir)).not.toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("sanitizeSecrets", () => {
  test("sanitizes sk- API keys", () => {
    const dirty = "key: sk-abc12345678901234567890";
    expect(sanitizeSecrets(dirty)).toContain("***");
    expect(sanitizeSecrets(dirty)).not.toMatch(/sk-abc/);
  });

  test("sanitizes short sk- keys that are below threshold (no match)", () => {
    // sk- followed by fewer than 20 alphanumerics — should NOT be replaced
    const short = "sk-tooshort";
    expect(sanitizeSecrets(short)).toBe(short);
  });

  test("sanitizes ANTHROPIC_API_KEY=value", () => {
    const dirty = "ANTHROPIC_API_KEY=sk-some-secret-value";
    const result = sanitizeSecrets(dirty);
    expect(result).toContain("ANTHROPIC_API_KEY=***");
    expect(result).not.toContain("sk-some-secret-value");
  });

  test("sanitizes OPENAI_API_KEY=value", () => {
    const dirty = "export OPENAI_API_KEY=mytoken123";
    const result = sanitizeSecrets(dirty);
    expect(result).toContain("OPENAI_API_KEY=***");
    expect(result).not.toContain("mytoken123");
  });

  test("sanitizes OPEN_CODE_API_KEY=value", () => {
    const dirty = "OPEN_CODE_API_KEY=secret-token";
    const result = sanitizeSecrets(dirty);
    expect(result).toContain("OPEN_CODE_API_KEY=***");
    expect(result).not.toContain("secret-token");
  });

  test('sanitizes "api_key": "value" JSON pattern', () => {
    const dirty = '{"api_key": "supersecret123"}';
    const result = sanitizeSecrets(dirty);
    expect(result).toContain('"api_key":"***"');
    expect(result).not.toContain("supersecret123");
  });

  test("leaves clean text untouched", () => {
    const clean = "# Run report\n- input tokens: 100\n- output tokens: 200\n";
    expect(sanitizeSecrets(clean)).toBe(clean);
  });
});
