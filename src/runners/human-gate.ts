import { join } from "node:path";
import type { HumanGateStageConfig } from "../config/schema";
import type { StageStatus } from "../engine/state";

export type HumanGateOutcome = Extract<StageStatus, "done" | "failed" | "aborted">;

export interface HumanGateDeps {
  write?: (s: string) => void;
  writeErr?: (s: string) => void;
  stdinFactory?: () => AsyncIterable<string> | Promise<AsyncIterable<string>>;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface HumanGateResult {
  outcome: HumanGateOutcome;
  inputSeen?: string;
  reason?: string;
}

export interface HumanGateContext {
  cwd: string;
  runDir: string;
  specExcerpt: string;
}

const AFFIRMATIVE = new Set(["y", "yes", "ok", "okay", "continue", "proceed", "go"]);
const NEGATIVE = new Set(["n", "no", "stop", "abort", "cancel", "exit"]);

function parseTimeoutMs(spec: string | undefined): number | null {
  const trimmed = (spec ?? "none").trim();
  if (trimmed === "" || trimmed === "none") return null;
  const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(trimmed);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2] ?? "ms";
  switch (unit) {
    case "ms": return value;
    case "s": return value * 1000;
    case "m": return value * 60_000;
    case "h": return value * 3_600_000;
    default: return value;
  }
}

function outcomeForDefault(action: HumanGateStageConfig["default_action"]): HumanGateOutcome {
  if (action === "pass") return "done";
  if (action === "fail") return "failed";
  return "aborted";
}

async function collectLines(iter: AsyncIterable<string>, signal: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  const it = iter[Symbol.asyncIterator]();
  while (true) {
    if (signal.aborted) return out;
    const next = await it.next();
    if (next.done) return out;
    out.push(String(next.value));
  }
}

/**
 * Block until stdin produces an affirmative/negative answer or the timeout fires.
 * Concurrency model:
 *   - launch a small task that reads every newline from stdinFactory()
 *   - launch a setTimeout that aborts a signal when the stage deadline passes
 *   - whichever settles first wins; the other is short-circuited via the signal
 */
export async function runHumanGate(
  stage: HumanGateStageConfig,
  _ctx: HumanGateContext,
  deps: HumanGateDeps = {},
): Promise<HumanGateResult> {
  const write = deps.write ?? ((s: string) => process.stdout.write(s));
  const writeErr = deps.writeErr ?? ((s: string) => process.stderr.write(s));
  const setT = deps.setTimeoutFn ?? setTimeout;
  const clearT = deps.clearTimeoutFn ?? clearTimeout;

  write(`\n[human_gate:${stage.id}] ${stage.prompt}\n`);
  write(`Type yes/no; with a timeout of '${stage.timeout ?? "none"}', default_action=${stage.default_action} applies on EOF / timeout.\n\n`);

  const factory = deps.stdinFactory ?? (() => (async function* () {})());
  const iterable = await Promise.resolve(factory());
  const controller = new AbortController();
  const timeoutMs = parseTimeoutMs(stage.timeout);
  const timer = timeoutMs !== null
    ? setT(() => {
        writeErr(`\n[human_gate:${stage.id}] timeout (${stage.timeout}) reached; applying default_action=${stage.default_action}\n`);
        controller.abort("timeout");
      }, timeoutMs)
    : null;

  try {
    const lines = await collectLines(iterable, controller.signal);
    if (timer !== null) clearT(timer);

    for (const raw of lines) {
      const line = raw.trim().toLowerCase();
      if (!line) continue;
      if (AFFIRMATIVE.has(line)) return { outcome: "done", inputSeen: line };
      if (NEGATIVE.has(line)) return { outcome: "failed", inputSeen: line, reason: `human answered '${line}'` };
      write(`  unrecognised answer '${line}'; expected yes/no\n`);
    }

    const reason = lines.length === 0 ? `stdin closed; default_action=${stage.default_action}` : `no affirmative/negative answer; default_action=${stage.default_action}`;
    return { outcome: outcomeForDefault(stage.default_action), reason };
  } finally {
    if (timer !== null) clearT(timer);
  }
}

export async function writeHumanGateArtifact(runDir: string, stage: HumanGateStageConfig, result: HumanGateResult): Promise<string> {
  const path = join(runDir, "artifacts", `human_gate_${stage.id}.json`);
  const fs = await import("node:fs/promises");
  await fs.mkdir(join(runDir, "artifacts"), { recursive: true });
  await fs.writeFile(path, JSON.stringify({ stage: stage.id, prompt: stage.prompt, outcome: result.outcome, reason: result.reason, inputSeen: result.inputSeen, ts: new Date().toISOString() }, null, 2));
  return path;
}
