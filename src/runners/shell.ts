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
  if (_signal?.aborted) {
    throw new Error("signal aborted before shell stage started");
  }

  // Bun's shell API does not expose a public AbortSignal hook on this runtime
  // version, so mid-flight abort is not supported. If a future version adds
  // $.signal(), wire it here; otherwise we already rejected an already-aborted
  // signal above.
  const shellPromise = $`sh -c ${stageConfig.command}`
    .cwd(cwd)
    .nothrow()
    .quiet();
  if (typeof (shellPromise as any).signal === "function") {
    (shellPromise as any).signal(_signal);
  }

  const { exitCode, stdout, stderr } = await shellPromise;
  const ok = stageConfig.on_failure === "continue" || exitCode === 0;
  return {
    result: ok ? "pass" : "fail",
    reason: exitCode === 0 ? undefined : `exit ${exitCode}\n${stderr}\n${stdout}`,
  };
}
