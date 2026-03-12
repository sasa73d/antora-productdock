#!/usr/bin/env node
// validate-nav.mjs
//
// Modes:
//
//  - PRE mode:  node validate-nav.mjs --pre <list-of-new-pages>
//      * checks that EVERY new source-of-truth page has an entry in its source nav
//      * does NOT modify nav files
//
//  - POST mode: node validate-nav.mjs
//      * automatically syncs EN/SR nav files:
//          - adds missing entries into the secondary nav
//          - aligns depth (*, **, ***) in the secondary nav to match the source nav
//          - translates the source nav entry label into the secondary language (AI, temperature 0)
//      * aborts the commit only if a truly problematic situation remains
//        (e.g., nav references a page that does not exist in EN or SR)

import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";

// ---------- Constants ----------

const EN_NAV_PATH = "docs-en/modules/ROOT/nav.adoc";
const SR_NAV_PATH = "docs-sr/modules/ROOT/nav.adoc";

const EN_PAGES_ROOT = "docs-en/modules/ROOT/pages";
const SR_PAGES_ROOT = "docs-sr/modules/ROOT/pages";

const NAV_STRICT_MODE = process.env.NAV_STRICT_MODE === "1";

// ---------- File helpers ----------

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readFileOrEmpty(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return "";
  }
}

async function readFileRequired(p) {
  if (!(await fileExists(p))) return null;
  return await fs.readFile(p, "utf8");
}

// ---------- Metadata helpers ----------

function extractAttrFromContent(content, attrName, fallback = "") {
  const match = content.match(
    new RegExp(`^[ \\t]*:${attrName}:[ \\t]*([^\\r\\n]+)[ \\t]*$`, "im")
  );
  if (!match) return fallback ?? "";
  return (match[1] || "").trim().toLowerCase();
}

function normalizeLangValue(raw, fallback = "") {
  const v = (raw || "").trim().toLowerCase();
  if (v.startsWith("en")) return "en";
  if (v.startsWith("sr")) return "sr";
  return fallback || "";
}

function defaultLangFromPath(filePath) {
  if (filePath.startsWith("docs-en/")) return "en";
  if (filePath.startsWith("docs-sr/")) return "sr";
  return "";
}

// Cache page metadata (so we don't read the same page files repeatedly)
const pageInfoCache = new Map();

/**
 * Returns info for a page by its relative file name, e.g. "test-page-1.adoc"
 * {
 *   existsEn: bool,
 *   existsSr: bool,
 *   enPageLang: "en"|"sr"|"" ,
 *   srPageLang: "en"|"sr"|"" ,
 *   translationSource: "en"|"sr"|"" ,
 * }
 */
async function getPageInfo(pageId) {
  if (pageInfoCache.has(pageId)) {
    return pageInfoCache.get(pageId);
  }

  const enPath = path.join(EN_PAGES_ROOT, pageId);
  const srPath = path.join(SR_PAGES_ROOT, pageId);

  const existsEn = await fileExists(enPath);
  const existsSr = await fileExists(srPath);

  let enPageLang = "";
  let srPageLang = "";
  let enTranslationSource = "";
  let srTranslationSource = "";

  if (existsEn) {
    const c = await readFileOrEmpty(enPath);
    enPageLang = normalizeLangValue(
      extractAttrFromContent(c, "page-lang", "en"),
      "en"
    );
    enTranslationSource = normalizeLangValue(
      extractAttrFromContent(c, "translation-source", ""),
      ""
    );
  }

  if (existsSr) {
    const c = await readFileOrEmpty(srPath);
    srPageLang = normalizeLangValue(
      extractAttrFromContent(c, "page-lang", "sr"),
      "sr"
    );
    srTranslationSource = normalizeLangValue(
      extractAttrFromContent(c, "translation-source", ""),
      ""
    );
  }

  // Determine source-of-truth
  let translationSource = "";

  if (enTranslationSource && srTranslationSource) {
    if (enTranslationSource === srTranslationSource) {
      translationSource = enTranslationSource;
    } else {
      // Inconsistent pair metadata; keep empty and let POST validation complain later.
      translationSource = "";
    }
  } else if (enTranslationSource) {
    translationSource = enTranslationSource;
  } else if (srTranslationSource) {
    translationSource = srTranslationSource;
  } else if (existsEn && !existsSr) {
    translationSource = "en";
  } else if (existsSr && !existsEn) {
    translationSource = "sr";
  }

  const info = {
    existsEn,
    existsSr,
    enPageLang,
    srPageLang,
    translationSource,
  };

  pageInfoCache.set(pageId, info);
  return info;
}

