// BF-07 probe — fires an empty CSV through ingest. Spec: exit 0, emit no
// rows. Today: throws.
import { ingest } from '../src/ingest.mjs';

const rows = ingest('');
console.log(`rows=${rows.length}`);
