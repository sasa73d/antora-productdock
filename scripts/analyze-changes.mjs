// analyze-changes.mjs
// Analyze staged changes for a single AsciiDoc file and classify them into:
// - NO_CHANGES
// - STRUCTURAL_ONLY
// - CODE_ONLY
// - TEXT_AND_STRUCTURE
//
// For now this is a JS version of the current shell heuristics,
// extended with basic code-block awareness. Later we will use
// translation.config.json feature flags more aggressively.

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
    return { ...defaultConfig, ...parsed };
  } catch {
    return defaultConfig;
  }
}

function getDiff(filePath) {
  try {
    const output = execSync(`git diff --cached -U0 -- "${filePath}"`, {
      encoding: 'utf8',
    });
    return output;
  } catch {
    // No diff or some error; treat as no changes
    return '';
  }
}

// Parse diff hunks and return changed line numbers in the "new" (staged) file.
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
      // removed line -> we care about oldLine
      changed.push({ type: 'removed', oldLine, newLine: null });
      oldLine++;
    } else if (line.startsWith('+')) {
      // added line -> we care about newLine
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

function normalizeLines(lines) {
  const normalized = [];

  for (let line of lines) {
    // strip leading +/- and whitespace
    line = line.replace(/^[-+]/, '').trimStart();

    // ignore attributes (:...), comments (//...), and block attrs ([...])
    if (line.startsWith(':') || line.startsWith('//') || line.startsWith('[')) {
      continue;
    }

    // headings: =, ==, === etc. -> treat heading markers as structural only
    // Example: "== Calling Other Flows" and "=== Calling Other Flows"
    // should both normalize to "Calling Other Flows"
    if (/^=+\s+/.test(line)) {
      line = line.replace(/^=+\s+/, '').trimEnd();
    } else {
      // lists: *, **, ., .., 1., 2., #, - at the beginning -> structural only
      line = line.replace(/^([=*.+0-9#-]+\s*)/, '').trimEnd();
    }

    // keep only lines that contain ANY Unicode letter (Latin, Cyrillic, etc.)
    // This fixes SR text with diacritics (š, ć, č, đ, ž) and/or Cyrillic.
    if (!/\p{L}/u.test(line)) {
      continue;
    }

    normalized.push(line);
  }

  // sort + unique
  const unique = Array.from(new Set(normalized));
  unique.sort((a, b) => a.localeCompare(b, 'en'));

  return unique;
}

// Determine if a given 1-based line number is inside a code/literal block.
function isLineInCodeBlock(fileLines, lineNumber) {
  let inSourceBlock = false;
  let inLiteralDots = false;

  for (let i = 0; i < fileLines.length; i++) {
    const line = fileLines[i];
    const currentLineNumber = i + 1;

    // Handle [source,...] + ---- blocks
    // When we see "----" and the closest preceding non-empty line is [source,...],
    // we enter a source block and leave it at the next "----".
    if (/^\[source[, ]/i.test(line.trim())) {
      // Look ahead for opening ----
      if (currentLineNumber + 1 <= fileLines.length) {
        const nextLine = fileLines[currentLineNumber].trim();
        if (nextLine === '----') {
          // We will enter the block on the next line after '----'
          // but for simplicity we mark from the line AFTER '----'
          // when we encounter it.
        }
      }
    }

    if (line.trim() === '----') {
      // Toggle source block state
      inSourceBlock = !inSourceBlock;
      continue;
    }

    // Literal "...." blocks
    if (line.trim() === '....') {
      inLiteralDots = !inLiteralDots;
      continue;
    }

    // Now check if this is the line we care about
    if (currentLineNumber === lineNumber) {
      return inSourceBlock || inLiteralDots;
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

  // 1) CODE-ONLY DETECTION (FIRST)
  const skipCodeOnly =
    config.features && config.features.skipCodeOnlyChanges === true;

  let stagedContent;
  try {
    stagedContent = execSync(`git show :${filePath}`, { encoding: 'utf8' });
  } catch {
    // fallback to working tree
    stagedContent = await fs.readFile(filePath, 'utf8');
  }

  const fileLines = stagedContent.split('\n');
  const changedLineNumbers = getChangedLineNumbers(diffOutput);

  let anyCode = false;
  let anyNonCode = false;

  for (const ch of changedLineNumbers) {
    const lineNo = ch.newLine || ch.oldLine;
    if (!lineNo) continue;

    const inCode = isLineInCodeBlock(fileLines, lineNo);
    if (inCode) {
      anyCode = true;
    } else {
      anyNonCode = true;
    }
  }

  if (skipCodeOnly && anyCode && !anyNonCode) {
    // All changed lines are inside code/literal blocks -> code-only change.
    console.log(`STATUS=${STATUS.CODE_ONLY}`);
    process.exit(0);
  }

  // 2) TEXT VS STRUCTURAL (same logic as before)
  const { removed, added } = extractRemovedAdded(diffOutput);
  const normRemoved = normalizeLines(removed);
  const normAdded = normalizeLines(added);

  // FAIL-SAFE:
  // If there IS a diff, but normalization stripped everything (e.g. non-ASCII language),
  // we must NOT classify as NO_CHANGES because that would skip translation.
  if (
    (removed.length > 0 || added.length > 0) &&
    normRemoved.length === 0 &&
    normAdded.length === 0
  ) {
    console.log(`STATUS=${STATUS.TEXT_AND_STRUCTURE}`);
    process.exit(0);
  }

  // If no textual content changed at all (after stripping headings/lists etc.)
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