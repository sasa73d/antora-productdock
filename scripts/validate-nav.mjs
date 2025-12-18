#!/usr/bin/env node
// validate-nav.mjs
//
// Modes:
//  - PRE  mode:  node validate-nav.mjs --pre <list-of-new-pages>
//       * provjerava da li SVAKA nova primarna stranica ima entry u svom primarnom nav-u
//       * NE mijenja nav fajlove
//
//  - POST mode: node validate-nav.mjs
//       * automatski usklađuje EN/SR nav:
//           - dodaje nedostajuće entry-je u sekundarni nav
//           - poravnava depth (*, **, ***) u sekundarnom nav-u prema primarnom
//           - prevodi labelu primarnog nav entry-ja u sekundarni jezik (AI, temperature 0)
//       * abortuje commit samo ako ostane "stvarno" problematična situacija
//         (npr. nav referencira stranicu koja uopšte ne postoji ni u EN ni u SR)

import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";

// ---------- Konstante ----------

const EN_NAV_PATH = "docs-en/modules/ROOT/nav.adoc";
const SR_NAV_PATH = "docs-sr/modules/ROOT/nav.adoc";

const EN_PAGES_ROOT = "docs-en/modules/ROOT/pages";
const SR_PAGES_ROOT = "docs-sr/modules/ROOT/pages";

const NAV_STRICT_MODE = process.env.NAV_STRICT_MODE === "1";

// ---------- Pomocne funkcije za fajlove ----------

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

// ---------- primary-lang helper ----------

function extractPrimaryLangFromContent(content, fallback) {
  const match = content.match(/^[ \t]*:primary-lang:[ \t]*([a-zA-Z\-]+)[ \t]*$/im);
  if (!match) return fallback ?? "";
  const raw = match[1].toLowerCase();
  if (raw.startsWith("en")) return "en";
  if (raw.startsWith("sr")) return "sr";
  return raw;
}

// Cache za informacije o stranicama (da ne citamo iste fajlove vise puta)
const pageInfoCache = new Map();

/**
 * Vraca info o stranici po relativnom imenu, npr. "test-page-1.adoc"
 * {
 *   existsEn: bool,
 *   existsSr: bool,
 *   enPrimary: bool,
 *   srPrimary: bool
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

  let enPrimary = false;
  let srPrimary = false;

  if (existsEn) {
    const c = await readFileOrEmpty(enPath);
    const lang = extractPrimaryLangFromContent(c, "en");
    if (lang === "en") enPrimary = true;
  }

  if (existsSr) {
    const c = await readFileOrEmpty(srPath);
    const lang = extractPrimaryLangFromContent(c, "sr");
    if (lang === "sr") srPrimary = true;
  }

  const info = { existsEn, existsSr, enPrimary, srPrimary };
  pageInfoCache.set(pageId, info);
  return info;
}

// ---------- Parsiranje nav fajlova ----------

/**
 * Parsira nav.adoc:
 *  - lines: niz svih linija
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

    // target je tipa "test-page.adoc" ili "modules:ROOT:test-page.adoc" itd.
    // Za sada pretpostavljamo da koristimo relativne page id-ove (test-page.adoc).
    const target = targetRaw;

    const entry = {
      lineIndex: idx,
      indent,
      stars,
      target,
      label: labelRaw,
      rawLine: line,
    };

    // Ako ima duplikata za isti target, uzimamo prvi (to je obicno dovoljno)
    if (!byTarget.has(target)) {
      byTarget.set(target, entry);
    }

    entries.push(entry);
  });

  return { lines, entries, byTarget };
}

/**
 * Rekonstruiše liniju xref entry-ja.
 */
function buildNavLine(indent, stars, target, label) {
  const safeLabel = label || "";
  return `${indent}${stars} xref:${target}[${safeLabel}]`;
}

