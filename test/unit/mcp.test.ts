import { test, expect } from "bun:test";
import { handleToolCall, listTools } from "../../src/mcp/tools";

test("status tool returns latest run id text", async () => {
  const result = await handleToolCall("aiflow_status", {}, "/tmp", {
    spawnCli: async () => ({ exitCode: 0, stdout: "No runs found\n", stderr: "" }),
  });
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe("text");
  expect(result.content[0].text).toContain("No runs");
});

test("run tool requires pipeline argument", async () => {
  const result = await handleToolCall("aiflow_run", {}, "/tmp", {
    spawnCli: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  expect(result.content[0].text).toContain("Missing required argument: pipeline");
});

test("unknown tool returns helpful error", async () => {
  const result = await handleToolCall("aiflow_unknown", {}, "/tmp", {
    spawnCli: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  expect(result.content[0].text).toContain("Unknown tool");
});

test("listTools exposes expected aiflow tools", () => {
  const tools = listTools();
  const names = tools.map((t) => t.name);
  expect(names).toContain("aiflow_status");
  expect(names).toContain("aiflow_run");
  expect(names).toContain("aiflow_brainstorm");
  expect(names).toContain("aiflow_review_diff");
});
