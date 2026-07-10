import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { runShellStage } from "../../../src/runners/shell";
import type { ShellStageConfig } from "../../../src/config/schema";

describe("runShellStage", () => {
  test("returns pass for a successful command", async () => {
    const stage: ShellStageConfig = {
      id: "build",
      type: "shell",
      command: "echo hello",
      on_failure: "fail",
    };
    const outcome = await runShellStage(stage, { id: "build", status: "running" }, {}, tmpdir(), tmpdir(), () => new Date(), undefined);
    expect(outcome.result).toBe("pass");
  });

  test("returns fail for a non-zero exit code", async () => {
    const stage: ShellStageConfig = {
      id: "build",
      type: "shell",
      command: "exit 1",
      on_failure: "fail",
    };
    const outcome = await runShellStage(stage, { id: "build", status: "running" }, {}, tmpdir(), tmpdir(), () => new Date(), undefined);
    expect(outcome.result).toBe("fail");
  });

  test("treats non-zero exit as pass when on_failure is continue", async () => {
    const stage: ShellStageConfig = {
      id: "build",
      type: "shell",
      command: "exit 1",
      on_failure: "continue",
    };
    const outcome = await runShellStage(stage, { id: "build", status: "running" }, {}, tmpdir(), tmpdir(), () => new Date(), undefined);
    expect(outcome.result).toBe("pass");
  });

  test("throws when started with an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const stage: ShellStageConfig = {
      id: "build",
      type: "shell",
      command: "echo hello",
      on_failure: "fail",
    };
    await expect(
      runShellStage(stage, { id: "build", status: "running" }, {}, tmpdir(), tmpdir(), () => new Date(), controller.signal)
    ).rejects.toThrow("signal aborted before shell stage started");
  });
});
