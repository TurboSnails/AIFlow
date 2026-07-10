import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import type { EngineState } from "../engine/state";
import type { AiflowEvent } from "../events/events";
import { readEvents } from "../events/events";
import { listRunIdsByMtimeDesc } from "../runs/store";

export interface RunReportOptions {
  now: Date;
  startedAt: Date;
}

function iso(d: Date): string {
  return d.toISOString();
}

function durationSeconds(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
}

function countByType(events: AiflowEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}

function storiesByResult(events: AiflowEvent[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of events) {
    if (e.type !== "story_result") continue;
    const arr = m.get(e.result) ?? [];
    arr.push(e.story);
    m.set(e.result, arr);
  }
  return m;
}

export function renderRunReport(state: EngineState, events: AiflowEvent[], opts: RunReportOptions): string {
  const durationS = durationSeconds(opts.startedAt, opts.now);
  const counts = countByType(events);
  const byResult = storiesByResult(events);

  const lines: string[] = [];
  lines.push(`# Run report — ${state.run_id}`);
  lines.push("");
  lines.push(`Pipeline: \`${state.pipeline}\``);
  lines.push(`Started:  ${iso(opts.startedAt)}`);
  lines.push(`Finished: ${iso(opts.now)}`);
  lines.push(`Duration: ${durationS}s`);
  lines.push("");
  lines.push("## Stages");
  lines.push("");
  lines.push("| id | status | reason |");
  lines.push("| --- | --- | --- |");
  for (const s of state.stages) {
    lines.push(`| ${s.id} | ${s.status} | ${s.reason ?? ""} |`);
  }
  lines.push("");
  lines.push("## Cost");
  lines.push("");
  lines.push(`- input tokens: ${state.cost.input_tokens}`);
  lines.push(`- output tokens: ${state.cost.output_tokens}`);
  lines.push(`- est_usd: ${state.cost.est_usd.toFixed(4)}`);
  lines.push("");
  lines.push("## Events");
  lines.push("");
  const sortedTypes = Object.keys(counts).sort();
  if (sortedTypes.length === 0) {
    lines.push("(none)");
  } else {
    for (const t of sortedTypes) {
      lines.push(`- ${t}: ${counts[t]}`);
    }
  }
  lines.push("");
  lines.push("## Stories");
  lines.push("");
  const resultOrder = ["pass", "fail", "suspended"];
  let any = false;
  for (const r of resultOrder) {
    const list = byResult.get(r);
    if (!list || list.length === 0) continue;
    any = true;
    lines.push(`### ${r} (${list.length})`);
    for (const sid of list) lines.push(`- ${sid}`);
    lines.push("");
  }
  if (!any) lines.push("(none)\n");
  return lines.join("\n");
}

export function writeRunReport(runDir: string, state: EngineState, events: AiflowEvent[], opts: RunReportOptions): string {
  const content = renderRunReport(state, events, opts);
  writeFileSync(join(runDir, "run-report.md"), content);
  return content;
}

export interface ReportResult {
  status: "ok" | "no_runs";
  report?: string;
}

export function runReport(cwd: string, opts: { runId?: string } = {}): ReportResult {
  const runId = opts.runId ?? listRunIdsByMtimeDesc(cwd)[0];
  if (!runId) return { status: "no_runs" };
  const runDir = join(cwd, ".aiflow", "runs", runId);
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) return { status: "no_runs" };
  const state = JSON.parse(readFileSync(statePath, "utf-8")) as EngineState;
  const events = readEvents(runDir);
  const startedAt = events.length > 0 ? new Date(events[0].ts) : new Date();
  const report = renderRunReport(state, events, { now: new Date(), startedAt });
  return { status: "ok", report };
}
