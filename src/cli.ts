#!/usr/bin/env bun
import { Command } from "commander";
import type { RunLock } from "./lock";

const program = new Command();
program.name("aiflow").description("AIFlow pipeline orchestrator CLI").version("0.1.0");

/** Acquire the run lock with the standard CLI messaging/SIGINT handling, run the
 *  provided callback while holding the lock, and release the lock afterwards.
 *  Returns `undefined` if the user aborted while waiting (sets exitCode to 1). */
async function withRunLock<T>(
  cwd: string,
  runId: string,
  fn: (lock: RunLock, controller: AbortController) => T | Promise<T>,
): Promise<T | undefined> {
  const { acquireRunLock, LockWaitAbortedError } = await import("./lock");
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  let lock: RunLock;
  try {
    lock = await acquireRunLock(cwd, runId, {
      signal: controller.signal,
      onWaiting: (info) => console.error(`Waiting: run ${info.run_id} in progress (pid ${info.pid}), queued...`),
      onStaleReclaimed: (info) => console.error(`Reclaimed stale lock left by pid ${info.pid} (process no longer running).`),
    });
  } catch (err) {
    process.removeListener("SIGINT", onSigint);
    if (err instanceof LockWaitAbortedError) {
      process.exitCode = 1;
      return undefined;
    }
    throw err;
  }
  try {
    return await fn(lock, controller);
  } finally {
    lock.release();
    process.removeListener("SIGINT", onSigint);
  }
}

program
  .command("doctor")
  .description("Check environment: OpenCode, reviewer API key, git status")
  .action(async () => {
    const { runDoctorChecks } = await import("./commands/doctor");
    const { loadModelsConfig } = await import("./config/loader");
    const { join } = await import("node:path");

    let reviewerProfile;
    try {
      const config = loadModelsConfig(join(process.cwd(), ".aiflow", "config", "models.yaml"));
      reviewerProfile = config.profiles["reviewer"];
    } catch {
      reviewerProfile = undefined;
    }

    const report = await runDoctorChecks(process.cwd(), reviewerProfile);
    console.log(`OpenCode version: ${report.openCodeVersion ?? "NOT FOUND"}`);
    console.log(`Git repo: ${report.gitOk ? "ok" : "NOT a git repository"}`);
    console.log(`Reviewer API key present: ${report.reviewerKeyPresent}`);
    console.log(`Reviewer reachable: ${report.reviewerReachable ?? "skipped (no key)"}`);
    if (report.reviewerError) console.log(`Reviewer error: ${report.reviewerError}`);
    for (const warning of report.pricingWarnings) console.log(`Pricing warning: ${warning}`);

    const fatal = !report.openCodeVersion || !report.gitOk;
    process.exitCode = fatal ? 1 : 0;
  });

program
  .command("init")
  .description("Generate .aiflow/ config scaffold in the current directory")
  .action(async () => {
    const { runInit } = await import("./commands/init");
    const result = runInit(process.cwd());
    if (result.created) {
      console.log("Created .aiflow/config scaffold.");
    } else {
      console.log(`Skipped: ${result.reason}`);
      process.exitCode = 1;
    }
  });

