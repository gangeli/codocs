# cb-auth

Tiny HTTP service used as an eval fixture. Two endpoints:

- `POST /login` — body `{username, password}` → 200 on match, 401 on mismatch or unknown user
- `GET /users?limit=N&offset=K` — returns users in the half-open range `[offset, offset+limit)`

Run: `node src/server.mjs` (listens on `$PORT`, default 3000).
