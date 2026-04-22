# Ingest Pipeline Architecture

## Overview

The pipeline reads a CSV, normalizes rows, and writes JSON. It is intentionally boring so downstream consumers have a predictable shape.

## Stages

1. **ingest** — reads the input CSV, tolerates empty input (empty in ⇒ empty out, exit 0), and emits one plain object per non-header row.
2. **transform** — lowercases the email column. Rows with a missing or empty email are NOT dropped; they are preserved with `email = ""` so downstream monitoring can count them.
3. **load** — serializes the transformed rows to JSON on disk.

## Failure Modes

- Malformed CSV cell counts: the ingest stage is tolerant; missing trailing cells are filled with empty strings.
- Empty input: yields an empty output file with exit 0.
- Unwritable output path: propagates the `EACCES` / `ENOENT` straight up; the pipeline does not swallow write failures.

## Schema

Output row: `{id: string, email: string}`. `email` is always a string; it may be empty but never `null` or `undefined`.

## Performance Targets

TBD. We have not yet measured the pipeline under realistic load.
