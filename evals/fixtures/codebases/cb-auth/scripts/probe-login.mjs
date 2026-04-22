// Standalone probe: starts the server on an ephemeral port, fires a
// /login request, prints the observed HTTP status, and exits 0. The
// eval harness greps stdout for `status=<N>`. Invoked by the `run`
// behavior check; any crash in setup yields a non-zero exit.
import { makeServer } from '../src/server.mjs';

const mode = process.argv[2] ?? '--bad';
const body =
  mode === '--good'
    ? { username: 'alice', password: 'alicepw' }
    : mode === '--unknown'
      ? { username: 'nobody', password: 'whatever' }
      : { username: 'alice', password: 'WRONG' };

const server = makeServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

try {
  const res = await fetch(`http://127.0.0.1:${port}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log(`status=${res.status}`);
} finally {
  server.close();
}
