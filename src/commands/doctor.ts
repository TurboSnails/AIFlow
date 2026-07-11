import { join } from "node:path";
import { $ } from "bun";
import { callReviewer as realCallReviewer, type ReviewerCallResult } from "../llm/client";
import { loadModelsConfig as realLoadModelsConfig, loadProjectConfig as realLoadProjectConfig } from "../config/loader";
import { listStaleWorktrees as realListStaleWorktrees } from "../worktree/manager";
import type { ModelProfile, ModelsConfig, ProjectConfig } from "../config/schema";
import type { WorktreeEntry } from "../worktree/manager";

export interface Diagnosis {
  check: string;
  ok: boolean;
  message: string;
}

export interface RunDoctorDeps {
  runOpenCode: (cwd: string) => Promise<{ exitCode: number }>;
  loadModelsConfig: (path: string) => unknown;
  runGitStatus: (cwd: string) => Promise<{ exitCode: number }>;
}

const defaultRunDoctorDeps: RunDoctorDeps = {
  runOpenCode: async (cwd: string) => {
    const result = await $`opencode --version`.cwd(cwd).nothrow().quiet();
    return { exitCode: result.exitCode };
  },
  loadModelsConfig: realLoadModelsConfig,
  runGitStatus: async (cwd: string) => {
    const result = await $`git status`.cwd(cwd).nothrow().quiet();
    return { exitCode: result.exitCode };
  },
};

export async function runDoctor(cwd: string, deps: Partial<RunDoctorDeps> = {}): Promise<Diagnosis[]> {
  const d: RunDoctorDeps = { ...defaultRunDoctorDeps, ...deps };
  const results: Diagnosis[] = [];
  // OpenCode CLI
  try {
    const { exitCode } = await d.runOpenCode(cwd);
    results.push({ check: "opencode_cli", ok: exitCode === 0, message: exitCode === 0 ? "ok" : "opencode not found" });
  } catch {
    results.push({ check: "opencode_cli", ok: false, message: "opencode --version failed" });
  }
  // 模型 profile 连通性（至少能解析配置）
  const modelsPath = join(cwd, ".aiflow", "config", "models.yaml");
  try {
    d.loadModelsConfig(modelsPath);
    results.push({ check: "models_config", ok: true, message: "models.yaml parsed" });
  } catch (e) {
    results.push({ check: "models_config", ok: false, message: String(e) });
  }
  // git
  try {
    const { exitCode } = await d.runGitStatus(cwd);
    results.push({ check: "git", ok: exitCode === 0, message: exitCode === 0 ? "ok" : "not a git repo" });
  } catch {
    results.push({ check: "git", ok: false, message: "git status failed" });
  }
  return results;
}

export interface DoctorReport {
  openCodeVersion: string | null;
  gitOk: boolean;
  configOk: boolean;
  configError?: string;
  reviewerKeyPresent: boolean;
  reviewerReachable: boolean | null;
  reviewerError?: string;
  pricingWarnings: string[];
  profileStatuses: Array<{ name: string; reachable: boolean | null; error?: string }>;
  staleWorktrees: number;
}

export interface DoctorDeps {
  checkOpenCodeVersion: () => Promise<string | null>;
  checkGitRepo: (cwd: string) => Promise<boolean>;
  callReviewer: (profile: ModelProfile, prompt: string) => Promise<ReviewerCallResult>;
  loadModelsConfig: (path: string) => ModelsConfig;
  loadProjectConfig: (path: string) => ProjectConfig;
  listStaleWorktrees: (cwd: string, maxAgeMs: number) => Promise<WorktreeEntry[]>;
  env: Record<string, string | undefined>;
}

export async function checkOpenCodeVersionReal(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["opencode", "--version"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    return output.trim();
  } catch {
    return null;
  }
}

export async function checkGitRepoReal(cwd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return exitCode === 0 && output.trim() === "true";
  } catch {
    return false;
  }
}

const STALE_WORKTREE_AGE_MS = 7 * 86400_000;

const defaultDeps: DoctorDeps = {
  checkOpenCodeVersion: checkOpenCodeVersionReal,
  checkGitRepo: checkGitRepoReal,
  callReviewer: realCallReviewer,
  loadModelsConfig: realLoadModelsConfig,
  loadProjectConfig: realLoadProjectConfig,
  listStaleWorktrees: realListStaleWorktrees,
  env: process.env,
};

function keyPresent(profile: ModelProfile, env: Record<string, string | undefined>): boolean {
  return Boolean(profile.api_key_env && env[profile.api_key_env]);
}

export async function runDoctorChecks(
  cwd: string,
  reviewerProfile: ModelProfile | undefined,
  deps: Partial<DoctorDeps> = {},
): Promise<DoctorReport> {
  const d = { ...defaultDeps, ...deps };
  const openCodeVersion = await d.checkOpenCodeVersion();
  const gitOk = await d.checkGitRepo(cwd);

  let configOk = true;
  let configError: string | undefined;
  let modelsConfig: ModelsConfig | undefined;
  let projectConfig: ProjectConfig | undefined;
  try {
    modelsConfig = d.loadModelsConfig(join(cwd, ".aiflow", "config", "models.yaml"));
    projectConfig = d.loadProjectConfig(join(cwd, ".aiflow", "config", "project.yaml"));
  } catch (err) {
    configOk = false;
    configError = err instanceof Error ? err.message : String(err);
  }

  const pricingWarnings: string[] = [];
  const profileStatuses: Array<{ name: string; reachable: boolean | null; error?: string }> = [];

  if (modelsConfig) {
    for (const [name, profile] of Object.entries(modelsConfig.profiles)) {
      if (profile.channel === "http") {
        if (!profile.price) {
          pricingWarnings.push(
            `Profile "${name}" is missing the canonical "price" field (input_cost_per_1m/output_cost_per_1m are compatibility-only); spend will be under-counted in budget and cost reports (missing price is treated as $0).`,
          );
        }
        if (keyPresent(profile, d.env)) {
          try {
            await d.callReviewer(profile, 'Respond with only this JSON: {"summary":"pong","issues":[]}');
            profileStatuses.push({ name, reachable: true });
          } catch (err) {
            profileStatuses.push({
              name,
              reachable: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          profileStatuses.push({ name, reachable: null });
        }
      }
    }
  }

  const effectiveReviewer = reviewerProfile ?? modelsConfig?.profiles["reviewer"];
  const reviewerKeyPresent = effectiveReviewer ? keyPresent(effectiveReviewer, d.env) : false;

  let reviewerReachable: boolean | null = null;
  let reviewerError: string | undefined;
  if (effectiveReviewer && reviewerKeyPresent) {
    const existing = profileStatuses.find((s) => s.name === "reviewer");
    if (existing) {
      reviewerReachable = existing.reachable;
      reviewerError = existing.error;
    } else {
      try {
        await d.callReviewer(effectiveReviewer, 'Respond with only this JSON: {"summary":"pong","issues":[]}');
        reviewerReachable = true;
      } catch (err) {
        reviewerReachable = false;
        reviewerError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const staleWorktrees = (await d.listStaleWorktrees(cwd, STALE_WORKTREE_AGE_MS)).length;

  return {
    openCodeVersion,
    gitOk,
    configOk,
    configError,
    reviewerKeyPresent,
    reviewerReachable,
    reviewerError,
    pricingWarnings,
    profileStatuses,
    staleWorktrees,
  };
}
