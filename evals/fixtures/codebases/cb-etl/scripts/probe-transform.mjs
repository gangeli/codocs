// Fires a tiny fixed input through the transform stage and prints
// `kept=<N> dropped=<N>`. Used by the BF-02 behavior check.
//
// Row 2 tests `email = ''`; row 4 tests a missing `email` key. Both
// should be preserved per the doc (email stays an empty string). A fix
// that only handles one of the two cases will fail this probe.
import { transform } from '../src/transform.mjs';

const input = [
  { id: '1', email: 'alice@example.com' },
  { id: '2', email: '' },
  { id: '3', email: 'bob@example.com' },
  { id: '4' }, // no `email` key at all
];
const out = transform(input);
const kept = out.length;
const dropped = input.length - kept;
const allEmailsStrings = out.every((r) => typeof r.email === 'string');
console.log(`kept=${kept} dropped=${dropped} emails_all_string=${allEmailsStrings}`);
