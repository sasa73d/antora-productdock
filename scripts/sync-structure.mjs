// sync-structure.mjs
// Synchronizes structural markers (list bullets, numbering, headings) from
// an English AsciiDoc file to its Serbian counterpart, without calling AI.
//
// The idea:
// - Read EN and SR files
// - Walk line by line (best-effort alignment)
// - For lines that are list items or headings in both files,
//   copy the marker part (*, **, 1., ==, ===, ...) from EN to SR,
//   but keep the SR text as-is.

import fs from 'fs/promises';

async function main() {
  const [, , enPath, srPath] = process.argv;

  if (!enPath || !srPath) {
    console.error('Usage: node sync-structure.mjs <enFile.adoc> <srFile.adoc>');
    process.exit(1);
  }

  console.log(`Syncing structure from EN to SR: ${enPath} -> ${srPath}`);

  const [enContent, srContent] = await Promise.all([
    fs.readFile(enPath, 'utf8'),
    fs.readFile(srPath, 'utf8'),
  ]);

  const enLines = enContent.split('\n');
  const srLines = srContent.split('\n');

  const max = Math.min(enLines.length, srLines.length);

  for (let i = 0; i < max; i++) {
    const enLine = enLines[i];
    let srLine = srLines[i];

    // Headings: =, ==, === etc.
    const enHeading = enLine.match(/^(\s*)(=+)(\s+)(.+)$/);
    const srHeading = srLine.match(/^(\s*)(=+)(\s+)(.+)$/);

    if (enHeading && srHeading) {
      const [, enLead, enMarks, enSpace] = enHeading;
      const [, srLead, , srSpace, srText] = srHeading;

      // Copy heading markers (=, ==, ===) from EN, keep SR text
      srLine = `${srLead}${enMarks}${srSpace}${srText}`;
      srLines[i] = srLine;
      continue;
    }

    // Lists: *, **, ., .., 1., 2., -, # etc.
    const enList = enLine.match(/^(\s*)([*.+0-9#-]+)(\s+)(.+)$/);
    const srList = srLine.match(/^(\s*)([*.+0-9#-]+)(\s+)(.+)$/);

    if (enList && srList) {
      const [, enLead, enMarker] = enList;
      const [, srLead, , srSpace, srText] = srList;

      // Copy list marker (*, **, 1., etc.) from EN, keep SR text
      srLine = `${srLead}${enMarker}${srSpace}${srText}`;
      srLines[i] = srLine;
      continue;
    }

    // All other lines stay untouched
  }

  const updatedSrContent = srLines.join('\n');
  await fs.writeFile(srPath, updatedSrContent, 'utf8');

  console.log('Structure sync completed.');
}

main().catch((err) => {
  console.error('Error while syncing structure:', err);
  process.exit(1);
});
