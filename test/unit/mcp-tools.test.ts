import { test, expect, mock } from "bun:test";
import { handleToolCall, listTools } from "../../src/mcp/tools";

test("mcp exposes aiflow_review_diff and routes to review-diff command", async () => {
  const spawnCli = mock(async () => ({ exitCode: 0, stdout: "{\"verdict\":\"pass\"}", stderr: "" }));
  const result = await handleToolCall("aiflow_review_diff", { diff: "@@ -1 +1 @@", reviewers: ["kimi"] }, "/tmp", { spawnCli });
  expect(spawnCli).toHaveBeenCalledWith("/tmp", ["review-diff", "--diff", "@@ -1 +1 @@", "--reviewers", "kimi"]);
  expect(result.content[0].text).toContain("pass");
});

test("aiflow_review_diff without reviewers omits --reviewers flag", async () => {
  const spawnCli = mock(async () => ({ exitCode: 0, stdout: "{\"verdict\":\"pass\"}", stderr: "" }));
  await handleToolCall("aiflow_review_diff", { diff: "@@ -1 +1 @@" }, "/tmp", { spawnCli });
  expect(spawnCli).toHaveBeenCalledWith("/tmp", ["review-diff", "--diff", "@@ -1 +1 @@"]);
});

test("aiflow_review_diff throws on missing diff", async () => {
  const spawnCli = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  await expect(handleToolCall("aiflow_review_diff", {}, "/tmp", { spawnCli })).rejects.toThrow();
});

test("listTools includes aiflow_review_diff with complete schema", () => {
  const tools = listTools();
  const tool = tools.find((t) => t.name === "aiflow_review_diff");
  expect(tool).toBeDefined();
  expect(tool!.inputSchema).toMatchObject({
    type: "object",
    properties: {
      diff: { type: "string" },
      reviewers: { type: "array" },
    },
    required: ["diff"],
  });
});

test("listTools all tools have required field", () => {
  const tools = listTools();
  for (const tool of tools) {
    expect((tool.inputSchema as Record<string, unknown>).required).toBeDefined();
  }
});
