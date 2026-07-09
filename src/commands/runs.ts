import {
  listRunIdsByMtimeDesc,
  loadRun,
  isRunActive,
  summarizeRunStatus,
  runsRoot,
} from "../runs/store";

export interface RunRow {
  runId: string;
  pipeline: string;
  status: string;
  estUsd: number;
  mtimeMs: number;
  active: boolean;
}

export interface RunsOptions {
  json?: boolean;
  csv?: boolean;
  color?: boolean;
  write?: (s: string) => void;
  writeErr?: (s: string) => void;
}

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", gray: "\x1b[90m" } as const;
function paint(code: keyof typeof ANSI, on: boolean, text: string): string {
  return on ? `${ANSI[code]}${text}${ANSI.reset}` : text;
}
function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}
function escapeCsv(field: string): string {
  if (/[",\r\n]/.test(field)) return `"${field.replace(/"/g, '""')}"`;
  return field;
}
function relAge(mtimeMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - mtimeMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function buildRunRows(cwd: string): RunRow[] {
  const rows: RunRow[] = [];
  for (const runId of listRunIdsByMtimeDesc(cwd)) {
    const loaded = loadRun(cwd, runId);
    if (!loaded) continue;
    rows.push({
      runId,
      pipeline: loaded.state.pipeline,
      status: summarizeRunStatus(loaded.state),
      estUsd: loaded.state.cost.est_usd,
      mtimeMs: loaded.mtimeMs,
      active: isRunActive(cwd, runId, loaded.state),
    });
  }
  return rows;
}

export function renderRunsTable(rows: RunRow[], now: number, opts: { color?: boolean } = {}): string {
  const color = opts.color !== false;
  const lines: string[] = [];
  lines.push(paint("bold", color, "Runs"));
  lines.push("");
  const runW = Math.max(20, ...rows.map((r) => r.runId.length));
  const pipeW = Math.max(10, ...rows.map((r) => r.pipeline.length));
  const statusW = Math.max(8, ...rows.map((r) => r.status.length));
  const header = `  ${"Run".padEnd(runW)}  ${"Pipeline".padEnd(pipeW)}  ${"Status".padEnd(statusW)}  ${"Cost".padStart(10)}  ${"Age".padStart(6)}`;
  lines.push(paint("bold", color, header));
  let anyActive = false;
  for (const r of rows) {
    if (r.active) anyActive = true;
    const mark = r.active ? " *" : "";
    lines.push(`  ${r.runId.padEnd(runW)}  ${r.pipeline.padEnd(pipeW)}  ${r.status.padEnd(statusW)}  ${usd(r.estUsd).padStart(10)}  ${relAge(r.mtimeMs, now).padStart(6)}${mark}`);
  }
  if (anyActive) {
    lines.push(paint("gray", color, "  * active (running or lock-held)"));
  }
  return lines.join("\n");
}

export function renderRunsJson(rows: RunRow[]): string {
  return JSON.stringify(rows, null, 2);
}

export function renderRunsCsv(rows: RunRow[]): string {
  const lines: string[] = ["run_id,pipeline,status,est_usd,mtime_ms,active"];
  for (const r of rows) {
    lines.push(`${escapeCsv(r.runId)},${escapeCsv(r.pipeline)},${escapeCsv(r.status)},${r.estUsd},${r.mtimeMs},${r.active}`);
  }
  return lines.join("\n") + "\n";
}

export function runRuns(cwd: string, opts: RunsOptions): number {
  const write = opts.write ?? ((s) => process.stdout.write(s));
  const writeErr = opts.writeErr ?? ((s) => process.stderr.write(s));
  const color = opts.color !== false;

  if (opts.json && opts.csv) {
    writeErr("--json and --csv are mutually exclusive\n");
    return 1;
  }

  const rows = buildRunRows(cwd);
  if (rows.length === 0) {
    writeErr(`No runs found in ${runsRoot(cwd)}\n`);
    return 1;
  }

  if (opts.json) write(renderRunsJson(rows) + "\n");
  else if (opts.csv) write(renderRunsCsv(rows));
  else write(renderRunsTable(rows, Date.now(), { color }) + "\n");
  return 0;
}
