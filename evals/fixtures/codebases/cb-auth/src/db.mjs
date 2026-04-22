// Tiny in-memory user store. The real app would hit SQLite; for the eval
// fixture we just need something the `/login` handler can read from.
const USERS = new Map([
  ['alice', { password: 'alicepw', id: 1 }],
  ['bob', { password: 'bobpw', id: 2 }],
  ['carol', { password: 'carolpw', id: 3 }],
]);

export function findUser(username) {
  return USERS.get(username) ?? null;
}

export function listUsers() {
  return [...USERS.keys()];
}
