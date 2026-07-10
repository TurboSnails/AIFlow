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

test("run tool invokes aiflow with --pipeline", async () => {
  let capturedArgs: string[] = [];
  const result = await handleToolCall("aiflow_run", { pipeline: "demo" }, "/tmp", {
    spawnCli: async (_cwd, args) => {
      capturedArgs = args;
      return { exitCode: 0, stdout: "started\n", stderr: "" };
    },
  });
  expect(capturedArgs).toEqual(["run", "--pipeline", "demo"]);
  expect(result.content[0].text).toContain("started");
});

test("brainstorm tool invokes aiflow with --pipeline and --requirement", async () => {
  let capturedArgs: string[] = [];
  const result = await handleToolCall("aiflow_brainstorm", { prompt: "Build a widget" }, "/tmp", {
    spawnCli: async (_cwd, args) => {
      capturedArgs = args;
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    },
  });
  expect(capturedArgs.slice(0, 2)).toEqual(["run", "--pipeline"]);
  expect(capturedArgs).toContain("--requirement");
  expect(capturedArgs).toContain("Build a widget");
  expect(result.content[0].text).toContain("ok");
});

test("review_diff tool invokes aiflow report --run-id", async () => {
  let capturedArgs: string[] = [];
  const result = await handleToolCall("aiflow_review_diff", { runId: "20260101_120000" }, "/tmp", {
    spawnCli: async (_cwd, args) => {
      capturedArgs = args;
      return { exitCode: 0, stdout: "# Run report\n", stderr: "" };
    },
  });
  expect(capturedArgs).toEqual(["report", "--run-id", "20260101_120000"]);
  expect(result.content[0].text).toContain("Run report");
});
