/**
 * OpenCode HTTP channel adapter.
 *
 * When a model profile uses `channel: "opencode"` via an HTTP endpoint
 * (rather than the subprocess-based runner in `src/adapters/opencode.ts`),
 * this adapter routes the call through `callLlm` so that the same
 * exponential-backoff / budget-exceeded logic applies automatically.
 */
import { callLlm, type LlmCallOptions, type LlmCallResult, type LlmDeps } from "../llm/client";

/**
 * Run an OpenCode model call over HTTP with the same retry / budget-exceeded
 * behaviour as `callLlm`.  Accepts an optional `deps` parameter for testing.
 */
export async function runOpenCode(opts: LlmCallOptions, deps?: LlmDeps): Promise<LlmCallResult> {
  return callLlm(opts, deps);
}
