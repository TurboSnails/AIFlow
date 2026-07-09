import { rmSync } from "node:fs";
import { join } from "node:path";
import { buildRunRows, type RunRow } from "./runs";
import { runsRoot } from "../runs/store";

const CLEANABLE_STATUSES = new Set(["done", "failed", "aborted"]);

function formatAge(mtimeMs: number, now: Date): string {
  const diff = Math.max(0, now.getTime() - mtimeMs);
  const days = Math.floor(diff / 86400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(diff / 3600_000);
  if (hours >= 1) return `${hours}h`;
  const minutes = Math.floor(diff / 60_000);
  if (minutes >= 1) return `${minutes}m`;
  return `${Math.floor(diff / 1000)}s`;
}

export interface CleanOptions {
  before?: string;
  status?: string;
  keep?: number;
  dryRun?: boolean;
  yes?: boolean;
  write?: (s: string) => void;
  writeErr?: (s: string) => void;
  confirm?: () => boolean;
}

/** Parse a --before value: "Nd" relative days, or a strict ISO 8601 date. undefined when unparseable. */
export function parseBefore(value: string, now: Date): Date | undefined {
  const rel = /^(\d+)d$/.exec(value);
  if (rel) {
    return new Date(now.getTime() - Number(rel[1]) * 86400_000);
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) return undefined;
  const isoStrict = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
  if (!isoStrict.test(value)) return undefined;
  return new Date(t);
}

/** Pure selection. Active runs and non-cleanable statuses are never candidates. */
export function selectRunsToClean(
  rows: RunRow[],
  filters: { before?: Date; status?: string; keep?: number },
): { toDelete: RunRow[]; kept: RunRow[] } {
  let candidates = rows.filter((r) => !r.active && CLEANABLE_STATUSES.has(r.status));
  if (filters.status) candidates = candidates.filter((r) => r.status === filters.status);
  if (filters.before) candidates = candidates.filter((r) => r.mtimeMs < filters.before!.getTime());

  const kept: RunRow[] = [];
  let toDelete = candidates;
  if (filters.keep !== undefined) {
    const sorted = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs);
    kept.push(...sorted.slice(0, filters.keep));
    toDelete = sorted.slice(filters.keep);
  }
  return { toDelete, kept };
}

function defaultConfirm(): boolean {
  // Non-interactive by default in this codebase's tests; real TTY confirm is
  // gated by --yes at the command layer, so this path is only hit interactively.
  return false;
}

export function runClean(cwd: string, opts: CleanOptions): number {
  const write = opts.write ?? ((s) => process.stdout.write(s));
  const writeErr = opts.writeErr ?? ((s) => process.stderr.write(s));

  // Validate --status
  if (opts.status !== undefined && !CLEANABLE_STATUSES.has(opts.status)) {
    writeErr(`Invalid --status "${opts.status}" (must be one of: done, failed, aborted)\n`);
    return 1;
  }
  // Validate --keep
  if (opts.keep !== undefined && (!Number.isInteger(opts.keep) || opts.keep < 0)) {
    writeErr(`Invalid --keep "${opts.keep}" (must be a non-negative integer)\n`);
    return 1;
  }
  // Parse --before
  let before: Date | undefined;
  const now = new Date();
  if (opts.before !== undefined) {
    before = parseBefore(opts.before, now);
    if (!before) {
      writeErr(`Invalid --before "${opts.before}" (use "<N>d" or an ISO date)\n`);
      return 1;
    }
  }
  // Require at least one filter
  if (opts.before === undefined && opts.status === undefined && opts.keep === undefined) {
    writeErr("clean requires at least one of --before, --status, --keep\n");
    return 1;
  }

  const rows = buildRunRows(cwd);
  if (rows.length === 0) {
    writeErr(`No runs found in ${runsRoot(cwd)}\n`);
    return 1;
  }

  const { toDelete, kept } = selectRunsToClean(rows, { before, status: opts.status, keep: opts.keep });
  if (toDelete.length === 0) {
    write("Nothing to clean\n");
    return 0;
  }

  write(`Run(s) to delete:\n`);
  const runW = Math.max(20, ...toDelete.map((r) => r.runId.length));
  const pipeW = Math.max(10, ...toDelete.map((r) => r.pipeline.length));
  const statusW = Math.max(8, ...toDelete.map((r) => r.status.length));
  const header = `  ${"Run".padEnd(runW)}  ${"Pipeline".padEnd(pipeW)}  ${"Status".padEnd(statusW)}  ${"Cost".padStart(10)}  Age`;
  write(header + "\n");
  for (const r of toDelete) {
    const cost = `$${r.estUsd.toFixed(4)}`.padStart(10);
    write(`  ${r.runId.padEnd(runW)}  ${r.pipeline.padEnd(pipeW)}  ${r.status.padEnd(statusW)}  ${cost}  ${formatAge(r.mtimeMs, now)}\n`);
  }

  if (opts.dryRun) {
    write(`Would delete ${toDelete.length} run(s)\n`);
    return 0;
  }

  // Confirmation gate
  if (!opts.yes) {
    const confirmFn = opts.confirm;
    if (!confirmFn) {
      // No injected confirm and not --yes: refuse in non-interactive contexts.
      if (!process.stdin.isTTY) {
        writeErr("refusing to delete without --yes (non-interactive)\n");
        return 1;
      }
    }
    const confirmed = (confirmFn ?? defaultConfirm)();
    if (!confirmed) {
      write("Aborted\n");
      return 0;
    }
  }

  for (const r of toDelete) {
    rmSync(join(runsRoot(cwd), r.runId), { recursive: true, force: true });
  }
  write(`Deleted ${toDelete.length} run(s)\n`);
  if (kept.length > 0) write(`Kept ${kept.length} run(s)\n`);
  return 0;
}
