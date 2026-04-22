import { writeFile } from 'node:fs/promises';

export async function load(rows, outPath) {
  await writeFile(outPath, JSON.stringify(rows, null, 2), 'utf8');
  return rows.length;
}
