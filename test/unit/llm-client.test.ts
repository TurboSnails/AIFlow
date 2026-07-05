import { test, expect } from "bun:test";
import { callReviewer } from "../../src/llm/client";
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
  }) as typeof fetch;

  const result = await callReviewer(profile, "review this diff", fakeFetch);
  expect(result).toEqual({ summary: "ok", issues: [] });
});

test("callReviewer throws when the API key env var is not set", async () => {
  delete process.env.MISSING_KEY_VAR;
  const badProfile: ModelProfile = { ...profile, api_key_env: "MISSING_KEY_VAR" };
  await expect(callReviewer(badProfile, "x", (async () => new Response("{}")) as typeof fetch)).rejects.toThrow();
});

test("callReviewer throws when the HTTP response is not ok", async () => {
  process.env.TEST_REVIEWER_KEY = "fake-key-value";
  const fakeFetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  await expect(callReviewer(profile, "x", fakeFetch)).rejects.toThrow();
});
