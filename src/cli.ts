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
  .action(async (opts: { pipeline: string; once: boolean }) => {
    const { runCommand } = await import("./commands/run");
    const state = await runCommand(process.cwd(), opts.pipeline);
    console.log(`Stage ${state.stages[0].id}: ${state.stages[0].status}`);
    process.exitCode = state.stages[0].status === "done" ? 0 : 1;
  });

program
  .command("status")
  .description("Render the current run snapshot (read-only)")
  .option("--run-id <id>", "show a specific run (defaults to latest)")
  .option("--tail <n>", "show only the last N events", (v) => Number(v), 8)
  .option("--no-color", "disable ANSI colors")
  .action(async (opts: { runId?: string; tail: number; color: boolean }) => {
    const { runStatus } = await import("./commands/monitor");
    const code = runStatus(process.cwd(), {
      runId: opts.runId,
      tail: opts.tail,
      color: opts.color,
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
