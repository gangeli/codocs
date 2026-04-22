import { readFile } from 'node:fs/promises';
import { ingest } from '../src/ingest.mjs';
import { transform } from '../src/transform.mjs';
import { load } from '../src/load.mjs';

const [, , inPath, outPath, ...rest] = process.argv;
const dry = rest.includes('--dry');

const csv = await readFile(inPath, 'utf8');
const rows = ingest(csv);
const transformed = transform(rows);
if (!dry) {
  await load(transformed, outPath);
}
console.log(`rows_in=${rows.length} rows_out=${transformed.length}`);
