import { test, expect, describe } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runResume } from "../../src/commands/resume";
import {
  createWorktree,
  commitStory,
  tryMergeBack,
  resolveConflict,
  resolveConflictWithAI,
  generateMergeGuide,
  removeWorktree,
  listStaleWorktrees,
  parsePorcelainWorktrees,
  type WorktreeManagerDeps,
  type GitResult,
  type WorktreeEntry,
} from "../../src/worktree/manager";

function makeDeps(
  overrides: Partial<WorktreeManagerDeps> = {},
): { deps: WorktreeManagerDeps; calls: Array<{ cwd: string; args: string[] }> } {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const deps: WorktreeManagerDeps = {
    runGit: async (cwd: string, args: string[]): Promise<GitResult> => {
      calls.push({ cwd, args });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    listWorktrees: async () => [],
    now: () => 1_000_000,
    statMtime: () => undefined,
    ...overrides,
  };
  return { deps, calls };
}

describe("createWorktree", () => {
  test("computes worktree path and branch", async () => {
    const { deps, calls } = makeDeps();
    const ctx = await createWorktree("/repo", "20260710_abc123", deps);

    expect(ctx.branch).toBe("aiflow/20260710_abc123");
    expect(ctx.worktreePath).toContain("repo-aiflow-20260710_abc123");
    expect(ctx.originalCwd).toBe("/repo");
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe("/repo");
    expect(calls[0].args).toEqual(["worktree", "add", ctx.worktreePath, "-b", ctx.branch]);
  });

  test("throws when git worktree add fails", async () => {
    const { deps } = makeDeps({
      runGit: async () => ({ exitCode: 1, stdout: "fatal", stderr: "worktree already exists" }),
    });
    await expect(createWorktree("/repo", "20260710_abc123", deps)).rejects.toThrow("git worktree add failed");
  });
});

describe("commitStory", () => {
  test("stages all changes and commits with story prefix", async () => {
    const { deps, calls } = makeDeps();
    const ctx = { originalCwd: "/repo", worktreePath: "/repo-aiflow-20260710_abc123", branch: "aiflow/20260710_abc123" };

    await commitStory(ctx, "story-1", "add widget", deps);

    expect(calls).toHaveLength(2);
    expect(calls[0].cwd).toBe(ctx.worktreePath);
    expect(calls[0].args).toEqual(["add", "-A"]);
    expect(calls[1].cwd).toBe(ctx.worktreePath);
    expect(calls[1].args).toEqual(["commit", "-q", "-m", "feat(story-1): add widget"]);
  });
});

describe("tryMergeBack", () => {
  test("skips merge when autonomy is full", async () => {
    const { deps, calls } = makeDeps();
    const ctx = { originalCwd: "/repo", worktreePath: "/repo-aiflow-20260710_abc123", branch: "aiflow/20260710_abc123" };

    const result = await tryMergeBack(ctx, "full", deps);

    expect(result).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  test("returns merged when merge succeeds", async () => {
    const { deps, calls } = makeDeps();
    const ctx = { originalCwd: "/repo", worktreePath: "/repo-aiflow-20260710_abc123", branch: "aiflow/20260710_abc123" };

    const result = await tryMergeBack(ctx, "gated", 50, deps);

    expect(result).toBe("merged");
    expect(calls).toHaveLength(3);
    expect(calls[0].args).toEqual(["merge-base", "HEAD", ctx.branch]);
    expect(calls[1].args).toEqual(["diff", "--name-only", expect.stringContaining("..")]);
    expect(calls[2].args).toEqual(["merge", "--no-ff", ctx.branch]);
  });

  test("returns conflict when merge fails", async () => {
    const { deps } = makeDeps({
      runGit: async (cwd, args) => {
        if (args[0] === "merge-base") return { exitCode: 0, stdout: "base123\n", stderr: "" };
        if (args[0] === "diff" && args[1] === "--name-only") return { exitCode: 0, stdout: "\n", stderr: "" };
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    });
    const ctx = { originalCwd: "/repo", worktreePath: "/repo-aiflow-20260710_abc123", branch: "aiflow/20260710_abc123" };

    const result = await tryMergeBack(ctx, "gated", 50, deps);

    expect(result).toBe("conflict");
  });

  test("returns drift when main branch has changed more than maxDriftFiles since merge base", async () => {
    const { deps, calls } = makeDeps();
    const ctx = { originalCwd: "/repo", worktreePath: "/repo-aiflow-20260710_abc123", branch: "aiflow/20260710_abc123" };
    deps.runGit = async (cwd, args) => {
      calls.push({ cwd, args });
      if (args[0] === "merge-base") {
        return { exitCode: 0, stdout: "base123\n", stderr: "" };
      }
      if (args[0] === "diff" && args[1] === "--name-only") {
        const files = Array.from({ length: 51 }, (_, i) => `file-${i}.txt`).join("\n");
        return { exitCode: 0, stdout: `${files}\n`, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "" };
    };

    const result = await tryMergeBack(ctx, "gated", 50, deps);

    expect(result).toBe("drift");
    expect(calls.some((c) => c.args[0] === "merge")).toBe(false);
  });

  test("attempts merge when drift is within maxDriftFiles", async () => {
    const { deps, calls } = makeDeps();
    const ctx = { originalCwd: "/repo", worktreePath: "/repo-aiflow-20260710_abc123", branch: "aiflow/20260710_abc123" };
    deps.runGit = async (cwd, args) => {
      calls.push({ cwd, args });
      if (args[0] === "merge-base") return { exitCode: 0, stdout: "base123\n", stderr: "" };
      if (args[0] === "diff" && args[1] === "--name-only") {
        return { exitCode: 0, stdout: "a.txt\nb.txt\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await tryMergeBack(ctx, "gated", 50, deps);

    expect(result).toBe("merged");
    expect(calls.some((c) => c.args[0] === "merge" && c.args[1] === "--no-ff")).toBe(true);
  });
});

describe("resolveConflict", () => {
  test("aborts the merge", async () => {
    const { deps, calls } = makeDeps();
    const ctx = { originalCwd: "/repo", worktreePath: "/repo-aiflow-20260710_abc123", branch: "aiflow/20260710_abc123" };

    const result = await resolveConflict(ctx, deps);

    expect(result).toBe("aborted");
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe("/repo");
    expect(calls[0].args).toEqual(["merge", "--abort"]);
  });

  test("returns failed when abort fails", async () => {
    const { deps } = makeDeps({
      runGit: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    });
    const ctx = { originalCwd: "/repo", worktreePath: "/repo-aiflow-20260710_abc123", branch: "aiflow/20260710_abc123" };

    const result = await resolveConflict(ctx, deps);

    expect(result).toBe("failed");
  });
});

describe("removeWorktree", () => {
  test("removes worktree and branch and returns true", async () => {
    const { deps, calls } = makeDeps();
    const ctx = { originalCwd: "/repo", worktreePath: "/repo-aiflow-20260710_abc123", branch: "aiflow/20260710_abc123" };

    const result = await removeWorktree(ctx, deps);

    expect(result).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(["worktree", "remove", ctx.worktreePath]);
    expect(calls[1].args).toEqual(["branch", "-D", ctx.branch]);
  });

  test("returns false when git commands fail", async () => {
    const { deps } = makeDeps({
      runGit: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    });
    const ctx = { originalCwd: "/repo", worktreePath: "/repo-aiflow-20260710_abc123", branch: "aiflow/20260710_abc123" };

    const result = await removeWorktree(ctx, deps);

    expect(result).toBe(false);
  });
});

describe("listStaleWorktrees", () => {
  test("returns aiflow worktrees older than maxAgeMs", async () => {
    const { deps } = makeDeps({
      listWorktrees: async () => [
        { path: "/repo-aiflow-old", branch: "aiflow/20260709_old" },
        { path: "/repo-aiflow-fresh", branch: "aiflow/20260710_fresh" },
        { path: "/other-worktree", branch: "feature/other" },
      ],
      now: () => 1_000_000,
      statMtime: (path: string) => {
        if (path === "/repo-aiflow-old") return 0;
        if (path === "/repo-aiflow-fresh") return 999_999;
        return undefined;
      },
    });

    const stale = await listStaleWorktrees("/repo", 500_000, deps);

    expect(stale.map((s) => s.path)).toEqual(["/repo-aiflow-old"]);
  });

  test("excludes aiflow worktrees newer than maxAgeMs", async () => {
    const { deps } = makeDeps({
      listWorktrees: async () => [{ path: "/repo-aiflow-fresh", branch: "aiflow/20260710_fresh" }],
      now: () => 1_000_000,
      statMtime: () => 999_999,
    });

    const stale = await listStaleWorktrees("/repo", 500_000, deps);

    expect(stale).toHaveLength(0);
  });
});

describe("parsePorcelainWorktrees", () => {
  test("parses git worktree list --porcelain output", () => {
    const porcelain = [
      "worktree /path/to/main",
      "branch refs/heads/main",
      "HEAD abc123",
      "",
      "worktree /path/to/branch1",
      "branch refs/heads/aiflow/run-1",
      "HEAD def456",
      "",
      "worktree /path/to/another-worktree",
      "branch refs/heads/feature/xyz",
      "",
    ].join("\n");

    const entries = parsePorcelainWorktrees(porcelain);

    expect(entries).toEqual([
      { path: "/path/to/main", branch: "main" },
      { path: "/path/to/branch1", branch: "aiflow/run-1" },
      { path: "/path/to/another-worktree", branch: "feature/xyz" },
    ]);
  });
});


describe("tryMergeBack git error handling", () => {
  test("returns error when merge-base fails", async () => {
    const { deps } = makeDeps({
      runGit: async () => ({ exitCode: 1, stdout: "", stderr: "fatal: Not a valid object name" }),
    });
    const ctx = { originalCwd: "/repo", worktreePath: "/repo-aiflow-20260710_abc123", branch: "aiflow/20260710_abc123" };

    const result = await tryMergeBack(ctx, "gated", 50, deps);

    expect(result).toBe("error");
  });

  test("returns error when diff --name-only fails", async () => {
    const { deps } = makeDeps();
    deps.runGit = async (cwd, args) => {
      if (args[0] === "merge-base") return { exitCode: 0, stdout: "base123\n", stderr: "" };
      if (args[0] === "diff" && args[1] === "--name-only") return { exitCode: 1, stdout: "", stderr: "diff failed" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const ctx = { originalCwd: "/repo", worktreePath: "/repo-aiflow-20260710_abc123", branch: "aiflow/20260710_abc123" };

    const result = await tryMergeBack(ctx, "gated", 50, deps);

    expect(result).toBe("error");
  });
});

describe("resume worktree re-entry", () => {
  test("resume uses worktree path from state.json", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "aiflow-resume-worktree-cwd-"));
    try {
      mkdirSync(join(cwd, ".aiflow", "config", "pipelines"), { recursive: true });
      writeFileSync(
        join(cwd, ".aiflow", "config", "models.yaml"),
        "profiles:\n  main-dev:\n    channel: http\n    provider: x\n    model: y\n    base_url: http://localhost\n    api_key_env: API_KEY\n"
      );
      writeFileSync(
        join(cwd, ".aiflow", "config", "pipelines", "test.yaml"),
        "name: test\nstages:\n  - id: step\n    type: shell\n    command: echo ok\n"
      );

      const runId = "20260710_120000_test01";
      const runDir = join(cwd, ".aiflow", "runs", runId);
      mkdirSync(runDir, { recursive: true });
      const worktreePath = mkdtempSync(join(tmpdir(), "aiflow-resume-worktree-path-"));
      writeFileSync(
        join(runDir, "state.json"),
        JSON.stringify({
          run_id: runId,
          pipeline: "test",
          worktree: { path: worktreePath },
          stages: [{ id: "step", status: "pending" }],
          cost: { input_tokens: 0, output_tokens: 0, est_usd: 0 },
        })
      );

      let recordedCwd: string | undefined;
      const result = await runResume(cwd, { runId }, {
        runners: {
          shell: async (_stageConfig, _stageState, _profiles, stageCwd) => {
            recordedCwd = stageCwd;
            return { result: "pass", usage: { inTok: 0, outTok: 0, costUsd: 0 } };
          },
        },
      });

      expect(result.status).toBe("resumed");
      expect(recordedCwd).toBe(worktreePath);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("resolveConflictWithAI", () => {
  test("writes AI-resolved files, stages, commits, and returns resolved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiflow-conflict-resolve-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "a.ts"), "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch\n");
      const recorded: Array<{ cwd: string; args: string[] }> = [];
      const deps = {
        runGit: async (cwd: string, args: string[]) => {
          recorded.push({ cwd, args });
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        diffConflictFileNames: async () => ["src/a.ts"],
        callLlm: async () => ({
          text: JSON.stringify({ files: [{ path: "src/a.ts", content: "resolved" }] }),
          usage: { inTok: 0, outTok: 0, costUsd: 0 },
        }),
      };
      const ctx = { originalCwd: dir, worktreePath: dir, branch: "aiflow/run", baseCwd: dir };
      const profile = {
        channel: "http" as const,
        provider: "x",
        model: "y",
        base_url: "http://localhost",
        api_key_env: "API_KEY",
      };
      const result = await resolveConflictWithAI(ctx, profile, "gated", join(dir, "run"), deps);
      expect(result).toBe("resolved");
      expect(recorded.some((c) => c.args[0] === "add" && c.args[1] === "src/a.ts")).toBe(true);
      expect(recorded.some((c) => c.args[0] === "commit" && c.args.includes("aiflow: resolve conflicts via main-dev"))).toBe(true);
      expect(readFileSync(join(dir, "src", "a.ts"), "utf-8")).toBe("resolved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns escalated when AI resolution fails for non-full autonomy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiflow-conflict-escalate-"));
    try {
      writeFileSync(join(dir, "a.txt"), "conflict");
      const deps = {
        runGit: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        diffConflictFileNames: async () => ["a.txt"],
        callLlm: async () => ({ text: "not json", usage: { inTok: 0, outTok: 0, costUsd: 0 } }),
      };
      const ctx = { originalCwd: dir, worktreePath: dir, branch: "aiflow/run", baseCwd: dir };
      const profile = {
        channel: "http" as const,
        provider: "x",
        model: "y",
        base_url: "http://localhost",
        api_key_env: "API_KEY",
      };
      const result = await resolveConflictWithAI(ctx, profile, "gated", join(dir, "run"), deps);
      expect(result).toBe("escalated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns aborted when AI resolution fails for full autonomy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiflow-conflict-abort-"));
    try {
      writeFileSync(join(dir, "a.txt"), "conflict");
      const deps = {
        runGit: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        diffConflictFileNames: async () => ["a.txt"],
        callLlm: async () => {
          throw new Error("LLM unavailable");
        },
      };
      const ctx = { originalCwd: dir, worktreePath: dir, branch: "aiflow/run", baseCwd: dir };
      const profile = {
        channel: "http" as const,
        provider: "x",
        model: "y",
        base_url: "http://localhost",
        api_key_env: "API_KEY",
      };
      const result = await resolveConflictWithAI(ctx, profile, "full", join(dir, "run"), deps);
      expect(result).toBe("aborted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("generateMergeGuide", () => {
  test("writes merge guide with base cwd and branch", () => {
    const runDir = mkdtempSync(join(tmpdir(), "aiflow-merge-guide-"));
    try {
      const ctx = {
        originalCwd: "/base",
        worktreePath: "/wt",
        branch: "aiflow/run",
        baseCwd: "/base",
      };
      generateMergeGuide(ctx, runDir);
      const content = readFileSync(join(runDir, "artifacts", "merge-guide.md"), "utf-8");
      expect(content).toContain("cd /base");
      expect(content).toContain("git merge aiflow/run");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
