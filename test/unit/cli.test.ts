import { test, expect } from "bun:test";

test("cli --help lists doctor, init, run commands", async () => {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--help"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  expect(output).toContain("doctor");
  expect(output).toContain("init");
  expect(output).toContain("run");
});
