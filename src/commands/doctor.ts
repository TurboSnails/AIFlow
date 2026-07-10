import { join } from "node:path";
import { callReviewer as realCallReviewer, type ReviewerCallResult } from "../llm/client";
import { loadModelsConfig as realLoadModelsConfig, loadProjectConfig as realLoadProjectConfig } from "../config/loader";
import { listStaleWorktrees as realListStaleWorktrees } from "../worktree/manager";
import type { ModelProfile, ModelsConfig, ProjectConfig } from "../config/schema";
import type { WorktreeEntry } from "../worktree/manager";

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

const defaultDeps: DoctorDeps = {
  checkOpenCodeVersion: checkOpenCodeVersionReal,
  checkGitRepo: checkGitRepoReal,
  callReviewer: realCallReviewer,
  loadModelsConfig: realLoadModelsConfig,
  loadProjectConfig: realLoadProjectConfig,
  listStaleWorktrees: realListStaleWorktrees,
};

function keyPresent(profile: ModelProfile): boolean {
  return Boolean(profile.api_key_env && process.env[profile.api_key_env]);
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
        if (profile.input_cost_per_1m === undefined || profile.output_cost_per_1m === undefined) {
          pricingWarnings.push(
            `Profile "${name}" is missing one or both of input_cost_per_1m/output_cost_per_1m; spend will be under-counted in budget and cost reports (missing fields are treated as $0).`,
          );
        }
        if (keyPresent(profile)) {
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
  const reviewerKeyPresent = effectiveReviewer ? keyPresent(effectiveReviewer) : false;

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

  const staleWorktrees = (await d.listStaleWorktrees(cwd, 7 * 86400_000)).length;

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
