import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGateAnswer, writeGateAnswer } from "../../src/gate-answer/answer";

test("write and read gate answer", () => {
  const runDir = mkdtempSync(join(tmpdir(), "ga-"));
  try {
    writeGateAnswer(runDir, {
      stage: "confirm",
      prompt: "ok?",
      status: "answered",
      answered_at: "2026-07-10T12:00:00Z",
      action: "approve",
      reason: null,
    });
    const ans = readGateAnswer(runDir);
    expect(ans?.action).toBe("approve");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("readGateAnswer returns undefined when file is missing", () => {
  const runDir = mkdtempSync(join(tmpdir(), "ga-missing-"));
  try {
    const ans = readGateAnswer(runDir);
    expect(ans).toBeUndefined();
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("writeGateAnswer leaves no temporary file behind", () => {
  const runDir = mkdtempSync(join(tmpdir(), "ga-atomic-"));
  try {
    writeGateAnswer(runDir, {
      stage: "confirm",
      prompt: "ok?",
      status: "waiting",
      answered_at: null,
      action: null,
      reason: null,
    });
    expect(existsSync(join(runDir, "gate-answer.json"))).toBe(true);
    expect(existsSync(join(runDir, "gate-answer.json.tmp"))).toBe(false);
    const raw = readFileSync(join(runDir, "gate-answer.json"), "utf-8");
    expect(JSON.parse(raw).status).toBe("waiting");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("readGateAnswer throws on malformed gate-answer.json", () => {
  const runDir = mkdtempSync(join(tmpdir(), "ga-malformed-"));
  try {
    writeFileSync(join(runDir, "gate-answer.json"), JSON.stringify({ status: "answered" }));
    expect(() => readGateAnswer(runDir)).toThrow();
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
