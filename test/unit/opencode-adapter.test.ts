import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentTask, type AgentTask } from "../../src/adapters/opencode";
import { readEvents } from "../../src/events/events";

function fakeStdoutStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + "\n"));
      }
      controller.close();
    },
  });
}

function baseTask(runDir: string): AgentTask {
  return {
    profile: { channel: "opencode", provider: "opencode", model: "opencode/deepseek-v4-flash-free" },
    prompt: "do something",
    cwd: "/tmp/does-not-matter-for-this-test",
    timeoutMs: 5000,
    runDir,
    stage: "develop",
    story: "US-1",
  };
}

test("runAgentTask parses a real event stream, writes transcripts to both legacy and new paths, and reports usage", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-adapter-test-"));
  try {
    const lines = [
      '{"type":"step_start","timestamp":1,"sessionID":"s1","part":{}}',
      '{"type":"tool_use","timestamp":2,"sessionID":"s1","part":{"type":"tool","tool":"write","callID":"c1","state":{"status":"completed","input":{"filePath":"src/math.ts"},"output":"Wrote file successfully."}}}',
      '{"type":"step_finish","timestamp":3,"sessionID":"s1","part":{"type":"step-finish","reason":"stop","tokens":{"total":130,"input":110,"output":20,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0.002}}',
    ];
    const fakeSpawn = () => ({
      stdout: fakeStdoutStream(lines),
      exited: Promise.resolve(0),
      kill: () => {},
    });

    const result = await runAgentTask(baseTask(runDir), fakeSpawn);

    expect(result.ok).toBe(true);
    expect(result.usage.inTok).toBe(110);
    expect(result.usage.outTok).toBe(20);
    expect(result.usage.costUsd).toBe(0.002);
    expect(existsSync(result.transcriptPath)).toBe(true);
    expect(result.transcriptPath.startsWith(join(runDir, "transcripts"))).toBe(true);
    expect(existsSync(join(runDir, "artifacts", "opencode"))).toBe(true);

    const events = readEvents(runDir);
    const toolUseEvents = events.filter((e) => e.type === "opencode_tool_use");
    expect(toolUseEvents.length).toBe(1);
    expect((toolUseEvents[0] as any).tool).toBe("write");
    const finishEvents = events.filter((e) => e.type === "opencode_step_finish");
    expect(finishEvents.length).toBe(1);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runAgentTask returns ok:false when the subprocess exits non-zero", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-adapter-test-"));
  try {
    const fakeSpawn = () => ({
      stdout: fakeStdoutStream([]),
      exited: Promise.resolve(1),
      kill: () => {},
    });
    const result = await runAgentTask(baseTask(runDir), fakeSpawn);
    expect(result.ok).toBe(false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("runAgentTask aborts and reports ok:false when cumulative tokens exceed maxTokenCost", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aiflow-adapter-budget-"));
  try {
    let killed = false;
    let resolveExited: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExited = resolve;
    });
    const lines = [
      '{"type":"step_finish","timestamp":1,"sessionID":"s1","part":{"type":"step-finish","reason":"stop","tokens":{"total":100,"input":90,"output":10,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0.05}}',
      '{"type":"step_finish","timestamp":2,"sessionID":"s1","part":{"type":"step-finish","reason":"stop","tokens":{"total":100,"input":90,"output":10,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0.06}}',
    ];
    const fakeSpawn = () => ({
      stdout: fakeStdoutStream(lines),
      exited,
      kill: () => {
        killed = true;
        resolveExited(1);
      },
    });

    const task = { ...baseTask(runDir), maxTokenCost: 50 };
    const result = await runAgentTask(task, fakeSpawn);

    expect(killed).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("max_token_cost_exceeded");
    expect(result.usage.inTok + result.usage.outTok).toBeGreaterThan(50);

    const events = readEvents(runDir);
    const warning = events.find((e) => e.type === "budget_warning");
    expect(warning).toBeDefined();
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
