import { callLlm } from "../llm/client";
import { ArbitrationOutputSchema, type ReviewOutput } from "../gate/review-schema";
import type { ModelProfile } from "../config/schema";

export interface ArbitratorDeps {
  callLlm: typeof callLlm;
}

export async function runArbitrator(
  profile: ModelProfile,
  diff: string,
  issueSets: ReviewOutput[],
  deps: ArbitratorDeps = { callLlm }
) {
  const prompt = [
    "You are arbitrating a code review disagreement.",
    "Review the diff and the issues raised by each reviewer.",
    "Return ONLY JSON matching {summary, verdict: 'pass'|'fail', reason, issues: []}.",
    "",
    "Diff:",
    diff,
    "",
    "Reviewer issues:",
    JSON.stringify(issueSets),
  ].join("\n");
  const result = await deps.callLlm({ profile, prompt, jsonMode: true });
  const parsed = ArbitrationOutputSchema.parse(JSON.parse(result.text));
  return parsed;
}
