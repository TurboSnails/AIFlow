import { $ } from "bun";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, relative } from "node:path";
import { callLlm } from "../llm/client";
import type { ModelProfile } from "../config/schema";
import { diffConflictFileNames as realDiffConflictFileNames } from "../git";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WorktreeContext {
  originalCwd: string;
  worktreePath: string;
  branch: string;
  worktreeCwd?: string;
  baseCwd?: string;
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

export interface ResolveConflictDeps extends WorktreeManagerDeps {
  callLlm: typeof callLlm;
  diffConflictFileNames: (cwd: string) => Promise<string[]>;
  maxRetrySteps?: number;
  maxTokenCost?: number;
}

const defaultRunGit = async (cwd: string, args: string[]): Promise<GitResult> => {
  const result = await $`git -C ${cwd} ${args}`.nothrow().quiet();
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf-8"),
    stderr: result.stderr.toString("utf-8"),
  };
};

function parsePorcelainWorktrees(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  for (const line of output.split("\n")) {
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

async function defaultListWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const out = await $`git -C ${cwd} worktree list --porcelain`.text();
  return parsePorcelainWorktrees(out);
}

export { parsePorcelainWorktrees };

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

const defaultResolveDeps: ResolveConflictDeps = {
  ...defaultDeps,
  callLlm,
  diffConflictFileNames: realDiffConflictFileNames,
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
    throw new Error(`git worktree add failed: ${result.stdout} ${result.stderr}`);
  }
  return { originalCwd: cwd, worktreePath, branch, worktreeCwd: worktreePath, baseCwd: cwd };
}

export async function commitStory(
  ctx: WorktreeContext,
  storyId: string,
  title: string,
  deps: WorktreeManagerDeps = defaultDeps,
): Promise<void> {
  const { exitCode: stageCode, stdout: stageOut, stderr: stageErr } = await deps.runGit(ctx.worktreePath, ["add", "-A"]);
  if (stageCode !== 0) {
    throw new Error(`git add failed: ${stageOut} ${stageErr}`);
  }
  const { exitCode: commitCode, stdout: commitOut, stderr: commitErr } = await deps.runGit(ctx.worktreePath, [
    "commit",
    "-q",
    "-m",
    `feat(${storyId}): ${title}`,
  ]);
  if (commitCode !== 0) {
    throw new Error(`git commit failed: ${commitOut} ${commitErr}`);
  }
}

