import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic/atomic-write";
import { SpecBoardSchema } from "./schema";
import type { SpecBoard, OpenQuestion, Decision, ReviewVerdictEntry } from "./types";

const BOARD_FILE = "specboard.json";

function boardPath(runDir: string): string {
  return join(runDir, BOARD_FILE);
}

function defaultBoard(): SpecBoard {
  return { requirement: "", artifacts: {}, open_questions: [], decisions: [], review_matrix: {} };
}

export function readSpecBoard(runDir: string): SpecBoard {
  const path = boardPath(runDir);
  if (!existsSync(path)) return defaultBoard();
  return SpecBoardSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
}

export function writeSpecBoard(runDir: string, board: SpecBoard): void {
  SpecBoardSchema.parse(board);
  writeFileAtomic(boardPath(runDir), JSON.stringify(board, null, 2));
}

export function registerArtifact(runDir: string, name: string, relativePath: string): void {
  const board = readSpecBoard(runDir);
  board.artifacts[name] = relativePath;
  writeSpecBoard(runDir, board);
}

export function addOpenQuestions(runDir: string, questions: OpenQuestion[]): void {
  const board = readSpecBoard(runDir);
  for (const q of questions) {
    if (!board.open_questions.find((o) => o.id === q.id)) {
      board.open_questions.push(q);
    }
  }
  writeSpecBoard(runDir, board);
}

export function addDecisions(runDir: string, decisions: Decision[]): void {
  const board = readSpecBoard(runDir);
  for (const d of decisions) {
    if (!board.decisions.find((existing) => existing.id === d.id)) {
      board.decisions.push(d);
    }
  }
  writeSpecBoard(runDir, board);
}

export function resolveOpenQuestions(runDir: string, ids: string[], resolution: string, by: string): void {
  const board = readSpecBoard(runDir);
  for (const id of ids) {
    const q = board.open_questions.find((o) => o.id === id);
    if (!q) continue;
    q.resolution = resolution;
    q.resolved_by = by;
    board.decisions.push({ id: q.id, topic: q.topic, resolution, by });
  }
  board.open_questions = board.open_questions.filter((o) => !ids.includes(o.id));
  writeSpecBoard(runDir, board);
}

export function recordReviewMatrix(runDir: string, storyId: string, entry: ReviewVerdictEntry): void {
  const board = readSpecBoard(runDir);
  board.review_matrix[storyId] = entry;
  writeSpecBoard(runDir, board);
}
