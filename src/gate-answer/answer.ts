import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic/atomic-write";

export const GateAnswerSchema = z.object({
  stage: z.string(),
  prompt: z.string(),
  status: z.enum(["waiting", "answered"]),
  answered_at: z.string().nullable(),
  action: z.enum(["approve", "reject"]).nullable(),
  reason: z.string().nullable(),
});

export type GateAnswer = z.infer<typeof GateAnswerSchema>;

export function readGateAnswer(runDir: string): GateAnswer | undefined {
  const path = join(runDir, "gate-answer.json");
  if (!existsSync(path)) return undefined;
  return GateAnswerSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
}

export function writeGateAnswer(runDir: string, answer: GateAnswer): void {
  writeFileAtomic(join(runDir, "gate-answer.json"), JSON.stringify(answer, null, 2));
}
