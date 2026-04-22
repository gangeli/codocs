// Probe /users?limit=N. Prints `count=<N>` so the eval harness can assert
// exactly N items came back.
import { makeServer } from '../src/server.mjs';

const limit = Number(process.argv[2] ?? 1);

const server = makeServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

try {
  const res = await fetch(`http://127.0.0.1:${port}/users?limit=${limit}&offset=0`);
  const arr = await res.json();
  console.log(`count=${arr.length}`);
} finally {
  server.close();
}