// ---------- nav.adoc parsing ----------

/**
 * Parses nav.adoc:
 *  - lines: array of all lines
 *  - entries: { lineIndex, indent, stars, target, label, rawLine }
 *  - byTarget: Map(target -> entry)
 */
function parseNav(content) {
  const lines = content.split(/\r?\n/);
  const entries = [];
  const byTarget = new Map();

  const navRegex = /^(\s*)(\*+)\s+xref:([^[]+)\[([^\]]*)\]/;

  lines.forEach((line, idx) => {
    const m = line.match(navRegex);
    if (!m) return;

    const indent = m[1] || "";
    const stars = m[2] || "*";
    const targetRaw = m[3].trim();
    const labelRaw = m[4].trim();

    const target = targetRaw;

    const entry = {
      lineIndex: idx,
      indent,
      stars,
      target,
      label: labelRaw,
      rawLine: line,
    };

    if (!byTarget.has(target)) {
      byTarget.set(target, entry);
    }

    entries.push(entry);
  });

  return { lines, entries, byTarget };
}

/**
 * Rebuilds a single xref entry line.
 */
function buildNavLine(indent, stars, target, label) {
  const safeLabel = label || "";
  return `${indent}${stars} xref:${target}[${safeLabel}]`;
}

// ---------- PRE mode: check new source pages exist in source nav ----------

async function runPreCheck(newPages) {
  console.log("🧭 Running navigation PRE-check for new primary pages...");

  if (!newPages || newPages.length === 0) {
    console.log("ℹ️  No NEW .adoc pages detected for navigation PRE-check.");
    return 0;
  }

  const missingInNav = {
    en: [],
    sr: [],
  };

  const enNavContent = await readFileOrEmpty(EN_NAV_PATH);
  const srNavContent = await readFileOrEmpty(SR_NAV_PATH);

  const enNav = parseNav(enNavContent);
  const srNav = parseNav(srNavContent);

  for (const pagePath of newPages) {
    let lang = "";
    let pageId = "";

    if (pagePath.startsWith("docs-en/modules/ROOT/pages/")) {
      lang = "en";
      pageId = pagePath.replace("docs-en/modules/ROOT/pages/", "");
    } else if (pagePath.startsWith("docs-sr/modules/ROOT/pages/")) {
      lang = "sr";
      pageId = pagePath.replace("docs-sr/modules/ROOT/pages/", "");
    } else {
      continue;
    }

    const pageInfo = await getPageInfo(pageId);

    // Enforce nav entry only for the source-of-truth side
    const isSourcePage = pageInfo.translationSource === lang;
    if (!isSourcePage) continue;

    const navToCheck = lang === "en" ? enNav : srNav;
    if (!navToCheck.byTarget.has(pageId)) {
      missingInNav[lang].push(pageId);
    }
  }

  if (missingInNav.en.length === 0 && missingInNav.sr.length === 0) {
    console.log(
      "✅ Navigation PRE-check passed: all new primary pages are present in nav."
    );
    return 0;
  }

  console.log("⛔ Navigation PRE-check failed.\n");

  if (missingInNav.en.length > 0) {
    console.log("The following NEW EN source-of-truth pages are missing from EN nav.adoc:");
    missingInNav.en.forEach((p) => console.log(`  - ${p}`));
    console.log("");
  }

  if (missingInNav.sr.length > 0) {
    console.log("The following NEW SR source-of-truth pages are missing from SR nav.adoc:");
    missingInNav.sr.forEach((p) => console.log(`  - ${p}`));
    console.log("");
  }

  console.log("How to fix PRE-check:");
  console.log("  1. Open the appropriate nav file(s):");
  console.log("       - docs-en/modules/ROOT/nav.adoc");
  console.log("       - docs-sr/modules/ROOT/nav.adoc");
  console.log("  2. For each new source-of-truth page listed above, add an xref entry, for example:");
  console.log("       * xref:test-page.adoc[Some title]");
  console.log("  3. Stage the updated nav.adoc file(s) and retry the commit.\n");

  return 1;
}

