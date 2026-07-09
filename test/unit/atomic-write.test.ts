import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { writeFileAtomic } from "../../src/atomic/atomic-write";

test("writes content atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "atomic-"));
  const target = join(dir, "out.txt");
  writeFileAtomic(target, "hello");
  expect(readFileSync(target, "utf-8")).toBe("hello");
  expect(existsSync(target + ".tmp")).toBe(false);
});
