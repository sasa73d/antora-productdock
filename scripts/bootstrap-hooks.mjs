#!/usr/bin/env node
/**
 * bootstrap-hooks.mjs
 *
 * Cross-platform bootstrap:
 * - sets git config core.hooksPath to ".githooks" for this repo (local config)
 * - ensures .githooks/pre-commit exists
 *
 * Works on macOS/Linux/Windows as long as git is installed and npm runs.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const VERIFY_ONLY = args.has("--verify");

// Optional: help output
if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node scripts/bootstrap-hooks.mjs [--dry-run] [--verify]

Default (no flags): sets core.hooksPath to .githooks and performs self-check.
--dry-run: prints what would be done, makes no changes.
--verify: verifies setup; exits 0 if OK, 1 if NOT OK.
`);
  process.exit(0);
}

function run(cmd) {
  return execSync(cmd, { stdio: "pipe" }).toString("utf8").trim();
}

function tryRun(cmd) {
  try {
    return { ok: true, out: run(cmd) };
  } catch (e) {
    return { ok: false, err: String(e?.message || e) };
  }
}

function log(msg) {
  process.stdout.write(msg + "\n");
}

function getHooksPath() {
  const res = tryRun("git config --get core.hooksPath");
  if (!res.ok) return ""; // not set
  return res.out.trim();
}

function ensureExecutable(preCommitHook) {
  // Git ignores non-executable hooks on macOS/Linux
  if (process.platform === "win32") return { changed: false, note: "win32-skip" };

  try {
    fs.chmodSync(preCommitHook, 0o755);
    return { changed: true };
  } catch (e) {
    return { changed: false, error: String(e?.message || e) };
  }
}

function verifySetup(preCommitHook) {
  const hooksPath = getHooksPath();
  const hookExists = fs.existsSync(preCommitHook);

  let hookExecutable = true;
  if (process.platform !== "win32") {
    try {
      const st = fs.statSync(preCommitHook);
      // executable if any execute bit is set (user/group/other)
      hookExecutable = (st.mode & 0o111) !== 0;
    } catch {
      hookExecutable = false;
    }
  }

  const problems = [];
  if (hooksPath !== ".githooks") problems.push(`core.hooksPath is "${hooksPath || "(not set)"}" (expected ".githooks")`);
  if (!hookExists) problems.push(".githooks/pre-commit is missing");
  if (process.platform !== "win32" && hookExists && !hookExecutable) problems.push(".githooks/pre-commit is not executable (+x)");

  return { ok: problems.length === 0, problems, hooksPath, hookExists, hookExecutable };
}

function main() {
  log("🔧 bootstrap-hooks: starting...");
  if (DRY_RUN) log("🧪 mode: --dry-run (no changes will be made)");
  if (VERIFY_ONLY) log("🔎 mode: --verify (checks only; will fail if not OK)");

  // Find repo root
  const rootRes = tryRun("git rev-parse --show-toplevel");
  if (!rootRes.ok) {
    log("⚠️  bootstrap-hooks: not a git repository (git rev-parse failed). Skipping.");
    process.exit(0);
  }
  const repoRoot = rootRes.out;

  const hooksDir = path.join(repoRoot, ".githooks");
const preCommitHook = path.join(hooksDir, "pre-commit");

// --verify mode: only check state and exit with proper code
if (VERIFY_ONLY) {
  const v = verifySetup(preCommitHook);

  if (v.ok) {
    log('✅ verify: OK (core.hooksPath=".githooks", hook exists, executable where applicable)');
    process.exit(0);
  }

  log("❌ verify: NOT OK");
  v.problems.forEach((p) => log("  - " + p));
  process.exit(1);
}

// Normal mode: hook must exist
if (!fs.existsSync(preCommitHook)) {
  log("⚠️  bootstrap-hooks: .githooks/pre-commit not found. Nothing to install.");
  process.exit(0);
}

// Ensure executable bit on POSIX (macOS/Linux)
if (DRY_RUN) {
  log("ℹ️  dry-run: would ensure .githooks/pre-commit is executable (chmod 755 on macOS/Linux)");
} else if (process.platform !== "win32") {
  try {
    fs.chmodSync(preCommitHook, 0o755);
    log("✅ bootstrap-hooks: ensured .githooks/pre-commit is executable (chmod 755)");
  } catch (e) {
    log("⚠️  bootstrap-hooks: could not chmod .githooks/pre-commit (continuing)");
    log(String(e?.message || e));
  }
}

  if (DRY_RUN) {
  log('ℹ️  dry-run: would run: git config core.hooksPath .githooks');
  } else {
    try {
      execSync(`git config core.hooksPath .githooks`, { stdio: "pipe" });
      log("✅ bootstrap-hooks: set git config core.hooksPath=.githooks");
    } catch (e) {
      log("❌ bootstrap-hooks: failed to set core.hooksPath. Is git installed?");
      log(String(e?.message || e));
      process.exit(1);
    }
  }

  // Self-check (always runs; in dry-run it reports current state)
  const v = verifySetup(preCommitHook);
  if (v.ok) {
    log('✅ self-check: OK (core.hooksPath=".githooks", hook exists, executable where applicable)');
  } else {
    log("⚠️  self-check: NOT OK");
    v.problems.forEach((p) => log("  - " + p));
    // Default mode: do NOT fail hard; only --verify fails.
  }

  log("✅ bootstrap-hooks: done.");
  process.exit(0);
}

main();