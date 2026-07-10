import type { ModelProfile } from "../config/schema";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendEvent } from "../events/events";
import type { LlmRetryAiflowEvent } from "../events/new-events";

export interface LlmCallOptions {
  profile: ModelProfile;
  prompt: string;
  jsonMode?: boolean;
  thinking?: boolean;
  fetchFn?: typeof fetch;
  stage?: string;
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

function isRetryableError(err: unknown): boolean {
  if (err instanceof LlmHttpError) return err.status === 429 || err.status >= 500;
  return true;
}

async function withRetry<T>(fn: () => Promise<T>, retries: number, stage: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === retries) throw err;
      const ctx = llmRetryContext.getStore();
      if (ctx) {
        const event: LlmRetryAiflowEvent = {
          ts: new Date().toISOString(),
          type: "llm_retry",
          stage,
          attempt: attempt + 1,
          error: String(err),
        };
        appendEvent(ctx.runDir, event);
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function callLlm(opts: LlmCallOptions): Promise<LlmCallResult> {
  const { profile, prompt, jsonMode = false, thinking = false, fetchFn = fetch, stage = "unknown" } = opts;
  if (!profile.api_key_env) throw new Error("Profile has no api_key_env configured");
  const apiKey = process.env[profile.api_key_env];
  if (!apiKey) throw new Error(`Environment variable ${profile.api_key_env} is not set`);
  if (!profile.base_url) throw new Error("Profile has no base_url configured");

  return withRetry(async () => {
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
    const costUsd =
      (inTok / 1_000_000) * (profile.input_cost_per_1m ?? 0) +
      (outTok / 1_000_000) * (profile.output_cost_per_1m ?? 0);
    return {
      text: data.choices[0].message.content,
      usage: { inTok, outTok, costUsd },
    };
  }, 3, stage);
}

export async function callLlmFanOut(
  profiles: ModelProfile[],
  promptFn: (profile: ModelProfile) => string,
  opts: { jsonMode?: boolean; thinking?: boolean; fetchFn?: typeof fetch; stage?: string } = {}
): Promise<Array<{ profile: ModelProfile; ok: boolean; result?: LlmCallResult; error?: string }>> {
  const settled = await Promise.allSettled(
    profiles.map((profile) => callLlm({ profile, prompt: promptFn(profile), ...opts }))
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
  fetchFn: typeof fetch = fetch
): Promise<ReviewerCallResult> {
  const result = await callLlm({ profile, prompt, jsonMode: true, thinking: false, fetchFn, stage });
  return { data: JSON.parse(result.text), usage: result.usage };
}