// ---------- PRE-MODE: provjera za nove primarne stranice ----------

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
    // Očekujemo putanju tipa docs-en/modules/ROOT/pages/test-page.adoc
    let lang = "";
    let pageId = "";

    if (pagePath.startsWith("docs-en/modules/ROOT/pages/")) {
      lang = "en";
      pageId = pagePath.replace("docs-en/modules/ROOT/pages/", "");
    } else if (pagePath.startsWith("docs-sr/modules/ROOT/pages/")) {
      lang = "sr";
      pageId = pagePath.replace("docs-sr/modules/ROOT/pages/", "");
    } else {
      // Nije standardna lokacija, preskačemo
      continue;
    }

    const pageInfo = await getPageInfo(pageId);

    // Stranica moze biti primarna en ili sr, zavisno od :primary-lang:
    let isPrimary = false;
    if (lang === "en" && pageInfo.enPrimary) isPrimary = true;
    if (lang === "sr" && pageInfo.srPrimary) isPrimary = true;

    if (!isPrimary) continue; // ako stranica nije primarna, ne forsiramo nav entry ovdje

    const navToCheck = lang === "en" ? enNav : srNav;
    if (!navToCheck.byTarget.has(pageId)) {
      missingInNav[lang].push(pageId);
    }
  }

  if (missingInNav.en.length === 0 && missingInNav.sr.length === 0) {
    console.log("✅ Navigation PRE-check passed: all new primary pages are present in nav.");
    return 0;
  }

  console.log("⛔ Navigation PRE-check failed.\n");

  if (missingInNav.en.length > 0) {
    console.log("The following NEW EN primary pages are missing from EN nav.adoc:");
    missingInNav.en.forEach((p) => console.log(`  - ${p}`));
    console.log("");
  }

  if (missingInNav.sr.length > 0) {
    console.log("The following NEW SR primary pages are missing from SR nav.adoc:");
    missingInNav.sr.forEach((p) => console.log(`  - ${p}`));
    console.log("");
  }

  console.log("How to fix PRE-check:");
  console.log("  1. Open the appropriate nav file(s):");
  console.log("       - docs-en/modules/ROOT/nav.adoc");
  console.log("       - docs-sr/modules/ROOT/nav.adoc");
  console.log("  2. For each new primary page listed above, add an xref entry, for example:");
  console.log("       * xref:test-page.adoc[Some title]");
  console.log("  3. Stage the updated nav.adoc file(s) and retry the commit.\n");

  return 1;
}

// ---------- AI prevod labela ----------

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

async function translateLabel(label, sourceLang, targetLang) {
  // Ako nema label-a ili nema API key-a, samo vracamo original
  if (!label || !label.trim()) return label;
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
                `Keep it short and natural for a sidebar menu. Return only the translated label, no quotes, no extra text:\n\n` +
                label,
            },
          ],
        },
      ],
      temperature: 0,
    });

    const out = response.output?.[0]?.content?.[0]?.text || label;
    const trimmed = out.trim();
    if (!trimmed) return label;
    return trimmed;
  } catch (err) {
    console.log(
      `⚠️  Failed to translate nav label "${label}" from ${sourceLang} to ${targetLang}:`,
      String(err)
    );
    return label;
  }
}

// ---------- POST-MODE: automatsko usklađivanje NAV ----------

