import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSpecBoard,
  writeSpecBoard,
  registerArtifact,
  addOpenQuestions,
  resolveOpenQuestions,
  recordReviewMatrix,
  setSpecHash,
  setConfigHash,
} from "../../src/specboard/specboard";
import type { SpecBoard, ReviewVerdictEntry } from "../../src/specboard/types";

function makeRunDir(): string {
  return mkdtempSync(join(tmpdir(), "sb-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test("register artifact and read back", () => {
  const runDir = makeRunDir();
  try {
    registerArtifact(runDir, "spec", "spec.md");
    const board = readSpecBoard(runDir);
    expect(board.artifacts.spec).toBe("spec.md");
  } finally {
    cleanup(runDir);
  }
});

test("resolve open question", () => {
  const runDir = makeRunDir();
  try {
    addOpenQuestions(runDir, [{ id: "D1", topic: "a", positions: {} }]);
    resolveOpenQuestions(runDir, ["D1"], "chosen A", "human");
    const board = readSpecBoard(runDir);
    expect(board.open_questions).toHaveLength(0);
    expect(board.decisions[0].resolution).toBe("chosen A");
  } finally {
    cleanup(runDir);
  }
});

test("readSpecBoard returns default board when file does not exist", () => {
  const runDir = makeRunDir();
  try {
    const board = readSpecBoard(runDir);
    expect(board).toEqual({
      requirement: "",
      artifacts: {},
      open_questions: [],
      decisions: [],
      review_matrix: {},
    });
  } finally {
    cleanup(runDir);
  }
});

test("writeSpecBoard then readSpecBoard round-trips the exact board", () => {
  const runDir = makeRunDir();
  try {
    const board: SpecBoard = {
      requirement: "add offline cache",
      artifacts: { spec: "spec.md", plan: "plan.md" },
      spec_hash: "abc123",
      config_hash: "def456",
      open_questions: [{ id: "Q1", topic: "cache strategy", positions: { A: "local", B: "remote" } }],
      decisions: [{ id: "D1", topic: "cache strategy", resolution: "local", by: "ralph" }],
      review_matrix: {
        story_1: {
          verdicts: { reviewer_a: "pass", reviewer_b: "fail" },
          arbitrated: true,
          arbitrator: "human",
          final: "pass",
        },
      },
    };
    writeSpecBoard(runDir, board);
    const loaded = readSpecBoard(runDir);
    expect(loaded).toEqual(board);
  } finally {
    cleanup(runDir);
  }
});

test("registerArtifact appends to existing artifacts", () => {
  const runDir = makeRunDir();
  try {
    registerArtifact(runDir, "spec", "spec.md");
    registerArtifact(runDir, "plan", "plan.md");
    const board = readSpecBoard(runDir);
    expect(board.artifacts).toEqual({ spec: "spec.md", plan: "plan.md" });
  } finally {
    cleanup(runDir);
  }
});

test("addOpenQuestions deduplicates by id", () => {
  const runDir = makeRunDir();
  try {
    addOpenQuestions(runDir, [{ id: "Q1", topic: "a", positions: {} }]);
    addOpenQuestions(runDir, [
      { id: "Q1", topic: "a", positions: {} },
      { id: "Q2", topic: "b", positions: {} },
    ]);
    const board = readSpecBoard(runDir);
    expect(board.open_questions).toHaveLength(2);
    expect(board.open_questions.map((q) => q.id)).toEqual(["Q1", "Q2"]);
  } finally {
    cleanup(runDir);
  }
});

test("resolveOpenQuestions moves resolved questions to decisions", () => {
  const runDir = makeRunDir();
  try {
    addOpenQuestions(runDir, [
      { id: "Q1", topic: "a", positions: {} },
      { id: "Q2", topic: "b", positions: {} },
    ]);
    resolveOpenQuestions(runDir, ["Q1"], "resolution A", "human");
    const board = readSpecBoard(runDir);
    expect(board.open_questions).toHaveLength(1);
    expect(board.open_questions[0].id).toBe("Q2");
    expect(board.decisions).toHaveLength(1);
    expect(board.decisions[0]).toEqual({ id: "Q1", topic: "a", resolution: "resolution A", by: "human" });
  } finally {
    cleanup(runDir);
  }
});

test("resolveOpenQuestions ignores unknown ids", () => {
  const runDir = makeRunDir();
  try {
    addOpenQuestions(runDir, [{ id: "Q1", topic: "a", positions: {} }]);
    resolveOpenQuestions(runDir, ["Q1", "unknown"], "resolution A", "human");
    const board = readSpecBoard(runDir);
    expect(board.open_questions).toHaveLength(0);
    expect(board.decisions).toHaveLength(1);
  } finally {
    cleanup(runDir);
  }
});

test("recordReviewMatrix stores entry by story id", () => {
  const runDir = makeRunDir();
  try {
    const entry: ReviewVerdictEntry = {
      verdicts: { reviewer_a: "pass", reviewer_b: "skipped" },
      arbitrated: false,
      final: "pass",
    };
    recordReviewMatrix(runDir, "story_1", entry);
    const board = readSpecBoard(runDir);
    expect(board.review_matrix.story_1).toEqual(entry);
  } finally {
    cleanup(runDir);
  }
});

test("all writes use atomic writer and leave no temp file behind", () => {
  const runDir = makeRunDir();
  try {
    registerArtifact(runDir, "spec", "spec.md");
    addOpenQuestions(runDir, [{ id: "Q1", topic: "a", positions: {} }]);
    resolveOpenQuestions(runDir, ["Q1"], "r", "human");
    recordReviewMatrix(runDir, "story_1", { verdicts: {}, arbitrated: false, final: "pass" });
    expect(existsSync(join(runDir, "specboard.json"))).toBe(true);
    expect(existsSync(join(runDir, "specboard.json.tmp"))).toBe(false);
    expect(readdirSync(runDir)).toEqual(["specboard.json"]);
  } finally {
    cleanup(runDir);
  }
});

test("setSpecHash persists hash to board", () => {
  const runDir = makeRunDir();
  try {
    setSpecHash(runDir, "abc123");
    const board = readSpecBoard(runDir);
    expect(board.spec_hash).toBe("abc123");
  } finally {
    cleanup(runDir);
  }
});

test("setConfigHash persists hash to board", () => {
  const runDir = makeRunDir();
  try {
    setConfigHash(runDir, "def456");
    const board = readSpecBoard(runDir);
    expect(board.config_hash).toBe("def456");
  } finally {
    cleanup(runDir);
  }
});
