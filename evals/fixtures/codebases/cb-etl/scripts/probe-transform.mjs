// Fires a tiny fixed input through the transform stage and prints
// `kept=<N> dropped=<N>`. Used by the BF-02 behavior check.
import { transform } from '../src/transform.mjs';

const input = [
  { id: '1', email: 'alice@example.com' },
  { id: '2', email: '' },
  { id: '3', email: 'bob@example.com' },
];
const out = transform(input);
const kept = out.length;
const dropped = input.length - kept;
console.log(`kept=${kept} dropped=${dropped}`);
