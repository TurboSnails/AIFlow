import { $ } from "bun";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";

export interface GitResult {
  exitCode: number;
  stdout: string;
}

export interface WorktreeContext {
  originalCwd: string;
  worktreePath: string;
  branch: string;
}

export interface WorktreeEntry {
  path: string;
  branch: string;
}

export interface WorktreeManagerDeps {
  runGit: (cwd: string, args: string[]) => Promise<GitResult>;
  listWorktrees: (cwd: string) => Promise<WorktreeEntry[]>;
  now: () => number;
  statMtime: (path: string) => number | undefined;
}

const defaultRunGit = async (cwd: string, args: string[]): Promise<GitResult> => {
  const result = await $`git -C ${cwd} ${args}`.nothrow().quiet();
  return { exitCode: result.exitCode, stdout: result.stdout.toString("utf-8") };
};

async function defaultListWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const out = await $`git -C ${cwd} worktree list --porcelain`.text();
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) entries.push(current as WorktreeEntry);
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  if (current.path) entries.push(current as WorktreeEntry);
  return entries;
}

const defaultStatMtime = (path: string): number | undefined => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
};

const defaultDeps: WorktreeManagerDeps = {
  runGit: defaultRunGit,
  listWorktrees: defaultListWorktrees,
  now: () => Date.now(),
  statMtime: defaultStatMtime,
};

export async function createWorktree(
  cwd: string,
  runId: string,
  deps: WorktreeManagerDeps = defaultDeps,
): Promise<WorktreeContext> {
  const repoName = basename(cwd);
  const worktreePath = resolve(cwd, "..", `${repoName}-aiflow-${runId}`);
  const branch = `aiflow/${runId}`;
  const result = await deps.runGit(cwd, ["worktree", "add", worktreePath, "-b", branch]);
  if (result.exitCode !== 0) {
    throw new Error(`git worktree add failed: ${result.stdout}`);
  }
  return { originalCwd: cwd, worktreePath, branch };
}

export async function commitStory(
  ctx: WorktreeContext,
  storyId: string,
  title: string,
  deps: WorktreeManagerDeps = defaultDeps,
): Promise<void> {
  const { exitCode: stageCode, stdout: stageOut } = await deps.runGit(ctx.worktreePath, ["add", "-A"]);
  if (stageCode !== 0) {
    throw new Error(`git add failed: ${stageOut}`);
  }
  const { exitCode: commitCode, stdout: commitOut } = await deps.runGit(ctx.worktreePath, [
    "commit",
    "-q",
    "-m",
    `feat(${storyId}): ${title}`,
  ]);
  if (commitCode !== 0) {
    throw new Error(`git commit failed: ${commitOut}`);
  }
}

export async function tryMergeBack(
  ctx: WorktreeContext,
  autonomy: string,
  deps: WorktreeManagerDeps = defaultDeps,
): Promise<"merged" | "conflict" | "skipped"> {
  if (autonomy === "full") return "skipped";
  const { exitCode } = await deps.runGit(ctx.originalCwd, ["merge", "--no-ff", ctx.branch]);
  return exitCode === 0 ? "merged" : "conflict";
}

export async function resolveConflict(
  ctx: WorktreeContext,
  deps: WorktreeManagerDeps = defaultDeps,
): Promise<"aborted" | "failed"> {
  const { exitCode } = await deps.runGit(ctx.originalCwd, ["merge", "--abort"]);
  return exitCode === 0 ? "aborted" : "failed";
}

export async function removeWorktree(
  ctx: WorktreeContext,
  deps: WorktreeManagerDeps = defaultDeps,
): Promise<void> {
  await deps.runGit(ctx.originalCwd, ["worktree", "remove", ctx.worktreePath]);
  await deps.runGit(ctx.originalCwd, ["branch", "-D", ctx.branch]);
}

export async function listStaleWorktrees(
  cwd: string,
  maxAgeMs: number,
  deps: WorktreeManagerDeps = defaultDeps,
): Promise<WorktreeEntry[]> {
  const entries = await deps.listWorktrees(cwd);
  const now = deps.now();
  return entries.filter((entry) => {
    if (!entry.branch?.startsWith("aiflow/")) return false;
    const mtime = deps.statMtime(entry.path);
    if (mtime == null) return false;
    return now - mtime > maxAgeMs;
  });
}
