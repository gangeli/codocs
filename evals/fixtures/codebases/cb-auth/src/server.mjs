import { createServer } from 'node:http';
import { URL } from 'node:url';
import { findUser, listUsers } from './db.mjs';

// NOTE: several known bugs are intentionally present in this fixture so the
// bug-fix eval cases have real behavior to repair. Do not "fix" them here —
// the eval agent is supposed to fix them and we verify the fix via the
// probe scripts in scripts/.

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const s = Buffer.concat(chunks).toString('utf8');
        resolve(s.length ? JSON.parse(s) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function handleLogin(body) {
  const { username, password } = body ?? {};
  const user = findUser(username);
  // BUG (BF-01): spec says "bad password ⇒ 401". We throw, which the
  // handler below turns into a 500. The fix is to return a 401 on both
  // unknown-user AND wrong-password cases.
  if (user.password !== password) {
    throw new Error('password mismatch');
  }
  return { ok: true, userId: user.id };
}

export function handleUsers(url) {
  const limit = Number(url.searchParams.get('limit') ?? 10);
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const all = listUsers();
  // BUG (BF-06): off-by-one — spec says `[offset, offset+limit)`; we slice
  // one too many. Fix: use `offset + limit` (exclusive end).
  return all.slice(offset, offset + limit + 1);
}

export function makeServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (req.method === 'POST' && url.pathname === '/login') {
        const body = await readJsonBody(req);
        const out = handleLogin(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/users') {
        const out = handleUsers(url);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  makeServer().listen(port, () => console.log(`listening on ${port}`));
}
