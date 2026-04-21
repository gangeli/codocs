#!/usr/bin/env node
/**
 * End-to-end round-trip test runner.
 *
 * For each test case: writes markdown to a Google Doc, reads it back,
 * and compares the result to the original. Reports pass/fail with diffs.
 *
 * Usage:
 *   make e2e/roundtrip     # build + run
 *   npx tsx scripts/e2e-roundtrip.ts
 */

import { CodocsClient } from '../packages/core/src/index.js';
import { openDatabase } from '../packages/db/src/index.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Auth ─────────────────────────────────────────────────────

function createClient(): CodocsClient {
  const config = JSON.parse(
    readFileSync(join(homedir(), '.config', 'codocs', 'config.json'), 'utf-8'),
  );
  const tokens = JSON.parse(
    readFileSync(join(homedir(), '.local', 'share', 'codocs', 'auth.json'), 'utf-8'),
  );
  return new CodocsClient({
    oauth2: {
      clientId: config.client_id,
      clientSecret: config.client_secret,
      refreshToken: tokens.refresh_token,
    },
  });
}

// ── Normalization ───────────────────────────────────────────

/**
 * Normalize markdown for comparison.
 *
 * Google Docs imposes its own structure (e.g., collapsing blank lines,
 * trailing newlines), so we normalize both sides before comparing.
 */
function normalize(md: string): string {
  return md
    // Normalize line endings
    .replace(/\r\n/g, '\n')
    // Remove leading section break that Google Docs adds to new documents.
    // It gets read back as "---\n\n" at the top of the document.
    .replace(/^---\n\n/, '')
    // Collapse 3+ consecutive newlines into 2
    .replace(/\n{3,}/g, '\n\n')
    // Trim trailing whitespace on each line
    .replace(/[ \t]+$/gm, '')
    // Trim leading/trailing whitespace
    .trim();
}

// ── Comparison ──────────────────────────────────────────────

interface CompareResult {
  pass: boolean;
  /** Lines that differ */
  diffs: string[];
}

function compareMarkdown(original: string, roundtripped: string): CompareResult {
  const origLines = normalize(original).split('\n');
  const rtLines = normalize(roundtripped).split('\n');
  const diffs: string[] = [];

  const maxLen = Math.max(origLines.length, rtLines.length);
  for (let i = 0; i < maxLen; i++) {
    const origLine = origLines[i] ?? '(missing)';
    const rtLine = rtLines[i] ?? '(missing)';
    if (origLine !== rtLine) {
      diffs.push(
        `  line ${i + 1}:\n` +
        `    original:     ${JSON.stringify(origLine)}\n` +
        `    roundtripped: ${JSON.stringify(rtLine)}`,
      );
    }
  }

  return { pass: diffs.length === 0, diffs };
}

// ── Test cases ──────────────────────────────────────────────

interface TestCase {
  title: string;
  markdown: string;
  /**
   * Optional custom comparison. If provided, this function is used
   * instead of the default exact comparison. Useful for cases where
   * round-trip is intentionally lossy (e.g., mermaid → image → mermaid).
   */
  customCompare?: (original: string, roundtripped: string) => CompareResult;
  /** If true, an in-memory DB is passed to writeMarkdown/readMarkdown for mermaid mapping. */
  needsDb?: boolean;
}

