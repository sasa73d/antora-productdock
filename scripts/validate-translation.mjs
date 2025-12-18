// validate-translation.mjs
// Validates that the translated AsciiDoc (SR) file preserves the structure
// of the source (EN) file. Checks:
// - Heading markers (=, ==, ===) alignment
// - Code/literal blocks position and content
// - Counts of xref:, include::, image:: macros
// - Attribute lines (names) consistency
//
// If postTranslationValidation is disabled in translation.config.json,
// this script exits successfully without validation.
//
// Exit codes:
// - 0: validation passed (or disabled)
// - 1: validation failed

import fs from 'fs/promises';
import path from 'path';

async function loadConfig() {
  const defaultConfig = {
    features: {
      postTranslationValidation: true,
    },
  };

  try {
    const raw = await fs.readFile(
      path.join(process.cwd(), 'translation.config.json'),
      'utf8'
    );
    const parsed = JSON.parse(raw);
    return {
      ...defaultConfig,
      ...parsed,
      features: {
        ...defaultConfig.features,
        ...(parsed.features || {}),
      },
    };
  } catch {
    return defaultConfig;
  }
}

function splitLines(content) {
  return content.split('\n');
}

// Simple heading matcher: captures leading = signs and text
function matchHeading(line) {
  const m = line.match(/^(\s*)(=+)(\s+)(.+)$/);
  if (!m) return null;
  return {
    indent: m[1],
    marks: m[2],
    space: m[3],
    text: m[4],
  };
}

// Detect if line is attribute definition like :page-title: ...
function extractAttributeName(line) {
  const m = line.match(/^:([^:]+):/);
  return m ? m[1].trim() : null;
}

// Collect positions and content of code/literal blocks
function collectCodeBlocks(lines) {
  const blocks = [];
  let inSource = false;
  let inLiteral = false;
  let currentType = null;
  let start = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Literal "...." blocks
    if (trimmed === '....') {
      if (!inLiteral) {
        // entering literal
        inLiteral = true;
        currentType = 'literal';
        start = i;
      } else {
        // leaving literal
        inLiteral = false;
        blocks.push({
          type: currentType,
          start,
          end: i,
        });
        currentType = null;
        start = null;
      }
      continue;
    }

    // Source "----" blocks
    if (trimmed === '----') {
      if (!inSource) {
        inSource = true;
        currentType = 'source';
        start = i;
      } else {
        inSource = false;
        blocks.push({
          type: currentType,
          start,
          end: i,
        });
        currentType = null;
        start = null;
      }
      continue;
    }
  }

  return blocks;
}

function countMatches(text, pattern) {
  const re = new RegExp(pattern, 'g');
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

async function main() {
  const [, , enPath, srPath] = process.argv;

  if (!enPath || !srPath) {
    console.error('Usage: node validate-translation.mjs <enFile.adoc> <srFile.adoc>');
    process.exit(1);
  }

  const config = await loadConfig();
  if (!config.features.postTranslationValidation) {
    console.log('Validation is disabled by config (postTranslationValidation=false). Skipping.');
    process.exit(0);
  }

  console.log(`Validating translation structure: ${enPath} -> ${srPath}`);

  const [enContent, srContent] = await Promise.all([
    fs.readFile(enPath, 'utf8'),
    fs.readFile(srPath, 'utf8'),
  ]);

  const enLines = splitLines(enContent);
  const srLines = splitLines(srContent);

  let hasError = false;

  // 1) Heading markers
  const maxLines = Math.min(enLines.length, srLines.length);
  for (let i = 0; i < maxLines; i++) {
    const enHeading = matchHeading(enLines[i]);
    const srHeading = matchHeading(srLines[i]);

    if (enHeading && srHeading) {
      if (enHeading.marks !== srHeading.marks) {
        console.error(
          `ERROR: Heading level mismatch at line ${i + 1}: EN="${enHeading.marks}" SR="${srHeading.marks}"`
        );
        hasError = true;
      }
    } else if (enHeading && !srHeading) {
      console.error(
        `ERROR: EN has a heading at line ${i + 1}, but SR does not: "${enLines[i]}"`
      );
      hasError = true;
    } else if (!enHeading && srHeading) {
      console.error(
        `ERROR: SR has a heading at line ${i + 1}, but EN does not: "${srLines[i]}"`
      );
      hasError = true;
    }
  }

  // 2) Code/literal blocks alignment and content
  const enBlocks = collectCodeBlocks(enLines);
  const srBlocks = collectCodeBlocks(srLines);

  if (enBlocks.length !== srBlocks.length) {
    console.error(
      `ERROR: Number of code/literal blocks differs: EN=${enBlocks.length}, SR=${srBlocks.length}`
    );
    hasError = true;
  } else {
    for (let i = 0; i < enBlocks.length; i++) {
      const eb = enBlocks[i];
      const sb = srBlocks[i];

      if (eb.type !== sb.type) {
        console.error(
          `ERROR: Block type mismatch at block #${i + 1}: EN=${eb.type}, SR=${sb.type}`
        );
        hasError = true;
        continue;
      }

      const enBlockLines = enLines.slice(eb.start, eb.end + 1);
      const srBlockLines = srLines.slice(sb.start, sb.end + 1);

      if (enBlockLines.length !== srBlockLines.length) {
        console.error(
          `ERROR: Code block #${i + 1} line count differs: EN=${enBlockLines.length}, SR=${srBlockLines.length}`
        );
        hasError = true;
        continue;
      }

      for (let j = 0; j < enBlockLines.length; j++) {
        if (enBlockLines[j] !== srBlockLines[j]) {
          console.error(
            `ERROR: Code block #${i + 1} mismatch at relative line ${j + 1} (global line ${eb.start + j + 1}).`
          );
          console.error(`       EN: "${enBlockLines[j]}"`);
          console.error(`       SR: "${srBlockLines[j]}"`);
          hasError = true;
          break;
        }
      }
    }
  }

  // 3) xref, include::, image:: counts
  const macroChecks = [
    { name: 'xref', pattern: 'xref:' },
    { name: 'include', pattern: 'include::' },
    { name: 'image', pattern: 'image::' },
  ];

  for (const mc of macroChecks) {
    const enCount = countMatches(enContent, mc.pattern);
    const srCount = countMatches(srContent, mc.pattern);
    if (enCount !== srCount) {
      console.error(
        `ERROR: Macro count mismatch for "${mc.name}": EN=${enCount}, SR=${srCount}`
      );
      hasError = true;
    }
  }

  // 4) Attribute lines (names only)
  const enAttrs = new Set();
  const srAttrs = new Set();

  for (const line of enLines) {
    const name = extractAttributeName(line);
    if (name) enAttrs.add(name);
  }
  for (const line of srLines) {
    const name = extractAttributeName(line);
    if (name) srAttrs.add(name);
  }

  const enOnly = [...enAttrs].filter((n) => !srAttrs.has(n));
  const srOnly = [...srAttrs].filter((n) => !enAttrs.has(n));

  if (enOnly.length > 0) {
    console.error(
      `ERROR: Attributes present only in EN: ${enOnly.join(', ')}`
    );
    hasError = true;
  }
  if (srOnly.length > 0) {
    console.error(
      `ERROR: Attributes present only in SR: ${srOnly.join(', ')}`
    );
    hasError = true;
  }

    if (hasError) {
    console.error('Translation validation FAILED.');
    console.error(
      'Hint: Check the errors above, fix the SR file structure (or the EN source), then retry the commit.'
    );
    process.exit(1);
  } else {
    console.log('Translation validation PASSED.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Error in validate-translation.mjs:', err);
  process.exit(1);
});

