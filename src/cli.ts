#!/usr/bin/env bun
import { Command } from "commander";

const program = new Command();
program.name("aiflow").description("AIFlow pipeline orchestrator CLI").version("0.1.0");

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
    const { summarizePipelineOutcome } = await import("./engine/engine");
    try {
      const state = await runCommand(process.cwd(), opts.pipeline, {}, {
        requirement: opts.requirement,
        requirementFile: opts.requirementFile,
      });
      const outcome = summarizePipelineOutcome(state);
      console.log(outcome.line);
      process.exitCode = outcome.exitCode;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command("resume")
  .description("Resume an in-flight or previously-aborted run (reads state.json)")
  .option("--run-id <id>", "resume a specific run (defaults to latest)")
  .option("--pipeline <name>", "override the pipeline name read from state.json")
  .option("--force", "re-execute stages that already reached a terminal state", false)
  .action(async (opts: { runId?: string; pipeline?: string; force: boolean }) => {
    const { runResume } = await import("./commands/resume");
    const result = await runResume(process.cwd(), {
      runId: opts.runId,
      pipeline: opts.pipeline,
      force: opts.force,
    });
    if (result.status === "no_runs" || result.status === "missing_run_dir") {
      console.error(result.message ?? "");
      process.exitCode = 1;
      return;
    }
    const { summarizePipelineOutcome } = await import("./engine/engine");
    const outcome = summarizePipelineOutcome(result.state!);
    console.log(`Run ${result.runId}: ${outcome.line}`);
    process.exitCode = outcome.exitCode;
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
  .command("watch")
  .description("Poll and re-render the current run snapshot every second")
  .option("--run-id <id>", "show a specific run (defaults to latest)")
  .option("--tail <n>", "show only the last N events", (v) => Number(v), 8)
  .option("--interval <ms>", "polling interval in ms", (v) => Number(v), 1000)
  .action(async (opts: { runId?: string; tail: number; interval: number }) => {
    const { watchRun, readRunSnapshot } = await import("./commands/monitor");
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);
    try {
      await watchRun(process.cwd(), {
        tail: opts.tail,
        intervalMs: opts.interval,
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
