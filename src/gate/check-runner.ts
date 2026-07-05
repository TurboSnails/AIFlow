export const MAX_CHECK_OUTPUT_CHARS = 4000;

export interface CheckResult {
  pass: boolean;
  failedCommand?: string;
  output: string;
}

export async function runChecks(commands: string[], cwd: string): Promise<CheckResult> {
  for (const command of commands) {
    const proc = Bun.spawn(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      const combined = (stdout + stderr).slice(-MAX_CHECK_OUTPUT_CHARS);
      return { pass: false, failedCommand: command, output: combined };
    }
  }
  return { pass: true, output: "" };
}
