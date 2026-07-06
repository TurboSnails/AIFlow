import { test, expect, describe } from "bun:test";
import { runHumanGate, type HumanGateDeps } from "../../src/runners/human-gate";
import type { HumanGateStageConfig } from "../../src/config/schema";

const STAGE: HumanGateStageConfig = {
  id: "confirm-spec",
  type: "human_gate",
  prompt: "Continue with spec.md?",
  timeout: "none",
  default_action: "abort",
};

function stdinDeps(input: string, onStdin?: (chunk: string) => void): HumanGateDeps {
  return {
    write: () => {},
    writeErr: () => {},
    stdinFactory: () => {
      const lines = input.split("\n");
      let i = 0;
      return {
        async *[Symbol.asyncIterator]() {
          while (i < lines.length) {
            const line = lines[i++];
            if (onStdin) onStdin(line);
            yield line + "\n";
          }
        },
      } as unknown as AsyncIterable<string>;
    },
    setTimeoutFn: setTimeout,
  };
}

const CTX = { cwd: "/tmp", runDir: "/tmp/run", specExcerpt: "" };

describe("runHumanGate", () => {
  test("returns done when stdin receives 'yes'", async () => {
    const out = await runHumanGate(STAGE, CTX, stdinDeps("yes\n"));
    expect(out.outcome).toBe("done");
    expect(out.inputSeen).toBe("yes");
  });

  test("returns done for 'ok', 'y', 'continue' (case-insensitive, trimmed)", async () => {
    for (const phrase of ["y", "  YES  ", "Ok", "continue"]) {
      const out = await runHumanGate(STAGE, CTX, stdinDeps(phrase));
      expect(out.outcome).toBe("done");
    }
  });

  test("returns failed for 'no' (without timeout)", async () => {
    const out = await runHumanGate(STAGE, CTX, stdinDeps("no\n"));
    expect(out.outcome).toBe("failed");
  });

  test("applies default_action=abort when stdin does not provide an affirmative answer", async () => {
    const stage: HumanGateStageConfig = { ...STAGE, default_action: "abort" };
    const out = await runHumanGate(stage, CTX, { write: () => {}, writeErr: () => {}, stdinFactory: async function* () {} });
    expect(out.outcome).toBe("aborted");
    expect(out.reason).toContain("stdin closed");
  });

  test("applies default_action=pass when stdin closes", async () => {
    const stage: HumanGateStageConfig = { ...STAGE, default_action: "pass" };
    const out = await runHumanGate(stage, CTX, { write: () => {}, writeErr: () => {}, stdinFactory: async function* () {} });
    expect(out.outcome).toBe("done");
  });

  test("applies default_action=abort when timeout fires", async () => {
    const stage: HumanGateStageConfig = { ...STAGE, timeout: "1ms", default_action: "abort" };
    const out = await runHumanGate(stage, CTX, {
      write: () => {},
      writeErr: () => {},
      stdinFactory: async function* () {
        await new Promise((r) => setTimeout(r, 5));
      },
      setTimeoutFn: setTimeout,
    });
    expect(out.outcome).toBe("aborted");
  });

  test("writes the prompt and footer to write()", async () => {
    const lines: string[] = [];
    const errs: string[] = [];
    await runHumanGate(STAGE, CTX, {
      write: (s) => lines.push(s),
      writeErr: (s) => errs.push(s),
      stdinFactory: async function* () {
        yield "yes\n";
      },
    });
    expect(lines.join("")).toContain("Continue with spec.md?");
  });
});
