import { test, expect, describe } from "bun:test";
import {
  createWorktree,
  commitStory,
  tryMergeBack,
  resolveConflict,
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
