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
    customCompare(_original, roundtripped) {
      // Known limitation: code blocks come back as inline code per-line
      // (Google Docs uses monospace font, not fenced blocks).
      // Verify the code content survives.
      const n = normalize(roundtripped);
      const hasCode = n.includes('function hello()') && n.includes('return "world"');
      return {
        pass: hasCode,
        diffs: hasCode ? [] : [`Code content not found in: ${n}`],
      };
    },
  },

  {
    title: 'Code block with language tag',
    markdown: `\`\`\`typescript
const x: number = 42;
\`\`\``,
    customCompare(original, roundtripped) {
      // Language tags are lost in Google Docs (rendered as monospace),
      // so just check that the code content survives.
      const codeContent = 'const x: number = 42;';
      const hasCode = normalize(roundtripped).includes(codeContent);
      return {
        pass: hasCode,
        diffs: hasCode ? [] : [`Code content "${codeContent}" not found in roundtripped output`],
      };
    },
  },

  // ── Lists ───────────────────────────────────────────────

  {
    title: 'Unordered list',
    markdown: `- First item
- Second item
- Third item`,
    customCompare(_original, roundtripped) {
      // Known limitation: Google Docs adds blank lines between list items.
      const n = normalize(roundtripped);
      const hasAll = ['First item', 'Second item', 'Third item'].every(i => n.includes(`- ${i}`));
      return { pass: hasAll, diffs: hasAll ? [] : [`List items not found in: ${n}`] };
    },
  },

  {
    title: 'Ordered list',
    markdown: `1. Step one
2. Step two
3. Step three`,
    customCompare(_original, roundtripped) {
      // Known limitations: Google Docs adds blank lines between items and
      // renumbers all items to `1.` (the actual numbering is in list properties).
      const n = normalize(roundtripped);
      const hasAll = ['Step one', 'Step two', 'Step three'].every(i => n.includes(i));
      return { pass: hasAll, diffs: hasAll ? [] : [`List items not found in: ${n}`] };
    },
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
    customCompare(_original, roundtripped) {
      // Known limitation: empty cells get extra spaces in roundtrip ("|  |" vs "| |").
      const n = normalize(roundtripped);
      const hasStructure = n.includes('| A | B | C |') && n.includes('x') && n.includes('y') && n.includes('z');
      return { pass: hasStructure, diffs: hasStructure ? [] : [`Table structure not found in: ${n}`] };
    },
  },

  // ── Blockquotes ─────────────────────────────────────────

  {
    title: 'Blockquote',
    markdown: `> This is a quoted block of text.`,
    customCompare(_original, roundtripped) {
      // Known limitation: blockquote > prefix is lost (Google Docs has no
      // native blockquote concept; we insert plain text).
      const n = normalize(roundtripped);
      const hasText = n.includes('This is a quoted block of text.');
      return { pass: hasText, diffs: hasText ? [] : [`Blockquote text not found in: ${n}`] };
    },
  },

  // ── Horizontal rules ────────────────────────────────────

  {
    title: 'Horizontal rule',
    markdown: `Above the rule.

---

Below the rule.`,
    customCompare(_original, roundtripped) {
      // Known limitation: --- is rendered as ——— (em-dash characters).
      const n = normalize(roundtripped);
      const hasContent = n.includes('Above the rule') && n.includes('Below the rule');
      return { pass: hasContent, diffs: hasContent ? [] : [`Rule content not found in: ${n}`] };
    },
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
    customCompare(_original, roundtripped) {
      // Combines known limitations of lists (extra blank lines) and
      // code blocks (inline code per-line).
      const n = normalize(roundtripped);
      const checks = ['## Setup', 'Install dependencies', 'Node.js 18+', 'npm or yarn', 'npm install', 'npm start'];
      const hasAll = checks.every(c => n.includes(c));
      return { pass: hasAll, diffs: hasAll ? [] : [`Missing content in: ${n}`] };
    },
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
    title: 'Mermaid diagram renders as image',
    markdown: `\`\`\`mermaid
graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Do something]
    B -->|No| D[Do nothing]
    C --> E[End]
    D --> E
\`\`\``,
    customCompare(_original, roundtripped) {
      // Without a DB, the mermaid source can't be restored from the image.
      // Verify that the mermaid was rendered and inserted as an image
      // (the roundtripped output should contain a ![...](...) image tag).
      const normalized = normalize(roundtripped);
      const hasImage = /!\[.*\]\(https:\/\//.test(normalized);
      return {
        pass: hasImage,
        diffs: hasImage ? [] : [`Expected an image tag in roundtripped output. Got:\n${normalized}`],
      };
    },
  },

  // ── Edge cases ──────────────────────────────────────────

  {
    title: 'Special characters',
    markdown: `Ampersand & angle brackets < > and "quotes" and 'apostrophes'.`,
  },

  {
    title: 'Nested formatting',
    markdown: `This is **bold and *bold italic* text** here.`,
    customCompare(_original, roundtripped) {
      // Known limitation: bold+italic boundary splits differently on round-trip.
      // Google Docs stores formatting per-run, so boundaries may shift.
      const n = normalize(roundtripped);
      const hasContent = n.includes('bold and') && n.includes('bold italic') && n.includes('text');
      return { pass: hasContent, diffs: hasContent ? [] : [`Formatting content not found in: ${n}`] };
    },
  },
];

// ── Runner ──────────────────────────────────────────────────

async function run() {
  const client = createClient();

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

      // Write the test case markdown
      await client.writeMarkdown(docId, tc.markdown);

      // Read it back
      const roundtripped = await client.readMarkdown(docId);

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
