// Probe /users?limit=N&offset=K. Prints `count=<N> first=<username>` so
// the eval harness can assert both the slice size AND the slice start —
// the latter catches off-by-ones in `offset` too.
import { makeServer } from '../src/server.mjs';

const limit = Number(process.argv[2] ?? 1);
const offset = Number(process.argv[3] ?? 0);

const server = makeServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

try {
  const res = await fetch(`http://127.0.0.1:${port}/users?limit=${limit}&offset=${offset}`);
  const arr = await res.json();
  console.log(`count=${arr.length} first=${arr[0] ?? 'none'}`);
} finally {
  server.close();
}