// ---------- AI label translation ----------

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
let openaiClient = null;

function getOpenAIClient() {
  if (!OPENAI_API_KEY) return null;
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
  return openaiClient;
}

const LANGUAGE_NAMES = {
  en: "English",
  sr: "Serbian",
};

/**
 * Splits an ordinal prefix from a nav label.
 * Examples:
 *  - "1. Opšti pregled"   -> { prefix: "1. ", rest: "Opšti pregled" }
 *  - "1.2. Some topic"    -> { prefix: "1.2. ", rest: "Some topic" }
 * If no prefix is found, prefix is "" and rest is the original trimmed label.
 */
function splitOrdinalPrefix(label) {
  const raw = (label ?? "").trim();
  const m = raw.match(/^(\d+(?:\.\d+)*\.\s+)(.*)$/);
  if (!m) return { prefix: "", rest: raw };
  return { prefix: m[1] || "", rest: (m[2] || "").trim() };
}

async function translateLabel(label, sourceLang, targetLang) {
  if (!label || !label.trim()) return label;

  const { prefix, rest } = splitOrdinalPrefix(label);

  if (!rest) return label.trim();

  const client = getOpenAIClient();
  if (!client) {
    console.log(
      `⚠️  No OPENAI_API_KEY set. Using original label for nav translation (${sourceLang} -> ${targetLang}).`
    );
    return label;
  }

  const srcName = LANGUAGE_NAMES[sourceLang] || sourceLang;
  const tgtName = LANGUAGE_NAMES[targetLang] || targetLang;

  try {
    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `Translate this Antora navigation label from ${srcName} to ${tgtName}. ` +
                `Keep it short and natural for a sidebar menu. ` +
                `IMPORTANT: Do NOT add or remove any numbering prefixes. Return only the translated text, no quotes, no extra text:\n\n` +
                rest,
            },
          ],
        },
      ],
      temperature: 0,
    });

    let out = response.output?.[0]?.content?.[0]?.text || rest;
    out = out.trim();
    if (!out) out = rest;

    if (prefix) {
      out = out.replace(/^\d+(?:\.\d+)*\.\s+/, "").trim();
    }

    return `${prefix}${out}`.trim();
  } catch (err) {
    console.log(
      `⚠️  Failed to translate nav label "${label}" from ${sourceLang} to ${targetLang}:`,
      String(err)
    );
    return label;
  }
}

// ---------- POST mode: automatic EN/SR nav sync ----------

