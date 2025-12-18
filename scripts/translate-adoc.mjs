// translate-adoc.mjs
// Translates an AsciiDoc (.adoc) file between English and Serbian (latin alphabet)
// while preserving all Antora / AsciiDoc structure.
//
// Supported directions:
//   --direction=en-sr (default)  -> English (source) to Serbian (target)
//   --direction=sr-en           -> Serbian (source) to English (target)

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import { appendUsageEntry, extractUsageFromOpenAIResponse, getDefaultLedgerPath } from "./token-ledger.mjs";

function pickTranslateModel() {
  const model =
    (process.env.OPENAI_MODEL_TRANSLATE || "").trim() ||
    (process.env.OPENAI_MODEL_DEFAULT || "").trim();

  if (!model) {
    throw new Error(
      "Missing OpenAI model configuration. Set OPENAI_MODEL_DEFAULT (and optionally OPENAI_MODEL_TRANSLATE) in .env"
    );
  }

  if ((process.env.OPENAI_LOG_MODEL || "").trim() === "1") {
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
- Do NOT change heading markup (=, ==, ===, etc.), only translate the text after them.
- Do NOT change roles, attributes, IDs, anchors, xrefs, include directives or macros.
- Do NOT change anything inside source/code blocks (----, ...., \`\`\`, [source,java], etc.).
- Do NOT change URLs, xrefs, file paths or attribute names.
- Do NOT add or remove lines.
- Keep all inline formatting markers (*bold*, _italic_, \`monospace\`) as they are, only translate the human-readable text.
- Keep lists (-, *, .) and their structure unchanged, only translate the text.
- Keep table structure unchanged, only translate the cell text.
- Do NOT add explanations or comments.
- Do NOT change the :primary-lang: attribute or its value if present.

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
- Do NOT change attribute line names (:page-...:). Do NOT change the :primary-lang: attribute or its value.
- Do NOT change URLs, xrefs targets, file paths or attribute names.
- Do NOT add, remove or reorder lines.

CODE & LITERAL BLOCKS (CRITICAL):
- Do NOT change anything inside source/code/literal blocks:
  - blocks delimited by ----, ...., \`\`\` or similar
  - blocks with [source,java], [source,xml], etc.
- Copy code and literal blocks EXACTLY as in the input.

TRANSLATION SCOPE:
- Translate ONLY human-readable natural language text outside of code/literal blocks.
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
- Do NOT change heading markup (=, ==, ===, etc.), only translate the text after them.
- Do NOT change roles, attributes, IDs, anchors, xrefs, include directives or macros.
- Do NOT change anything inside source/code blocks (----, ...., \`\`\`, [source,java], etc.).
- Do NOT change URLs, xrefs, file paths or attribute names.
- Do NOT add or remove lines.
- Keep all inline formatting markers (*bold*, _italic_, \`monospace\`) as they are, only translate the human-readable text.
- Keep lists (-, *, .) and their structure unchanged, only translate the text.
- Keep table structure unchanged, only translate the cell text.
- Do NOT add explanations or comments.
- Do NOT change the :primary-lang: attribute or its value if present.

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
- Do NOT change attribute line names (:page-...:). Do NOT change the :primary-lang: attribute or its value.
- Do NOT change URLs, xrefs targets, file paths or attribute names.
- Do NOT add, remove or reorder lines.

CODE & LITERAL BLOCKS (CRITICAL):
- Do NOT change anything inside source/code/literal blocks:
  - blocks delimited by ----, ...., \`\`\` or similar
  - blocks with [source,java], [source,xml], etc.
- Copy code and literal blocks EXACTLY as in the input.

TRANSLATION SCOPE:
- Translate ONLY human-readable natural language text outside of code/literal blocks.
- If translating a sentence would require you to modify any structure, macro, attribute name, code or delimiter, LEAVE THAT PART EXACTLY AS IN THE ORIGINAL SERBIAN.

OUTPUT:
- Return ONLY the translated AsciiDoc document.
- The output MUST have the same number of lines and the same AsciiDoc structure as the input.
`.trim();

/**
 * Translate full AsciiDoc content.
 * @param {string} adocText - Original AsciiDoc content
 * @param {boolean} isSafeMode - Whether to use SAFE MODE instructions
 * @param {'en-sr'|'sr-en'} direction - translation direction
 */
async function translateAdocContent(adocText, isSafeMode, direction) {
  let instructions;
  if (direction === 'sr-en') {
    instructions = isSafeMode ? safeModeInstructionsSrEn : normalInstructionsSrEn;
  } else {
    instructions = isSafeMode ? safeModeInstructionsEnSr : normalInstructionsEnSr;
  }

  const model = pickTranslateModel();

  const response = await client.responses.create({
    model,
    instructions,
    input: adocText,
  });

  // Token usage logging (best-effort)
  try {
    const usage = extractUsageFromOpenAIResponse(response);
    // NOTE: ledgerPath is available in main(); we attach it via global or pass it in.
    // We'll pass it via a global variable set in main (see next step).
    if (globalThis.__TOKEN_LEDGER_PATH__) {
        await appendUsageEntry(globalThis.__TOKEN_LEDGER_PATH__, {
          ts: new Date().toISOString(),
          script: "translate-adoc",
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

  const translated =
    response.output &&
    response.output[0] &&
    response.output[0].content &&
    response.output[0].content[0] &&
    response.output[0].content[0].text;

  if (!translated) {
    throw new Error('Unexpected OpenAI response format: missing translated text.');
  }

  return translated;
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
  // We support optional flags: --safe, --direction=en-sr|sr-en
  const argv = process.argv.slice(2); // [inputPath, output?, flags...]

  if (argv.length === 0) {
    console.error('Usage: node translate-adoc.mjs <input.adoc> [output.adoc] [--safe] [--direction=en-sr|sr-en]');
    process.exit(1);
  }

  let inputPath = argv[0];
  let explicitOutputPath = null;
  let isSafeMode = false;
  let direction = 'en-sr'; // default

  // Drugi argument može biti output path ili flag; moramo malo pažljivije parsirati
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
      // prvi ne-flag argument nakon inputPath tretiramo kao output path
      explicitOutputPath = arg;
    } else {
      console.error(`Unexpected argument: ${arg}`);
      console.error('Usage: node translate-adoc.mjs <input.adoc> [output.adoc] [--safe] [--direction=en-sr|sr-en]');
      process.exit(1);
    }
  }

  const outputPath = explicitOutputPath || deriveFallbackOutputPath(inputPath, direction);
  // repo root (works when script is executed from repo root; otherwise it resolves relative)
  const repoRoot = process.cwd();
  const ledgerPath = getDefaultLedgerPath(repoRoot);

  globalThis.__TOKEN_LEDGER_PATH__ = ledgerPath;

  console.log(`Reading input AsciiDoc file: ${inputPath}`);
  if (isSafeMode) {
    console.log('⚠️ translate-adoc.mjs is running in SAFE MODE.');
  }
  console.log(`➡️  Direction: ${direction === 'en-sr' ? 'EN → SR' : 'SR → EN'}`);

  const adocText = await fs.readFile(inputPath, 'utf8');

  console.log(
    'Sending content to OpenAI for translation...' +
      (isSafeMode ? ' (SAFE MODE)' : '')
  );
  const translated = await translateAdocContent(adocText, isSafeMode, direction);

  const outputDir = path.dirname(outputPath);
  await fs.mkdir(outputDir, { recursive: true });

  console.log(`Writing translated AsciiDoc file: ${outputPath}`);
  await fs.writeFile(outputPath, translated, 'utf8');

  console.log('Translation finished successfully.');
}

main().catch((err) => {
  console.error('Error while translating AsciiDoc file:', err);
  process.exit(1);
});