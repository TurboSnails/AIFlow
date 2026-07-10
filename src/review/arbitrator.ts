import { callLlm } from "../llm/client";
import { ArbitrationOutputSchema, type ReviewOutput, type ArbitrationOutput } from "../gate/review-schema";
import type { ModelProfile } from "../config/schema";

export type ArbitratorResult = ArbitrationOutput;

export interface ArbitratorDeps {
  callLlm: typeof callLlm;
  stage?: string;
  maxRetrySteps?: number;
  maxTokenCost?: number;
}

export async function runArbitrator(
  profile: ModelProfile,
  diff: string,
  issueSets: ReviewOutput[],
  acceptance: string[],
  deps: ArbitratorDeps = { callLlm }
): Promise<ArbitratorResult> {
  const prompt = `Arbitrate the following review issues.
Diff:
${diff}

Acceptance criteria:
${acceptance.join("\n")}

Reviewer issues:
${JSON.stringify(issueSets)}

Return JSON with summary, verdict (pass|fail), and issues[].`;
  const stage = deps.stage ?? "unknown";
  const result = await deps.callLlm({
    profile,
    prompt,
    jsonMode: true,
    stage,
    maxRetrySteps: deps.maxRetrySteps,
    maxTokenCost: deps.maxTokenCost,
  });
  const parsed = ArbitrationOutputSchema.parse(JSON.parse(result.text));
  return parsed;
}
