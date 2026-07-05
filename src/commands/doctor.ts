import { callReviewer as realCallReviewer } from "../llm/client";
import type { ModelProfile } from "../config/schema";

export interface DoctorReport {
  openCodeVersion: string | null;
  gitOk: boolean;
  reviewerKeyPresent: boolean;
  reviewerReachable: boolean | null;
  reviewerError?: string;
}

export interface DoctorDeps {
  checkOpenCodeVersion: () => Promise<string | null>;
  checkGitRepo: (cwd: string) => Promise<boolean>;
  callReviewer: (profile: ModelProfile, prompt: string) => Promise<unknown>;
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
};

export async function runDoctorChecks(
  cwd: string,
  reviewerProfile: ModelProfile | undefined,
  deps: DoctorDeps = defaultDeps
): Promise<DoctorReport> {
  const openCodeVersion = await deps.checkOpenCodeVersion();
  const gitOk = await deps.checkGitRepo(cwd);

  const reviewerKeyPresent = Boolean(
    reviewerProfile?.api_key_env && process.env[reviewerProfile.api_key_env]
  );

  if (!reviewerProfile || !reviewerKeyPresent) {
    return { openCodeVersion, gitOk, reviewerKeyPresent, reviewerReachable: null };
  }

  try {
    await deps.callReviewer(reviewerProfile, 'Respond with only this JSON: {"summary":"pong","issues":[]}');
    return { openCodeVersion, gitOk, reviewerKeyPresent, reviewerReachable: true };
  } catch (err) {
    return {
      openCodeVersion,
      gitOk,
      reviewerKeyPresent,
      reviewerReachable: false,
      reviewerError: err instanceof Error ? err.message : String(err),
    };
  }
}
