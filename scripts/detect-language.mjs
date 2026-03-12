#!/usr/bin/env node
// detect-language.mjs
//
// Detects whether an AsciiDoc page is written in the language declared by metadata.
//
// New metadata model:
//   :page-lang: en|sr
//
// Transitional fallback:
//   :primary-lang: en|sr
//
// Exit codes:
//   0  -> match
//   1  -> script/config/runtime error
//   10 -> language mismatch

import fs from "fs/promises";
import OpenAI from "openai";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL =
  (process.env.OPENAI_MODEL_DETECT_LANGUAGE || "").trim() ||
  (process.env.OPENAI_MODEL_DEFAULT || "").trim() ||
  "gpt-4.1-mini";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in environment.");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

function usage() {
  console.error("Usage: node scripts/detect-language.mjs <file.adoc>");
  process.exit(1);
}

function normalizeLangValue(raw) {
  const v = (raw || "").trim().toLowerCase();
  if (v.startsWith("en")) return "en";
  if (v.startsWith("sr")) return "sr";
  return "";
}

function extractAttr(content, attrName) {
  const re = new RegExp(`^:${attrName}:\\s*(.+)\\s*$`, "im");
  const m = content.match(re);
  return m ? (m[1] || "").trim() : "";
}

function extractExpectedLanguage(content) {
  const pageLang = normalizeLangValue(extractAttr(content, "page-lang"));
  if (pageLang) {
    return {
      lang: pageLang,
      attr: "page-lang",
    };
  }

  const primaryLang = normalizeLangValue(extractAttr(content, "primary-lang"));
  if (primaryLang) {
    return {
      lang: primaryLang,
      attr: "primary-lang",
    };
  }

  return {
    lang: "",
    attr: "",
  };
}

function removeProtectedRegions(text) {
  const lines = text.split(/\r?\n/);
  const kept = [];

  let inDelimitedBlock = false;
  let currentDelimiter = "";
  let pendingBlockAttr = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^\[(source|listing|literal)(%[^\]]+)?(?:,[^\]]*)?\]$/i.test(trimmed)) {
      pendingBlockAttr = true;
      continue;
    }

    if (!inDelimitedBlock && pendingBlockAttr && /^(----|\.{4}|```.*)$/.test(trimmed)) {
      inDelimitedBlock = true;
      currentDelimiter = trimmed.startsWith("```") ? "```" : trimmed;
      pendingBlockAttr = false;
      continue;
    }

    if (!inDelimitedBlock && /^(----|\.{4}|```.*)$/.test(trimmed)) {
      inDelimitedBlock = true;
      currentDelimiter = trimmed.startsWith("```") ? "```" : trimmed;
      pendingBlockAttr = false;
      continue;
    }

    if (inDelimitedBlock) {
      const closes =
        currentDelimiter === "```"
          ? trimmed.startsWith("```")
          : trimmed === currentDelimiter;

      if (closes) {
        inDelimitedBlock = false;
        currentDelimiter = "";
      }
      continue;
    }

    pendingBlockAttr = false;

    // skip metadata lines
    if (/^:[^:]+:\s*.*$/.test(trimmed)) continue;

    // skip comments
    if (/^\/\//.test(trimmed)) continue;

    // skip include/xref/image macros and anchors
    if (/^(include::|xref:|image::|\[\[)/.test(trimmed)) continue;

    // keep headings, list items, paragraphs, table text, etc.
    kept.push(line);
  }

  return kept.join("\n").trim();
}

function languageName(lang) {
  if (lang === "en") return "English";
  if (lang === "sr") return "Serbian";
  return lang;
}

async function detectLanguage(text) {
  const response = await client.responses.create({
    model: MODEL,
    temperature: 0,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You are a language detector for documentation pages. " +
              "Decide whether the given text is primarily written in English or Serbian (Latin). " +
              "Return strict JSON only with keys: language, confidence. " +
              'Example: {"language":"en","confidence":0.98}',
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: text,
          },
        ],
      },
    ],
  });

  const output =
    response.output_text ||
    response.output?.flatMap((item) => item.content || [])
      .map((c) => {
        if (typeof c?.text === "string") return c.text;
        if (typeof c?.text?.value === "string") return c.text.value;
        return "";
      })
      .join("")
      .trim() ||
    "";

  if (!output) {
    throw new Error("Empty response from language detector.");
  }

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`Language detector returned non-JSON output: ${output}`);
  }

  return {
    language: normalizeLangValue(parsed.language),
    confidence:
      typeof parsed.confidence === "number" ? parsed.confidence : 0,
  };
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) usage();

  const content = await fs.readFile(filePath, "utf8");
  const expected = extractExpectedLanguage(content);

  if (!expected.lang) {
    console.error(
      `No :page-lang: found in ${filePath}, and no fallback :primary-lang: is available.`
    );
    process.exit(1);
  }

  if ((process.env.OPENAI_LOG_MODEL || "").trim() === "1") {
    console.log(`ℹ️  Using OpenAI model (detect-language): ${MODEL}`);
  }

  const cleaned = removeProtectedRegions(content);

  if (!cleaned) {
    console.error(`No human-readable text found for language detection in ${filePath}.`);
    process.exit(1);
  }

  const detected = await detectLanguage(cleaned);
  const status = detected.language === expected.lang ? "match" : "mismatch";

  console.log(
    `LANGUAGE_CHECK expected=${expected.lang} (${languageName(expected.lang)}) ` +
      `via=${expected.attr} detected=${detected.language || "unknown"} ` +
      `(${languageName(detected.language || "unknown")}) ` +
      `confidence=${detected.confidence.toFixed(2)} status=${status}`
  );

  if (status === "mismatch") {
    process.exit(10);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("detect-language.mjs failed:", err?.message || String(err));
  process.exit(1);
});