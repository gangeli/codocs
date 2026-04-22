# Notes for Claude

To run a subset of the e2e edit-roundtrip tests, pass case-insensitive title substrings as positional args (e.g. `npx tsx scripts/e2e-edit-roundtrip.ts X1 M3` runs anything matching `X1` or `M3`; chain tests auto-include their predecessors).

To run individual eval cases: `make eval FILTER=<id-or-category>` — `FILTER` is a case-insensitive substring match against case IDs (e.g. `BF-01`, `BF-08-deploy`) or an exact category (`bug-fix`, `safety`). Add `MODEL=haiku|sonnet|opus` (default `sonnet`) and `CONCURRENCY=<n>` (default 2) as needed.
