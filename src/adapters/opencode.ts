import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import type { ModelProfile } from "../config/schema";
import { parseOpenCodeLine } from "./opencode-events";
import { appendEvent } from "../events/events";

export interface AgentTask {
  profile: ModelProfile;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  runDir: string;
  stage: string;
  story: string;
  maxTokenCost?: number;
}

export interface AgentResult {
  ok: boolean;
  transcriptPath: string;
  usage: { inTok: number; outTok: number; costUsd: number };
  reason?: string;
}

export type SpawnFn = (
  cmd: string[],
  opts: { cwd: string; signal?: AbortSignal }
) => { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill: () => void };

const defaultSpawn: SpawnFn = (cmd, opts) => {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", signal: opts.signal });
  return { stdout: proc.stdout, exited: proc.exited, kill: () => proc.kill() };
};

function buildArgs(task: AgentTask): string[] {
  const args = ["opencode", "run", task.prompt, "--format", "json", "--dir", task.cwd];
  if (task.profile.agent) {
    args.push("--agent", task.profile.agent);
  } else {
    args.push("--model", `${task.profile.provider}/${task.profile.model}`);
  }
  if (task.profile.variant) args.push("--variant", task.profile.variant);
  if (task.profile.thinking) args.push("--thinking");
  if (task.profile.dangerously_skip_permissions) args.push("--dangerously-skip-permissions");
  return args;
}

export async function runAgentTask(task: AgentTask, spawnFn: SpawnFn = defaultSpawn): Promise<AgentResult> {
  const legacyArtifactsDir = join(task.runDir, "artifacts", "opencode");
  const transcriptsDir = join(task.runDir, "transcripts");
  mkdirSync(legacyArtifactsDir, { recursive: true });
  mkdirSync(transcriptsDir, { recursive: true });
  const callId = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const legacyPath = join(legacyArtifactsDir, `${callId}.jsonl`);
  const transcriptPath = join(transcriptsDir, `${callId}.jsonl`);

  const controller = new AbortController();
  const proc = spawnFn(buildArgs(task), { cwd: task.cwd, signal: controller.signal });

  // Belt-and-suspenders: some spawn implementations (especially injected test
  // doubles or non-Bun runtimes) may not tie the AbortSignal into actually
  // killing the child process, so explicitly kill on timeout in addition to
  // aborting the signal.
  const timer = setTimeout(() => {
    controller.abort();
    proc.kill();
  }, task.timeoutMs);

  let inTok = 0;
  let outTok = 0;
  let costUsd = 0;
  let abortedByBudget = false;

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch {
        // Stream errored out (e.g. because the process was killed on
        // timeout) — treat as end of stream rather than crashing.
        break;
      }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        appendFileSync(legacyPath, line + "\n");
        appendFileSync(transcriptPath, line + "\n");
        const event = parseOpenCodeLine(line);
        if (!event) continue;
        if (event.type === "tool_use") {
          appendEvent(task.runDir, {
            ts: new Date().toISOString(),
            type: "opencode_tool_use",
            stage: task.stage,
            story: task.story,
            tool: event.part.tool,
            summary: `${event.part.tool} (${event.part.state.status})`,
          });
        } else if (event.type === "step_finish") {
          inTok += event.part.tokens.input;
          outTok += event.part.tokens.output;
          costUsd += event.part.cost;
          appendEvent(task.runDir, {
            ts: new Date().toISOString(),
            type: "opencode_step_finish",
            stage: task.stage,
            in_tok: event.part.tokens.input,
            out_tok: event.part.tokens.output,
            cost_usd: event.part.cost,
          });
          if (task.maxTokenCost !== undefined && costUsd > task.maxTokenCost) {
            abortedByBudget = true;
            appendEvent(task.runDir, {
              ts: new Date().toISOString(),
              type: "budget_warning",
              stage: task.stage,
              threshold_pct: 100,
              spent_usd: costUsd,
              limit_usd: task.maxTokenCost,
            });
            controller.abort();
            proc.kill();
            break;
          }
        }
      }
      if (abortedByBudget) break;
    }
  } finally {
    clearTimeout(timer);
  }

  const exitCode = await proc.exited;
  return {
    ok: exitCode === 0 && !abortedByBudget,
    transcriptPath,
    usage: { inTok, outTok, costUsd },
    reason: abortedByBudget ? "max_token_cost_exceeded" : undefined,
  };
}
