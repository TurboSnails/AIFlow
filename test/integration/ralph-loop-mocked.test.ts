import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { runCommand } from "../../src/commands/run";

const FIXTURE_SOURCE = join(process.cwd(), "fixtures", "sample-project");

async function copyFixture(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-run-integration-"));
  cpSync(FIXTURE_SOURCE, dir, { recursive: true, filter: (src) => !src.includes(`${FIXTURE_SOURCE}/.git`) });
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} config user.email "test@example.com"`;
  await $`git -C ${dir} config user.name "Test"`;
  await $`git -C ${dir} add -A`;
  await $`git -C ${dir} commit -q -m "initial"`;
  return dir;
}

test(
  "run command: checks fail on the initial broken fixture, loop retries until stall_limit, story stays unpassed",
  async () => {
    const dir = await copyFixture();
    try {
      const fakeAgent = mock(async () => ({
        ok: true,
        transcriptPath: "unused",
        usage: { inTok: 1, outTok: 1, costUsd: 0 },
      }));
      const state = await runCommand(dir, "ralph-only", { runAgentTask: fakeAgent });
      expect(state.stages[0].status).toBe("suspended");
      expect(state.stages[0].reason).toBe("stall");
      expect(state.cost).toEqual({ input_tokens: 3, output_tokens: 3, est_usd: 0 });
      const prd = JSON.parse(readFileSync(join(dir, "prd.json"), "utf-8"));
      expect(prd.stories[0].passes).toBe(false);
      expect(prd.stories[0].fixCount).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20000
);

test("run command: checks pass and AI review passes when the fix is applied and review is mocked to approve", async () => {
  const dir = await copyFixture();
  try {
    writeFileSync(
      join(dir, "src", "math.ts"),
      `export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`
    );
    const fakeAgent = mock(async () => ({
      ok: true,
      transcriptPath: "unused",
      usage: { inTok: 1, outTok: 1, costUsd: 0 },
    }));
    const fakeReviewer = mock(async () => ({ data: { summary: "looks good", issues: [] }, usage: { inTok: 0, outTok: 0, costUsd: 0 } }));
    const state = await runCommand(dir, "ralph-only", { runAgentTask: fakeAgent, callReviewer: fakeReviewer });
    expect(state.stages[0].status).toBe("done");
    const prd = JSON.parse(readFileSync(join(dir, "prd.json"), "utf-8"));
    expect(prd.stories[0].passes).toBe(true);
    const log = await $`git -C ${dir} log -1 --pretty=%s`.text();
    expect(log.trim()).toContain("US-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "run command: checks pass but AI review returns a blocker every time, loop retries until stall_limit, story stays unpassed",
  async () => {
    const dir = await copyFixture();
    try {
      writeFileSync(
        join(dir, "src", "math.ts"),
        `export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`
      );
      const fakeAgent = mock(async () => ({
        ok: true,
        transcriptPath: "unused",
        usage: { inTok: 1, outTok: 1, costUsd: 0 },
      }));
      const fakeReviewer = mock(async () => ({
        data: {
          summary: "missing input validation",
          issues: [{ severity: "blocker", file: "src/math.ts", line: 1, title: "t", detail: "d", suggestion: "s" }],
        },
        usage: { inTok: 0, outTok: 0, costUsd: 0 },
      }));
      const state = await runCommand(dir, "ralph-only", { runAgentTask: fakeAgent, callReviewer: fakeReviewer });
      expect(state.stages[0].status).toBe("suspended");
      expect(state.stages[0].reason).toBe("stall");
      const prd = JSON.parse(readFileSync(join(dir, "prd.json"), "utf-8"));
      expect(prd.stories[0].passes).toBe(false);
      expect(prd.stories[0].fixCount).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20000
);
