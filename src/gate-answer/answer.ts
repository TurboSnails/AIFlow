import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic/atomic-write";

export interface GateAnswer {
  stage: string;
  prompt: string;
  status: "waiting" | "answered";
  answered_at: string | null;
  action: "approve" | "reject" | null;
  reason: string | null;
}

export function readGateAnswer(runDir: string): GateAnswer | undefined {
  const path = join(runDir, "gate-answer.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as GateAnswer;
}

export function writeGateAnswer(runDir: string, answer: GateAnswer): void {
  writeFileAtomic(join(runDir, "gate-answer.json"), JSON.stringify(answer, null, 2));
}
