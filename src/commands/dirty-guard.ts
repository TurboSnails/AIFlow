import { isClean } from "../git";
import type { PipelineConfig } from "../config/schema";

/**
 * 若管道任一 stage 是 auto_clean 的 ralph_loop，则要求工作区干净，否则 throw。
 * checkoutClean 无法区分用户未提交的工作和失败的 agent 尝试，故恢复前必须先拦。
 */
export async function assertCleanIfAutoClean(
  cwd: string,
  pipeline: PipelineConfig,
  pipelineName: string,
  isCleanFn: (cwd: string) => Promise<boolean> = isClean
): Promise<void> {
  const hasAutoClean = pipeline.stages.some((s) => s.type === "ralph_loop" && s.auto_clean);
  if (!hasAutoClean) return;
  if (!(await isCleanFn(cwd))) {
    throw new Error(
      `Pipeline "${pipelineName}" has auto_clean enabled on a ralph_loop stage, but the working tree at ${cwd} is not clean. Commit or stash your changes before running (auto_clean cannot distinguish your uncommitted work from a failed agent attempt).`
    );
  }
}
