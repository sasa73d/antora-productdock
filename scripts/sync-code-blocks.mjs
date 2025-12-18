// sync-code-blocks.mjs
// Synchronizes code and literal blocks from an English AsciiDoc file
// to its Serbian counterpart, without calling AI.
// It copies block contents for:
// - [source,...] + ---- ... ----
// - .... ... .... literal blocks

import fs from 'fs/promises';

async function main() {
  const [, , enPath, srPath] = process.argv;

  if (!enPath || !srPath) {
    console.error('Usage: node sync-code-blocks.mjs <enFile.adoc> <srFile.adoc>');
    process.exit(1);
  }

  console.log(`Syncing code blocks from EN to SR: ${enPath} -> ${srPath}`);

  const [enContent, srContent] = await Promise.all([
    fs.readFile(enPath, 'utf8'),
    fs.readFile(srPath, 'utf8'),
  ]);

  const enLines = enContent.split('\n');
  const srLines = srContent.split('\n');

  const max = Math.min(enLines.length, srLines.length);

  let inSourceBlockEn = false;
  let inSourceBlockSr = false;
  let inLiteralBlockEn = false;
  let inLiteralBlockSr = false;

  for (let i = 0; i < max; i++) {
    const enLine = enLines[i];
    const srLine = srLines[i];

    const trimmedEn = enLine.trim();
    const trimmedSr = srLine.trim();

    // Track literal "...." blocks
    if (trimmedEn === '....') {
      inLiteralBlockEn = !inLiteralBlockEn;
    }
    if (trimmedSr === '....') {
      inLiteralBlockSr = !inLiteralBlockSr;
    }

    // Track ---- blocks (source blocks)
    if (trimmedEn === '----') {
      inSourceBlockEn = !inSourceBlockEn;
    }
    if (trimmedSr === '----') {
      inSourceBlockSr = !inSourceBlockSr;
    }

    const enInCode = inSourceBlockEn || inLiteralBlockEn;
    const srInCode = inSourceBlockSr || inLiteralBlockSr;

    // If both EN and SR are within a code/literal block at this line index,
    // copy EN line over SR.
    if (enInCode && srInCode) {
      srLines[i] = enLine;
    }
  }

  const updatedSrContent = srLines.join('\n');
  await fs.writeFile(srPath, updatedSrContent, 'utf8');

  console.log('Code block sync completed.');
}

main().catch((err) => {
  console.error('Error while syncing code blocks:', err);
  process.exit(1);
});

