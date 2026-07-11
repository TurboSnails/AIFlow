import { test, expect, mock } from "bun:test";
import { callReviewer, callLlm, callLlmFanOut } from "../../src/llm/client";
import type { ModelProfile } from "../../src/config/schema";

const profile: ModelProfile = {
  channel: "http",
  provider: "minimax",
  model: "some-model",
  base_url: "https://example.invalid/v1",
  api_key_env: "TEST_REVIEWER_KEY",
};

test("callReviewer sends an OpenAI-compatible chat completion request and returns parsed JSON content", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe("https://example.invalid/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("some-model");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer fake-key-value");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ summary: "ok", issues: [] }) } }],
      }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;

  const result = await callReviewer(profile, "review this diff", "unknown", fakeFetch);
  expect(result.data).toEqual({ summary: "ok", issues: [] });
});

test("callReviewer throws when the API key env var is not set", async () => {
  delete process.env.MISSING_KEY_VAR;
  const badProfile: ModelProfile = { ...profile, api_key_env: "MISSING_KEY_VAR" };
  await expect(callReviewer(badProfile, "x", "unknown", (async () => new Response("{}")) as unknown as typeof fetch)).rejects.toThrow();
});

test("callReviewer throws when the HTTP response is not ok", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const fakeFetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
  await expect(callReviewer(profile, "x", "unknown", fakeFetch)).rejects.toThrow();
});

test("callReviewer throws when api_key_env is missing from profile", async () => {
  const badProfile: ModelProfile = { ...profile, api_key_env: undefined };
  const fakeFetch = (async () => new Response("{}")) as unknown as typeof fetch;
  await expect(callReviewer(badProfile, "x", "unknown", fakeFetch)).rejects.toThrow();
});

test("callReviewer throws when base_url is missing from profile", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const badProfile: ModelProfile = { ...profile, base_url: undefined };
  const fakeFetch = (async () => new Response("{}")) as unknown as typeof fetch;
  await expect(callReviewer(badProfile, "x", "unknown", fakeFetch)).rejects.toThrow();
});

test("callLlm omits response_format when jsonMode is false, includes it when true", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  let capturedBody: any;
  const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  await callLlm({ profile, prompt: "x", jsonMode: false, fetchFn: fakeFetch });
  expect(capturedBody.response_format).toBeUndefined();

  await callLlm({ profile, prompt: "x", jsonMode: true, fetchFn: fakeFetch });
  expect(capturedBody.response_format).toEqual({ type: "json_object" });
});

test("callLlm retries once on a 429 response and succeeds on the second attempt", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    if (calls === 1) return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await callLlm({ profile, prompt: "x", fetchFn: fakeFetch });
  expect(result.text).toBe("ok");
  expect(calls).toBe(2);
});

test("callLlm does not retry on a 401 response", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return new Response("unauthorized", { status: 401 });
  }) as unknown as typeof fetch;

  await expect(callLlm({ profile, prompt: "x", fetchFn: fakeFetch })).rejects.toThrow();
  expect(calls).toBe(1);
});

test("callLlm reads usage from the response body's usage field", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const result = await callLlm({ profile, prompt: "x", fetchFn: fakeFetch });
  expect(result.usage).toEqual({ inTok: 10, outTok: 4, costUsd: 0 });
});

test("callLlmFanOut returns per-profile ok/error without one failure blocking the others", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const profileB: ModelProfile = { ...profile, api_key_env: "MISSING_FANOUT_KEY" };
  delete process.env.MISSING_FANOUT_KEY;
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })) as unknown as typeof fetch;

  const results = await callLlmFanOut([profile, profileB], () => "prompt", { fetchFn: fakeFetch });
  expect(results[0].ok).toBe(true);
  expect(results[0].result?.text).toBe("ok");
  expect(results[1].ok).toBe(false);
  expect(results[1].error).toBeDefined();
});

test("callLlm computes real costUsd from input_cost_per_1m/output_cost_per_1m when configured", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const pricedProfile: ModelProfile = { ...profile, input_cost_per_1m: 1, output_cost_per_1m: 2 };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 } }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const result = await callLlm({ profile: pricedProfile, prompt: "x", fetchFn: fakeFetch });
  // 1_000_000 tok @ $1/1M = $1.00; 500_000 tok @ $2/1M = $1.00; total $2.00
  expect(result.usage.costUsd).toBeCloseTo(2, 5);
});

test("callLlm computes costUsd from input_cost_per_1m alone when output_cost_per_1m is missing", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const pricedProfile: ModelProfile = { ...profile, input_cost_per_1m: 2, output_cost_per_1m: undefined };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 } }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const result = await callLlm({ profile: pricedProfile, prompt: "x", fetchFn: fakeFetch });
  // 1_000_000 tok @ $2/1M = $2.00; output tokens have no price, so they contribute 0
  expect(result.usage.costUsd).toBeCloseTo(2, 5);
});

