import fs from "node:fs/promises";
import path from "node:path";

export interface AppPaths {
  root: string;
  authDir: string;
  logsDir: string;
  memoryDir: string;
  walletsDir: string;
  pendingCodesFile: string;
  verifiedUsersFile: string;
  verificationLogFile: string;
  walletsDbFile: string;
  walletsBackupDbFile: string;
}

export function resolveDataPaths(memoryRoot: string): AppPaths {
  const projectRoot = path.resolve(import.meta.dir, "..", "..");
  const root = path.isAbsolute(memoryRoot)
    ? memoryRoot
    : path.resolve(projectRoot, memoryRoot);
  const authDir = path.join(root, "auth");
  const logsDir = path.join(root, "logs");
  const memoryDir = path.join(root, "memory-tdai");
  const walletsDir = path.join(root, "wallets");

  return {
    root,
    authDir,
    logsDir,
    memoryDir,
    walletsDir,
    pendingCodesFile: path.join(authDir, "pending-codes.json"),
    verifiedUsersFile: path.join(authDir, "verified-users.json"),
    verificationLogFile: path.join(logsDir, "verification.log"),
    walletsDbFile: path.join(walletsDir, "wallets.sqlite"),
    walletsBackupDbFile: path.join(walletsDir, "wallets-backup.sqlite"),
  };
}

export async function ensureRuntimeDirectories(paths: AppPaths): Promise<void> {
  await fs.mkdir(paths.root, { recursive: true });
  await fs.mkdir(paths.authDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.mkdir(paths.memoryDir, { recursive: true });
  await fs.mkdir(paths.walletsDir, { recursive: true });
}
