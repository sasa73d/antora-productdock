#!/usr/bin/env node
// Simple AsciiDoc formatter for Antora docs.
//
// Safe operations only:
// - remove trailing spaces
// - normalize heading spacing (=, ==, ===) outside code blocks
// - normalize unordered list markers (*, -) outside code blocks
// - normalize attribute block at top (:...: lines) and ensure one blank line after it
//
// The script is intentionally conservative and idempotent: running it multiple
// times over the same file should always produce the same result.

import fs from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const [, , inputPath] = process.argv;

  if (!inputPath) {
    console.error('Usage: node format-adoc.mjs <file.adoc>');
    process.exit(1);
  }

  const absPath = path.resolve(process.cwd(), inputPath);

  let original;
  try {
    original = await fs.readFile(absPath, 'utf8');
  } catch (err) {
    console.error(`❌ Could not read file: ${absPath}`);
    console.error(err.message);
    process.exit(1);
  }

  const formatted = formatAdoc(original);

  if (formatted !== original) {
    try {
      await fs.writeFile(absPath, formatted, 'utf8');
      console.log(`🧹 Formatted AsciiDoc file: ${inputPath}`);
    } catch (err) {
      console.error(`❌ Could not write formatted file: ${absPath}`);
      console.error(err.message);
      process.exit(1);
    }
  } else {
    // No changes needed
    // console.log(`ℹ️  No formatting changes for: ${inputPath}`);
  }
}

/**
 * Apply safe, idempotent formatting rules to AsciiDoc content.
 */
function formatAdoc(content) {
  let lines = content.split(/\r?\n/);

  // 1) Strip trailing spaces/tabs on every line
  lines = lines.map((line) => line.replace(/[ \t]+$/u, ''));

  // 2) Normalize top-of-file attribute block first
  lines = normalizeTopAttributesBlock(lines);

  // 3) Normalize headings and lists outside code blocks
  lines = normalizeHeadingsAndLists(lines);

  // Join back with '\n' (LF). Antora/AsciiDoc is fine with LF endings.
  return lines.join('\n');
}

/**
 * Normalize the attribute block at the top of the file.
 *
 * In Antora / Asciidoctor, lines like ":primary-lang: en", ":toc:", ":sectnums:"
 * are attributes (metadata). They MUST start at the beginning of the line
 * (no leading spaces). If they are indented, they are treated as normal text
 * and will be rendered on the page.
 *
 * This function:
 *   - detects a contiguous block of attribute lines at the top of the file
 *     (ignoring leading whitespace when reading),
 *   - strips leading whitespace from each attribute line so they start with ":",
 *   - ensures there is exactly one blank line after the attribute block,
 *   - keeps the rest of the file as-is.
 */
function normalizeTopAttributesBlock(lines) {
  let i = 0;
  const n = lines.length;

  // Skip initial empty lines (we effectively drop them to keep the top compact)
  while (i < n && lines[i].trim() === '') {
    i += 1;
  }

  // Detect attribute block starting at current position.
  // We allow leading whitespace when detecting, but we will remove it later.
  const attrStart = i;
  let attrEnd = -1;

  while (i < n && lines[i].trim().startsWith(':')) {
    attrEnd = i;
    i += 1;
  }

  // No attribute block at the top -> return original lines unchanged.
  if (attrEnd === -1) {
    return lines;
  }

  // Skip any empty lines right after the attribute block
  let j = attrEnd + 1;
  while (j < n && lines[j].trim() === '') {
    j += 1;
  }

  const newLines = [];

  // 1) Copy attribute block, but strip any leading whitespace
  for (let k = attrStart; k <= attrEnd; k += 1) {
    const attrLine = lines[k].replace(/^\s+/u, '');
    newLines.push(attrLine);
  }

  // 2) Ensure exactly one blank line after the attribute block
  newLines.push('');

  // 3) Copy the rest of the file starting from the first non-empty line
  // after the original attribute block.
  for (let k = j; k < n; k += 1) {
    newLines.push(lines[k]);
  }

  return newLines;
}

/**
 * Normalize heading and list lines outside of code blocks.
 *
 * Rules:
 * - Heading lines:
 *     "   ==   Title   text" -> "== Title   text"
 *   (strip leading indentation and ensure exactly one space after the '=' run)
 *   We do NOT touch inner spacing inside the heading text.
 *
 * - Unordered list lines:
 *     "*Item" or "*   Item" -> "* Item"
 *     "  **    Sub-item"    -> "  ** Sub-item"
 *   (keep original indentation and marker, normalize to a single space after marker)
 *
 * - All of the above is skipped inside delimited code blocks:
 *   sections between "----" lines (typical Antora/AsciiDoc source blocks).
 */
function normalizeHeadingsAndLists(lines) {
  const result = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];

    const trimmed = line.trim();

    // Toggle code block state on "----" delimiter lines.
    // We do not attempt to be smart about other block types here.
    if (trimmed === '----') {
      result.push(line);
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      // Inside code blocks, do not touch headings/lists/spacing.
      result.push(line);
      continue;
    }

    // 3.1) Normalize heading lines: "= Title", "== Subtitle", "=== Something"
    // Allow optional leading spaces, one or more '=' chars, optional spaces,
    // then heading text. Example:
    //   "   ==   My heading" -> "== My heading"
    const headingMatch = line.match(/^\s*(=+)\s*(\S.*)?$/u);
    if (headingMatch) {
      const [, equals, text] = headingMatch;
      if (!text) {
        // No text after "====", leave just the markers (e.g. example block delimiters)
        result.push(equals);
      } else {
        result.push(`${equals} ${text}`);
      }
      continue;
    }

    // 3.2) Normalize unordered list items:
    // Keep indentation and marker, normalize to a single space before text.
    //
    // Examples:
    //   "*Item"          -> "* Item"
    //   "*   Item"       -> "* Item"
    //   "  **    Item"   -> "  ** Item"
    //
    // We require at least some text after the marker; lines like "---" (rules)
    // will not match this pattern and will be left as-is.
    const listMatch = line.match(/^(\s*)([*-]+)\s+(\S.*)$/u);
    if (listMatch) {
      const [, indent, markers, text] = listMatch;
      result.push(`${indent}${markers} ${text}`);
      continue;
    }

    // Default: keep the line as-is
    result.push(line);
  }

  return result;
}

main().catch((err) => {
  console.error('❌ Unexpected error in format-adoc.mjs:', err);
  process.exit(1);
});