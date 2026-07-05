import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { runCommand } from "../../src/commands/run";

const FIXTURE_SOURCE = join(process.cwd(), "fixtures", "sample-project");
const hasReviewerKey = Boolean(process.env.MINIMAX_API_KEY);

async function copyFixture(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-real-e2e-"));
  cpSync(FIXTURE_SOURCE, dir, {
    recursive: true,
    filter: (src) => !src.includes(`${FIXTURE_SOURCE}/.git`),
  });
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} config user.email "test@example.com"`;
  await $`git -C ${dir} config user.name "Test"`;
  await $`git -C ${dir} add -A`;
  await $`git -C ${dir} commit -q -m "initial"`;
  return dir;
}

test.skipIf(!hasReviewerKey)(
  "real end-to-end: aiflow run against fixtures/sample-project with real OpenCode + real reviewer",
  async () => {
    const dir = await copyFixture();
    try {
      const state = await runCommand(dir, "ralph-only");

      expect(["done", "failed", "suspended"]).toContain(state.stages[0].status);

      const runsRoot = join(dir, ".aiflow", "runs");
      expect(existsSync(runsRoot)).toBe(true);
      const runDirs = readdirSync(runsRoot).filter((name) =>
        existsSync(join(runsRoot, name, "events.jsonl"))
      );
      expect(runDirs.length).toBeGreaterThan(0);

      if (state.stages[0].status === "done") {
        const prd = JSON.parse(readFileSync(join(dir, "prd.json"), "utf-8"));
        expect(prd.stories[0].passes).toBe(true);
        const log = (await $`git -C ${dir} log -1 --pretty=%s`.text()).trim();
        expect(log).toContain("US-1");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000
);
