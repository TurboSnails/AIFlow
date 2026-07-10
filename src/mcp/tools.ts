import { $ } from "bun";
import { join } from "node:path";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface McpToolsDeps {
  spawnCli: (cwd: string, args: string[]) => Promise<CliResult>;
}

const defaultSpawnCli = async (cwd: string, args: string[]): Promise<CliResult> => {
  const result = await $`bun run ${join(import.meta.dir, "../cli.ts")} ${args}`.cwd(cwd).nothrow().quiet();
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf-8"),
    stderr: result.stderr.toString("utf-8"),
  };
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
      },
    },
    {
      name: "aiflow_run",
      description: "Start an AIFlow pipeline run.",
      inputSchema: {
        type: "object",
        properties: { pipeline: { type: "string", description: "Pipeline name" } },
        required: ["pipeline"],
      },
    },
    {
      name: "aiflow_brainstorm",
      description: "Trigger an AIFlow brainstorm stage.",
      inputSchema: {
        type: "object",
        properties: { prompt: { type: "string", description: "Brainstorm prompt" } },
        required: ["prompt"],
      },
    },
  ];
}
