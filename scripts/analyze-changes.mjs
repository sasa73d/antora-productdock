// analyze-changes.mjs
// Analyze staged changes for a single AsciiDoc file and classify them into:
// - NO_CHANGES
// - STRUCTURAL_ONLY
// - CODE_ONLY
// - TEXT_AND_STRUCTURE
//
// Notes:
// - STRUCTURAL_ONLY means only heading/list markers / metadata / similar non-semantic
//   structure changed, while normalized human-readable text stayed the same.
// - CODE_ONLY means all changed lines are inside code/literal/listing blocks.
// - TEXT_AND_STRUCTURE is the safe fallback for everything else.

import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

const STATUS = {
  NO_CHANGES: 'NO_CHANGES',
  STRUCTURAL_ONLY: 'STRUCTURAL_ONLY',
  CODE_ONLY: 'CODE_ONLY',
  TEXT_AND_STRUCTURE: 'TEXT_AND_STRUCTURE',
};

async function loadConfig() {
  const defaultConfig = {
    features: {
      optimizeStructuralChanges: true,
      syncStructureOnStructuralChanges: true,
      skipCodeOnlyChanges: false,
      postTranslationValidation: false,
    },
    languages: {
      sr: {
        enabled: true,
        direction: 'en->sr',
        sourceDir: 'docs-en',
        targetDir: 'docs-sr',
      },
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
      languages: {
        ...defaultConfig.languages,
        ...(parsed.languages || {}),
      },
    };
  } catch {
    return defaultConfig;
  }
}

function getDiff(filePath) {
  try {
    return execSync(`git diff --cached -U0 -- "${filePath}"`, {
      encoding: 'utf8',
    });
  } catch {
    return '';
  }
}

// Parse diff hunks and return changed line numbers in the new/old staged file.
function getChangedLineNumbers(diffOutput) {
  const lines = diffOutput.split('\n');
  const changed = [];

  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const hunk = line.match(/^@@ -(\d+),?\d* \+(\d+),?\d* @@/);
    if (hunk) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[2], 10);
      continue;
    }

    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }

    if (line.startsWith(' ')) {
      oldLine++;
      newLine++;
    } else if (line.startsWith('-')) {
      changed.push({ type: 'removed', oldLine, newLine: null });
      oldLine++;
    } else if (line.startsWith('+')) {
      changed.push({ type: 'added', oldLine: null, newLine });
      newLine++;
    }
  }

  return changed;
}

function extractRemovedAdded(diffOutput) {
  const lines = diffOutput.split('\n');

  const removed = [];
  const added = [];

  for (const line of lines) {
    if (
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('@@')
    ) {
      continue;
    }

    if (line.startsWith('-')) {
      removed.push(line);
    } else if (line.startsWith('+')) {
      added.push(line);
    }
  }

  return { removed, added };
}

function isListingBlockAttributeLine(line) {
  const trimmed = line.trim();
  return /^\[(source|listing|literal)(%[^\]]+)?(?:,[^\]]*)?\]$/i.test(trimmed);
}

function isMetadataLine(line) {
  const trimmed = line.trim();

  if (/^:[^:]+:\s*.*$/.test(trimmed)) return true;
  if (trimmed.startsWith('//')) return true;
  if (isListingBlockAttributeLine(trimmed)) return true;

  return false;
}

function normalizeLines(lines) {
  const normalized = [];

  for (let line of lines) {
    line = line.replace(/^[-+]/, '').trimStart();

    if (!line.trim()) continue;

    if (isMetadataLine(line)) {
      continue;
    }

    if (/^=+\s+/.test(line)) {
      line = line.replace(/^=+\s+/, '').trimEnd();
    } else {
      line = line.replace(/^([*.+0-9#-]+\s*)/, '').trimEnd();
    }

    if (!line.trim()) continue;

    if (!/\p{L}/u.test(line)) {
      continue;
    }

    normalized.push(line);
  }

  const unique = Array.from(new Set(normalized));
  unique.sort((a, b) => a.localeCompare(b, 'en'));

  return unique;
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
        ranges.push({ start: i + 1, end: closingIndex - 1 });
        i = closingIndex + 1;
        continue;
      }
    }

    if (isSupportedDelimiter(currentLine)) {
      const closingIndex = findClosingDelimiter(lines, i, currentLine);
      if (closingIndex !== -1) {
        ranges.push({ start: i + 1, end: closingIndex - 1 });
        i = closingIndex + 1;
        continue;
      }
    }

    i += 1;
  }

  return ranges;
}

function isLineInProtectedRange(ranges, lineNumber) {
  for (const r of ranges) {
    if (lineNumber >= r.start + 1 && lineNumber <= r.end + 1) {
      return true;
    }
  }
  return false;
}

async function main() {
  const [, , filePath] = process.argv;

  if (!filePath) {
    console.error('Usage: node analyze-changes.mjs <file.adoc>');
    process.exit(1);
  }

  const config = await loadConfig();
  const diffOutput = getDiff(filePath);

  if (!diffOutput.trim()) {
    console.log(`STATUS=${STATUS.NO_CHANGES}`);
    process.exit(0);
  }

  const skipCodeOnly =
    config.features && config.features.skipCodeOnlyChanges === true;

  let stagedContent;
  try {
    stagedContent = execSync(`git show :${filePath}`, { encoding: 'utf8' });
  } catch {
    stagedContent = await fs.readFile(filePath, 'utf8');
  }

  const fileLines = stagedContent.split('\n');
  const protectedRanges = collectProtectedBlockRanges(fileLines);
  const changedLineNumbers = getChangedLineNumbers(diffOutput);

  let anyCode = false;
  let anyNonCode = false;

  for (const ch of changedLineNumbers) {
    const lineNo = ch.newLine || ch.oldLine;
    if (!lineNo) continue;

    const inCode = isLineInProtectedRange(protectedRanges, lineNo);
    if (inCode) {
      anyCode = true;
    } else {
      anyNonCode = true;
    }
  }

  if (skipCodeOnly && anyCode && !anyNonCode) {
    console.log(`STATUS=${STATUS.CODE_ONLY}`);
    process.exit(0);
  }

  const { removed, added } = extractRemovedAdded(diffOutput);
  const normRemoved = normalizeLines(removed);
  const normAdded = normalizeLines(added);

  if (
    (removed.length > 0 || added.length > 0) &&
    normRemoved.length === 0 &&
    normAdded.length === 0
  ) {
    console.log(`STATUS=${STATUS.TEXT_AND_STRUCTURE}`);
    process.exit(0);
  }

  if (normRemoved.length === 0 && normAdded.length === 0) {
    console.log(`STATUS=${STATUS.NO_CHANGES}`);
    process.exit(0);
  }

  const removedJoined = normRemoved.join('\n');
  const addedJoined = normAdded.join('\n');

  if (removedJoined === addedJoined) {
    console.log(`STATUS=${STATUS.STRUCTURAL_ONLY}`);
  } else {
    console.log(`STATUS=${STATUS.TEXT_AND_STRUCTURE}`);
  }
}

main().catch((err) => {
  console.error('Error in analyze-changes.mjs:', err);
  console.log(`STATUS=${STATUS.TEXT_AND_STRUCTURE}`);
  process.exit(1);
});