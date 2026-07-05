import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { EngineState } from "../engine/state";
import type { AiflowEvent } from "../events/events";

export interface MonitorOptions {
  tail: number;
  now: Date;
  color?: boolean;
}

export interface RunSnapshot {
  runId: string;
  runDir: string;
  startedAt: Date;
  state: EngineState;
  events: AiflowEvent[];
}

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

function c(code: keyof typeof ANSI, on: boolean, text: string): string {
  if (!on) return text;
  return `${ANSI[code]}${text}${ANSI.reset}`;
}

function statusColor(status: EngineState["stages"][number]["status"], on: boolean): string {
  const map: Record<EngineState["stages"][number]["status"], keyof typeof ANSI> = {
    pending: "gray",
    running: "cyan",
    done: "green",
    failed: "red",
    aborted: "yellow",
    suspended: "yellow",
  };
  return c(map[status], on, status);
}

function pickLatestRun(cwd: string): string | undefined {
  const runsRoot = join(cwd, ".aiflow", "runs");
  if (!existsSync(runsRoot)) return undefined;
  const entries = readdirSync(runsRoot).filter((name) => {
    const full = join(runsRoot, name);
    return statSync(full).isDirectory();
  });
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => statSync(join(runsRoot, b)).mtimeMs - statSync(join(runsRoot, a)).mtimeMs);
  return entries[0];
}

export function readRunSnapshot(cwd: string, runId?: string): RunSnapshot | undefined {
  const resolvedRunId = runId ?? pickLatestRun(cwd);
  if (!resolvedRunId) return undefined;
  const runDir = join(cwd, ".aiflow", "runs", resolvedRunId);
  const statePath = join(runDir, "state.json");
  const eventsPath = join(runDir, "events.jsonl");
  if (!existsSync(statePath)) return undefined;

  const state = JSON.parse(readFileSync(statePath, "utf-8")) as EngineState;
  const events: AiflowEvent[] = existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf-8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as AiflowEvent)
    : [];

  const startedAt = statSync(statePath).birthtime;
  return { runId: resolvedRunId, runDir, startedAt, state, events };
}

function formatTime(iso: string, now: Date): string {
  const t = new Date(iso);
  const deltaSec = Math.max(0, Math.round((now.getTime() - t.getTime()) / 1000));
  const hh = String(t.getUTCHours()).padStart(2, "0");
  const mm = String(t.getUTCMinutes()).padStart(2, "0");
  const ss = String(t.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss} (-${deltaSec}s)`;
}

function describeEvent(evt: AiflowEvent, color: boolean, now: Date): string {
  switch (evt.type) {
    case "opencode_tool_use":
      return `${formatTime(evt.ts, now)}  ${c("blue", color, "tool")}     ${evt.stage}/${evt.story}  ${evt.tool} — ${evt.summary}`;
    case "opencode_step_finish":
      return `${formatTime(evt.ts, now)}  ${c("blue", color, "step")}     ${evt.stage}  in=${evt.in_tok} out=${evt.out_tok} $${evt.cost_usd.toFixed(4)}`;
    case "gate_result": {
      const checksTag = evt.checks === "pass" ? c("green", color, "pass") : c("red", color, "fail");
      const reviewTag =
        evt.ai_review === "pass" ? c("green", color, "pass") : evt.ai_review === "skipped" ? c("gray", color, "skip") : c("red", color, "fail");
      return `${formatTime(evt.ts, now)}  ${c("blue", color, "gate")}     ${evt.stage}/${evt.story}  checks=${checksTag} review=${reviewTag} blockers=${evt.blockers}`;
    }
    case "story_result": {
      const tag =
        evt.result === "pass" ? c("green", color, "PASS") : evt.result === "fail" ? c("red", color, "FAIL") : c("yellow", color, "SUSPEND");
      return `${formatTime(evt.ts, now)}  ${c("blue", color, "story")}    ${evt.story}  ${tag}`;
    }
  }
}

export function renderStatus(state: EngineState, events: AiflowEvent[], opts: MonitorOptions): string {
  const color = opts.color !== false;
  const lines: string[] = [];
  lines.push(`${c("bold", color, "AIFlow run")}`);
  lines.push(`run_id:    ${state.run_id}`);
  lines.push(`pipeline:  ${state.pipeline}`);
  lines.push("");
  lines.push(c("bold", color, "Stages:"));
  for (const stg of state.stages) {
    const it = stg.iteration !== undefined ? ` (iteration ${stg.iteration})` : "";
    lines.push(`  ${stg.id.padEnd(14)} ${statusColor(stg.status, color)}${it}`);
  }
  lines.push("");
  lines.push(c("bold", color, "Cost:"));
  lines.push(`  in=${state.cost.input_tokens}  out=${state.cost.output_tokens}  est_usd=$${state.cost.est_usd.toFixed(4)}`);
  lines.push("");
  const tail = events.slice(-opts.tail);
  lines.push(c("bold", color, `Recent events: (${tail.length} of ${events.length})`));
  if (tail.length === 0) {
    lines.push("  (none)");
  } else {
    for (const evt of tail) lines.push(`  ${describeEvent(evt, color, opts.now)}`);
  }
  return lines.join("\n");
}

export function renderSnapshot(snap: RunSnapshot, opts: MonitorOptions): string {
  return renderStatus(snap.state, snap.events, opts);
}

export async function watchRun(cwd: string, opts: { now?: () => Date; tail: number; write?: (s: string) => void; signal?: AbortSignal; intervalMs?: number; readSnapshot?: (cwd: string) => RunSnapshot | undefined }): Promise<void> {
  const write = opts.write ?? ((s) => process.stdout.write(s));
  const nowFn = opts.now ?? (() => new Date());
  const intervalMs = opts.intervalMs ?? 1000;
  const snapshotFn = opts.readSnapshot ?? readRunSnapshot;

  function hideCursor(on: boolean) {
    write(on ? "\x1b[?25l" : "\x1b[?25h");
  }

  hideCursor(true);
  try {
    while (true) {
      if (opts.signal?.aborted) return;
      const snap = snapshotFn(cwd);
      write("\x1b[2J\x1b[H");
      if (!snap) {
        write(`No .aiflow/runs found in ${cwd}\n`);
      } else {
        write(renderSnapshot(snap, { tail: opts.tail, now: nowFn(), color: true }) + "\n");
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  } finally {
    write("\x1b[2J\x1b[H");
    hideCursor(false);
  }
}

export function runStatus(cwd: string, opts: { tail: number; runId?: string; color?: boolean; now?: () => Date }): number {
  const snap = readRunSnapshot(cwd, opts.runId);
  if (!snap) {
    process.stderr.write(`No run found in ${cwd}/.aiflow/runs${opts.runId ? ` (run_id=${opts.runId})` : ""}\n`);
    return 1;
  }
  const out = renderSnapshot(snap, { tail: opts.tail, now: (opts.now ?? (() => new Date()))(), color: opts.color ?? true });
  process.stdout.write(out + "\n");
  return 0;
}
