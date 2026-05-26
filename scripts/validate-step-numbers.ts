#!/usr/bin/env bun
/**
 * Step Number Validation Script
 *
 * Validates that all [Step N] headers and sub-step numbers (─── Step Na,
 * ─── Step Na-i) in source files match the CLAUDE.md Step Number Reference
 * table.
 *
 * Checks performed:
 *   1. Every source file in the table has the expected [Step N] header.
 *   2. Every source file's [Step N] matches its table entry.
 *   3. All sub-step numbers within a file use the correct numeric prefix N.
 *   4. No source file outside the table contains a [Step N] header.
 *
 * Usage:
 *   bun run scripts/validate-step-numbers.ts
 *
 * Exit codes:
 *   0 — All checks pass
 *   1 — One or more mismatches found
 */

import { readdirSync } from "node:fs";
import { statSync } from "node:fs";
import { join } from "node:path";

// ─── Configuration ──────────────────────────────────────────────────────────

const CLAUDE_MD_PATH = "CLAUDE.md";
const EXCLUDE_DIRS = new Set(["TencentDB-Agent-Memory", "node_modules", "dist", "data"]);

// ─── Parse the Step Number Reference table from CLAUDE.md ───────────────────

interface StepEntry {
  step: number;
  filePath: string;
  subStepInfo: string | null;
}

