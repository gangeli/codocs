// BUG (BF-02): spec says rows with missing email are preserved with
// `email = ""` (so downstream can notice and alert). We currently drop
// them, silently losing data. Fix: keep the row, set email to "".
export function transform(rows) {
  const out = [];
  for (const row of rows) {
    if (!row.email || row.email.length === 0) continue;
    out.push({ id: row.id, email: row.email.toLowerCase() });
  }
  return out;
}
