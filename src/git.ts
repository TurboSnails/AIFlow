import { $ } from "bun";

export async function revParseHead(cwd: string): Promise<string> {
  const out = await $`git -C ${cwd} rev-parse HEAD`.text();
  return out.trim();
}

export async function stageAll(cwd: string): Promise<void> {
  await $`git -C ${cwd} add -A`.quiet();
}

export async function diffCached(cwd: string): Promise<string> {
  const out = await $`git -C ${cwd} diff --cached`.text();
  return out;
}

export async function commit(cwd: string, message: string): Promise<void> {
  await $`git -C ${cwd} commit -q -m ${message}`.quiet();
}

export async function isClean(cwd: string): Promise<boolean> {
  const out = await $`git -C ${cwd} status --porcelain`.text();
  return out.trim().length === 0;
}

export async function checkoutClean(cwd: string): Promise<void> {
  await $`git -C ${cwd} checkout -- .`.quiet();
  await $`git -C ${cwd} clean -fd`.quiet();
}
