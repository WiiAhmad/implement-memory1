#!/usr/bin/env bun
import { existsSync } from "node:fs";
import path from "node:path";

const vendorDir = path.resolve("TencentDB-Agent-Memory");
const patchFile = path.resolve(
  "docs",
  "patches",
  "tencentdb-agent-memory-session-scoped-search.patch",
);

function runGit(args: string[]) {
  return Bun.spawnSync(["git", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).trim();
}

if (!existsSync(vendorDir)) {
  console.error(`Vendor directory not found: ${vendorDir}`);
  process.exit(1);
}

if (!existsSync(patchFile)) {
  console.error(`Patch file not found: ${patchFile}`);
  process.exit(1);
}

const reverseCheck = runGit([
  "-C",
  vendorDir,
  "apply",
  "--reverse",
  "--check",
  patchFile,
]);

if (reverseCheck.exitCode === 0) {
  console.log("TencentDB-Agent-Memory patch is already applied.");
  process.exit(0);
}

const apply = runGit(["-C", vendorDir, "apply", patchFile]);

if (apply.exitCode !== 0) {
  const stderr = text(apply.stderr);
  const stdout = text(apply.stdout);
  console.error("Failed to apply TencentDB-Agent-Memory patch.");
  if (stdout) console.error(stdout);
  if (stderr) console.error(stderr);
  process.exit(apply.exitCode);
}

console.log("TencentDB-Agent-Memory patch applied.");