program
  .command("run")
  .description("Run a pipeline")
  .requiredOption("--pipeline <name>", "pipeline name to run")
  .option("--once", "run exactly one iteration", false)
  .option("--requirement <text>", "requirement text for pipelines with a brainstorm/spec stage")
  .option("--requirement-file <path>", "path to a file containing the requirement text")
  .action(async (opts: { pipeline: string; once: boolean; requirement?: string; requirementFile?: string }) => {
    if (opts.requirement && opts.requirementFile) {
      console.error("--requirement and --requirement-file are mutually exclusive");
      process.exitCode = 1;
      return;
    }
    const { runCommand } = await import("./commands/run");
    const { summarizePipelineOutcome, createRunId } = await import("./engine/engine");
    const runId = createRunId();
    const done = await withRunLock(process.cwd(), runId, async (lock, controller) => {
      try {
        const state = await runCommand(
          process.cwd(),
          opts.pipeline,
          {},
          { requirement: opts.requirement, requirementFile: opts.requirementFile },
          controller.signal,
          runId
        );
        const outcome = summarizePipelineOutcome(state);
        console.log(outcome.line);
        const { formatBudgetOutcomeLine } = await import("./commands/budget-outcome");
        const budgetLine = formatBudgetOutcomeLine(state);
        if (budgetLine) console.log(budgetLine);
        process.exitCode = outcome.exitCode;
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
    if (done === undefined) return; // aborted while waiting for lock
  });

program
  .command("resume")
  .description("Resume an in-flight or previously-aborted run (reads state.json)")
  .option("--run-id <id>", "resume a specific run (defaults to latest)")
  .option("--pipeline <name>", "override the pipeline name read from state.json")
  .option("--force", "re-execute stages that already reached a terminal state", false)
  .option("--raise-budget <n>", "raise the pipeline's budget.max_cost_usd to this value before resuming", (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid --raise-budget value: ${v}`);
    return n;
  })
  .action(async (opts: { runId?: string; pipeline?: string; force: boolean; raiseBudget?: number }) => {
    const { runResume } = await import("./commands/resume");
    const { summarizePipelineOutcome } = await import("./engine/engine");
    const { formatBudgetOutcomeLine } = await import("./commands/budget-outcome");
    const done = await withRunLock(process.cwd(), opts.runId ?? "pending-resume", async (lock, controller) => {
      const result = await runResume(
        process.cwd(),
        { runId: opts.runId, pipeline: opts.pipeline, force: opts.force, raiseBudget: opts.raiseBudget },
        undefined,
        controller.signal
      );
      if (result.status === "no_runs" || result.status === "missing_run_dir") {
        console.error(result.message ?? "");
        process.exitCode = 1;
        return;
      }
      const outcome = summarizePipelineOutcome(result.state!);
      console.log(`Run ${result.runId}: ${outcome.line}`);
      const budgetLine = formatBudgetOutcomeLine(result.state!);
      if (budgetLine) console.log(budgetLine);
      process.exitCode = outcome.exitCode;
    });
    if (done === undefined) return; // aborted while waiting for lock
  });

program
  .command("approve")
  .description("Approve a stage that is waiting for human confirmation (human_gate)")
  .option("--run-id <id>", "target a specific run (defaults to latest)")
  .option("--stage <id>", "target a specific stage (defaults to the sole waiting stage)")
  .action(async (opts: { runId?: string; stage?: string }) => {
    const { runApprove } = await import("./commands/approve");
    const { summarizePipelineOutcome } = await import("./engine/engine");
    const { formatBudgetOutcomeLine } = await import("./commands/budget-outcome");
    const done = await withRunLock(process.cwd(), opts.runId ?? "pending-approve", async (lock, controller) => {
      const result = await runApprove(process.cwd(), opts, undefined, controller.signal);
      if (result.status !== "resumed") {
        console.error(result.message ?? result.status);
        process.exitCode = 1;
        return;
      }
      const outcome = summarizePipelineOutcome(result.state!);
      console.log(`Run ${result.runId}: ${outcome.line}`);
      const budgetLine = formatBudgetOutcomeLine(result.state!);
      if (budgetLine) console.log(budgetLine);
      process.exitCode = outcome.exitCode;
    });
    if (done === undefined) return; // aborted while waiting for lock
  });

program
  .command("reject")
  .description("Reject a stage that is waiting for human confirmation (human_gate); aborts the pipeline")
  .option("--run-id <id>", "target a specific run (defaults to latest)")
  .option("--stage <id>", "target a specific stage (defaults to the sole waiting stage)")
  .option("--reason <text>", "reason recorded in events.jsonl")
  .action(async (opts: { runId?: string; stage?: string; reason?: string }) => {
    const { runReject } = await import("./commands/reject");
    await withRunLock(process.cwd(), opts.runId ?? "pending-reject", () => {
      const result = runReject(process.cwd(), opts);
      if (result.status !== "rejected") {
        console.error(result.message ?? result.status);
        process.exitCode = 1;
        return;
      }
      const rejectedStage = result.state!.stages.find((s) => s.status === "aborted");
      console.log(`Run ${result.runId}: stage ${rejectedStage?.id} rejected`);
      process.exitCode = 1;
    });
  });

program
  .command("abort")
  .description("Abort a run, marking active/waiting/pending stages as aborted")
  .option("--run-id <id>", "target a specific run (defaults to latest)")
  .action(async (opts: { runId?: string }) => {
    const { runAbort } = await import("./commands/abort");
    const done = await withRunLock(process.cwd(), opts.runId ?? "pending-abort", () => {
      const result = runAbort(process.cwd(), opts);
      if (result.status !== "aborted") {
        console.error(result.status === "no_runs" ? "No runs found" : "Could not abort run");
        process.exitCode = 1;
        return;
      }
      console.log(`Run ${result.runId}: aborted`);
      process.exitCode = 0;
    });
    if (done === undefined) return;
  });

program
  .command("status")
  .description("Render the current run snapshot (read-only)")
  .option("--run-id <id>", "show a specific run (defaults to latest)")
  .option("--tail <n>", "show only the last N events", (v) => Number(v), 8)
  .option("--stall-timeout <s>", "seconds since last event before a running stage is flagged stalled", (v) => Number(v), 300)
  .option("--no-color", "disable ANSI colors")
  .action(async (opts: { runId?: string; tail: number; color: boolean; stallTimeout: number }) => {
    const { runStatus } = await import("./commands/monitor");
    const code = runStatus(process.cwd(), {
      runId: opts.runId,
      tail: opts.tail,
      color: opts.color,
      stallTimeoutS: opts.stallTimeout,
    });
    process.exitCode = code;
  });

program
  .command("cost")
  .description("Report token and USD cost per stage (default: latest run)")
  .option("--run-id <id>", "show a specific run (defaults to latest)")
  .option("--all", "summarize cost across all runs", false)
  .option("--json", "output structured JSON", false)
  .option("--csv", "output CSV", false)
  .option("--no-color", "disable ANSI colors")
  .action(async (opts: { runId?: string; all: boolean; json: boolean; csv: boolean; color: boolean }) => {
    const { runCost } = await import("./commands/cost");
    const code = runCost(process.cwd(), {
      runId: opts.runId,
      all: opts.all,
      json: opts.json,
      csv: opts.csv,
      color: opts.color,
    });
    process.exitCode = code;
  });

program
  .command("runs")
  .description("List all runs (read-only): id, pipeline, status, cost, age")
  .option("--json", "output structured JSON", false)
  .option("--csv", "output CSV", false)
  .option("--no-color", "disable ANSI colors")
  .action(async (opts: { json: boolean; csv: boolean; color: boolean }) => {
    const { runRuns } = await import("./commands/runs");
    process.exitCode = runRuns(process.cwd(), { json: opts.json, csv: opts.csv, color: opts.color });
  });

program
  .command("clean")
  .description("Delete terminal run directories (active runs are never deleted)")
  .option("--before <when>", "delete runs older than this (\"<N>d\" or an ISO date)")
  .option("--status <status>", "only delete runs with this terminal status (done|failed|aborted)")
  .option("--keep <n>", "keep the newest N matching runs", (v) => Number(v))
  .option("--dry-run", "show what would be deleted without deleting", false)
  .option("--yes", "skip the confirmation prompt", false)
  .option("--worktrees", "remove stale aiflow worktrees", false)
  .action(async (opts: { before?: string; status?: string; keep?: number; dryRun: boolean; yes: boolean; worktrees: boolean }) => {
    const { runClean, cleanWorktrees } = await import("./commands/clean");
    let code = 0;
    if (opts.worktrees) {
      code = await cleanWorktrees(process.cwd(), { dryRun: opts.dryRun });
      if (code !== 0) {
        process.exitCode = code;
        return;
      }
    }
    if (opts.before || opts.status || opts.keep) {
      const confirm = process.stdin.isTTY
        ? () => {
            const answer = prompt("Delete these runs? (y/N)");
            return answer?.trim().toLowerCase() === "y";
          }
        : undefined;
      const runCode = runClean(process.cwd(), {
        before: opts.before,
        status: opts.status,
        keep: opts.keep,
        dryRun: opts.dryRun,
        yes: opts.yes,
        confirm: opts.yes ? undefined : confirm,
      });
      if (runCode !== 0) code = runCode;
    }
    if (!opts.worktrees && !opts.before && !opts.status && !opts.keep) {
      process.stderr.write("clean requires at least one of --before, --status, --keep, --worktrees\n");
      code = 1;
    }
    process.exitCode = code;
  });

program
  .command("watch")
  .description("Poll and re-render the current run snapshot every second")
  .option("--run-id <id>", "show a specific run (defaults to latest)")
  .option("--tail <n>", "show only the last N events", (v) => Number(v), 8)
  .option("--interval <ms>", "polling interval in ms", (v) => Number(v), 1000)
  .option("--stall-timeout <s>", "seconds since last event before a running stage is flagged stalled", (v) => Number(v), 300)
  .option("--no-color", "disable ANSI colors")
  .action(async (opts: { runId?: string; tail: number; interval: number; stallTimeout: number; color: boolean }) => {
    const { watchRun, readRunSnapshot } = await import("./commands/monitor");
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);
    try {
      await watchRun(process.cwd(), {
        tail: opts.tail,
        intervalMs: opts.interval,
        stallTimeoutS: opts.stallTimeout,
        color: opts.color,
        signal: controller.signal,
        readSnapshot: opts.runId
          ? (cwd) => readRunSnapshot(cwd, opts.runId)
          : undefined,
      });
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  });

program.parseAsync(process.argv);
