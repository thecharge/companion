import { join, resolve } from "node:path";

const SAFE_BASE = resolve(process.cwd());

export function safePath(workingDir: string, relativePath: string): string {
  const abs = resolve(join(workingDir, relativePath));
  if (!abs.startsWith(SAFE_BASE) && !abs.startsWith(resolve(workingDir))) {
    throw new Error(`SECURITY: path "${relativePath}" resolves outside safe base`);
  }
  return abs;
}

export function safeWorkingDir(workingDir: string): string {
  const abs = resolve(workingDir);
  if (!abs.startsWith(SAFE_BASE)) {
    throw new Error(`SECURITY: working_dir "${workingDir}" escapes safe base "${SAFE_BASE}"`);
  }
  return abs;
}
