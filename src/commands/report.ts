import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { EngineState } from "../engine/state";
import type { AiflowEvent } from "../events/events";
import { readEvents } from "../events/events";
import { listRunIdsByMtimeDesc } from "../runs/store";
import { writeFileAtomic } from "../atomic/atomic-write";

export function sanitizeSecrets(text: string): string {
  return text
    .replace(/\b(sk-[a-zA-Z0-9-]{20,})\b/g, "***")
    .replace(/\b(ANTHROPIC_API_KEY|OPENAI_API_KEY|OPEN_CODE_API_KEY)\s*=\s*[^\s]+/g, "$1=***")
    .replace(/"api_key"\s*:\s*"[^"]+"/g, '"api_key":"***"');
}

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

function reviewDistribution(events: AiflowEvent[]): Map<string, { pass: number; fail: number; skipped: number }> {
  const m = new Map<string, { pass: number; fail: number; skipped: number }>();
  for (const e of events) {
    if (e.type !== "review_verdict") continue;
    for (const [reviewer, verdict] of Object.entries(e.reviewers)) {
      const cur = m.get(reviewer) ?? { pass: 0, fail: 0, skipped: 0 };
      if (verdict === "pass") cur.pass++;
      else if (verdict === "fail") cur.fail++;
      else if (verdict === "skipped") cur.skipped++;
      m.set(reviewer, cur);
    }
  }
  return m;
}

function debateSummary(events: AiflowEvent[]): { rounds: number; openQuestions: number } {
  let rounds = 0;
  let openQuestions = 0;
  for (const e of events) {
    if (e.type === "debate_round") rounds++;
    if (e.type === "debate_end") openQuestions += e.open_questions ?? 0;
  }
  return { rounds, openQuestions };
}

function gateBlockers(events: AiflowEvent[]): { total: number; fails: Array<{ stage: string; story: string; blockers: number }> } {
  let total = 0;
  const fails: Array<{ stage: string; story: string; blockers: number }> = [];
  for (const e of events) {
    if (e.type !== "gate_result") continue;
    total += e.blockers ?? 0;
    if (e.checks === "fail" || e.ai_review === "fail") {
      fails.push({ stage: e.stage, story: e.story, blockers: e.blockers ?? 0 });
    }
  }
  return { total, fails };
}

export function renderRunReport(state: EngineState, events: AiflowEvent[], opts: RunReportOptions): string {
  const durationS = durationSeconds(opts.startedAt, opts.now);
  const counts = countByType(events);
  const byResult = storiesByResult(events);
  const reviews = reviewDistribution(events);
  const debate = debateSummary(events);
  const gate = gateBlockers(events);

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

  lines.push("## Reviews");
  lines.push("");
  if (reviews.size === 0) {
    lines.push("(none)");
  } else {
    lines.push("| reviewer | pass | fail | skipped |");
    lines.push("| --- | --- | --- | --- |");
    for (const [reviewer, { pass, fail, skipped }] of reviews) {
      lines.push(`| ${reviewer} | ${pass} | ${fail} | ${skipped} |`);
    }
  }
  lines.push("");

  lines.push("## Debates");
  lines.push("");
  lines.push(`- rounds: ${debate.rounds}`);
  lines.push(`- open questions: ${debate.openQuestions}`);
  lines.push("");

  lines.push("## Gate Results");
  lines.push("");
  lines.push(`- total blockers: ${gate.total}`);
  if (gate.fails.length > 0) {
    lines.push("- failed gates:");
    for (const f of gate.fails) {
      lines.push(`  - ${f.stage}/${f.story} (${f.blockers} blockers)`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

export function writeRunReport(runDir: string, state: EngineState, events: AiflowEvent[], opts: RunReportOptions): string {
  const content = sanitizeSecrets(renderRunReport(state, events, opts));
  writeFileAtomic(join(runDir, "run-report.md"), content);
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
