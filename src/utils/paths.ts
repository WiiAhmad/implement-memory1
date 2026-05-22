import fs from "node:fs/promises";
import path from "node:path";

export interface AppPaths {
  root: string;
  authDir: string;
  logsDir: string;
  memoryDir: string;
  pendingCodesFile: string;
  verifiedUsersFile: string;
  verificationLogFile: string;
}

export function resolveDataPaths(memoryRoot: string): AppPaths {
  const projectRoot = path.resolve(import.meta.dir, "..", "..");
  const root = path.isAbsolute(memoryRoot)
    ? memoryRoot
    : path.resolve(projectRoot, memoryRoot);
  const authDir = path.join(root, "auth");
  const logsDir = path.join(root, "logs");
  const memoryDir = path.join(root, "memory-tdai");

  return {
    root,
    authDir,
    logsDir,
    memoryDir,
    pendingCodesFile: path.join(authDir, "pending-codes.json"),
    verifiedUsersFile: path.join(authDir, "verified-users.json"),
    verificationLogFile: path.join(logsDir, "verification.log"),
  };
}

export async function ensureRuntimeDirectories(paths: AppPaths): Promise<void> {
  await fs.mkdir(paths.root, { recursive: true });
  await fs.mkdir(paths.authDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.mkdir(paths.memoryDir, { recursive: true });
}
