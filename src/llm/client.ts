import type { ModelProfile } from "../config/schema";
import { sanitizeSecrets } from "../commands/report";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendEvent } from "../events/events";
import type { LlmRetryAiflowEvent } from "../events/new-events";
import { assertPerCallBudget, BudgetExceededError } from "../gate/budget";

export interface LlmCallOptions {
  profile: ModelProfile;
  prompt: string;
  jsonMode?: boolean;
  thinking?: boolean;
  fetchFn?: typeof fetch;
  stage?: string;
  maxRetrySteps?: number;
  maxTokenCost?: number;
}

export interface LlmCallResult {
  text: string;
  usage: { inTok: number; outTok: number; costUsd: number };
}

export class LlmHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface LlmRetryContext {
  runDir: string;
}

export const llmRetryContext = new AsyncLocalStorage<LlmRetryContext>();

/** Dependency-injection interface for testing retry and sleep behaviour. */
export interface LlmDeps {
  doCall: (opts: LlmCallOptions) => Promise<LlmCallResult>;
  sleepFn: (ms: number) => Promise<void>;
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof LlmHttpError) return err.status === 429 || err.status >= 500;
  if (err instanceof Error && "status" in err) {
    const status = (err as { status: number }).status;
    return status === 429 || status >= 500;
  }
  if (err instanceof Error) return /ETIMEDOUT|ECONNRESET/.test(err.message);
  return false;
}

/**
 * The raw HTTP call with no retry logic.  This is the default `doCall`
 * implementation; tests may substitute it via the `deps` parameter.
 */
async function rawCallLlm(opts: LlmCallOptions): Promise<LlmCallResult> {
  const {
    profile,
    prompt,
    jsonMode = false,
    thinking = false,
    fetchFn = fetch,
  } = opts;
  if (!profile.api_key_env) throw new Error("Profile has no api_key_env configured");
  const apiKey = process.env[profile.api_key_env];
  if (!apiKey) throw new Error(`Environment variable ${profile.api_key_env} is not set`);
  if (!profile.base_url) throw new Error("Profile has no base_url configured");

  const response = await fetchFn(`${profile.base_url}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: profile.model,
      messages: [{ role: "user", content: prompt }],
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      thinking: { type: thinking ? "enabled" : "disabled" },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new LlmHttpError(response.status, `LLM HTTP call failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const inTok = data.usage?.prompt_tokens ?? 0;
  const outTok = data.usage?.completion_tokens ?? 0;
  const inPerM = profile.price?.in_per_m ?? profile.input_cost_per_1m ?? 0;
  const outPerM = profile.price?.out_per_m ?? profile.output_cost_per_1m ?? 0;
  const costUsd = (inTok / 1_000_000) * inPerM + (outTok / 1_000_000) * outPerM;
  return {
    text: data.choices[0].message.content,
    usage: { inTok, outTok, costUsd },
  };
}

const defaultDeps: LlmDeps = {
  doCall: rawCallLlm,
  sleepFn: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export async function callLlm(opts: LlmCallOptions, deps: LlmDeps = defaultDeps): Promise<LlmCallResult> {
  const { maxRetrySteps, stage = "unknown" } = opts;
  const retries = maxRetrySteps ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await deps.doCall(opts);
      assertPerCallBudget(result.usage, opts.maxTokenCost);
      return result;
    } catch (err) {
      lastErr = err;
      if (err instanceof BudgetExceededError) throw err;
      if (!isRetryableError(err) || attempt === retries) throw err;
      const ctx = llmRetryContext.getStore();
      if (ctx) {
        const event: LlmRetryAiflowEvent = {
          ts: new Date().toISOString(),
          type: "llm_retry",
          stage,
          attempt: attempt + 1,
          error: sanitizeSecrets(String(err)),
        };
        appendEvent(ctx.runDir, event);
      }
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      await deps.sleepFn(delay);
    }
  }
  throw lastErr;
}

export async function callLlmFanOut(
  profiles: ModelProfile[],
  promptFn: (profile: ModelProfile) => string,
  opts: {
    jsonMode?: boolean;
    thinking?: boolean;
    fetchFn?: typeof fetch;
    stage?: string;
    maxRetrySteps?: number;
    maxTokenCost?: number;
  } = {}
): Promise<Array<{ profile: ModelProfile; ok: boolean; result?: LlmCallResult; error?: string }>> {
  const settled = await Promise.allSettled(
    profiles.map((profile) =>
      callLlm({ profile, prompt: promptFn(profile), ...opts })
    )
  );
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? { profile: profiles[i], ok: true, result: r.value }
      : { profile: profiles[i], ok: false, error: String(r.reason) }
  );
}

export interface ReviewerCallResult {
  data: unknown;
  usage: LlmCallResult["usage"];
}

export async function callReviewer(
  profile: ModelProfile,
  prompt: string,
  stage = "unknown",
  fetchFn: typeof fetch = fetch,
  maxRetrySteps?: number,
  maxTokenCost?: number
): Promise<ReviewerCallResult> {
  const result = await callLlm({
    profile,
    prompt,
    jsonMode: true,
    thinking: false,
    fetchFn,
    stage,
    maxRetrySteps,
    maxTokenCost,
  });
  return { data: JSON.parse(result.text), usage: result.usage };
}
