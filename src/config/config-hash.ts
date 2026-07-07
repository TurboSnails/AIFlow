import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

/** Deterministic content hash of everything under `<cwd>/.aiflow/config/`, order-independent. */
export function hashConfigDir(cwd: string): string {
  const configDir = join(cwd, ".aiflow", "config");
  const files = listFilesRecursive(configDir).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(configDir, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}