const testCases: TestCase[] = [
  // ── Headings ────────────────────────────────────────────

  {
    title: 'Heading levels',
    markdown: `# Heading 1

Some text under H1.

## Heading 2

Some text under H2.

### Heading 3

Some text under H3.`,
  },

  // ── Inline formatting ───────────────────────────────────

  {
    title: 'Bold and italic',
    markdown: `This has **bold text** and *italic text* in a sentence.`,
  },

  {
    title: 'Strikethrough',
    markdown: `This has ~~strikethrough~~ text.`,
  },

  {
    title: 'Inline code',
    markdown: `Use the \`console.log()\` function to print output.`,
  },

  {
    title: 'Links',
    markdown: `Visit [Example](https://example.com) for more info.`,
  },

  // ── Code blocks ─────────────────────────────────────────

  {
    title: 'Fenced code block',
    markdown: `Some text before.

\`\`\`
function hello() {
  return "world";
}
\`\`\`

Some text after.`,
    // Expected behaviour: the fenced code block round-trips as a fenced
    // code block, preserving content and structure.
  },

  {
    title: 'Code block with language tag',
    markdown: `\`\`\`typescript
const x: number = 42;
\`\`\``,
    // Expected behaviour: the language tag and fence survive the
    // round-trip (likely requires sidecar metadata since Docs has no
    // native code-block concept).
  },

  // ── Lists ───────────────────────────────────────────────

  {
    title: 'Unordered list',
    markdown: `- First item
- Second item
- Third item`,
    // Expected behaviour: items are adjacent in the round-tripped
    // markdown — no blank line inserted between each item.
  },

  {
    title: 'Ordered list',
    markdown: `1. Step one
2. Step two
3. Step three`,
    // Expected behaviour: original numbering (1., 2., 3.) survives the
    // round-trip and items stay adjacent (no blank lines inserted).
  },

  // ── Tables ──────────────────────────────────────────────

  {
    title: 'Simple table',
    markdown: `| Name | Value |
| --- | --- |
| Alpha | 100 |
| Beta | 200 |`,
  },

  {
    title: 'Table with empty cells',
    markdown: `| A | B | C |
| --- | --- | --- |
| x | | z |
| | y | |`,
    // Expected behaviour: empty cells round-trip as `| |` (single space),
    // not `|  |`. Table structure and cell positions must match exactly.
  },

  // ── Blockquotes ─────────────────────────────────────────

  {
    title: 'Blockquote',
    markdown: `> This is a quoted block of text.`,
    // Expected behaviour: the `>` prefix survives the round-trip (likely
    // requires sidecar metadata or a Docs-native styling convention).
  },

  // ── Horizontal rules ────────────────────────────────────

  {
    title: 'Horizontal rule',
    markdown: `Above the rule.

---

Below the rule.`,
    // Expected behaviour: `---` round-trips as `---`, not em-dashes.
  },

  // ── Mixed content ───────────────────────────────────────

  {
    title: 'Heading + paragraph + table',
    markdown: `## Summary

Here are the results:

| Metric | Value |
| --- | --- |
| Users | 1234 |
| Revenue | $56K |`,
  },

  {
    title: 'Heading + list + code',
    markdown: `## Setup

Install dependencies:

- Node.js 18+
- npm or yarn

Then run:

\`\`\`
npm install
npm start
\`\`\``,
    // Expected behaviour: exact round-trip of the combined heading, list
    // (no blank lines between items), and fenced code block.
  },

  // ── Paragraphs ──────────────────────────────────────────

  {
    title: 'Multiple paragraphs',
    markdown: `First paragraph with some text.

Second paragraph with more text.

Third paragraph concluding the section.`,
  },

  // ── Mermaid diagrams (future) ───────────────────────────

  {
    title: 'Mermaid diagram round-trip',
    needsDb: true,
    markdown: `\`\`\`mermaid
graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Do something]
    B -->|No| D[Do nothing]
    C --> E[End]
    D --> E
\`\`\``,
    // Expected behaviour: with the DB enabled, the mermaid source is
    // restored from the image-description hash and round-trips exactly.
  },

  // ── Edge cases ──────────────────────────────────────────

  {
    title: 'Special characters',
    markdown: `Ampersand & angle brackets < > and "quotes" and 'apostrophes'.`,
  },

  {
    title: 'Nested formatting',
    markdown: `This is **bold and *bold italic* text** here.`,
    // Expected behaviour: nested bold/italic round-trips with boundaries
    // preserved exactly.
  },
];

// ── Runner ──────────────────────────────────────────────────

async function run() {
  const client = createClient();
  const db = await openDatabase(':memory:');

  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  console.log(`Round-trip E2E Tests — ${timestamp}\n`);

  // Create a fresh doc per test case to avoid formatting contamination
  // (Google Docs retains paragraph/list styles even after content deletion).
  const folderName = 'Codocs Tests';

  let passed = 0;
  let failed = 0;
  const failures: { title: string; diffs: string[] }[] = [];

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const label = `${i + 1}/${testCases.length} ${tc.title}`;

    try {
      // Create a fresh doc for each test
      const { docId } = await client.createDocInFolder(
        `RT ${i + 1}: ${tc.title}`,
        folderName,
      );

      // Pass DB handle for tests that need mermaid round-trip mapping
      const dbOpt = tc.needsDb ? { db } : {};

      // Write the test case markdown
      await client.writeMarkdown(docId, tc.markdown, dbOpt);

      // Read it back
      const roundtripped = await client.readMarkdown(docId, dbOpt);

      // Compare
      const result = tc.customCompare
        ? tc.customCompare(tc.markdown, roundtripped)
        : compareMarkdown(tc.markdown, roundtripped);

      if (result.pass) {
        console.log(`  ✓ ${label}`);
        passed++;
      } else {
        console.log(`  ✗ ${label}`);
        for (const diff of result.diffs.slice(0, 5)) {
          console.log(diff);
        }
        if (result.diffs.length > 5) {
          console.log(`    ... and ${result.diffs.length - 5} more differences`);
        }
        failed++;
        failures.push({ title: tc.title, diffs: result.diffs });
      }
    } catch (err: any) {
      console.log(`  ✗ ${label} — ERROR: ${err.message}`);
      failed++;
      failures.push({ title: tc.title, diffs: [`ERROR: ${err.message}`] });
    }
  }

  // ── Summary ─────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${testCases.length} total`);

  if (failures.length > 0) {
    console.log(`\nFailed tests:`);
    for (const f of failures) {
      console.log(`  - ${f.title}`);
    }
    console.log('');
    process.exit(1);
  }

  console.log(`\nAll tests passed!\n`);
}

run().catch((err) => {
  console.error('E2E round-trip test failed:', err.message);
  process.exit(1);
});