function parseStepTable(content: string): StepEntry[] {
  // Find the table between "### Step Number Reference" and "### Execution Flowchart"
  const tableStart = content.indexOf("### Step Number Reference");
  const tableEnd = content.indexOf("### Execution Flowchart");
  if (tableStart === -1 || tableEnd === -1) {
    console.error("FATAL: Could not locate Step Number Reference table in CLAUDE.md");
    process.exit(1);
  }

  const tableSection = content.slice(tableStart, tableEnd);
  const lines = tableSection.split("\n");

  // Find the separator line (contains |---|---)
  let separatorIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("---") && lines[i].includes("|")) {
      separatorIdx = i;
      break;
    }
  }
  if (separatorIdx === -1) {
    console.error("FATAL: Could not find table separator in CLAUDE.md step reference table");
    process.exit(1);
  }

  const entries: StepEntry[] = [];
  for (let i = separatorIdx + 1; i < lines.length; i++) {
    const raw = lines[i].trimEnd(); // Strip Windows \r
    // Stop at blank line or non-table content
    if (!raw.startsWith("|")) break;

    const cols = raw.split("|").map((c) => c.trim());
    // After split: cols[0] is empty, cols[1] = step, cols[2] = file, cols[3] = purpose
    if (cols.length < 4) continue;

    const stepStr = cols[1];
    const fileStr = cols[2];
    const purposeStr = cols[3] ?? "";

    if (!stepStr || !fileStr) continue;

    const step = parseInt(stepStr, 10);
    if (isNaN(step)) continue;

    // Extract file path from backticks
    const fileMatch = fileStr.match(/`([^`]+)`/);
    if (!fileMatch) continue;
    const filePath = fileMatch[1];

    // Extract sub-step info from the Purpose column (content in trailing parentheses)
    const subStepMatch = purposeStr.match(/\((.+)\)\s*$/);
    const subStepInfo = subStepMatch ? subStepMatch[1] : null;

    entries.push({ step, filePath, subStepInfo });
  }

  return entries;
}

// ─── File I/O Helpers ──────────────────────────────────────────────────────

async function readLines(path: string): Promise<{ lines: string[]; ok: boolean }> {
  try {
    const content = await Bun.file(path).text();
    // Normalize Windows \r\n → \n, then split
    return { lines: content.replace(/\r\n/g, "\n").split("\n"), ok: true };
  } catch {
    return { lines: [], ok: false };
  }
}

function* enumerateSourceFiles(): Generator<string> {
  yield* walkDir("src");
  yield "index.ts";
}

function* walkDir(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // Directory doesn't exist or not readable
  }

  for (const name of entries) {
    if (EXCLUDE_DIRS.has(name)) continue;
    const fullPath = join(dir, name);

    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }

    if (stats.isDirectory()) {
      yield* walkDir(fullPath);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      yield fullPath.replace(/\\/g, "/");
    }
  }
}

// ─── Validation Logic ──────────────────────────────────────────────────────

interface Mismatch {
  type: "missing_header" | "step_mismatch" | "substep_mismatch" | "unexpected_header" | "file_not_found";
  filePath: string;
  expected: string;
  actual: string;
}

/** Find the first [Step N] header in a file's lines (looks at first 10 lines). */
function findStepHeader(lines: string[]): number | null {
  const limit = Math.min(lines.length, 10);
  for (let i = 0; i < limit; i++) {
    const match = lines[i].match(/\[Step\s+(\d+)\]/);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Find sub-steps whose numeric prefix doesn't match the expected step number.
 *
 * Matches only comment lines that START with comment content `─── Step Nx`,
 * to avoid false-positives on cross-references like "see Step 28a".
 */
function findSubStepIssues(lines: string[], expectedStep: number): string[] {
  const issues: string[] = [];
  // Look for ─── Step N followed by letter-suffix (a-z, a-i, a-ii, etc.)
  const subStepRegex = /─── Step (\d+)([a-z](?:-[a-z0-9]+)?)\b/g;
  // But only match when `─── Step` appears as a label, not a cross-reference.
  // In this codebase, sub-step labels always start at the beginning of a comment
  // (possibly with indentation). Cross-references would be inline like "see Step 28a".
  // The regex naturally handles this because we search globally, but we need to
  // distinguish `// ─── Step 28a: ...` (label) from `// something uses Step 28a` (xref).
  // Since labels always have `─── Step` and xrefs are free text, this is already handled
  // by requiring the `───` prefix.

  for (const line of lines) {
    const matches = line.matchAll(subStepRegex);
    for (const match of matches) {
      const foundStep = parseInt(match[1], 10);
      const suffix = match[2];
      if (foundStep !== expectedStep) {
        const indent = line.startsWith("  ") ? "  " : "";
        issues.push(`${indent}Line: "${line.trim()}" — expected [Step ${expectedStep}${suffix}], found [Step ${foundStep}${suffix}]`);
      }
    }
  }
  return issues;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  console.log("🔍 Validating step numbers against CLAUDE.md reference table...\n");

  // 1. Parse the table
  let claudeContent: string;
  try {
    claudeContent = await Bun.file(CLAUDE_MD_PATH).text();
  } catch (err) {
    console.error(`FATAL: Could not read ${CLAUDE_MD_PATH}: ${err}`);
    return 1;
  }

  const stepEntries = parseStepTable(claudeContent);
  console.log(`   Parsed ${stepEntries.length} entries from the Step Number Reference table.\n`);

  // Build lookup: filePath → StepEntry
  const tableByFile = new Map<string, StepEntry>();
  const seenStepNumbers = new Set<number>();
  for (const entry of stepEntries) {
    tableByFile.set(entry.filePath, entry);
    if (seenStepNumbers.has(entry.step)) {
      console.error(`❌ Duplicate step number ${entry.step} in CLAUDE.md table (${entry.filePath})`);
      return 1;
    }
    seenStepNumbers.add(entry.step);
  }

  // 2. Build set of all source files on disk
  const allSourceFiles = new Set<string>();
  for (const f of enumerateSourceFiles()) {
    allSourceFiles.add(f);
  }

  // 3. Validate each source file
  const mismatches: Mismatch[] = [];

  for (const filePath of allSourceFiles) {
    const expectedEntry = tableByFile.get(filePath);
    const { lines, ok: readOk } = await readLines(filePath);

    if (!readOk) {
      // File doesn't exist or can't be read — could be a stale reference in the table
      if (expectedEntry) {
        mismatches.push({
          type: "file_not_found",
          filePath,
          expected: `Step ${expectedEntry.step} in table`,
          actual: "(file missing or unreadable on disk)",
        });
      }
      continue;
    }

    const actualHeaderStep = findStepHeader(lines);

    if (expectedEntry && actualHeaderStep === null) {
      mismatches.push({
        type: "missing_header",
        filePath,
        expected: `[Step ${expectedEntry.step}]`,
        actual: "(no [Step N] header found in first 10 lines)",
      });
      continue;
    }

    if (expectedEntry && actualHeaderStep !== null && actualHeaderStep !== expectedEntry.step) {
      mismatches.push({
        type: "step_mismatch",
        filePath,
        expected: `[Step ${expectedEntry.step}]`,
        actual: `[Step ${actualHeaderStep}]`,
      });
      continue;
    }

    if (!expectedEntry && actualHeaderStep !== null) {
      mismatches.push({
        type: "unexpected_header",
        filePath,
        expected: "(not listed in CLAUDE.md table)",
        actual: `[Step ${actualHeaderStep}]`,
      });
      continue;
    }

    // 4. Validate sub-step numbers
    if (expectedEntry && actualHeaderStep !== null) {
      const substepIssues = findSubStepIssues(lines, actualHeaderStep);
      if (substepIssues.length > 0) {
        mismatches.push({
          type: "substep_mismatch",
          filePath,
          expected: `all sub-steps use prefix ${actualHeaderStep}`,
          actual: substepIssues.join("\n"),
        });
      }
    }
  }

  // 5. Check for files in the table that don't exist on disk
  for (const [filePath] of tableByFile) {
    if (!allSourceFiles.has(filePath)) {
      mismatches.push({
        type: "file_not_found",
        filePath,
        expected: "exists in CLAUDE.md table",
        actual: "(file not found on disk)",
      });
    }
  }

  // ─── Report Results ───────────────────────────────────────────────────

  if (mismatches.length === 0) {
    console.log("   ┌────────────────────────────────────────────────────────────────┐");
    console.log("   │  ✅  ALL CHECKS PASSED                                       │");
    console.log("   │                                                              │");
    console.log(`   │  ${String(stepEntries.length).padStart(5)} source files in reference table                │`);
    console.log(`   │  ${String(allSourceFiles.size).padStart(5)} source files on disk                        │`);
    console.log(`   │  ${String(stepEntries.filter((e) => e.subStepInfo).length).padStart(5)} files with sub-steps validated                 │`);
    console.log("   │                                                              │");
    console.log("   │  No mismatches found. Step numbers are in sync.              │");
    console.log("   └────────────────────────────────────────────────────────────────┘\n");

    // Per-file summary
    console.log("   Step reference status:");
    console.log("   " + "─".repeat(60));
    console.log(`   ${"Step".padEnd(6)} ${"File".padEnd(42)} Status`);
    console.log("   " + "─".repeat(60));

    for (const entry of stepEntries) {
      const label = `Step ${String(entry.step)}`;
      const pathDisplay = entry.filePath.length > 40
        ? ".." + entry.filePath.slice(-38)
        : entry.filePath;
      const sub = entry.subStepInfo ? ` (${entry.subStepInfo})` : "";
      console.log(`   ${label.padEnd(6)} ${pathDisplay.padEnd(42)} ✅${sub}`);
    }

    const noHeaderCount = allSourceFiles.size - stepEntries.length;
    if (noHeaderCount > 0) {
      console.log(`\n   (${noHeaderCount} additional source files without step headers — ` +
        `these are expected to be scripts, etc.)`);
    }
    console.log();
    return 0;
  }

  // Report mismatches
  console.error(`   ❌  ${mismatches.length} MISMATCH(ES) FOUND\n`);

  for (const m of mismatches) {
    const typeLabel = {
      missing_header: "MISSING HEADER",
      step_mismatch: "STEP NUMBER MISMATCH",
      substep_mismatch: "SUB-STEP PREFIX MISMATCH",
      unexpected_header: "UNEXPECTED HEADER",
      file_not_found: "FILE NOT FOUND",
    }[m.type];

    console.error(`   ${typeLabel}: ${m.filePath}`);
    console.error(`     Expected: ${m.expected}`);
    console.error(`     Actual:   ${m.actual}`);
    console.error();
  }

  return 1;
}

const exitCode = await main();
process.exit(exitCode);