async function runPostSync() {
  console.log("🧭 Running EN/SR navigation POST auto-sync...");

  const enNavExists = await fileExists(EN_NAV_PATH);
  const srNavExists = await fileExists(SR_NAV_PATH);

  if (!enNavExists && !srNavExists) {
    console.log("ℹ️  No EN/SR nav.adoc files found. Skipping navigation POST validation.");
    return 0;
  }

  const enNavContent = enNavExists ? await readFileRequired(EN_NAV_PATH) : "";
  const srNavContent = srNavExists ? await readFileRequired(SR_NAV_PATH) : "";

  const enNav = parseNav(enNavContent || "");
  const srNav = parseNav(srNavContent || "");

  // Skupljamo sve pageId-ove koji se pojavljuju u bar jednom nav-u
  const allTargets = new Set();
  for (const e of enNav.entries) allTargets.add(e.target);
  for (const e of srNav.entries) allTargets.add(e.target);

  const enLines = enNav.lines.slice();
  const srLines = srNav.lines.slice();

  let enNavChanged = false;
  let srNavChanged = false;

  const unresolvedProblems = [];

  for (const target of allTargets) {
    const pageId = target; // trenutno pretpostavljamo da je target = "test-page.adoc"

    const info = await getPageInfo(pageId);
    const enEntry = enNav.byTarget.get(target) || null;
    const srEntry = srNav.byTarget.get(target) || null;

    // Ako stranica ne postoji ni u EN ni u SR, a pojavljuje se u nav-u -> realan problem
    if (!info.existsEn && !info.existsSr) {
      unresolvedProblems.push(
        `Nav references page "${pageId}" but the page does not exist in EN or SR.`
      );
      continue;
    }

    // Odredjujemo primarni jezik za ovu stranicu
    let primaryLang = null;
    let secondaryLang = null;

    if (info.enPrimary && !info.srPrimary) {
      primaryLang = "en";
      secondaryLang = "sr";
    } else if (info.srPrimary && !info.enPrimary) {
      primaryLang = "sr";
      secondaryLang = "en";
    } else if (info.enPrimary && info.srPrimary) {
      // Ako su oba markirana kao primary (neocekivano), dajemo prednost EN
      primaryLang = "en";
      secondaryLang = "sr";
      console.log(
        `⚠️  Both EN and SR are marked as primary for page "${pageId}". Using EN as primary for nav sync.`
      );
    } else if (info.existsEn && !info.existsSr) {
      // Samo EN verzija postoji -> nav moze da postoji samo u EN; u SR ne radimo nista
      // Ako postoji SR nav bez stranice, to je problem
      if (srEntry) {
        unresolvedProblems.push(
          `SR nav references "${pageId}" but SR page does not exist.`
        );
      }
      continue;
    } else if (info.existsSr && !info.existsEn) {
      // Samo SR verzija postoji
      if (enEntry) {
        unresolvedProblems.push(
          `EN nav references "${pageId}" but EN page does not exist.`
        );
      }
      continue;
    } else {
      // Neki cudan slucaj, preskacemo
      continue;
    }

    const primaryNav = primaryLang === "en" ? enNav : srNav;
    const secondaryNav = primaryLang === "en" ? srNav : enNav;
    const primaryLines = primaryLang === "en" ? enLines : srLines;
    const secondaryLines = primaryLang === "en" ? srLines : enLines;
    const setPrimaryChanged = primaryLang === "en"
      ? (v) => {
          enNavChanged = enNavChanged || v;
        }
      : (v) => {
          srNavChanged = srNavChanged || v;
        };
    const setSecondaryChanged = primaryLang === "en"
      ? (v) => {
          srNavChanged = srNavChanged || v;
        }
      : (v) => {
          enNavChanged = enNavChanged || v;
        };

    const primaryEntry = primaryNav.byTarget.get(target) || null;
    const secondaryEntry = secondaryNav.byTarget.get(target) || null;

    // Ako primary nav NEMA entry, a secondary ima -> ovo je sumnjivo.
    // Po filozofiji: primary se edituje ručno, secondary automatski.
    // Ako se desi ovo, prijavimo kao problem i ne diramo automatski.
    if (!primaryEntry && secondaryEntry) {
      unresolvedProblems.push(
        `Page "${pageId}" is primary in ${primaryLang.toUpperCase()}, but nav entry exists only in ${secondaryLang.toUpperCase()} nav. Please add it manually to ${primaryLang.toUpperCase()} nav.`
      );
      continue;
    }

    // Ako nema primary entry-ja -> ne radimo nista ovdje (primary nav treba prvo da se popravi)
    if (!primaryEntry) {
      continue;
    }

    // Sada pravimo canonical sekundarni entry:
    //  - ista dubina (*, **, ...)
    //  - target isti (pageId)
    //  - label = AI prevod label-e iz primary nav-a
    let newSecondaryLabel;
    if (primaryLang === secondaryLang) {
      newSecondaryLabel = primaryEntry.label;
    } else {
      newSecondaryLabel = await translateLabel(
        primaryEntry.label,
        primaryLang,
        secondaryLang
      );
    }

    const newSecondaryLine = buildNavLine(
      primaryEntry.indent,
      primaryEntry.stars,
      target,
      newSecondaryLabel
    );

    if (!secondaryEntry) {
      // Nema entry-ja u sekundarnom nav-u -> dodajemo na kraj
      console.log(
        `🧭 Adding nav entry in ${secondaryLang.toUpperCase()} nav for page ${pageId}`
      );
      secondaryLines.push(newSecondaryLine);
      setSecondaryChanged(true);
    } else {
      // Postoji entry u sekundarnom nav-u -> provjerimo da li treba update
      const needUpdate =
        secondaryEntry.indent !== primaryEntry.indent ||
        secondaryEntry.stars !== primaryEntry.stars ||
        secondaryEntry.target !== primaryEntry.target ||
        secondaryEntry.label !== newSecondaryLabel;

      if (needUpdate) {
        console.log(
          `🧭 Updating nav entry in ${secondaryLang.toUpperCase()} nav for page ${pageId}`
        );
        // Azuriramo liniju na istoj poziciji
        secondaryLines[secondaryEntry.lineIndex] = newSecondaryLine;
        setSecondaryChanged(true);
      }
    }
  }

  // Upis promjena (ako ih ima)
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

  console.log("✅ Navigation POST auto-sync & validation passed. EN and SR nav files are consistent.");
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