export async function tryMergeBack(
  ctx: WorktreeContext,
  autonomy: string,
  maxDriftFiles: number = 50,
  deps: WorktreeManagerDeps = defaultDeps,
): Promise<"merged" | "conflict" | "skipped" | "drift" | "error"> {
  if (autonomy === "full") return "skipped";
  const mergeBase = await deps.runGit(ctx.originalCwd, ["merge-base", "HEAD", ctx.branch]);
  if (mergeBase.exitCode !== 0) {
    return "error";
  }
  const base = mergeBase.stdout.trim();
  const driftDiff = await deps.runGit(ctx.originalCwd, ["diff", "--name-only", `${base}..HEAD`]);
  if (driftDiff.exitCode !== 0) {
    return "error";
  }
  const driftFiles = driftDiff.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (driftFiles.length > maxDriftFiles) {
    return "drift";
  }
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

class ConflictResolutionValidationError extends Error {}

export async function resolveConflictWithAI(
  ctx: WorktreeContext,
  mainDevProfile: ModelProfile,
  autonomy: string,
  deps: Partial<ResolveConflictDeps> = defaultResolveDeps
): Promise<"resolved" | "aborted" | "escalated"> {
  const d = { ...defaultResolveDeps, ...deps };
  const baseCwd = ctx.baseCwd ?? ctx.originalCwd;
  try {
    const conflictFiles = await d.diffConflictFileNames(baseCwd);
    const prompt = `Resolve these git conflicts. Return the resolved content for each file as JSON: { "files": [{ "path": "...", "content": "..." }] }.\n${conflictFiles.map((f) => readFileSync(join(baseCwd, f), "utf-8")).join("\n---\n")}`;
    const result = await d.callLlm({
      profile: mainDevProfile,
      prompt,
      jsonMode: true,
      maxRetrySteps: d.maxRetrySteps,
      maxTokenCost: d.maxTokenCost,
    });
    let data: { files: Array<{ path: string; content: string }> };
    try {
      data = JSON.parse(result.text);
    } catch {
      throw new ConflictResolutionValidationError("AI conflict resolution response is not valid JSON");
    }
    if (!Array.isArray(data.files)) {
      throw new ConflictResolutionValidationError("AI conflict resolution response missing files array");
    }
    const conflictSet = new Set(conflictFiles);
    const resolvedPaths = new Set<string>();
    for (const f of data.files) {
      if (typeof f.path !== "string" || typeof f.content !== "string") {
        throw new ConflictResolutionValidationError("AI conflict resolution file entry missing path or content");
      }
      const resolvedPath = resolve(baseCwd, f.path);
      const relativeToBase = relative(baseCwd, resolvedPath);
      if (relativeToBase.startsWith("..") || relativeToBase === "") {
        throw new ConflictResolutionValidationError(`AI conflict resolution path outside baseCwd: ${f.path}`);
      }
      if (!conflictSet.has(f.path)) {
        throw new ConflictResolutionValidationError(`AI conflict resolution path not in conflict files: ${f.path}`);
      }
      resolvedPaths.add(f.path);
    }
    if (resolvedPaths.size !== conflictFiles.length) {
      throw new ConflictResolutionValidationError("AI conflict resolution missing files");
    }
    for (const f of data.files) {
      writeFileSync(join(baseCwd, f.path), f.content);
      await d.runGit(baseCwd, ["add", f.path]);
    }
    await d.runGit(baseCwd, ["commit", "-m", "aiflow: resolve conflicts via main-dev"]);
    return "resolved";
  } catch (err) {
    await d.runGit(baseCwd, ["merge", "--abort"]);
    if (err instanceof ConflictResolutionValidationError) return "escalated";
    return autonomy === "full" ? "aborted" : "escalated";
  }
}

export function generateMergeGuide(ctx: WorktreeContext, runDir: string): void {
  const baseCwd = ctx.baseCwd ?? ctx.originalCwd;
  const guide = `Run the following to merge the AIFlow branch manually:\n\n` + `cd ${baseCwd}\n` + `git merge ${ctx.branch}\n`;
  const artifactsDir = join(runDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, "merge-guide.md"), guide);
}

export async function removeWorktree(
  ctx: WorktreeContext,
  deps: WorktreeManagerDeps = defaultDeps,
): Promise<boolean> {
  let worktreeOk = false;
  let branchOk = false;
  try {
    const result = await deps.runGit(ctx.originalCwd, ["worktree", "remove", ctx.worktreePath]);
    worktreeOk = result.exitCode === 0;
  } catch {
    // Best-effort cleanup: do not block the caller on already-removed worktrees.
  }
  try {
    const result = await deps.runGit(ctx.originalCwd, ["branch", "-D", ctx.branch]);
    branchOk = result.exitCode === 0;
  } catch {
    // Best-effort cleanup: ignore missing branches.
  }
  return worktreeOk && branchOk;
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

export async function removeStaleWorktrees(
  cwd: string,
  maxAgeMs: number = 7 * 86400_000,
  deps: WorktreeManagerDeps = defaultDeps,
): Promise<{ removed: string[]; failed: Array<{ path: string; reason: string }> }> {
  const stale = await listStaleWorktrees(cwd, maxAgeMs, deps);
  const removed: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  for (const entry of stale) {
    const { exitCode: removeCode, stderr: removeErr } = await deps.runGit(cwd, ["worktree", "remove", entry.path]);
    if (removeCode !== 0) {
      failed.push({ path: entry.path, reason: removeErr || "git worktree remove failed" });
      continue;
    }
    const { exitCode: branchCode, stderr: branchErr } = await deps.runGit(cwd, ["branch", "-D", entry.branch]);
    if (branchCode !== 0) {
      failed.push({ path: entry.path, reason: branchErr || "git branch -D failed" });
      continue;
    }
    removed.push(entry.path);
  }
  return { removed, failed };
}
