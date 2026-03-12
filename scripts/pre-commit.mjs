#!/usr/bin/env node
/**
 * Cross-platform pre-commit hook (Node.js) for Antora EN/SR docs.
 *
 * New metadata model:
 *   :page-lang: en|sr
 *   :translation-source: en|sr
 *
 * Meaning:
 * - page-lang: actual language of this concrete file
 * - translation-source: source of truth for the EN/SR page pair
 *
 * Behavior:
 * - nav PRE-check for NEW pages
 * - ensure page metadata
 * - enforce metadata consistency
 * - prevent manual edits on secondary pages
 * - translation pipelines:
 *    EN-source: docs-en -> docs-sr
 *    SR-source: docs-sr -> docs-en
 * - SAFE fallback logic depending on TRANSLATION_MODE
 * - language detection for source pages
 * - format staged .adoc files
 * - nav POST validation (+ stage nav files)
 *
 * Temp workflow:
 * - generated files are first written into a temp folder
 * - validation runs against temp output
 * - only after success is temp output promoted to final destination
 *
 * Env vars:
 *   TRANSLATION_MODE=normal|strict|off
 *   LANGUAGE_CHECK_MODE=strict|warn|off
 *   LANGUAGE_CHECK_INCLUDE_UPDATED=0|1
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import path from "node:path";

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: opts.stdio ?? "pipe",
    shell: false,
  });
}

function runOk(cmd, args, opts = {}) {
  const r = run(cmd, args, opts);
  if (r.status !== 0) {
    const err = r.stderr?.trim();
    if (err) process.stderr.write(err + "\n");
    throw Object.assign(new Error(`${cmd} ${args.join(" ")} failed`), {
      status: r.status ?? 1,
    });
  }
  return r.stdout?.toString().trim() ?? "";
}

function git(args, opts = {}) {
  return runOk("git", args, opts);
}

function gitTry(args) {
  const r = run("git", args, { stdio: "pipe" });
  if (r.status !== 0) return "";
  return (r.stdout ?? "").toString().trim();
}

function gitTryRaw(args) {
  const r = run("git", args, { stdio: "pipe" });
  if (r.status !== 0) return "";
  return (r.stdout ?? "").toString();
}

function nodeScript(scriptFile, args = [], { allowFail = false } = {}) {
  const p = path.join("scripts", scriptFile);
  const r = run(process.execPath, [p, ...args], { stdio: "inherit" });
  if (!allowFail && r.status !== 0) {
    throw Object.assign(new Error(`node ${p} failed`), {
      status: r.status ?? 1,
    });
  }
  return r.status ?? 0;
}

function loadDotEnvIfPresent() {
  if (!existsSync(".env")) return;
  console.log("ℹ️  Loading environment variables from .env...");
  const content = readFileSync(".env", "utf8");

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();

    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

function getStagedNameStatus(patterns) {
  const out = gitTryRaw([
    "diff",
    "--cached",
    "--name-status",
    "-z",
    "--",
    ...patterns,
  ]);
  if (!out) return [];

  const parts = out.split("\0").filter(Boolean);
  const res = [];

  for (let i = 0; i < parts.length; ) {
    const status = (parts[i] || "").trim();
    i++;

    if (!status) continue;

    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = parts[i] || "";
      const newPath = parts[i + 1] || "";
      i += 2;
      if (newPath) res.push({ status, file: newPath });
      else if (oldPath) res.push({ status, file: oldPath });
      continue;
    }

    const file = parts[i] || "";
    i++;
    if (file) res.push({ status, file });
  }

  return res;
}

function getStagedFiles(patterns) {
  const out = gitTryRaw([
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--",
    ...patterns,
  ]);
  if (!out) return [];
  return out.split("\0").filter(Boolean);
}

function readFileSafe(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function extractAttrValue(content, attrName) {
  const re = new RegExp(`^:${attrName}:\\s*(.+)\\s*$`, "im");
  const m = content.match(re);
  return m ? (m[1] || "").trim().toLowerCase() : "";
}

function fileMeta(file) {
  const txt = readFileSafe(file);
  return {
    pageLang: extractAttrValue(txt, "page-lang"),
    translationSource: extractAttrValue(txt, "translation-source"),
  };
}

function defaultLangFromFolder(file) {
  if (file.startsWith("docs-en/")) return "en";
  if (file.startsWith("docs-sr/")) return "sr";
  return "";
}

function ensureMetadata(file) {
  if (file.endsWith("/nav.adoc")) return;
  if (!existsSync(file)) return;

  const txt = readFileSafe(file);
  const folderLang = defaultLangFromFolder(file);
  if (!folderLang) return;

  let next = txt;
  let changed = false;

  if (!/^:page-lang:/im.test(next)) {
    console.log(`🏷️  Adding :page-lang: ${folderLang} to ${file}`);
    next = `:page-lang: ${folderLang}\n${next}`;
    changed = true;
  }

  if (!/^:translation-source:/im.test(next)) {
    console.log(`🏷️  Adding :translation-source: ${folderLang} to ${file}`);
    next = `:translation-source: ${folderLang}\n${next}`;
    changed = true;
  }

  if (changed) {
    writeFileSync(file, next.replace(/^\n+/, ""), "utf8");
    git(["add", file], { stdio: "inherit" });
  }
}

function isNonAscii(s) {
  return /[^\x00-\x7F]/.test(s);
}

function isValidPageFileName(filePath) {
  const base = path.posix.basename(filePath);

  if (!base.endsWith(".adoc")) return { ok: true };

  if (base.includes(" ")) {
    return { ok: false, reason: "contains spaces" };
  }

  if (isNonAscii(base)) {
    return {
      ok: false,
      reason: "contains non-ASCII characters (e.g. diacritics)",
    };
  }

  const name = base.slice(0, -".adoc".length);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    return {
      ok: false,
      reason: "contains invalid characters (allowed: a-z, 0-9, '_' and '-')",
    };
  }

  return { ok: true };
}

function abortInvalidPageFileNames(badFiles) {
  console.log("");
  console.log("⛔ Commit aborted: invalid Antora page filename(s) detected.");
  console.log("");
  console.log("Antora page filenames are technical identifiers used by git hooks,");
  console.log("navigation sync and translation pipelines. Unsafe names cause unstable builds.");
  console.log("");
  console.log("Filename rules for *.adoc pages:");
  console.log("  - ASCII characters only (no diacritics)");
  console.log("  - no spaces");
  console.log("  - allowed characters: a-z, 0-9, '_' and '-'");
  console.log("  - must end with .adoc");
  console.log("");
  console.log("Invalid file(s):");
  for (const b of badFiles) {
    console.log(`  - ${b.file}  (${b.reason})`);
  }
  console.log("");
  console.log("How to fix:");
  console.log('  1) Rename the file to a safe ASCII name (kebab-case or snake_case).');
  console.log('     Example: "My Page Title.adoc" → "my-page-title.adoc"');
  console.log("  2) Update the corresponding xref target in the relevant nav.adoc.");
  console.log("  3) Stage the changes and retry the commit.");
  console.log("");
  process.exit(1);
}

function stripStatusPrefixes(s) {
  let out = (s ?? "").trim();
  while (out.startsWith("STATUS=")) out = out.slice("STATUS=".length);
  return out.trim();
}

function getRepoRootSafe() {
  const root = gitTry(["rev-parse", "--show-toplevel"]);
  return root || process.cwd();
}

function envFilePath(repoRoot) {
  return path.join(repoRoot, ".env");
}

function getLedgerPath(repoRoot) {
  return path.join(repoRoot, ".translation-usage.jsonl");
}

function hasOpenAIKey() {
  return Boolean((process.env.OPENAI_API_KEY || "").trim());
}

function abortMissingEnvOrKey({ reason }) {
  console.log("");
  console.log("❌ Missing .env / OpenAI configuration, but AI work is required for this commit.");
  if (reason) console.log(`   Reason: ${reason}`);
  console.log("");
  console.log("Fix:");
  console.log("  1) Create .env from template:");
  console.log("     cp .env.example .env");
  console.log("  2) Edit .env and set:");
  console.log("     OPENAI_API_KEY=sk-...");
  console.log("");
  console.log("Then re-run the commit.");
  console.log("");
  process.exit(1);
}

function readLedgerTotalsSync(ledgerPath) {
  if (!existsSync(ledgerPath)) {
    return { prompt: 0, completion: 0, total: 0, requests: 0 };
  }

  const text = readFileSync(ledgerPath, "utf8");
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
      continue;
    }

    if (typeof obj.prompt === "number") prompt += obj.prompt;
    if (typeof obj.completion === "number") completion += obj.completion;
    if (typeof obj.total === "number") {
      total += obj.total;
      requests += 1;
    }
  }

  return { prompt, completion, total, requests };
}

function formatInt(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function runLanguageCheck(file, status, LANGUAGE_CHECK_MODE, LANGUAGE_CHECK_INCLUDE_UPDATED) {
  if (LANGUAGE_CHECK_MODE === "off") return;

  const shouldCheck =
    status === "A" || (LANGUAGE_CHECK_INCLUDE_UPDATED === "1" && status === "M");

  if (!shouldCheck) return;

  if (!hasOpenAIKey()) {
    abortMissingEnvOrKey({
      reason: `Language detection is enabled and required for: ${file}`,
    });
  }

  console.log(`🧪 Running language detection for source page: ${file}`);
  const r = run(
    process.execPath,
    [path.join("scripts", "detect-language.mjs"), file],
    { stdio: "inherit" }
  );

  if (r.status === 10) {
    if (LANGUAGE_CHECK_MODE === "strict") {
      console.log(`⛔ Language mismatch detected for source page: ${file}`);
      console.log("   The detected language does not match the :page-lang: marker.");
      console.log("   Please fix the page language (or adjust :page-lang:) and retry the commit.");
      process.exit(1);
    } else {
      console.log(`⚠️  Language mismatch detected for source page (warning mode): ${file}`);
    }
  } else if (r.status !== 0) {
    console.log(`⚠️  Language detection failed for ${file} (see message above). Skipping language check.`);
  }
}

function pagePairFor(file) {
  if (file.startsWith("docs-en/")) {
    return {
      self: file,
      other: file.replace(/^docs-en\//, "docs-sr/"),
      selfLang: "en",
      otherLang: "sr",
    };
  }
  if (file.startsWith("docs-sr/")) {
    return {
      self: file,
      other: file.replace(/^docs-sr\//, "docs-en/"),
      selfLang: "sr",
      otherLang: "en",
    };
  }
  return null;
}

function checkMetadataConsistency(stagedEn, stagedSr) {
  const bad = [];

  for (const f of [...stagedEn, ...stagedSr]) {
    if (!existsSync(f)) continue;
    if (f.endsWith("/nav.adoc")) continue;

    const folderLang = defaultLangFromFolder(f);
    const meta = fileMeta(f);

    if (!meta.pageLang) {
      bad.push(`${f} (missing :page-lang:)`);
    } else if (meta.pageLang !== folderLang) {
      bad.push(`${f} (folder=${folderLang}, :page-lang: ${meta.pageLang})`);
    }

    if (!meta.translationSource) {
      bad.push(`${f} (missing :translation-source:)`);
    } else if (!["en", "sr"].includes(meta.translationSource)) {
      bad.push(`${f} (:translation-source: ${meta.translationSource} is invalid)`);
    }
  }

  if (bad.length) {
    console.log("⛔ Metadata consistency check failed for the following files:");
    for (const b of bad) console.log(`   - ${b}`);
    console.log("");
    console.log("Expected:");
    console.log("  * docs-en/... files must have :page-lang: en");
    console.log("  * docs-sr/... files must have :page-lang: sr");
    console.log("  * :translation-source: must be either en or sr");
    console.log("");
    process.exit(1);
  }
}

function checkPairTranslationSourceConsistency(stagedEn, stagedSr) {
  const touched = new Set([...stagedEn, ...stagedSr].filter((f) => !f.endsWith("/nav.adoc")));

  const pairs = new Map();

  for (const f of touched) {
    const pair = pagePairFor(f);
    if (!pair) continue;
    const key = pair.self.replace(/^docs-(en|sr)\//, "");
    if (!pairs.has(key)) {
      pairs.set(key, {
        en: key.startsWith("modules/") ? `docs-en/${key}` : "",
        sr: key.startsWith("modules/") ? `docs-sr/${key}` : "",
      });
    }
  }

  const bad = [];

  for (const entry of pairs.values()) {
    const enPath = entry.en;
    const srPath = entry.sr;

    if (!enPath || !srPath) continue;
    if (!existsSync(enPath) || !existsSync(srPath)) continue;

    const enMeta = fileMeta(enPath);
    const srMeta = fileMeta(srPath);

    if (
      enMeta.translationSource &&
      srMeta.translationSource &&
      enMeta.translationSource !== srMeta.translationSource
    ) {
      bad.push(
        `${enPath} (:translation-source: ${enMeta.translationSource}) <> ${srPath} (:translation-source: ${srMeta.translationSource})`
      );
    }
  }

  if (bad.length) {
    console.log("⛔ EN/SR page pairs have inconsistent :translation-source: values:");
    for (const b of bad) console.log(`   - ${b}`);
    console.log("");
    console.log("Both files of the same page pair must share the same :translation-source: value.");
    console.log("");
    process.exit(1);
  }
}

function detectManualEditsOnSecondaryPages() {
  const stagedPages = getStagedFiles([
    "docs-en/modules/ROOT/*.adoc",
    "docs-en/modules/ROOT/pages/*.adoc",
    "docs-sr/modules/ROOT/*.adoc",
    "docs-sr/modules/ROOT/pages/*.adoc",
  ]).filter((f) => f.endsWith(".adoc") && !f.endsWith("/nav.adoc"));

  const manual = [];

  for (const file of stagedPages) {
    if (!existsSync(file)) continue;

    const pair = pagePairFor(file);
    if (!pair) continue;

    const meta = fileMeta(file);
    if (!meta.translationSource) continue;

    const isSecondary = meta.translationSource !== pair.selfLang;
    if (!isSecondary) continue;

    const sourceFile = pair.other;

    const sourceStaged = getStagedFiles([sourceFile]).length > 0;
    if (sourceStaged) continue;

    manual.push({
      file,
      sourceFile,
      translationSource: meta.translationSource,
    });
  }

  if (manual.length) {
    console.log("⛔ Detected manual changes in secondary translated pages:");
    for (const x of manual) {
      console.log(`   - ${x.file} (source of truth: ${x.sourceFile})`);
    }
    console.log("");
    console.log("This project allows manual edits only in the source-of-truth page.");
    console.log("Secondary translated pages are generated automatically during pre-commit.");
    console.log("");
    console.log("Please move your edits to the source page and retry the commit.");
    console.log("");
    process.exit(1);
  }
}

// ---------------- temp helpers ----------------

function createTempRoot(repoRoot) {
  const tempRoot = path.join(
    repoRoot,
    ".tmp-precommit",
    `${Date.now()}-${process.pid}`
  );
  mkdirSync(tempRoot, { recursive: true });
  return tempRoot;
}

function toTempPath(tempRoot, finalPath) {
  return path.join(tempRoot, finalPath);
}

function ensureParentDir(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function promoteTempFile(tempPath, finalPath) {
  if (!existsSync(tempPath)) {
    throw new Error(`Temp file not found for promotion: ${tempPath}`);
  }
  ensureParentDir(finalPath);
  copyFileSync(tempPath, finalPath);
}

function cleanupTempRoot(tempRoot) {
  if (!tempRoot) return;
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}

function stagePromotedFile(tempPath, finalPath) {
  promoteTempFile(tempPath, finalPath);
  git(["add", finalPath], { stdio: "inherit" });
}

function validateOrAbort(sourceFile, tempTargetFile, failMessageLines) {
  const code = nodeScript("validate-translation.mjs", [sourceFile, tempTargetFile], {
    allowFail: true,
  });
  if (code === 0) return;

  for (const line of failMessageLines) {
    console.log(line);
  }
  process.exit(1);
}

function getTranslationSource(file) {
  const meta = fileMeta(file);
  return meta.translationSource || defaultLangFromFolder(file);
}

function determineAnalyzerResult(file, targetFile, status) {
  if (status === "A") {
    console.log(`ℹ️  New source page detected. Forcing TEXT_AND_STRUCTURE for ${file}.`);
    return "TEXT_AND_STRUCTURE";
  }

  const r = run(
    process.execPath,
    [path.join("scripts", "analyze-changes.mjs"), file, targetFile],
    {
      stdio: "pipe",
      shell: false,
      encoding: "utf8",
    }
  );

  const raw = (r.stdout ?? "").toString().trim();
  return stripStatusPrefixes(raw);
}

// ---------------------------- MAIN ----------------------------
let __TEMP_ROOT__ = "";

try {
  loadDotEnvIfPresent();

  const stagedPageCandidates = getStagedFiles([
    "docs-en/modules/ROOT/pages/*.adoc",
    "docs-sr/modules/ROOT/pages/*.adoc",
  ]);

  const badPages = [];
  for (const f of stagedPageCandidates) {
    const v = isValidPageFileName(f);
    if (!v.ok) badPages.push({ file: f, reason: v.reason });
  }

  if (badPages.length) {
    abortInvalidPageFileNames(badPages);
  }

  const repoRoot = getRepoRootSafe();
  __TEMP_ROOT__ = createTempRoot(repoRoot);

  const envMissing = !existsSync(envFilePath(repoRoot));
  if (envMissing) {
    console.log("ℹ️  .env not found. Create it via: cp .env.example .env (then set OPENAI_API_KEY)");
  }

  const ledgerPath = getLedgerPath(repoRoot);
  const ledgerStart = readLedgerTotalsSync(ledgerPath);

  function cleanEnvValue(v) {
    return (v ?? "").toString().split("#")[0].trim();
  }

  const TRANSLATION_MODE =
    (cleanEnvValue(process.env.TRANSLATION_MODE) || "normal").toLowerCase();

  const LANGUAGE_CHECK_MODE =
    (cleanEnvValue(process.env.LANGUAGE_CHECK_MODE) || "strict").toLowerCase();

  const LANGUAGE_CHECK_INCLUDE_UPDATED =
    cleanEnvValue(process.env.LANGUAGE_CHECK_INCLUDE_UPDATED) || "0";

  let NO_CHANGES_COUNT = 0;
  let STRUCTURAL_ONLY_COUNT = 0;
  let CODE_ONLY_COUNT = 0;
  let TEXT_AND_STRUCTURE_COUNT = 0;
  let SAFE_FALLBACK_COUNT = 0;

  console.log("🧭 Pre-checking navigation for new primary pages...");

  const newPages = getStagedNameStatus([
    "docs-en/modules/ROOT/pages/*.adoc",
    "docs-sr/modules/ROOT/pages/*.adoc",
  ])
    .filter((x) => x.status === "A")
    .map((x) => x.file);

  if (newPages.length) {
    if (existsSync(path.join("scripts", "validate-nav.mjs"))) {
      const code = nodeScript("validate-nav.mjs", ["--pre", ...newPages], {
        allowFail: true,
      });
      if (code !== 0) {
        console.log("⛔ pre-commit: navigation PRE-check failed. Aborting commit.");
        process.exit(code);
      }
    } else {
      console.log("ℹ️  validate-nav.mjs not found. Skipping navigation PRE-check.");
    }
  } else {
    console.log("ℹ️  No NEW .adoc pages detected for navigation PRE-check.");
  }

  console.log("🔁 pre-commit: checking docs .adoc files for translation & sync...");
  console.log(`ℹ️  TRANSLATION_MODE=${TRANSLATION_MODE}`);

  const stagedEnAll = getStagedFiles(["docs-en/**/*.adoc", "docs-en/**/**/*.adoc"]).filter(
    (f) => f.endsWith(".adoc")
  );
  const stagedSrAll = getStagedFiles(["docs-sr/**/*.adoc", "docs-sr/**/**/*.adoc"]).filter(
    (f) => f.endsWith(".adoc")
  );

  for (const f of [...new Set([...stagedEnAll, ...stagedSrAll])]) {
    ensureMetadata(f);
  }

  checkMetadataConsistency(stagedEnAll, stagedSrAll);
  checkPairTranslationSourceConsistency(stagedEnAll, stagedSrAll);
  detectManualEditsOnSecondaryPages();

  const EN_PAGES = getStagedNameStatus([
    "docs-en/modules/ROOT/*.adoc",
    "docs-en/modules/ROOT/pages/*.adoc",
  ])
    .filter(({ status, file }) => status !== "D" && file && !file.endsWith("/nav.adoc"))
    .map(({ file }) => file);

  const SR_PAGES = getStagedNameStatus([
    "docs-sr/modules/ROOT/*.adoc",
    "docs-sr/modules/ROOT/pages/*.adoc",
  ])
    .filter(({ status, file }) => status !== "D" && file && !file.endsWith("/nav.adoc"))
    .map(({ file }) => file);

  const EN_SOURCE_FILES = EN_PAGES.filter((f) => getTranslationSource(f) === "en");
  const SR_SOURCE_FILES = SR_PAGES.filter((f) => getTranslationSource(f) === "sr");

  if (TRANSLATION_MODE !== "off" && EN_SOURCE_FILES.length) {
    console.log("📄 Staged EN source-of-truth .adoc files:");
    for (const f of EN_SOURCE_FILES) console.log(f);
  }

  if (TRANSLATION_MODE !== "off") {
    for (const FILE of EN_SOURCE_FILES) {
      const ns = getStagedNameStatus([FILE])[0];
      const STATUS = ns?.status ?? "";

      runLanguageCheck(FILE, STATUS, LANGUAGE_CHECK_MODE, LANGUAGE_CHECK_INCLUDE_UPDATED);

      const SR_FILE = FILE.replace(/^docs-en\//, "docs-sr/");
      const TEMP_SR_FILE = toTempPath(__TEMP_ROOT__, SR_FILE);

      const ANALYZER_RESULT = determineAnalyzerResult(FILE, SR_FILE, STATUS);

      switch (ANALYZER_RESULT) {
        case "NO_CHANGES":
          NO_CHANGES_COUNT++;
          break;

        case "STRUCTURAL_ONLY":
          console.log(`ℹ️  Analyzer result (EN-source): STRUCTURAL_ONLY for ${FILE}. Syncing structure EN -> SR without AI.`);
          STRUCTURAL_ONLY_COUNT++;
          nodeScript("sync-structure.mjs", [FILE, SR_FILE, TEMP_SR_FILE, "--direction=en-sr"]);
          stagePromotedFile(TEMP_SR_FILE, SR_FILE);
          break;

        case "CODE_ONLY":
          console.log(`ℹ️  Analyzer result (EN-source): CODE_ONLY for ${FILE}. Syncing code blocks EN -> SR without AI.`);
          CODE_ONLY_COUNT++;
          nodeScript("sync-code-blocks.mjs", [FILE, SR_FILE, TEMP_SR_FILE, "--direction=en-sr"]);
          stagePromotedFile(TEMP_SR_FILE, SR_FILE);
          break;

        case "TEXT_AND_STRUCTURE":
          console.log(`ℹ️  Analyzer result (EN-source): TEXT_AND_STRUCTURE for ${FILE}. Calling AI translation EN -> SR.`);
          TEXT_AND_STRUCTURE_COUNT++;

          if (!hasOpenAIKey()) {
            abortMissingEnvOrKey({
              reason: `Translation is required (EN → SR) for: ${FILE}`,
            });
          }

          if (TRANSLATION_MODE === "strict") {
            console.log(`🌐 Translating (EN → SR, SAFE MODE ONLY): ${FILE}`);
            nodeScript("translate-adoc.mjs", [FILE, TEMP_SR_FILE, "--direction=en-sr", "--safe"]);

            validateOrAbort(FILE, TEMP_SR_FILE, [
              `❌ Translation validation FAILED (EN → SR, STRICT/SAFE ONLY) for ${FILE}.`,
              "    Please fix the translation manually and retry the commit.",
            ]);
          } else {
            console.log(`🌐 Translating (EN → SR, NORMAL MODE): ${FILE}`);
            nodeScript("translate-adoc.mjs", [FILE, TEMP_SR_FILE, "--direction=en-sr"]);

            const v1 = nodeScript("validate-translation.mjs", [FILE, TEMP_SR_FILE], {
              allowFail: true,
            });

            if (v1 !== 0) {
              console.log(`⚠️ Validation failed for ${FILE} in EN → SR NORMAL MODE. Retrying in SAFE MODE...`);
              nodeScript("translate-adoc.mjs", [FILE, TEMP_SR_FILE, "--direction=en-sr", "--safe"]);

              const v2 = nodeScript("validate-translation.mjs", [FILE, TEMP_SR_FILE], {
                allowFail: true,
              });

              if (v2 !== 0) {
                console.log(`❌ SAFE MODE translation validation FAILED for ${FILE} (EN → SR).`);
                console.log("    Please inspect the EN/SR files and fix manually.");
                process.exit(1);
              }

              SAFE_FALLBACK_COUNT++;
            }
          }

          stagePromotedFile(TEMP_SR_FILE, SR_FILE);
          break;

        default:
          if (ANALYZER_RESULT) {
            console.log(`⚠️  Unknown analyzer result for EN-source page ${FILE}: STATUS=${ANALYZER_RESULT}`);
          } else {
            console.log(`⚠️  Analyzer did not return a status for EN-source page ${FILE}. Skipping.`);
          }
          break;
      }
    }
  }

  if (TRANSLATION_MODE !== "off" && SR_SOURCE_FILES.length) {
    console.log("🔍 Analyzing SR source-of-truth page changes in:");
    for (const f of SR_SOURCE_FILES) console.log(f);
  }

  if (TRANSLATION_MODE !== "off") {
    for (const FILE of SR_SOURCE_FILES) {
      const ns = getStagedNameStatus([FILE])[0];
      const STATUS = ns?.status ?? "";

      runLanguageCheck(FILE, STATUS, LANGUAGE_CHECK_MODE, LANGUAGE_CHECK_INCLUDE_UPDATED);

      const EN_FILE = FILE.replace(/^docs-sr\//, "docs-en/");
      const TEMP_EN_FILE = toTempPath(__TEMP_ROOT__, EN_FILE);

      const ANALYZER_RESULT = determineAnalyzerResult(FILE, EN_FILE, STATUS);

      switch (ANALYZER_RESULT) {
        case "NO_CHANGES":
          NO_CHANGES_COUNT++;
          break;

        case "STRUCTURAL_ONLY":
          console.log(`ℹ️  Analyzer result (SR-source): STRUCTURAL_ONLY for ${FILE}. Syncing structure SR -> EN without AI.`);
          STRUCTURAL_ONLY_COUNT++;
          nodeScript("sync-structure.mjs", [FILE, EN_FILE, TEMP_EN_FILE, "--direction=sr-en"]);
          stagePromotedFile(TEMP_EN_FILE, EN_FILE);
          break;

        case "CODE_ONLY":
          console.log(`ℹ️  Analyzer result (SR-source): CODE_ONLY for ${FILE}. Syncing code blocks SR -> EN without AI.`);
          CODE_ONLY_COUNT++;
          nodeScript("sync-code-blocks.mjs", [FILE, EN_FILE, TEMP_EN_FILE, "--direction=sr-en"]);
          stagePromotedFile(TEMP_EN_FILE, EN_FILE);
          break;

        case "TEXT_AND_STRUCTURE":
          console.log(`ℹ️  Analyzer result (SR-source): TEXT_AND_STRUCTURE for ${FILE}. Calling AI translation SR -> EN.`);
          TEXT_AND_STRUCTURE_COUNT++;

          if (!hasOpenAIKey()) {
            abortMissingEnvOrKey({
              reason: `Translation is required (SR → EN) for: ${FILE}`,
            });
          }

          if (TRANSLATION_MODE === "strict") {
            console.log(`🌐 Translating (SR → EN, SAFE MODE ONLY): ${FILE}`);
            nodeScript("translate-adoc.mjs", [FILE, TEMP_EN_FILE, "--direction=sr-en", "--safe"]);

            validateOrAbort(FILE, TEMP_EN_FILE, [
              `❌ Translation validation FAILED (SR → EN, STRICT/SAFE ONLY) for ${FILE}.`,
              "    Please fix the translation manually and retry the commit.",
            ]);
          } else {
            console.log(`🌐 Translating (SR → EN, NORMAL MODE): ${FILE}`);
            nodeScript("translate-adoc.mjs", [FILE, TEMP_EN_FILE, "--direction=sr-en"]);

            const v1 = nodeScript("validate-translation.mjs", [FILE, TEMP_EN_FILE], {
              allowFail: true,
            });

            if (v1 !== 0) {
              console.log(`⚠️ Validation failed for ${FILE} in SR → EN NORMAL MODE. Retrying in SAFE MODE...`);
              nodeScript("translate-adoc.mjs", [FILE, TEMP_EN_FILE, "--direction=sr-en", "--safe"]);

              const v2 = nodeScript("validate-translation.mjs", [FILE, TEMP_EN_FILE], {
                allowFail: true,
              });

              if (v2 !== 0) {
                console.log(`❌ SAFE MODE translation validation FAILED for ${FILE} (SR → EN).`);
                console.log("    Please inspect the SR/EN files and fix manually.");
                process.exit(1);
              }

              SAFE_FALLBACK_COUNT++;
            }
          }

          stagePromotedFile(TEMP_EN_FILE, EN_FILE);
          break;

        default:
          if (ANALYZER_RESULT) {
            console.log(`⚠️  Unknown analyzer result for SR-source page ${FILE}: STATUS=${ANALYZER_RESULT}`);
          } else {
            console.log(`⚠️  Analyzer did not return a status for SR-source page ${FILE}. Skipping.`);
          }
          break;
      }
    }
  }

  const stagedAdocAll = getStagedFiles(["**/*.adoc"]);
  if (stagedAdocAll.length && existsSync(path.join("scripts", "format-adoc.mjs"))) {
    console.log("🧹 Running AsciiDoc formatter on staged .adoc files...");
    for (const f of stagedAdocAll) {
      if (!existsSync(f)) continue;
      const code = nodeScript("format-adoc.mjs", [f], { allowFail: true });
      if (code !== 0) {
        console.log(`❌ AsciiDoc formatter failed for: ${f}`);
        console.log("   Please fix the issue and try the commit again.");
        process.exit(1);
      }
      git(["add", f], { stdio: "inherit" });
    }
  }

  console.log("🧭 Validating EN/SR navigation (nav.adoc) consistency...");
  if (existsSync(path.join("scripts", "validate-nav.mjs"))) {
    const navCode = nodeScript("validate-nav.mjs", [], { allowFail: true });
    if (navCode !== 0) {
      console.log("⛔ pre-commit: navigation POST validation failed. Aborting commit.");
      process.exit(navCode);
    }
    if (existsSync("docs-en/modules/ROOT/nav.adoc")) {
      git(["add", "docs-en/modules/ROOT/nav.adoc"], { stdio: "inherit" });
    }
    if (existsSync("docs-sr/modules/ROOT/nav.adoc")) {
      git(["add", "docs-sr/modules/ROOT/nav.adoc"], { stdio: "inherit" });
    }
  } else {
    console.log("ℹ️  validate-nav.mjs not found. Skipping navigation validation.");
  }

  console.log("📊 Translation summary for this commit:");
  console.log(`   MODE:                ${TRANSLATION_MODE}`);
  console.log(`   LANGUAGE_CHECK_MODE: ${LANGUAGE_CHECK_MODE} (updated=${LANGUAGE_CHECK_INCLUDE_UPDATED})`);
  console.log(`   NO_CHANGES:          ${NO_CHANGES_COUNT} file(s)`);
  console.log(`   STRUCTURAL_ONLY:     ${STRUCTURAL_ONLY_COUNT} file(s)`);
  console.log(`   CODE_ONLY:           ${CODE_ONLY_COUNT} file(s)`);
  console.log(`   TEXT_AND_STRUCTURE:  ${TEXT_AND_STRUCTURE_COUNT} file(s)`);
  console.log(`   SAFE_FALLBACK_USED:  ${SAFE_FALLBACK_COUNT} time(s)`);

  const ledgerEnd = readLedgerTotalsSync(ledgerPath);
  const delta = {
    requests: ledgerEnd.requests - ledgerStart.requests,
    prompt: ledgerEnd.prompt - ledgerStart.prompt,
    completion: ledgerEnd.completion - ledgerStart.completion,
    total: ledgerEnd.total - ledgerStart.total,
  };

  console.log("🔢 Token usage (OpenAI) — this commit:");
  if (delta.total === 0 && delta.requests === 0) {
    console.log("ℹ️  Token usage: 0 (no AI calls in this commit)");
  }
  console.log(`   REQUESTS:           ${formatInt(delta.requests)}`);
  console.log(`   PROMPT_TOKENS:      ${formatInt(delta.prompt)}`);
  console.log(`   COMPLETION_TOKENS:  ${formatInt(delta.completion)}`);
  console.log(`   TOTAL_TOKENS:       ${formatInt(delta.total)}`);

  console.log("🔢 Token usage (OpenAI) — cumulative (local ledger):");
  console.log(`   REQUESTS:           ${formatInt(ledgerEnd.requests)}`);
  console.log(`   PROMPT_TOKENS:      ${formatInt(ledgerEnd.prompt)}`);
  console.log(`   COMPLETION_TOKENS:  ${formatInt(ledgerEnd.completion)}`);
  console.log(`   TOTAL_TOKENS:       ${formatInt(ledgerEnd.total)}`);

  console.log("✅ pre-commit: translation step completed.");
  cleanupTempRoot(__TEMP_ROOT__);
  process.exit(0);
} catch (e) {
  cleanupTempRoot(__TEMP_ROOT__);
  console.error("⛔ pre-commit failed.");
  if (e?.message) console.error(e.message);
  process.exit(e?.status ?? 1);
}