import { $, which } from "bun";
import { join } from "node:path";
import { z } from "zod";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface McpToolsDeps {
  spawnCli: (cwd: string, args: string[]) => Promise<CliResult>;
}

async function resolveCliPath(): Promise<string> {
  const global = which("aiflow");
  if (global) return "aiflow";
  return `bun run ${join(import.meta.dir, "../cli.ts")}`;
}

const defaultSpawnCli = async (cwd: string, args: string[]): Promise<CliResult> => {
  const cli = await resolveCliPath();
  const cliParts = cli.split(" ");
  const result = await $`${cliParts[0]} ${[...cliParts.slice(1), ...args]}`.cwd(cwd).nothrow().quiet();
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
};

const defaultDeps: McpToolsDeps = {
  spawnCli: defaultSpawnCli,
};

function textResponse(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  cwd: string = process.cwd(),
  deps: McpToolsDeps = defaultDeps,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  switch (name) {
    case "aiflow_status": {
      const runId = args.runId ? String(args.runId) : undefined;
      const cliArgs = ["status"];
      if (runId) cliArgs.push("--run-id", runId);
      const { stdout, stderr, exitCode } = await deps.spawnCli(cwd, cliArgs);
      const text = stdout || stderr || `aiflow status exited ${exitCode}`;
      return textResponse(text);
    }
    case "aiflow_run": {
      const pipeline = String(args.pipeline ?? "");
      if (!pipeline) return textResponse("Missing required argument: pipeline");
      const { stdout, stderr, exitCode } = await deps.spawnCli(cwd, ["run", "--pipeline", pipeline]);
      return textResponse(stdout || stderr || `aiflow run exited ${exitCode}`);
    }
    case "aiflow_brainstorm": {
      const prompt = String(args.prompt ?? "");
      const pipeline = String(args.pipeline ?? "brainstorm");
      if (!prompt) return textResponse("Missing required argument: prompt");
      const { stdout, stderr, exitCode } = await deps.spawnCli(cwd, ["run", "--pipeline", pipeline, "--requirement", prompt]);
      return textResponse(stdout || stderr || `aiflow brainstorm exited ${exitCode}`);
    }
    case "aiflow_review_diff": {
      const diff = z.string().parse(args.diff);
      const reviewers = z.array(z.string()).optional().parse(args.reviewers);
      const extra = reviewers ? ["--reviewers", reviewers.join(",")] : [];
      const { stdout, stderr, exitCode } = await deps.spawnCli(cwd, ["review-diff", "--diff", diff, ...extra]);
      return textResponse(stdout || stderr || `aiflow review-diff exited ${exitCode}`);
    }
    default:
      return textResponse(`Unknown tool: ${name}`);
  }
}

export function listTools(): Array<{ name: string; description: string; inputSchema: object }> {
  return [
    {
      name: "aiflow_status",
      description: "Get the status of the latest or a specific AIFlow run.",
      inputSchema: {
        type: "object",
        properties: { runId: { type: "string", description: "Optional run id" } },
        required: [],
      },
    },
    {
      name: "aiflow_run",
      description: "Start an AIFlow pipeline run.",
      inputSchema: {
        type: "object",
        properties: {
          pipeline: { type: "string", description: "Pipeline name" },
          requirement: { type: "string", description: "User requirement" },
        },
        required: ["pipeline"],
      },
    },
    {
      name: "aiflow_brainstorm",
      description: "Trigger an AIFlow brainstorm stage.",
      inputSchema: {
        type: "object",
        properties: { prompt: { type: "string" }, mode: { type: "string", enum: ["independent", "debate"] } },
        required: ["prompt"],
      },
    },
    {
      name: "aiflow_review_diff",
      description: "Run multi-reviewer AI review on a diff.",
      inputSchema: {
        type: "object",
        properties: {
          diff: { type: "string", description: "Unified diff text" },
          reviewers: { type: "array", items: { type: "string" }, description: "Optional reviewer profile names" },
        },
        required: ["diff"],
      },
    },
  ];
}
