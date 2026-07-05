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
    console.log("run: not implemented yet", opts);
  });

program.parseAsync(process.argv);