async function runPostSync() {
  console.log("🧭 Running EN/SR navigation POST auto-sync...");

  const enNavExists = await fileExists(EN_NAV_PATH);
  const srNavExists = await fileExists(SR_NAV_PATH);

  if (!enNavExists && !srNavExists) {
    console.log(
      "ℹ️  No EN/SR nav.adoc files found. Skipping navigation POST validation."
    );
    return 0;
  }

  const enNavContent = enNavExists ? await readFileRequired(EN_NAV_PATH) : "";
  const srNavContent = srNavExists ? await readFileRequired(SR_NAV_PATH) : "";

  const enNav = parseNav(enNavContent || "");
  const srNav = parseNav(srNavContent || "");

  const allTargets = new Set();
  for (const e of enNav.entries) allTargets.add(e.target);
  for (const e of srNav.entries) allTargets.add(e.target);

  const enLines = enNav.lines.slice();
  const srLines = srNav.lines.slice();

  let enNavChanged = false;
  let srNavChanged = false;

  const unresolvedProblems = [];

  for (const target of allTargets) {
    const pageId = target;

    const info = await getPageInfo(pageId);
    const enEntry = enNav.byTarget.get(target) || null;
    const srEntry = srNav.byTarget.get(target) || null;

    if (!info.existsEn && !info.existsSr) {
      unresolvedProblems.push(
        `Nav references page "${pageId}" but the page does not exist in EN or SR.`
      );
      continue;
    }

    // If only one side exists, nav on the missing side must not reference it.
    if (info.existsEn && !info.existsSr) {
      if (srEntry) {
        unresolvedProblems.push(
          `SR nav references "${pageId}" but the SR page does not exist.`
        );
      }
      continue;
    }

    if (info.existsSr && !info.existsEn) {
      if (enEntry) {
        unresolvedProblems.push(
          `EN nav references "${pageId}" but the EN page does not exist.`
        );
      }
      continue;
    }

    // Both sides exist. Source-of-truth comes from :translation-source:
    let primaryLang = info.translationSource;
    let secondaryLang = primaryLang === "en" ? "sr" : "en";

    if (!primaryLang) {
      unresolvedProblems.push(
        `Page pair "${pageId}" has inconsistent or missing :translation-source: metadata between EN and SR files.`
      );
      continue;
    }

    const primaryNav = primaryLang === "en" ? enNav : srNav;
    const secondaryNav = primaryLang === "en" ? srNav : enNav;
    const secondaryLines = primaryLang === "en" ? srLines : enLines;

    const setSecondaryChanged =
      primaryLang === "en"
        ? (v) => {
            srNavChanged = srNavChanged || v;
          }
        : (v) => {
            enNavChanged = enNavChanged || v;
          };

    const primaryEntry = primaryNav.byTarget.get(target) || null;
    const secondaryEntry = secondaryNav.byTarget.get(target) || null;

    // Source nav must contain the canonical entry.
    if (!primaryEntry && secondaryEntry) {
      unresolvedProblems.push(
        `Page "${pageId}" is source-of-truth in ${primaryLang.toUpperCase()}, but nav entry exists only in ${secondaryLang.toUpperCase()} nav. Please add it manually to ${primaryLang.toUpperCase()} nav.`
      );
      continue;
    }

    if (!primaryEntry) {
      continue;
    }

    const newSecondaryLabel =
      primaryLang === secondaryLang
        ? primaryEntry.label
        : await translateLabel(primaryEntry.label, primaryLang, secondaryLang);

    const newSecondaryLine = buildNavLine(
      primaryEntry.indent,
      primaryEntry.stars,
      target,
      newSecondaryLabel
    );

    if (!secondaryEntry) {
      console.log(
        `🧭 Adding nav entry in ${secondaryLang.toUpperCase()} nav for page ${pageId}`
      );
      secondaryLines.push(newSecondaryLine);
      setSecondaryChanged(true);
    } else {
      const needUpdate =
        secondaryEntry.indent !== primaryEntry.indent ||
        secondaryEntry.stars !== primaryEntry.stars ||
        secondaryEntry.target !== primaryEntry.target ||
        secondaryEntry.label !== newSecondaryLabel;

      if (needUpdate) {
        console.log(
          `🧭 Updating nav entry in ${secondaryLang.toUpperCase()} nav for page ${pageId}`
        );
        secondaryLines[secondaryEntry.lineIndex] = newSecondaryLine;
        setSecondaryChanged(true);
      }
    }
  }

  if (enNavExists && enNavChanged) {
    console.log("🧭 Writing updated EN nav.adoc (auto-synced)...");
    await fs.writeFile(EN_NAV_PATH, enLines.join("\n"), "utf8");
  }
  if (srNavExists && srNavChanged) {
    console.log("🧭 Writing updated SR nav.adoc (auto-synced)...");
    await fs.writeFile(SR_NAV_PATH, srLines.join("\n"), "utf8");
  }

  if (unresolvedProblems.length > 0) {
    console.log("⛔ Navigation POST validation found unresolved issues:\n");
    for (const msg of unresolvedProblems) {
      console.log("  - " + msg);
    }
    console.log("\nHow to fix:");
    console.log("  1. Open both nav files:");
    console.log("       - " + EN_NAV_PATH);
    console.log("       - " + SR_NAV_PATH);
    console.log("  2. Resolve the issues listed above (e.g. remove stale nav entries,");
    console.log("     or create the missing page files).");
    console.log("  3. Stage the nav files and retry the commit.\n");

    if (NAV_STRICT_MODE) {
      return 1;
    } else {
      console.log(
        "⚠️  NAV_STRICT_MODE is DISABLED – allowing commit despite unresolved nav issues."
      );
      return 0;
    }
  }

  console.log(
    "✅ Navigation POST auto-sync & validation passed. EN and SR nav files are consistent."
  );
  return 0;
}

// ---------- main ----------

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--pre") {
    const newPages = args.slice(1);
    const code = await runPreCheck(newPages);
    process.exit(code);
  } else {
    const code = await runPostSync();
    process.exit(code);
  }
}

main().catch((err) => {
  console.error("❌ validate-nav.mjs failed with error:", err);
  process.exit(1);
});