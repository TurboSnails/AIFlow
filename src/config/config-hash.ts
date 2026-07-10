import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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

/** SHA-256 hash of a single spec file; returns undefined if the file does not exist. */
export function hashSpecFile(specPath: string): string | undefined {
  if (!existsSync(specPath)) return undefined;
  const content = readFileSync(specPath);
  return createHash("sha256").update(content).digest("hex");
}
