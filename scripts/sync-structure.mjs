// sync-structure.mjs
// Synchronizes structural markers (list bullets, numbering, headings) from
// a source AsciiDoc file to its translated counterpart, without calling AI.
//
// Supported modes:
//   Legacy mode:
//     node sync-structure.mjs <sourceFile.adoc> <targetFile.adoc>
//
//   Temp-output mode:
//     node sync-structure.mjs <sourceFile.adoc> <existingTargetFile.adoc> <outputTargetFile.adoc> --direction=en-sr|sr-en
//
// Behavior:
// - Read source and existing target files
// - Walk line by line (best-effort alignment)
// - For lines that are headings or list items in both files,
//   copy the marker part from source to target
// - Keep the target-language text as-is
// - Write the result either back to targetFile (legacy mode)
//   or to outputTargetFile (temp mode)

import fs from 'fs/promises';
import path from 'path';

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.length < 2) {
    console.error(
      'Usage:\n' +
      '  node sync-structure.mjs <sourceFile.adoc> <targetFile.adoc>\n' +
      '  node sync-structure.mjs <sourceFile.adoc> <existingTargetFile.adoc> <outputTargetFile.adoc> --direction=en-sr|sr-en'
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

function syncStructure(sourceContent, targetContent) {
  const sourceLines = sourceContent.split('\n');
  const targetLines = targetContent.split('\n');

  const max = Math.min(sourceLines.length, targetLines.length);

  for (let i = 0; i < max; i++) {
    const sourceLine = sourceLines[i];
    let targetLine = targetLines[i];

    // Headings: =, ==, === etc.
    const sourceHeading = sourceLine.match(/^(\s*)(=+)(\s+)(.+)$/);
    const targetHeading = targetLine.match(/^(\s*)(=+)(\s+)(.+)$/);

    if (sourceHeading && targetHeading) {
      const [, , sourceMarks] = sourceHeading;
      const [, targetLead, , targetSpace, targetText] = targetHeading;

      // Copy heading markers (=, ==, ===) from source, keep target text
      targetLine = `${targetLead}${sourceMarks}${targetSpace}${targetText}`;
      targetLines[i] = targetLine;
      continue;
    }

    // Lists: *, **, ., .., 1., 2., -, # etc.
    const sourceList = sourceLine.match(/^(\s*)([*.+0-9#-]+)(\s+)(.+)$/);
    const targetList = targetLine.match(/^(\s*)([*.+0-9#-]+)(\s+)(.+)$/);

    if (sourceList && targetList) {
      const [, , sourceMarker] = sourceList;
      const [, targetLead, , targetSpace, targetText] = targetList;

      // Copy list marker (*, **, 1., etc.) from source, keep target text
      targetLine = `${targetLead}${sourceMarker}${targetSpace}${targetText}`;
      targetLines[i] = targetLine;
      continue;
    }

    // All other lines stay untouched
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
    `Syncing structure (${resolvedDirection}) from source to target: ${sourcePath} -> ${existingTargetPath}`
  );

  if (outputPath !== existingTargetPath) {
    console.log(`Writing synced structure to temp output: ${outputPath}`);
  }

  const [sourceContent, targetContent] = await Promise.all([
    fs.readFile(sourcePath, 'utf8'),
    fs.readFile(existingTargetPath, 'utf8'),
  ]);

  const updatedTargetContent = syncStructure(sourceContent, targetContent);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, updatedTargetContent, 'utf8');

  console.log('Structure sync completed.');
}

main().catch((err) => {
  console.error('Error while syncing structure:', err);
  process.exit(1);
});