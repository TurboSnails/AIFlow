import { test, expect } from "bun:test";
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

  const result = await callReviewer(profile, "review this diff", fakeFetch);
  expect(result).toEqual({ summary: "ok", issues: [] });
});

test("callReviewer throws when the API key env var is not set", async () => {
  delete process.env.MISSING_KEY_VAR;
  const badProfile: ModelProfile = { ...profile, api_key_env: "MISSING_KEY_VAR" };
  await expect(callReviewer(badProfile, "x", (async () => new Response("{}")) as unknown as typeof fetch)).rejects.toThrow();
});

test("callReviewer throws when the HTTP response is not ok", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const fakeFetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
  await expect(callReviewer(profile, "x", fakeFetch)).rejects.toThrow();
});

test("callReviewer throws when api_key_env is missing from profile", async () => {
  const badProfile: ModelProfile = { ...profile, api_key_env: undefined };
  const fakeFetch = (async () => new Response("{}")) as unknown as typeof fetch;
  await expect(callReviewer(badProfile, "x", fakeFetch)).rejects.toThrow();
});

test("callReviewer throws when base_url is missing from profile", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const badProfile: ModelProfile = { ...profile, base_url: undefined };
  const fakeFetch = (async () => new Response("{}")) as unknown as typeof fetch;
  await expect(callReviewer(badProfile, "x", fakeFetch)).rejects.toThrow();
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
