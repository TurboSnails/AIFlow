import type { ModelProfile } from "../config/schema";

export async function callReviewer(
  profile: ModelProfile,
  prompt: string,
  fetchFn: typeof fetch = fetch
): Promise<unknown> {
  if (!profile.api_key_env) {
    throw new Error(`Profile has no api_key_env configured`);
  }
  const apiKey = process.env[profile.api_key_env];
  if (!apiKey) {
    throw new Error(`Environment variable ${profile.api_key_env} is not set`);
  }
  if (!profile.base_url) {
    throw new Error(`Profile has no base_url configured`);
  }

  const response = await fetchFn(`${profile.base_url}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: profile.model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Reviewer HTTP call failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as { choices: { message: { content: string } }[] };
  return JSON.parse(data.choices[0].message.content);
}
