// scripts/token-ledger.mjs
import fs from "node:fs/promises";
import path from "node:path";

export function getDefaultLedgerPath(repoRoot) {
  return path.join(repoRoot, ".translation-usage.jsonl");
}

export async function appendUsageEntry(ledgerPath, entry) {
  const line = JSON.stringify(entry) + "\n";
  await fs.appendFile(ledgerPath, line, "utf8");
}

export async function readLedgerTotals(ledgerPath) {
  try {
    const text = await fs.readFile(ledgerPath, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);

    let prompt = 0;
    let completion = 0;
    let total = 0;
    let requests = 0;

    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // ignore corrupt lines
      }

      if (typeof obj.prompt === "number") prompt += obj.prompt;
      if (typeof obj.completion === "number") completion += obj.completion;
      if (typeof obj.total === "number") total += obj.total;
      if (typeof obj.total === "number") requests += 1;
    }

    return { prompt, completion, total, requests };
  } catch (e) {
    // ledger does not exist yet -> treat as 0
    return { prompt: 0, completion: 0, total: 0, requests: 0 };
  }
}

/**
 * Extract token usage from OpenAI Responses API response in a defensive way.
 * Supports different field names (input/output vs prompt/completion).
 */
export function extractUsageFromOpenAIResponse(response) {
  const u = response?.usage || {};

  const prompt =
    u.prompt_tokens ??
    u.input_tokens ??
    u.input_tokens_total ?? // some SDK variants
    0;

  const completion =
    u.completion_tokens ??
    u.output_tokens ??
    u.output_tokens_total ?? // some SDK variants
    0;

  const total =
    u.total_tokens ??
    (typeof prompt === "number" && typeof completion === "number"
      ? prompt + completion
      : 0);

  return {
    prompt: Number.isFinite(prompt) ? prompt : 0,
    completion: Number.isFinite(completion) ? completion : 0,
    total: Number.isFinite(total) ? total : 0,
  };
}