// translate-adoc.mjs
// Translates an AsciiDoc (.adoc) file between English and Serbian (latin alphabet)
// while preserving all Antora / AsciiDoc structure.
//
// Supported directions:
//   --direction=en-sr (default)  -> English (source) to Serbian (target)
//   --direction=sr-en            -> Serbian (source) to English (target)

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import {
  appendUsageEntry,
  extractUsageFromOpenAIResponse,
  getDefaultLedgerPath
} from './token-ledger.mjs';

let __LAST_OUTPUT_PATH__ = null;

function pickTranslateModel() {
  const model =
    (process.env.OPENAI_MODEL_TRANSLATE || '').trim() ||
    (process.env.OPENAI_MODEL_DEFAULT || '').trim();

  if (!model) {
    throw new Error(
      'Missing OpenAI model configuration. Set OPENAI_MODEL_DEFAULT (and optionally OPENAI_MODEL_TRANSLATE) in .env'
    );
  }

  if ((process.env.OPENAI_LOG_MODEL || '').trim() === '1') {
    console.log(`ℹ️  Using OpenAI model (translate): ${model}`);
  }

  return model;
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// System prompts for EN->SR (normal + SAFE)
const normalInstructionsEnSr = `
You are a professional technical translator from English to Serbian (latin alphabet).

You are given an AsciiDoc (.adoc) document used in Antora documentation.

IMPORTANT RULES (MUST FOLLOW):
- Do NOT change any AsciiDoc syntax or structure.
- Preserve line order EXACTLY.
- Do NOT add, remove or reorder lines.
- Do NOT move headings to another line.
- Do NOT insert blank lines at the top of the document.
- Do NOT change heading markup (=, ==, ===, etc.), only translate the text after them.
- Do NOT change roles, attributes, IDs, anchors, xrefs, include directives or macros.
- Do NOT change URLs, xrefs, file paths or attribute names.
- Keep all inline formatting markers (*bold*, _italic_, \`monospace\`) as they are, only translate the human-readable text.
- Keep lists (-, *, .) and their structure unchanged, only translate the text.
- Keep table structure unchanged, only translate the cell text.
- Do NOT add explanations or comments.
- Placeholder lines that look like @@PROTECTED_LINE_...@@ must remain EXACTLY unchanged.
- Keep metadata lines in place if present, but do not invent extra attributes.
- If you are unsure how to translate a line without changing structure, leave that line unchanged.

Return ONLY the translated AsciiDoc document, same structure, just with Serbian text where appropriate.
`.trim();

const safeModeInstructionsEnSr = `
You are a professional technical translator from English to Serbian (latin alphabet) in SAFE MODE.

You are given an AsciiDoc (.adoc) document used in Antora documentation.

You MUST obey ALL of the following rules:

STRUCTURE PRESERVATION (CRITICAL):
- Do NOT change any AsciiDoc syntax or structure.
- Do NOT change heading markup (=, ==, ===, etc.) at all.
- Do NOT change roles, attributes, IDs, anchors, xrefs, include directives or macros.
- Do NOT change or remove any AsciiDoc macros: xref:, include::, image::, etc.
- Do NOT change attribute line names (:page-...: and similar metadata names).
- Do NOT change URLs, xrefs targets, file paths or attribute names.
- Do NOT add, remove or reorder lines.

PROTECTED PLACEHOLDERS (CRITICAL):
- Placeholder lines that look like @@PROTECTED_LINE_...@@ must remain EXACTLY unchanged.
- Do not translate them, do not wrap them, do not add punctuation, spaces or comments to them.

TRANSLATION SCOPE:
- Translate ONLY human-readable natural language text outside protected placeholders.
- If translating a sentence would require you to modify any structure, macro, attribute name, code or delimiter, LEAVE THAT PART EXACTLY AS IN THE ORIGINAL ENGLISH.

OUTPUT:
- Return ONLY the translated AsciiDoc document.
- The output MUST have the same number of lines and the same AsciiDoc structure as the input.
`.trim();

// System prompts for SR->EN (normal + SAFE)
const normalInstructionsSrEn = `
You are a professional technical translator from Serbian (latin alphabet) to English.

You are given an AsciiDoc (.adoc) document used in Antora documentation.

IMPORTANT RULES (MUST FOLLOW):
- Do NOT change any AsciiDoc syntax or structure.
- Preserve line order EXACTLY.
- Do NOT add, remove or reorder lines.
- Do NOT move headings to another line.
- Do NOT insert blank lines at the top of the document.
- Do NOT change heading markup (=, ==, ===, etc.), only translate the text after them.
- Do NOT change roles, attributes, IDs, anchors, xrefs, include directives or macros.
- Do NOT change URLs, xrefs, file paths or attribute names.
- Keep all inline formatting markers (*bold*, _italic_, \`monospace\`) as they are, only translate the human-readable text.
- Keep lists (-, *, .) and their structure unchanged, only translate the text.
- Keep table structure unchanged, only translate the cell text.
- Do NOT add explanations or comments.
- Placeholder lines that look like @@PROTECTED_LINE_...@@ must remain EXACTLY unchanged.
- Keep metadata lines in place if present, but do not invent extra attributes.
- If you are unsure how to translate a line without changing structure, leave that line unchanged.

Return ONLY the translated AsciiDoc document, same structure, just with English text where appropriate.
`.trim();

const safeModeInstructionsSrEn = `
You are a professional technical translator from Serbian (latin alphabet) to English in SAFE MODE.

You are given an AsciiDoc (.adoc) document used in Antora documentation.

You MUST obey ALL of the following rules:

STRUCTURE PRESERVATION (CRITICAL):
- Do NOT change any AsciiDoc syntax or structure.
- Do NOT change heading markup (=, ==, ===, etc.) at all.
- Do NOT change roles, attributes, IDs, anchors, xrefs, include directives or macros.
- Do NOT change or remove any AsciiDoc macros: xref:, include::, image::, etc.
- Do NOT change attribute line names (:page-...: and similar metadata names).
- Do NOT change URLs, xrefs targets, file paths or attribute names.
- Do NOT add, remove or reorder lines.

PROTECTED PLACEHOLDERS (CRITICAL):
- Placeholder lines that look like @@PROTECTED_LINE_...@@ must remain EXACTLY unchanged.
- Do not translate them, do not wrap them, do not add punctuation, spaces or comments to them.

TRANSLATION SCOPE:
- Translate ONLY human-readable natural language text outside protected placeholders.
- If translating a sentence would require you to modify any structure, macro, attribute name, code or delimiter, LEAVE THAT PART EXACTLY AS IN THE ORIGINAL SERBIAN.

OUTPUT:
- Return ONLY the translated AsciiDoc document.
- The output MUST have the same number of lines and the same AsciiDoc structure as the input.
`.trim();

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable response object]';
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createSpinner(message) {
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0;

  process.stdout.write(`${frames[0]} ${message}`);

  const timer = setInterval(() => {
    const frame = frames[i = (i + 1) % frames.length];
    process.stdout.write(`\r${frame} ${message}`);
  }, 80);

  return () => {
    clearInterval(timer);
    process.stdout.write(`\r✔ ${message}\n`);
  };
}

