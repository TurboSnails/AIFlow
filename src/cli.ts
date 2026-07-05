#!/usr/bin/env bun
import { Command } from "commander";

const program = new Command();
program.name("aiflow").description("AIFlow pipeline orchestrator CLI").version("0.1.0");

program
  .command("doctor")
  .description("Check environment: OpenCode, reviewer API key, git status")
  .action(async () => {
    console.log("doctor: not implemented yet");
  });

program
  .command("init")
  .description("Generate .aiflow/ config scaffold in the current directory")
  .action(async () => {
    console.log("init: not implemented yet");
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
