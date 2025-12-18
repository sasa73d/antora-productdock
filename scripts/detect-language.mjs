#!/usr/bin/env node
// Detect main language of an AsciiDoc page and compare it to :primary-lang:.
//
// Usage:
//   node detect-language.mjs <file.adoc>
//
// Exit codes:
//   0  -> language matches primary-lang
//   10 -> language clearly does NOT match primary-lang (mismatch / unknown / other)
//   1  -> internal error (I/O, OpenAI, parsing issues)
//
// The script prints a short diagnostic message to stdout, e.g.:
//   LANGUAGE_CHECK primary=sr (Serbian) detected=nl (Dutch) confidence=0.95 status=mismatch

import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import "dotenv/config";
import {
  appendUsageEntry,
  extractUsageFromOpenAIResponse,
  getDefaultLedgerPath,
} from "./token-ledger.mjs";

function pickDetectModel() {
  const model =
    (process.env.OPENAI_MODEL_DETECT || "").trim() ||
    (process.env.OPENAI_MODEL_DEFAULT || "").trim();

  if (!model) {
    throw new Error(
      "Missing OpenAI model configuration. Set OPENAI_MODEL_DEFAULT (and optionally OPENAI_MODEL_DETECT) in .env"
    );
  }

  if ((process.env.OPENAI_LOG_MODEL || "").trim() === "1") {
    console.log(`ℹ️  Using OpenAI model (detect-language): ${model}`);
  }

  return model;
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function main() {
  const [, , inputPath] = process.argv;

  if (!inputPath) {
    console.error("Usage: node detect-language.mjs <file.adoc>");
    process.exit(1);
  }

  const absPath = path.resolve(process.cwd(), inputPath);
  const repoRoot = process.cwd();

  // Ensure ledger path is available (same pattern used by translate script)
  const ledgerPath = getDefaultLedgerPath(repoRoot);
  globalThis.__TOKEN_LEDGER_PATH__ = ledgerPath;

  let content;
  try {
    content = await fs.readFile(absPath, "utf8");
  } catch (err) {
    console.error(`❌ Could not read file for language detection: ${absPath}`);
    console.error(err.message);
    process.exit(1);
  }

  const primaryLang = extractPrimaryLang(content);
  if (!primaryLang) {
    console.log(
      "LANGUAGE_CHECK primary=unknown (unknown) detected=unknown (?) confidence=0.00 status=skipped (no :primary-lang: found)"
    );
    process.exit(0);
  }

  const sample = extractTextSample(content);

  if (!sample || sample.trim().length < 20) {
    const primaryPretty = prettyPrimaryLabel(primaryLang);
    console.log(
      `LANGUAGE_CHECK primary=${primaryLang} (${primaryPretty}) detected=unknown (?) confidence=0.00 status=insufficient_text`
    );
    process.exit(0);
  }

  let detection;
  try {
    detection = await detectLanguageWithOpenAI(sample, primaryLang);
  } catch (err) {
    console.error("❌ Error while calling OpenAI for language detection:");
    console.error(err.message);
    process.exit(1);
  }

  let { code, name, confidence, status } = detection;

  // Post-processing: be strict for EN/SR primary.
  const primaryLower = primaryLang.toLowerCase();
  const codeLower = (code || "unknown").toLowerCase();

  let finalStatus = status || "unknown";

  if (primaryLower === "en") {
    finalStatus = codeLower.startsWith("en") ? "match" : "mismatch";
  } else if (primaryLower === "sr") {
    finalStatus =
      codeLower.startsWith("sr") ||
      codeLower.startsWith("bs") ||
      codeLower.startsWith("hr") ||
      codeLower.startsWith("sh")
        ? "match"
        : "mismatch";
  }

  const primaryPretty = prettyPrimaryLabel(primaryLang);
  const detectedCode = code || "unknown";
  const detectedPretty = name || code || "unknown";

  console.log(
    `LANGUAGE_CHECK primary=${primaryLang} (${primaryPretty}) ` +
      `detected=${detectedCode} (${detectedPretty}) ` +
      `confidence=${Number(confidence || 0).toFixed(2)} status=${finalStatus}`
  );

  if (finalStatus === "mismatch") {
    process.exit(10);
  }

  process.exit(0);
}

function extractPrimaryLang(content) {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith(":primary-lang:")) {
      const parts = trimmed.split(":").map((p) => p.trim());
      if (parts.length >= 3 && parts[2]) {
        const value = parts[2].toLowerCase();
        if (value.startsWith("en")) return "en";
        if (value.startsWith("sr")) return "sr";
        return value;
      }
    }
  }
  return null;
}

function extractTextSample(content) {
  const lines = content.split(/\r?\n/);
  const MAX_CHARS = 800;

  let inCodeBlock = false;
  const buffer = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "----") {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    if (trimmed.startsWith(":")) continue;
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) continue;
    if (trimmed.length === 0) continue;

    buffer.push(trimmed);

    const sample = buffer.join("\n");
    if (sample.length >= MAX_CHARS) return sample.slice(0, MAX_CHARS);
  }

  return buffer.join("\n").slice(0, MAX_CHARS);
}

function prettyPrimaryLabel(primary) {
  const v = (primary || "").toLowerCase();
  if (v.startsWith("en")) return "English";
  if (v.startsWith("sr")) return "Serbian";
  return primary || "unknown";
}

async function detectLanguageWithOpenAI(sample, primaryLang) {
  const instructions = `
You are a language detection utility for documentation text.

Return ONLY a valid JSON object in this exact form (no extra text):

{
  "code": "<language-code-or-mixed-or-unknown>",
  "name": "<English name of the language or 'mixed' or 'unknown'>",
  "confidence": 0.0-1.0,
  "status": "match|mismatch|mixed|unknown"
}

Rules:
- "code" should ideally be a short language code like "en", "de", "sr", "bs", "hr", ...
  If unsure, you may use "mixed" or "unknown".
- "name" should be the English name of the language, or "mixed" / "unknown".
- "confidence" is 0.0 to 1.0.
- "status": match|mismatch|mixed|unknown
`;

  const input = `Expected primary language: "${primaryLang}"

Text sample:
"""${sample}"""`;

  const model = pickDetectModel();

  const response = await client.responses.create({
    model,
    instructions,
    input,
  });

  // Token usage logging (best-effort)
  try {
    const usage = extractUsageFromOpenAIResponse(response);
    if (globalThis.__TOKEN_LEDGER_PATH__) {
      await appendUsageEntry(globalThis.__TOKEN_LEDGER_PATH__, {
        ts: new Date().toISOString(),
        script: "detect-language",
        model,
        direction: "detect",
        safeMode: false,
        prompt: usage.prompt,
        completion: usage.completion,
        total: usage.total,
      });
    }
  } catch {
    // ignore usage logging errors
  }

  const text =
    response.output?.[0]?.content?.[0]?.text?.trim() ||
    response.output_text?.trim() ||
    "";

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Failed to parse language detection response as JSON. Raw response: ${text}`);
  }

  const code =
    typeof parsed.code === "string" && parsed.code.trim().length > 0
      ? parsed.code.trim()
      : "unknown";

  const name =
    typeof parsed.name === "string" && parsed.name.trim().length > 0
      ? parsed.name.trim()
      : code;

  const confidence =
    typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 0;

  const status =
    typeof parsed.status === "string" && parsed.status.trim().length > 0
      ? parsed.status.trim().toLowerCase()
      : "unknown";

  return { code, name, confidence, status };
}

main().catch((err) => {
  console.error("❌ Unexpected error in detect-language.mjs:", err);
  process.exit(1);
});