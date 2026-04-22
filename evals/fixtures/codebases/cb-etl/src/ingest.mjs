// Read a trivial CSV (first line header, `,` separator, no quoting). Real
// pipeline would use a proper parser — for eval fixture purposes this is
// enough to exercise the stages.
//
// BUG (BF-07): spec says empty input → empty output, exit 0. We currently
// throw on an empty buffer because we dereference `lines[0]` unconditionally.
// Fix: handle the empty / header-only case and return [].
export function ingest(csv) {
  const lines = csv.replace(/\r\n/g, '\n').split('\n').filter((l) => l.length > 0);
  const header = lines[0].split(',');
  const out = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const row = {};
    for (let i = 0; i < header.length; i += 1) {
      row[header[i]] = cells[i] ?? '';
    }
    out.push(row);
  }
  return out;
}
