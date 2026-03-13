// sync-code-blocks.mjs
// Synchronizes code and literal blocks from a source AsciiDoc file
// to its translated counterpart, without calling AI.
//
// Supported modes:
//   Legacy mode:
//     node sync-code-blocks.mjs <sourceFile.adoc> <targetFile.adoc>
//
//   Temp-output mode:
//     node sync-code-blocks.mjs <sourceFile.adoc> <existingTargetFile.adoc> <outputTargetFile.adoc> --direction=en-sr|sr-en
//
// It copies block contents for:
// - [source,...] + ---- ... ----
// - [listing,...] + ---- ... ----
// - [literal,...] + .... ... ....
// - [mermaid,...] + .... ... ....
// - bare ---- ... ---- blocks
// - bare .... ... .... literal blocks
// - ``` ... ``` fenced blocks

import fs from 'fs/promises';
import path from 'path';

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.length < 2) {
    console.error(
      'Usage:\n' +
        '  node sync-code-blocks.mjs <sourceFile.adoc> <targetFile.adoc>\n' +
        '  node sync-code-blocks.mjs <sourceFile.adoc> <existingTargetFile.adoc> <outputTargetFile.adoc> --direction=en-sr|sr-en'
    );
    process.exit(1);
  }

  const sourcePath = args[0];
  const existingTargetPath = args[1];

  let outputPath = existingTargetPath;
  let direction = '';

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--direction=')) {
      direction = arg.split('=')[1] || '';
    } else if (!arg.startsWith('--') && outputPath === existingTargetPath) {
      outputPath = arg;
    } else {
      console.error(`Unexpected argument: ${arg}`);
      process.exit(1);
    }
  }

  if (direction && direction !== 'en-sr' && direction !== 'sr-en') {
    console.error(`Invalid --direction value: ${direction}. Expected en-sr or sr-en.`);
    process.exit(1);
  }

  return {
    sourcePath,
    existingTargetPath,
    outputPath,
    direction,
  };
}

function detectDirection(sourcePath, targetPath, explicitDirection) {
  if (explicitDirection) return explicitDirection;

  if (sourcePath.startsWith('docs-en/') && targetPath.startsWith('docs-sr/')) {
    return 'en-sr';
  }
  if (sourcePath.startsWith('docs-sr/') && targetPath.startsWith('docs-en/')) {
    return 'sr-en';
  }

  return 'unknown';
}

function isListingBlockAttributeLine(line) {
  const trimmed = line.trim();
  return /^\[(source|listing|literal|mermaid)(%[^\]]+)?(?:,[^\]]*)?\]$/i.test(trimmed);
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

function collectProtectedBlockRanges(lines) {
  const ranges = [];
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
        ranges.push({
          start: i,
          end: closingIndex,
          type:
            nextLine.trim() === '....'
              ? 'literal'
              : isBacktickFence(nextLine)
                ? 'fenced'
                : 'delimited',
        });
        i = closingIndex + 1;
        continue;
      }
    }

    if (isSupportedDelimiter(currentLine)) {
      const closingIndex = findClosingDelimiter(lines, i, currentLine);
      if (closingIndex !== -1) {
        ranges.push({
          start: i,
          end: closingIndex,
          type:
            currentLine.trim() === '....'
              ? 'literal'
              : isBacktickFence(currentLine)
                ? 'fenced'
                : 'delimited',
        });
        i = closingIndex + 1;
        continue;
      }
    }

    i += 1;
  }

  return ranges;
}

function syncCodeBlocks(sourceContent, targetContent) {
  const sourceLines = sourceContent.split('\n');
  const targetLines = targetContent.split('\n');

  const sourceRanges = collectProtectedBlockRanges(sourceLines);
  const targetRanges = collectProtectedBlockRanges(targetLines);

  const rangeCount = Math.min(sourceRanges.length, targetRanges.length);

  let lineOffset = 0;

  for (let r = 0; r < rangeCount; r++) {
    const sourceRange = sourceRanges[r];
    const originalTargetRange = targetRanges[r];

    const adjustedTargetStart = originalTargetRange.start + lineOffset;
    const adjustedTargetEnd = originalTargetRange.end + lineOffset;

    const sourceBlockLines = sourceLines.slice(sourceRange.start, sourceRange.end + 1);
    const targetBlockLength = adjustedTargetEnd - adjustedTargetStart + 1;

    if (sourceRange.type !== originalTargetRange.type) {
      console.warn(
        `⚠️  Skipping block ${r + 1}: source block type is "${sourceRange.type}", target block type is "${originalTargetRange.type}".`
      );
      continue;
    }

    if (sourceBlockLines.length !== targetBlockLength) {
      console.log(
        `ℹ️  Replacing block ${r + 1} with different line count: source=${sourceBlockLines.length}, target=${targetBlockLength}.`
      );
    }

    targetLines.splice(
      adjustedTargetStart,
      targetBlockLength,
      ...sourceBlockLines
    );

    lineOffset += sourceBlockLines.length - targetBlockLength;
  }

  if (sourceRanges.length !== targetRanges.length) {
    console.warn(
      `⚠️  Block count differs: source=${sourceRanges.length}, target=${targetRanges.length}. Synced first ${rangeCount} matching block(s) only.`
    );
  }

  return targetLines.join('\n');
}

async function main() {
  const {
    sourcePath,
    existingTargetPath,
    outputPath,
    direction,
  } = parseArgs(process.argv);

  const resolvedDirection = detectDirection(sourcePath, existingTargetPath, direction);

  console.log(
    `Syncing code blocks (${resolvedDirection}) from source to target: ${sourcePath} -> ${existingTargetPath}`
  );

  if (outputPath !== existingTargetPath) {
    console.log(`Writing synced code blocks to temp output: ${outputPath}`);
  }

  const [sourceContent, targetContent] = await Promise.all([
    fs.readFile(sourcePath, 'utf8'),
    fs.readFile(existingTargetPath, 'utf8'),
  ]);

  const updatedTargetContent = syncCodeBlocks(sourceContent, targetContent);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, updatedTargetContent, 'utf8');

  console.log('Code block sync completed.');
}

main().catch((err) => {
  console.error('Error while syncing code blocks:', err);
  process.exit(1);
});