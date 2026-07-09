import { writeFileSync, renameSync } from "node:fs";

export function writeFileAtomic(filePath: string, data: string | Buffer): void {
  const tempPath = filePath + ".tmp";
  writeFileSync(tempPath, data);
  renameSync(tempPath, filePath);
}
