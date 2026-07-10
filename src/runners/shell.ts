import { $ } from "bun";
import type { ShellStageConfig, ModelProfile } from "../config/schema";
import type { StageOutcome } from "../engine/engine";
import type { StageState } from "../engine/state";
import { noopBudgetTracker, type BudgetTracker } from "../gate/budget";

export async function runShellStage(
  stageConfig: ShellStageConfig,
  _stageState: StageState,
  _profiles: Record<string, ModelProfile>,
  cwd: string,
  _runDir: string,
  _nowFn: () => Date,
  _signal: AbortSignal | undefined,
  _budget: BudgetTracker = noopBudgetTracker
): Promise<StageOutcome> {
  const { exitCode, stdout, stderr } = await $`sh -c ${stageConfig.command}`
    .cwd(cwd)
    .nothrow()
    .quiet();
  const ok = stageConfig.on_failure === "continue" || exitCode === 0;
  return {
    result: ok ? "pass" : "fail",
    reason: exitCode === 0 ? undefined : `exit ${exitCode}\n${stderr}\n${stdout}`,
  };
}
