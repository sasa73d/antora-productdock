#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function getRepoRootSafe() {
  // best-effort; if git is missing, fallback to cwd
  try {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
    if (r.status === 0) return (r.stdout || "").trim() || process.cwd();
  } catch {}
  return process.cwd();
}

function formatInt(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function main() {
  const repoRoot = process.cwd();
  const ledgerPath = path.join(repoRoot, ".translation-usage.jsonl");

  if (!existsSync(ledgerPath)) {
    console.log("ℹ️  No ledger found: .translation-usage.jsonl");
    console.log("   It will be created automatically on the first AI call.");
    process.exit(0);
  }

  const text = readFileSync(ledgerPath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);

  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalTokens = 0;
  let requests = 0;

  const byScript = new Map(); // script -> {requests,prompt,completion,total}
  const byModel = new Map();  // model  -> {requests,prompt,completion,total}

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const prompt = typeof obj.prompt === "number" ? obj.prompt : 0;
    const completion = typeof obj.completion === "number" ? obj.completion : 0;
    const total = typeof obj.total === "number" ? obj.total : (prompt + completion);

    if (typeof obj.total === "number" || prompt || completion) {
      requests += 1;
      totalPrompt += prompt;
      totalCompletion += completion;
      totalTokens += total;
    }

    const script = (obj.script || "unknown").toString();
    const model = (obj.model || "unknown").toString();

    const s = byScript.get(script) || { requests: 0, prompt: 0, completion: 0, total: 0 };
    s.requests += 1; s.prompt += prompt; s.completion += completion; s.total += total;
    byScript.set(script, s);

    const m = byModel.get(model) || { requests: 0, prompt: 0, completion: 0, total: 0 };
    m.requests += 1; m.prompt += prompt; m.completion += completion; m.total += total;
    byModel.set(model, m);
  }

  console.log("🔢 Token usage report (local ledger)");
  console.log(`Ledger: ${ledgerPath}`);
  console.log("");
  console.log("Totals:");
  console.log(`  REQUESTS:           ${formatInt(requests)}`);
  console.log(`  PROMPT_TOKENS:      ${formatInt(totalPrompt)}`);
  console.log(`  COMPLETION_TOKENS:  ${formatInt(totalCompletion)}`);
  console.log(`  TOTAL_TOKENS:       ${formatInt(totalTokens)}`);
  console.log("");

  console.log("By script:");
  for (const [k, v] of [...byScript.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  - ${k}`);
    console.log(`      REQUESTS:           ${formatInt(v.requests)}`);
    console.log(`      PROMPT_TOKENS:      ${formatInt(v.prompt)}`);
    console.log(`      COMPLETION_TOKENS:  ${formatInt(v.completion)}`);
    console.log(`      TOTAL_TOKENS:       ${formatInt(v.total)}`);
  }

  console.log("");
  console.log("By model:");
  for (const [k, v] of [...byModel.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  - ${k}`);
    console.log(`      REQUESTS:           ${formatInt(v.requests)}`);
    console.log(`      PROMPT_TOKENS:      ${formatInt(v.prompt)}`);
    console.log(`      COMPLETION_TOKENS:  ${formatInt(v.completion)}`);
    console.log(`      TOTAL_TOKENS:       ${formatInt(v.total)}`);
  }
}

main();