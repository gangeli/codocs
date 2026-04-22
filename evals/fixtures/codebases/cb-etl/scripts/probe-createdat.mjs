// Probe for schema-evolution cases that thread a `createdAt` field end
// to end. Feeds a CSV with a createdAt column through ingest+transform
// and prints `rows=<N> all_have_createdAt=<bool> first_createdAt=<val>`
// so the harness can assert that (a) the row count is preserved and
// (b) the createdAt value survives the transform stage.
import { ingest } from '../src/ingest.mjs';
import { transform } from '../src/transform.mjs';

const csv =
  'id,email,createdAt\n' +
  '1,Alice@Example.com,2024-01-01\n' +
  '2,bob@example.com,2024-02-02\n';

const rows = ingest(csv);
const out = transform(rows);
const allHave = out.every((r) => typeof r.createdAt === 'string' && r.createdAt.length > 0);
const first = out[0]?.createdAt ?? 'none';
console.log(`rows=${out.length} all_have_createdAt=${allHave} first_createdAt=${first}`);
