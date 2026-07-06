import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { callLlm } from "../llm/client";
import { PrdSchema } from "../prd";
import { appendEvent } from "../events/events";
import type { PlanStageConfig, ModelProfile } from "../config/schema";
import type { StageOutcome } from "../engine/engine";
import type { StageState } from "../engine/state";

export interface PlanDeps {
  callLlm: typeof callLlm;
}

const defaultDeps: PlanDeps = { callLlm };

function renderPlanPrompt(specText: string, priorError?: string): string {
  const lines = [
    "Convert the following spec into a JSON object matching exactly this shape:",
    '{"branchName": string, "stories": [{"id": string, "title": string, "acceptance": string[], "priority": number, "passes": false, "fixCount": 0}]}',
    "Respond with ONLY the JSON object.",
    "",
    "## Spec",
    specText,
  ];
  if (priorError) lines.push("", `Your previous response failed validation: ${priorError}`);
  return lines.join("\n");
}

export async function runPlanStage(
  stageConfig: PlanStageConfig,
  _stageState: StageState,
  profiles: Record<string, ModelProfile>,
  cwd: string,
  runDir: string,
  _nowFn: () => Date,
  _signal: AbortSignal | undefined,
  deps: PlanDeps = defaultDeps
): Promise<StageOutcome> {
  const specPath = join(cwd, stageConfig.input);
  const specText = existsSync(specPath) ? readFileSync(specPath, "utf-8") : "";
  const profile = profiles[stageConfig.model];

  const usage = { inTok: 0, outTok: 0, costUsd: 0 };
  let lastError: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await deps.callLlm({ profile, prompt: renderPlanPrompt(specText, lastError), jsonMode: true });
    usage.inTok += result.usage.inTok;
    usage.outTok += result.usage.outTok;
    usage.costUsd += result.usage.costUsd;

    try {
      const parsed = JSON.parse(result.text);
      const validated = PrdSchema.safeParse(parsed);
      if (validated.success) {
        writeFileSync(join(cwd, stageConfig.output), JSON.stringify(validated.data, null, 2));
        appendEvent(runDir, { ts: new Date().toISOString(), type: "plan_result", stage: stageConfig.id, result: "pass" });
        return { result: "pass", usage };
      }
      lastError = validated.error.message;
    } catch (err) {
      lastError = String(err);
    }
  }

  appendEvent(runDir, { ts: new Date().toISOString(), type: "plan_result", stage: stageConfig.id, result: "fail" });
  return { result: "fail", usage };
}
