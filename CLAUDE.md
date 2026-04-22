# Notes for Claude

To run a subset of the e2e edit-roundtrip tests, pass case-insensitive title substrings as positional args (e.g. `npx tsx scripts/e2e-edit-roundtrip.ts X1 M3` runs anything matching `X1` or `M3`; chain tests auto-include their predecessors).