function extractAttrValue(text, attrName) {
  const re = new RegExp(`^:${attrName}:\\s*(.+)\\s*$`, 'im');
  const m = text.match(re);
  return m ? (m[1] || '').trim().toLowerCase() : '';
}

function folderLangFromPath(filePath) {
  if (filePath.startsWith('docs-en/')) return 'en';
  if (filePath.startsWith('docs-sr/')) return 'sr';
  return '';
}

function getSourceTranslationSource(adocText, inputPath) {
  const fromAttr = extractAttrValue(adocText, 'translation-source');
  if (fromAttr === 'en' || fromAttr === 'sr') return fromAttr;

  const fallback = folderLangFromPath(inputPath);
  if (fallback === 'en' || fallback === 'sr') return fallback;

  return '';
}

function getTargetPageLang(direction) {
  return direction === 'sr-en' ? 'en' : 'sr';
}

function isListingBlockAttributeLine(line) {
  const trimmed = line.trim();
  return /^\[(source|listing|literal)(%[^\]]+)?(?:,[^\]]*)?\]$/i.test(trimmed);
}

function isBacktickFence(line) {
  return /^```/.test(line.trim());
}

function isProtectedDelimiter(line) {
  const trimmed = line.trim();
  return trimmed === '----' || trimmed === '....' || isBacktickFence(trimmed);
}

function isAttributeLine(line) {
  return /^:[^:]+:\s*.*$/i.test(line.trim());
}

function isMacroOnlyLine(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('include::') ||
    trimmed.startsWith('xref:') ||
    trimmed.startsWith('image::')
  );
}

function isAnchorLine(line) {
  const trimmed = line.trim();
  return /^\[\[[^\]]+\]\]$/.test(trimmed);
}

function isProtectedSingleLine(line) {
  return (
    isAttributeLine(line) ||
    isMacroOnlyLine(line) ||
    isAnchorLine(line)
  );
}

function findClosingDelimiter(lines, startIndex, openerLine) {
  const openerTrimmed = openerLine.trim();

  if (isBacktickFence(openerTrimmed)) {
    for (let i = startIndex + 1; i < lines.length; i++) {
      if (isBacktickFence(lines[i])) {
        return i;
      }
    }
    return -1;
  }

  for (let i = startIndex + 1; i < lines.length; i++) {
    if (lines[i].trim() === openerTrimmed) {
      return i;
    }
  }

  return -1;
}

/**
 * Protect code/literal/listing blocks before sending the document to the model.
 * Each protected line is replaced by a unique placeholder line to preserve line count.
 *
 * Extended with protection for single-line non-translatable regions:
 * - attribute lines
 * - macro-only lines
 * - anchor lines
 */
function protectCodeAndLiteralBlocks(adocText) {
  const lines = adocText.split('\n');
  const protectedLines = new Map();
  const outputLines = [];

  let protectedCounter = 0;

  const nextToken = () => {
    protectedCounter += 1;
    return `@@PROTECTED_LINE_${String(protectedCounter).padStart(6, '0')}@@`;
  };

  let i = 0;
  while (i < lines.length) {
    const currentLine = lines[i];
    const nextLine = i + 1 < lines.length ? lines[i + 1] : null;

    if (
      isListingBlockAttributeLine(currentLine) &&
      nextLine !== null &&
      isProtectedDelimiter(nextLine)
    ) {
      const closingIndex = findClosingDelimiter(lines, i + 1, nextLine);

      if (closingIndex !== -1) {
        for (let j = i; j <= closingIndex; j++) {
          const token = nextToken();
          protectedLines.set(token, lines[j]);
          outputLines.push(token);
        }
        i = closingIndex + 1;
        continue;
      }
    }

    if (isProtectedDelimiter(currentLine)) {
      const closingIndex = findClosingDelimiter(lines, i, currentLine);

      if (closingIndex !== -1) {
        for (let j = i; j <= closingIndex; j++) {
          const token = nextToken();
          protectedLines.set(token, lines[j]);
          outputLines.push(token);
        }
        i = closingIndex + 1;
        continue;
      }
    }

    if (isProtectedSingleLine(currentLine)) {
      const token = nextToken();
      protectedLines.set(token, currentLine);
      outputLines.push(token);
      i += 1;
      continue;
    }

    outputLines.push(currentLine);
    i += 1;
  }

  return {
    protectedText: outputLines.join('\n'),
    protectedLines,
  };
}

function restoreProtectedBlocks(translatedText, protectedLines) {
  let restored = translatedText;

  for (const [token, originalLine] of protectedLines.entries()) {
    const tokenRegex = new RegExp(`^${escapeRegExp(token)}$`, 'gm');
    restored = restored.replace(tokenRegex, originalLine);
  }

  return restored;
}

function collapseExactDuplicatedDocument(text) {
  if (!text || typeof text !== 'string') return text;

  const normalized = text.replace(/\r\n/g, '\n');

  if (normalized.length % 2 === 0) {
    const half = normalized.length / 2;
    const firstHalf = normalized.slice(0, half);
    const secondHalf = normalized.slice(half);

    if (firstHalf === secondHalf) {
      return firstHalf;
    }
  }

  const titleMatches = [...normalized.matchAll(/^= .+$/gm)];
  if (titleMatches.length >= 2) {
    const secondTitleIndex = titleMatches[1].index;
    const firstDoc = normalized.slice(0, secondTitleIndex).trim();
    const secondDoc = normalized.slice(secondTitleIndex).trim();

    if (firstDoc && firstDoc === secondDoc) {
      return `${firstDoc}\n`;
    }
  }

  return text;
}

function collectOutputTextFromResponse(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text;
  }

  const parts = [];

  if (Array.isArray(response?.output)) {
    for (const outputItem of response.output) {
      if (!Array.isArray(outputItem?.content)) continue;

      for (const contentItem of outputItem.content) {
        if (
          contentItem?.type === 'output_text' &&
          typeof contentItem?.text === 'string' &&
          contentItem.text.trim()
        ) {
          parts.push(contentItem.text);
          continue;
        }

        if (typeof contentItem?.text === 'string' && contentItem.text.trim()) {
          parts.push(contentItem.text);
          continue;
        }

        if (
          typeof contentItem?.text?.value === 'string' &&
          contentItem.text.value.trim()
        ) {
          parts.push(contentItem.text.value);
        }
      }
    }
  }

  const combined = parts.join('');
  return combined.trim() ? combined : '';
}

function upsertSingleLineAttr(lines, attrName, attrValue) {
  const attrRe = new RegExp(`^:${attrName}:\\s*.*$`, 'i');
  const newLine = `:${attrName}: ${attrValue}`;

  const idx = lines.findIndex((line) => attrRe.test(line));
  if (idx !== -1) {
    lines[idx] = newLine;
    return lines;
  }

  let insertIndex = 0;

  if (lines.length > 0 && /^= /.test(lines[0])) {
    insertIndex = 1;
    while (insertIndex < lines.length && /^:[^:]+:\s*.*$/.test(lines[insertIndex])) {
      insertIndex += 1;
    }
    lines.splice(insertIndex, 0, newLine);
    return lines;
  }

  while (insertIndex < lines.length && /^:[^:]+:\s*.*$/.test(lines[insertIndex])) {
    insertIndex += 1;
  }
  lines.splice(insertIndex, 0, newLine);
  return lines;
}

function removeLegacyPrimaryLang(lines) {
  return lines.filter((line) => !/^:primary-lang:\s*.*$/i.test(line));
}

function normalizeMetadata(adocText, direction, translationSource) {
  const targetPageLang = getTargetPageLang(direction);
  let lines = adocText.split('\n');

  lines = removeLegacyPrimaryLang(lines);
  lines = upsertSingleLineAttr(lines, 'page-lang', targetPageLang);

  if (translationSource === 'en' || translationSource === 'sr') {
    lines = upsertSingleLineAttr(lines, 'translation-source', translationSource);
  }

  return lines.join('\n');
}

function collapseLeadingBlankLines(text) {
  return text.replace(/^\s*\n+/, '');
}

function findFirstHeadingIndex(lines) {
  return lines.findIndex((line) => /^\s*=+\s+.+$/.test(line));
}

function findTopAttrBlock(lines) {
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;

  const start = i;
  while (i < lines.length && isAttributeLine(lines[i])) i += 1;

  if (i > start) {
    return {
      hasTopAttrBlock: true,
      start,
      end: i - 1,
    };
  }

  return {
    hasTopAttrBlock: false,
    start: -1,
    end: -1,
  };
}

/**
 * Stabilizes only the top-of-file structure. Keeps current file semantics,
 * but tries to align the top pattern with the source:
 * - remove legacy :primary-lang:
 * - ensure :page-lang:
 * - ensure :translation-source:
 * - collapse leading blank lines
 * - if source starts with top attributes, prefer target top attributes before heading
 * - if source starts with heading, prefer target heading before attributes
 */
function normalizeTopOfFileStructure(sourceText, adocText, direction, translationSource) {
  let text = collapseLeadingBlankLines(adocText);
  text = normalizeMetadata(text, direction, translationSource);

  const sourceLines = collapseLeadingBlankLines(sourceText).split('\n');
  let targetLines = text.split('\n');

  const sourceTopAttrs = findTopAttrBlock(sourceLines);
  const targetTopAttrs = findTopAttrBlock(targetLines);

  const sourceHeadingIdx = findFirstHeadingIndex(sourceLines);
  const targetHeadingIdx = findFirstHeadingIndex(targetLines);

  const sourceStartsWithAttrs =
    sourceTopAttrs.hasTopAttrBlock &&
    (sourceHeadingIdx === -1 || sourceTopAttrs.start <= sourceHeadingIdx);

  const sourceStartsWithHeading =
    sourceHeadingIdx !== -1 &&
    (!sourceTopAttrs.hasTopAttrBlock || sourceHeadingIdx < sourceTopAttrs.start);

  // Case 1:
  // Source begins with attributes, but target begins with heading and has attrs after it.
  // Move contiguous top attrs above the first heading.
  if (
    sourceStartsWithAttrs &&
    targetHeadingIdx === 0
  ) {
    let i = 1;
    const movedAttrs = [];

    while (i < targetLines.length && isAttributeLine(targetLines[i])) {
      movedAttrs.push(targetLines[i]);
      i += 1;
    }

    if (movedAttrs.length > 0) {
      const headingLine = targetLines[0];
      const rest = targetLines.slice(i);
      targetLines = [...movedAttrs, headingLine, ...rest];
    }
  }

  // Case 2:
  // Source begins with heading, but target begins with top attrs and heading follows.
  // Move heading above top attrs.
  if (
    sourceStartsWithHeading &&
    targetTopAttrs.hasTopAttrBlock &&
    targetHeadingIdx > targetTopAttrs.end
  ) {
    const headingLine = targetLines[targetHeadingIdx];
    const topAttrs = targetLines.slice(targetTopAttrs.start, targetTopAttrs.end + 1);
    const beforeAttrs = targetLines.slice(0, targetTopAttrs.start);
    const between = targetLines.slice(targetTopAttrs.end + 1, targetHeadingIdx);
    const afterHeading = targetLines.slice(targetHeadingIdx + 1);

    targetLines = [
      ...beforeAttrs.filter((l) => l.trim() !== ''),
      headingLine,
      ...topAttrs,
      ...between,
      ...afterHeading,
    ];
  }

  // Final cleanup
  return collapseLeadingBlankLines(targetLines.join('\n'));
}

/**
 * Cheap local structural repair before SAFE retry:
 * - collapse exact duplication
 * - collapse leading blank lines
 * - normalize top block against source
 */
function attemptCheapStructuralRepair(sourceText, translatedText, direction, translationSource) {
  let result = translatedText;
  result = collapseExactDuplicatedDocument(result);
  result = collapseLeadingBlankLines(result);
  result = normalizeTopOfFileStructure(sourceText, result, direction, translationSource);
  return result;
}

/**
 * Translate full AsciiDoc content.
 * @param {string} adocText - Original AsciiDoc content
 * @param {boolean} isSafeMode - Whether to use SAFE MODE instructions
 * @param {'en-sr'|'sr-en'} direction - translation direction
 * @param {string} translationSource - source of truth for the page pair
 */
async function translateAdocContent(adocText, isSafeMode, direction, translationSource) {
  let instructions;
  if (direction === 'sr-en') {
    instructions = isSafeMode ? safeModeInstructionsSrEn : normalInstructionsSrEn;
  } else {
    instructions = isSafeMode ? safeModeInstructionsEnSr : normalInstructionsEnSr;
  }

  const { protectedText, protectedLines } = protectCodeAndLiteralBlocks(adocText);
  const model = pickTranslateModel();

  createSpinner(`Translating ${path.basename(inputPath)}...`);

  const response = await client.responses.create({
    model,
    instructions,
    input: protectedText,
  });

  stopSpinner();

  try {
    const usage = extractUsageFromOpenAIResponse(response);
    if (globalThis.__TOKEN_LEDGER_PATH__) {
      await appendUsageEntry(globalThis.__TOKEN_LEDGER_PATH__, {
        ts: new Date().toISOString(),
        script: 'translate-adoc',
        model,
        direction,
        safeMode: isSafeMode,
        prompt: usage.prompt,
        completion: usage.completion,
        total: usage.total,
      });
    }
  } catch {
    // ignore usage logging errors
  }

  if (response?.error) {
    throw new Error(`OpenAI API error: ${safeJsonStringify(response.error)}`);
  }

  if (response?.status && response.status !== 'completed') {
    const statusDetails = [];
    statusDetails.push(`status=${response.status}`);

    if (response?.incomplete_details) {
      statusDetails.push(`incomplete_details=${safeJsonStringify(response.incomplete_details)}`);
    }

    if (response?.last_error) {
      statusDetails.push(`last_error=${safeJsonStringify(response.last_error)}`);
    }

    const maybeTranslated = collectOutputTextFromResponse(response);
    if (maybeTranslated) {
      let restored = restoreProtectedBlocks(maybeTranslated, protectedLines);
      restored = collapseExactDuplicatedDocument(restored);
      restored = normalizeTopOfFileStructure(adocText, restored, direction, translationSource);
      restored = attemptCheapStructuralRepair(adocText, restored, direction, translationSource);
      return restored;
    }

    if ((process.env.OPENAI_DEBUG_TRANSLATION || '').trim() === '1') {
      console.error('OpenAI raw response (non-completed):');
      console.error(safeJsonStringify(response));
    }

    throw new Error(`OpenAI response not completed: ${statusDetails.join(' | ')}`);
  }

  const translated = collectOutputTextFromResponse(response);

  if (!translated) {
    if ((process.env.OPENAI_DEBUG_TRANSLATION || '').trim() === '1') {
      console.error('OpenAI raw response (missing translated text):');
      console.error(safeJsonStringify(response));
    }

    throw new Error(
      'Unexpected OpenAI response format: missing translated text. ' +
      'Set OPENAI_DEBUG_TRANSLATION=1 to inspect the raw response.'
    );
  }

  let restored = restoreProtectedBlocks(translated, protectedLines);
  restored = collapseExactDuplicatedDocument(restored);
  restored = normalizeTopOfFileStructure(adocText, restored, direction, translationSource);
  restored = attemptCheapStructuralRepair(adocText, restored, direction, translationSource);

  return restored;
}

/**
 * Fallback output path if not provided: input + ".sr.adoc" (for en-sr),
 * or input + ".en.adoc" (for sr-en).
 */
function deriveFallbackOutputPath(inputPath, direction) {
  const ext = path.extname(inputPath);
  const base = ext ? inputPath.slice(0, -ext.length) : inputPath;
  const suffix = direction === 'sr-en' ? '.en.adoc' : '.sr.adoc';
  return `${base}${suffix}`;
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    console.error('Usage: node translate-adoc.mjs <input.adoc> [output.adoc] [--safe] [--direction=en-sr|sr-en]');
    process.exit(1);
  }

  const inputPath = argv[0];
  let explicitOutputPath = null;
  let isSafeMode = false;
  let direction = 'en-sr';

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--safe') {
      isSafeMode = true;
    } else if (arg.startsWith('--direction=')) {
      const value = arg.split('=')[1];
      if (value === 'en-sr' || value === 'sr-en') {
        direction = value;
      } else {
        console.error(`Unknown direction value: ${value}. Expected en-sr or sr-en.`);
        process.exit(1);
      }
    } else if (!explicitOutputPath) {
      explicitOutputPath = arg;
    } else {
      console.error(`Unexpected argument: ${arg}`);
      console.error('Usage: node translate-adoc.mjs <input.adoc> [output.adoc] [--safe] [--direction=en-sr|sr-en]');
      process.exit(1);
    }
  }

  const outputPath = explicitOutputPath || deriveFallbackOutputPath(inputPath, direction);
  __LAST_OUTPUT_PATH__ = outputPath;

  const repoRoot = process.cwd();
  const ledgerPath = getDefaultLedgerPath(repoRoot);
  globalThis.__TOKEN_LEDGER_PATH__ = ledgerPath;

  console.log(`Reading input AsciiDoc file: ${inputPath}`);
  if (isSafeMode) {
    console.log('⚠️ translate-adoc.mjs is running in SAFE MODE.');
  }
  console.log(`➡️  Direction: ${direction === 'en-sr' ? 'EN → SR' : 'SR → EN'}`);

  const adocText = await fs.readFile(inputPath, 'utf8');
  const translationSource = getSourceTranslationSource(adocText, inputPath);

  console.log(
    'Sending content to OpenAI for translation...' +
    (isSafeMode ? ' (SAFE MODE)' : '')
  );

  const translated = await translateAdocContent(
    adocText,
    isSafeMode,
    direction,
    translationSource
  );

  const outputDir = path.dirname(outputPath);
  await fs.mkdir(outputDir, { recursive: true });

  console.log(`Writing translated AsciiDoc file: ${outputPath}`);
  await fs.writeFile(outputPath, translated, 'utf8');

  console.log('Translation finished successfully.');
}

main().catch(async (err) => {
  console.error('Error while translating AsciiDoc file:', err);

  if (__LAST_OUTPUT_PATH__) {
    try {
      await fs.unlink(__LAST_OUTPUT_PATH__);
      console.error(`Cleaned up incomplete output file: ${__LAST_OUTPUT_PATH__}`);
    } catch {
      // ignore if file does not exist
    }
  }

  process.exit(1);
});