test("callLlm leaves costUsd at 0 when no pricing is configured on the profile", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const result = await callLlm({ profile, prompt: "x", fetchFn: fakeFetch });
  expect(result.usage.costUsd).toBe(0);
});

test("callReviewer returns both the parsed JSON payload and usage", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ summary: "ok", issues: [] }) } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const result = await callReviewer(profile, "review this diff", "unknown", fakeFetch);
  expect(result.data).toEqual({ summary: "ok", issues: [] });
  expect(result.usage).toEqual({ inTok: 5, outTok: 2, costUsd: 0 });
});

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { llmRetryContext } from "../../src/llm/client";

test("callLlm emits llm_retry event on retryable failure when a run context is set", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const runDir = mkdtempSync(join(tmpdir(), "llm-retry-"));
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    if (calls === 1) return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await llmRetryContext.run({ runDir }, async () => callLlm({ profile, prompt: "x", fetchFn: fakeFetch }));
  expect(result.text).toBe("ok");

  const events = readFileSync(join(runDir, "events.jsonl"), "utf-8").split("\n").filter(Boolean);
  expect(events).toHaveLength(1);
  const parsed = JSON.parse(events[0]);
  expect(parsed.type).toBe("llm_retry");
  expect(parsed.stage).toBe("unknown");
  expect(parsed.attempt).toBe(1);
  expect(parsed.error).toContain("429");

  rmSync(runDir, { recursive: true, force: true });
});

test("callLlm throws when single-call cost exceeds max_token_cost", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const pricedProfile: ModelProfile = { ...profile, input_cost_per_1m: 1, output_cost_per_1m: 0 };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 2_000_000, completion_tokens: 0 } }),
      { status: 200 }
    )) as unknown as typeof fetch;

  await expect(callLlm({ profile: pricedProfile, prompt: "x", maxTokenCost: 1, fetchFn: fakeFetch })).rejects.toThrow("max_token_cost");
});

test("callLlm honors maxRetrySteps for retry limit", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return new Response("rate limited", { status: 429 });
  }) as unknown as typeof fetch;

  await expect(callLlm({ profile, prompt: "x", maxRetrySteps: 1, fetchFn: fakeFetch })).rejects.toThrow();
  expect(calls).toBe(2);
});

test("callReviewer forwards maxRetrySteps and maxTokenCost to callLlm", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const pricedProfile: ModelProfile = { ...profile, input_cost_per_1m: 1, output_cost_per_1m: 0 };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "ok", issues: [] }) } }], usage: { prompt_tokens: 2_000_000, completion_tokens: 0 } }),
      { status: 200 }
    )) as unknown as typeof fetch;

  await expect(callReviewer(pricedProfile, "review", "unknown", fakeFetch, 0, 1)).rejects.toThrow("max_token_cost");
});

test("callLlm retries 429 and succeeds using injected doCall and sleepFn", async () => {
  let calls = 0;
  const doCall = mock(async () => {
    calls++;
    if (calls < 2) {
      const e = new Error("rate limited");
      (e as unknown as { status: number }).status = 429;
      throw e;
    }
    return { text: "ok", usage: { inTok: 1, outTok: 1, costUsd: 0 } };
  });
  const sleepFn = mock(async (_ms: number) => {});
  const result = await callLlm({ profile, prompt: "hi" }, { doCall, sleepFn });
  expect(result.text).toBe("ok");
  expect(calls).toBe(2);
  expect(sleepFn).toHaveBeenCalledTimes(1);
});

test("callLlm does not retry BudgetExceededError", async () => {
  let calls = 0;
  const { BudgetExceededError } = await import("../../src/gate/budget");
  const doCall = mock(async () => {
    calls++;
    throw new BudgetExceededError("Token cost 100 exceeds max_token_cost limit 10");
  });
  const sleepFn = mock(async (_ms: number) => {});
  await expect(callLlm({ profile, prompt: "hi" }, { doCall, sleepFn })).rejects.toBeInstanceOf(BudgetExceededError);
  expect(calls).toBe(1);
  expect(sleepFn).toHaveBeenCalledTimes(0);
});

test("callLlm computes costUsd from ModelProfile.price when configured", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const pricedProfile: ModelProfile = { ...profile, price: { in_per_m: 2, out_per_m: 3 } };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 } }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const result = await callLlm({ profile: pricedProfile, prompt: "x", fetchFn: fakeFetch });
  expect(result.usage.costUsd).toBeCloseTo(3.5, 5);
});

test("callLlm prefers price over legacy input_cost_per_1m/output_cost_per_1m", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const pricedProfile: ModelProfile = {
    ...profile,
    price: { in_per_m: 1, out_per_m: 1 },
    input_cost_per_1m: 100,
    output_cost_per_1m: 100,
  };
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const result = await callLlm({ profile: pricedProfile, prompt: "x", fetchFn: fakeFetch });
  expect(result.usage.costUsd).toBeCloseTo(2, 5);
});
