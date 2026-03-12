// validate-translation.mjs
// Validates that the translated AsciiDoc target file preserves the structure
// of the source file. Checks:
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

function extractAttributeName(line) {
  const m = line.match(/^:([^:]+):/);
  return m ? m[1].trim() : null;
}

function isListingBlockAttributeLine(line) {
  const trimmed = line.trim();
  return /^\[(source|listing|literal)(%[^\]]+)?(?:,[^\]]*)?\]$/i.test(trimmed);
}

function isBacktickFence(line) {
  return /^```/.test(line.trim());
}

function isSupportedDelimiter(line) {
  const trimmed = line.trim();
  return trimmed === '----' || trimmed === '....' || isBacktickFence(trimmed);
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

function collectCodeBlocks(lines) {
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const currentLine = lines[i];
    const nextLine = i + 1 < lines.length ? lines[i + 1] : null;

    if (
      isListingBlockAttributeLine(currentLine) &&
      nextLine !== null &&
      isSupportedDelimiter(nextLine)
    ) {
      const closingIndex = findClosingDelimiter(lines, i + 1, nextLine);
      if (closingIndex !== -1) {
        blocks.push({
          type: nextLine.trim() === '....' ? 'literal' : 'source',
          start: i,
          end: closingIndex,
        });
        i = closingIndex + 1;
        continue;
      }
    }

    if (isSupportedDelimiter(currentLine)) {
      const closingIndex = findClosingDelimiter(lines, i, currentLine);
      if (closingIndex !== -1) {
        blocks.push({
          type: currentLine.trim() === '....' ? 'literal' : 'source',
          start: i,
          end: closingIndex,
        });
        i = closingIndex + 1;
        continue;
      }
    }

    i += 1;
  }

  return blocks;
}

function countMatches(text, pattern) {
  const re = new RegExp(pattern, 'g');
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

function shouldIgnoreAttributeName(name) {
  const n = (name || '').trim().toLowerCase();

  // Ignore legacy attr during migration / cleanup.
  if (n === 'primary-lang') return true;

  return false;
}

async function main() {
  const [, , sourcePath, targetPath] = process.argv;

  if (!sourcePath || !targetPath) {
    console.error(
      'Usage: node validate-translation.mjs <sourceFile.adoc> <targetFile.adoc>'
    );
    process.exit(1);
  }

  const config = await loadConfig();
  if (!config.features.postTranslationValidation) {
    console.log(
      'Validation is disabled by config (postTranslationValidation=false). Skipping.'
    );
    process.exit(0);
  }

  console.log(`Validating translation structure: ${sourcePath} -> ${targetPath}`);

  const [sourceContent, targetContent] = await Promise.all([
    fs.readFile(sourcePath, 'utf8'),
    fs.readFile(targetPath, 'utf8'),
  ]);

  const sourceLines = splitLines(sourceContent);
  const targetLines = splitLines(targetContent);

  let hasError = false;

  // 1) Heading markers
  const maxLines = Math.min(sourceLines.length, targetLines.length);
  for (let i = 0; i < maxLines; i++) {
    const sourceHeading = matchHeading(sourceLines[i]);
    const targetHeading = matchHeading(targetLines[i]);

    if (sourceHeading && targetHeading) {
      if (sourceHeading.marks !== targetHeading.marks) {
        console.error(
          `ERROR: Heading level mismatch at line ${i + 1}: SOURCE="${sourceHeading.marks}" TARGET="${targetHeading.marks}"`
        );
        hasError = true;
      }
    } else if (sourceHeading && !targetHeading) {
      console.error(
        `ERROR: SOURCE has a heading at line ${i + 1}, but TARGET does not: "${sourceLines[i]}"`
      );
      hasError = true;
    } else if (!sourceHeading && targetHeading) {
      console.error(
        `ERROR: TARGET has a heading at line ${i + 1}, but SOURCE does not: "${targetLines[i]}"`
      );
      hasError = true;
    }
  }

  // 2) Code/literal blocks alignment and content
  const sourceBlocks = collectCodeBlocks(sourceLines);
  const targetBlocks = collectCodeBlocks(targetLines);

  if (sourceBlocks.length !== targetBlocks.length) {
    console.error(
      `ERROR: Number of code/literal blocks differs: SOURCE=${sourceBlocks.length}, TARGET=${targetBlocks.length}`
    );
    hasError = true;
  } else {
    for (let i = 0; i < sourceBlocks.length; i++) {
      const sb = sourceBlocks[i];
      const tb = targetBlocks[i];

      if (sb.type !== tb.type) {
        console.error(
          `ERROR: Block type mismatch at block #${i + 1}: SOURCE=${sb.type}, TARGET=${tb.type}`
        );
        hasError = true;
        continue;
      }

      const sourceBlockLines = sourceLines.slice(sb.start, sb.end + 1);
      const targetBlockLines = targetLines.slice(tb.start, tb.end + 1);

      if (sourceBlockLines.length !== targetBlockLines.length) {
        console.error(
          `ERROR: Code block #${i + 1} line count differs: SOURCE=${sourceBlockLines.length}, TARGET=${targetBlockLines.length}`
        );
        hasError = true;
        continue;
      }

      for (let j = 0; j < sourceBlockLines.length; j++) {
        if (sourceBlockLines[j] !== targetBlockLines[j]) {
          console.error(
            `ERROR: Code block #${i + 1} mismatch at relative line ${j + 1} (source global line ${sb.start + j + 1}).`
          );
          console.error(`       SOURCE: "${sourceBlockLines[j]}"`);
          console.error(`       TARGET: "${targetBlockLines[j]}"`);
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
    const sourceCount = countMatches(sourceContent, mc.pattern);
    const targetCount = countMatches(targetContent, mc.pattern);
    if (sourceCount !== targetCount) {
      console.error(
        `ERROR: Macro count mismatch for "${mc.name}": SOURCE=${sourceCount}, TARGET=${targetCount}`
      );
      hasError = true;
    }
  }

  // 4) Attribute lines (names only)
  const sourceAttrs = new Set();
  const targetAttrs = new Set();

  for (const line of sourceLines) {
    const name = extractAttributeName(line);
    if (name && !shouldIgnoreAttributeName(name)) {
      sourceAttrs.add(name);
    }
  }

  for (const line of targetLines) {
    const name = extractAttributeName(line);
    if (name && !shouldIgnoreAttributeName(name)) {
      targetAttrs.add(name);
    }
  }

  const sourceOnly = [...sourceAttrs].filter((n) => !targetAttrs.has(n));
  const targetOnly = [...targetAttrs].filter((n) => !sourceAttrs.has(n));

  if (sourceOnly.length > 0) {
    console.error(
      `ERROR: Attributes present only in SOURCE: ${sourceOnly.join(', ')}`
    );
    hasError = true;
  }

  if (targetOnly.length > 0) {
    console.error(
      `ERROR: Attributes present only in TARGET: ${targetOnly.join(', ')}`
    );
    hasError = true;
  }

  if (hasError) {
    console.error('Translation validation FAILED.');
    console.error(
      'Hint: Check the errors above, fix the target file structure (or the source file), then retry the commit.'
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
