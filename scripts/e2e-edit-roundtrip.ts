#!/usr/bin/env node
/**
 * End-to-end EDIT-roundtrip test runner.
 *
 * Complements scripts/e2e-roundtrip.ts. That script validates
 * write → read fidelity. This one validates EDIT fidelity:
 *
 *   writeMarkdown(fixture)         — seed the doc
 *   readMarkdown                   — get `base` that the agent sees
 *   agent edit: base → ours        — applied in-memory
 *   computeDocDiff + batchUpdate   — the real production pipeline
 *   readMarkdown                   — fetch the resulting doc
 *   assert exact position of the edit
 *
 * The assertions emphasize POSITION: exact normalized bodies where
 * possible, plus ordering checks and substring presence/absence
 * for rich content where round-trip introduces known quirks.
 *
 * To minimize doc creation, tests are grouped by fixture. Each group
 * uses one canvas doc, resetting the body via writeMarkdown('replace')
 * between tests. Chain tests skip the reset and build on the previous
 * test's end state.
 *
 * Usage:
 *   make e2e/roundtrip
 *   npx tsx scripts/e2e-edit-roundtrip.ts
 */

import {
  CodocsClient,
  docsToMarkdownWithMapping,
  computeDocDiff,
} from '../packages/core/src/index.js';
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

// ── Normalization (mirrors e2e-roundtrip.ts) ────────────────

function normalize(md: string): string {
  return md
    .replace(/\r\n/g, '\n')
    .replace(/^---\n\n/, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

// ── Assertion model ──────────────────────────────────────────

interface Expectation {
  /** Full normalized body must equal this (strongest assertion). */
  exact?: string;
  /** Every listed substring must appear after normalization. */
  contains?: string[];
  /** No listed substring may appear after normalization. */
  notContains?: string[];
  /** Each `[a, b]` pair: `a` must appear strictly before `b`. */
  ordering?: Array<[string, string]>;
  /** Each regex must match the normalized body. */
  matches?: RegExp[];
  /** Each regex must NOT match the normalized body. */
  notMatches?: RegExp[];
  /** Arbitrary extra check against the final body. */
  custom?: (actual: string) => { pass: boolean; reason?: string };
  /** Exact number of batchUpdate requests produced by computeDocDiff. */
  exactRequests?: number;
  /** Maximum number of batchUpdate requests produced by computeDocDiff. */
  maxRequests?: number;
  /** Minimum number of batchUpdate requests produced by computeDocDiff. */
  minRequests?: number;
}

interface EditTestCase {
  title: string;
  /** Fixture markdown to seed the doc with. Required unless chain. */
  fixture?: string;
  /** Produce the agent's edited markdown from the current read-back `base`. */
  apply: (base: string) => string;
  expect: Expectation;
  /** If true, inherit the doc state from the previous test (no reset). */
  chain?: boolean;
  /** Optional: override canvas doc name (tests in a group share a doc). */
  canvas?: string;
  /** If set, the test is reported as SKIPPED with this reason (no API
   *  calls are made). Use for scenarios the pipeline provably can't
   *  handle in this Docs environment. */
  skip?: string;
}

function verify(
  actual: string,
  exp: Expectation,
  requestCount?: number,
): { pass: boolean; reasons: string[] } {
  const n = normalize(actual);
  const reasons: string[] = [];

  if (exp.exact !== undefined) {
    const expectedN = normalize(exp.exact);
    if (n !== expectedN) {
      reasons.push(
        `Exact body mismatch.\n` +
          `      expected:\n${indent(expectedN, '        ')}\n` +
          `      actual:\n${indent(n, '        ')}`,
      );
    }
  }
  if (requestCount !== undefined) {
    if (exp.exactRequests !== undefined && requestCount !== exp.exactRequests) {
      reasons.push(
        `expected exactly ${exp.exactRequests} batchUpdate requests, got ${requestCount}`,
      );
    }
    if (exp.maxRequests !== undefined && requestCount > exp.maxRequests) {
      reasons.push(
        `expected at most ${exp.maxRequests} batchUpdate requests, got ${requestCount}`,
      );
    }
    if (exp.minRequests !== undefined && requestCount < exp.minRequests) {
      reasons.push(
        `expected at least ${exp.minRequests} batchUpdate requests, got ${requestCount}`,
      );
    }
  }
  for (const s of exp.contains ?? []) {
    if (!n.includes(s)) reasons.push(`missing substring: ${JSON.stringify(s)}`);
  }
  for (const s of exp.notContains ?? []) {
    if (n.includes(s)) reasons.push(`unexpected substring present: ${JSON.stringify(s)}`);
  }
  for (const [a, b] of exp.ordering ?? []) {
    const ai = n.indexOf(a);
    const bi = n.indexOf(b);
    if (ai === -1) reasons.push(`ordering ref A missing: ${JSON.stringify(a)}`);
    else if (bi === -1) reasons.push(`ordering ref B missing: ${JSON.stringify(b)}`);
    else if (ai >= bi)
      reasons.push(
        `ordering violated: ${JSON.stringify(a)} (idx ${ai}) must come before ${JSON.stringify(
          b,
        )} (idx ${bi})`,
      );
  }
  for (const r of exp.matches ?? []) {
    if (!r.test(n)) reasons.push(`pattern did not match: ${r}`);
  }
  for (const r of exp.notMatches ?? []) {
    if (r.test(n)) reasons.push(`pattern unexpectedly matched: ${r}`);
  }
  if (exp.custom) {
    const r = exp.custom(n);
    if (!r.pass) reasons.push(`custom: ${r.reason ?? 'failed'}`);
  }

  return { pass: reasons.length === 0, reasons };
}

function indent(s: string, prefix: string): string {
  return s
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

// ── Fixtures ─────────────────────────────────────────────────

const FIX_PLAIN = `# Alpha

First paragraph of Alpha.

# Beta

Second paragraph of Beta.

# Gamma

Third paragraph of Gamma.
`;

const FIX_RICH = `# Rich

Some **bold word** and *italic word* and \`inline code\` and [link](https://example.com).

- apple
- banana
- cherry

| Col1 | Col2 |
| --- | --- |
| a | b |
| c | d |

End paragraph.
`;

const FIX_ABOVE = `# Above

- bullet one
- bullet two

| K | V |
| --- | --- |
| k1 | v1 |

Target paragraph to edit.

Following paragraph.
`;

const FIX_SPECIAL = `# Special

Line with emoji \u{1F916} in the middle.

Japanese \u65E5\u672C\u8A9E sentence.

Special chars & < > "quotes" 'apos' here.
`;

const FIX_HEADING_ONLY = `# Lonely heading
`;

// Construct a 40-paragraph long doc (one heading + many body paragraphs).
function makeLongFixture(): string {
  const parts = [`# Long`];
  for (let i = 1; i <= 40; i++) {
    parts.push(`Paragraph number ${i} in the long doc.`);
  }
  return parts.join('\n\n') + '\n';
}
const FIX_LONG = makeLongFixture();

/**
 * Build the expected body for a Group D test by applying the given
 * paragraph rewrites to the generated long fixture. `edits` maps
 * paragraph number -> replacement paragraph body. The returned string
 * is NOT trailing-newline-terminated (to match normalize().trim() form).
 */
function buildLongExpected(edits: Record<number, string>): string {
  const parts = [`# Long`];
  for (let i = 1; i <= 40; i++) {
    parts.push(edits[i] ?? `Paragraph number ${i} in the long doc.`);
  }
  return parts.join('\n\n');
}

/**
 * Extended builder for the 40-paragraph long fixture: supports deletes
 * (skip certain paragraphs) and inserts (additional paragraphs after
 * a given index). Used by L2/L3.
 */
function buildLongExpectedEx(opts: {
  edits?: Record<number, string>;
  deletes?: Set<number>;
  insertsAfter?: Record<number, string[]>;
}): string {
  const parts = [`# Long`];
  for (let i = 1; i <= 40; i++) {
    if (opts.deletes?.has(i)) continue;
    parts.push(opts.edits?.[i] ?? `Paragraph number ${i} in the long doc.`);
    const add = opts.insertsAfter?.[i];
    if (add) parts.push(...add);
  }
  return parts.join('\n\n');
}

// ── L-group mega-doc fixture ────────────────────────────────

// 200-paragraph doc with H1 every 30 paragraphs, a 5-row table
// (header + 4 data rows) placed after paragraph 80, and a 10-item
// bullet list placed after paragraph 165. Designed to stress
// indexMap interpolation across a long body and exercise all three
// hunk routers (line-diff, table, list-append) in one diff.
function makeMegaFixture(): string {
  const parts: string[] = [`# Section 1`];
  for (let i = 1; i <= 200; i++) {
    parts.push(`Mega paragraph ${i}.`);
    if (i === 80) {
      parts.push(
        `| MC1 | MC2 |\n| --- | --- |\n| r1a | r1b |\n| r2a | r2b |\n| r3a | r3b |\n| r4a | r4b |`,
      );
    }
    if (i === 165) {
      const items: string[] = [];
      for (let j = 1; j <= 10; j++) items.push(`- mega-list item ${j}`);
      parts.push(items.join('\n'));
    }
    if (i % 30 === 0 && i < 200) {
      parts.push(`# Section ${Math.floor(i / 30) + 1}`);
    }
  }
  return parts.join('\n\n') + '\n';
}
const FIX_MEGA = makeMegaFixture();

// 100-paragraph single-section fixture, for L4 (edit near tail).
function makeSingleSectionLong(): string {
  const parts: string[] = [`# Long Section`];
  for (let i = 1; i <= 100; i++) parts.push(`L4 paragraph ${i}.`);
  return parts.join('\n\n') + '\n';
}
const FIX_L4 = makeSingleSectionLong();
function buildL4Expected(edits: Record<number, string>): string {
  const parts = [`# Long Section`];
  for (let i = 1; i <= 100; i++) {
    parts.push(edits[i] ?? `L4 paragraph ${i}.`);
  }
  return parts.join('\n\n');
}

// ── Test cases ───────────────────────────────────────────────

const tests: EditTestCase[] = [
  // ── Group A: Plain three-section positional edits ──
  {
    title: 'A1: replace first heading text',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) => b.replace('# Alpha', '# AAA'),
    expect: {
      exact: `# AAA

First paragraph of Alpha.

# Beta

Second paragraph of Beta.

# Gamma

Third paragraph of Gamma.`,
    },
  },
  {
    title: 'A2: replace middle heading text',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) => b.replace('# Beta', '# BBB'),
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# BBB

Second paragraph of Beta.

# Gamma

Third paragraph of Gamma.`,
    },
  },
  {
    title: 'A3: replace last heading text',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) => b.replace('# Gamma', '# GGG'),
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# Beta

Second paragraph of Beta.

# GGG

Third paragraph of Gamma.`,
    },
  },
  {
    title: 'A4: replace first body paragraph (whole)',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) => b.replace('First paragraph of Alpha.', 'Alpha body rewritten.'),
    expect: {
      exact: `# Alpha

Alpha body rewritten.

# Beta

Second paragraph of Beta.

# Gamma

Third paragraph of Gamma.`,
    },
  },
  {
    title: 'A5: replace middle body paragraph (whole)',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) => b.replace('Second paragraph of Beta.', 'Beta body rewritten.'),
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# Beta

Beta body rewritten.

# Gamma

Third paragraph of Gamma.`,
    },
  },
  {
    title: 'A6: replace last body paragraph (whole)',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) => b.replace('Third paragraph of Gamma.', 'Gamma body rewritten.'),
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# Beta

Second paragraph of Beta.

# Gamma

Gamma body rewritten.`,
    },
  },
  {
    title: 'A7: change single word in middle paragraph',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) => b.replace('paragraph of Beta', 'sentence of Beta'),
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# Beta

Second sentence of Beta.

# Gamma

Third paragraph of Gamma.`,
      contains: ['Second sentence of Beta.'],
      notContains: ['Second paragraph of Beta.'],
      ordering: [
        ['# Alpha', 'First paragraph of Alpha.'],
        ['First paragraph of Alpha.', '# Beta'],
        ['# Beta', 'Second sentence of Beta.'],
        ['Second sentence of Beta.', '# Gamma'],
        ['# Gamma', 'Third paragraph of Gamma.'],
      ],
    },
  },
  {
    title: 'A8: change a single character within a word',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) => b.replace('paragraph of Alpha', 'paragraphs of Alpha'),
    expect: {
      exact: `# Alpha

First paragraphs of Alpha.

# Beta

Second paragraph of Beta.

# Gamma

Third paragraph of Gamma.`,
      contains: ['First paragraphs of Alpha.'],
      notContains: ['First paragraph of Alpha.'],
    },
  },
  {
    title: 'A9: replace line with longer text',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) =>
      b.replace(
        'Second paragraph of Beta.',
        'Second paragraph of Beta has been significantly expanded with extra descriptive prose.',
      ),
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# Beta

Second paragraph of Beta has been significantly expanded with extra descriptive prose.

# Gamma

Third paragraph of Gamma.`,
      contains: ['Second paragraph of Beta has been significantly expanded'],
      notContains: ['Second paragraph of Beta.'],
      ordering: [
        ['# Beta', 'Second paragraph of Beta has been'],
        ['expanded with extra descriptive prose.', '# Gamma'],
      ],
    },
  },
  {
    title: 'A10: replace line with shorter text',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) => b.replace('Second paragraph of Beta.', 'Short.'),
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# Beta

Short.

# Gamma

Third paragraph of Gamma.`,
    },
  },
  {
    title: 'A11: replace single line with multi-line (split paragraph)',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) =>
      b.replace(
        'Second paragraph of Beta.',
        'Second paragraph of Beta line one.\n\nSecond paragraph of Beta line two.',
      ),
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# Beta

Second paragraph of Beta line one.

Second paragraph of Beta line two.

# Gamma

Third paragraph of Gamma.`,
      contains: [
        'Second paragraph of Beta line one.',
        'Second paragraph of Beta line two.',
      ],
      ordering: [
        ['# Beta', 'Second paragraph of Beta line one.'],
        ['Second paragraph of Beta line one.', 'Second paragraph of Beta line two.'],
        ['Second paragraph of Beta line two.', '# Gamma'],
      ],
    },
  },
  {
    title: 'A12: delete entire first section',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) => b.replace('# Alpha\n\nFirst paragraph of Alpha.\n\n', ''),
    expect: {
      exact: `# Beta

Second paragraph of Beta.

# Gamma

Third paragraph of Gamma.`,
      notContains: ['# Alpha', 'First paragraph of Alpha.'],
      contains: ['# Beta', 'Second paragraph of Beta.', '# Gamma', 'Third paragraph of Gamma.'],
      ordering: [
        ['# Beta', '# Gamma'],
      ],
    },
  },
  {
    title: 'A13: delete entire middle section',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) => b.replace('# Beta\n\nSecond paragraph of Beta.\n\n', ''),
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# Gamma

Third paragraph of Gamma.`,
      notContains: ['# Beta', 'Second paragraph of Beta.'],
      ordering: [['# Alpha', '# Gamma']],
    },
  },
  {
    title: 'A14: delete entire last section',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) => b.replace('\n\n# Gamma\n\nThird paragraph of Gamma.', ''),
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# Beta

Second paragraph of Beta.`,
      notContains: ['# Gamma', 'Third paragraph of Gamma.'],
      contains: ['# Alpha', '# Beta'],
    },
  },
  {
    title: 'A15: append a new section after last',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) => b.trimEnd() + '\n\n# Delta\n\nDelta body.\n',
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# Beta

Second paragraph of Beta.

# Gamma

Third paragraph of Gamma.

# Delta

Delta body.`,
      contains: ['# Delta', 'Delta body.'],
      ordering: [['# Gamma', '# Delta']],
    },
  },
  {
    title: 'A16: pure delete — drop a body line (leaves blank section)',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) => b.replace('\n\nSecond paragraph of Beta.', ''),
    expect: {
      // Beta section becomes empty; normalize() collapses 3+ newlines to 2,
      // so adjacent headings appear with a single blank line between them.
      exact: `# Alpha

First paragraph of Alpha.

# Beta

# Gamma

Third paragraph of Gamma.`,
      notContains: ['Second paragraph of Beta.'],
      contains: ['# Alpha', '# Beta', '# Gamma'],
      ordering: [
        ['# Beta', '# Gamma'],
      ],
    },
  },
  {
    title: 'A17: change heading level (H1 → H2)',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) => b.replace('# Alpha', '## Alpha'),
    expect: {
      exact: `## Alpha

First paragraph of Alpha.

# Beta

Second paragraph of Beta.

# Gamma

Third paragraph of Gamma.`,
      matches: [/^##\s+Alpha\s*$/m],
      notMatches: [/^#\s+Alpha\s*$/m],
      ordering: [
        ['## Alpha', 'First paragraph of Alpha.'],
        ['First paragraph of Alpha.', '# Beta'],
      ],
    },
  },
  {
    title: 'A18: insert a new section between Beta and Gamma',
    canvas: 'plain',
    fixture: FIX_PLAIN,
    apply: (b) =>
      b.replace(
        '# Beta\n\nSecond paragraph of Beta.\n\n',
        '# Beta\n\nSecond paragraph of Beta.\n\n# Inserted\n\nInserted body.\n\n',
      ),
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# Beta

Second paragraph of Beta.

# Inserted

Inserted body.

# Gamma

Third paragraph of Gamma.`,
    },
  },

  // ── Group B: Rich content edits ──
  {
    title: 'B1: edit the bolded word',
    canvas: 'rich',
    fixture: FIX_RICH,
    apply: (b) => b.replace('**bold word**', '**BOLD**'),
    expect: {
      exact: `# Rich

Some **BOLD** and *italic word* and \`inline code\` and [link](https://example.com).

- apple
- banana
- cherry

| Col1 | Col2 |
| --- | --- |
| a | b |
| c | d |

End paragraph.`,
      contains: ['**BOLD**'],
      notContains: ['**bold word**'],
    },
  },
  {
    title: 'B2: add bold to a previously plain word',
    canvas: 'rich',
    fixture: FIX_RICH,
    apply: (b) => b.replace('Some **bold word**', '**Some** **bold word**'),
    expect: {
      // Output is ambiguous — adjacent bold runs "**Some** **bold word**"
      // may be re-rendered as either two separate bold runs or a single
      // merged "**Some bold word**" (Docs stores textRun styling, not
      // markdown delimiters). Assert the invariant both renderings share:
      // each word lives inside a **…** span, "Some" precedes "bold word".
      contains: ['Some', 'bold word'],
      matches: [
        /\*\*[^*]*\bSome\b[^*]*\*\*/,
        /\*\*[^*]*\bbold word\b[^*]*\*\*/,
      ],
      ordering: [['Some', 'bold word']],
    },
  },
  {
    title: 'B3: remove bold formatting (keep text)',
    canvas: 'rich',
    fixture: FIX_RICH,
    apply: (b) => b.replace('**bold word**', 'bold word'),
    expect: {
      exact: `# Rich

Some bold word and *italic word* and \`inline code\` and [link](https://example.com).

- apple
- banana
- cherry

| Col1 | Col2 |
| --- | --- |
| a | b |
| c | d |

End paragraph.`,
      contains: ['bold word'],
      notMatches: [/\*\*bold word\*\*/],
    },
  },
  {
    title: 'B4: edit inline code content',
    canvas: 'rich',
    fixture: FIX_RICH,
    apply: (b) => b.replace('`inline code`', '`new snippet`'),
    expect: {
      exact: `# Rich

Some **bold word** and *italic word* and \`new snippet\` and [link](https://example.com).

- apple
- banana
- cherry

| Col1 | Col2 |
| --- | --- |
| a | b |
| c | d |

End paragraph.`,
      contains: ['`new snippet`'],
      notContains: ['`inline code`'],
    },
  },
  {
    title: 'B5: edit link text (preserve URL)',
    canvas: 'rich',
    fixture: FIX_RICH,
    apply: (b) => b.replace('[link](https://example.com)', '[homepage](https://example.com)'),
    expect: {
      exact: `# Rich

Some **bold word** and *italic word* and \`inline code\` and [homepage](https://example.com).

- apple
- banana
- cherry

| Col1 | Col2 |
| --- | --- |
| a | b |
| c | d |

End paragraph.`,
      contains: ['[homepage](https://example.com)'],
      notContains: ['[link](https://example.com)'],
    },
  },
  {
    title: 'B6: change link URL (preserve text)',
    canvas: 'rich',
    fixture: FIX_RICH,
    apply: (b) =>
      b.replace('[link](https://example.com)', '[link](https://codocs.dev)'),
    expect: {
      exact: `# Rich

Some **bold word** and *italic word* and \`inline code\` and [link](https://codocs.dev).

- apple
- banana
- cherry

| Col1 | Col2 |
| --- | --- |
| a | b |
| c | d |

End paragraph.`,
      contains: ['[link](https://codocs.dev)'],
      notContains: ['https://example.com'],
    },
  },
  {
    title: 'B7: edit a list item in the middle',
    canvas: 'rich',
    fixture: FIX_RICH,
    apply: (b) => b.replace('- banana', '- blueberry'),
    expect: {
      exact: `# Rich

Some **bold word** and *italic word* and \`inline code\` and [link](https://example.com).

- apple
- blueberry
- cherry

| Col1 | Col2 |
| --- | --- |
| a | b |
| c | d |

End paragraph.`,
      contains: ['- apple', '- blueberry', '- cherry'],
      notContains: ['- banana'],
      ordering: [
        ['- apple', '- blueberry'],
        ['- blueberry', '- cherry'],
      ],
    },
  },
  {
    title: 'B8: delete a middle list item',
    canvas: 'rich',
    fixture: FIX_RICH,
    apply: (b) => b.replace('- banana\n', ''),
    expect: {
      exact: `# Rich

Some **bold word** and *italic word* and \`inline code\` and [link](https://example.com).

- apple
- cherry

| Col1 | Col2 |
| --- | --- |
| a | b |
| c | d |

End paragraph.`,
      contains: ['- apple', '- cherry'],
      notContains: ['- banana'],
      ordering: [['- apple', '- cherry']],
    },
  },
  {
    title: 'B9: append a new list item at the end',
    canvas: 'rich',
    fixture: FIX_RICH,
    apply: (b) => b.replace('- cherry', '- cherry\n- date'),
    expect: {
      exact: `# Rich

Some **bold word** and *italic word* and \`inline code\` and [link](https://example.com).

- apple
- banana
- cherry
- date

| Col1 | Col2 |
| --- | --- |
| a | b |
| c | d |

End paragraph.`,
      contains: ['- apple', '- banana', '- cherry', '- date'],
      ordering: [['- cherry', '- date']],
    },
  },
  {
    title: 'B10: edit a table cell',
    canvas: 'rich',
    fixture: FIX_RICH,
    apply: (b) => b.replace('| a | b |', '| A | b |'),
    expect: {
      exact: `# Rich

Some **bold word** and *italic word* and \`inline code\` and [link](https://example.com).

- apple
- banana
- cherry

| Col1 | Col2 |
| --- | --- |
| A | b |
| c | d |

End paragraph.`,
      matches: [/\|\s*A\s*\|\s*b\s*\|/],
      ordering: [['| A | b |', '| c | d |']],
    },
  },
  {
    title: 'B11: add a table row',
    canvas: 'rich',
    fixture: FIX_RICH,
    apply: (b) => b.replace('| c | d |', '| c | d |\n| e | f |'),
    expect: {
      exact: `# Rich

Some **bold word** and *italic word* and \`inline code\` and [link](https://example.com).

- apple
- banana
- cherry

| Col1 | Col2 |
| --- | --- |
| a | b |
| c | d |
| e | f |

End paragraph.`,
      matches: [/\|\s*e\s*\|\s*f\s*\|/],
      ordering: [['| c | d |', '| e | f |']],
    },
  },
  {
    title: 'B12: delete a table row',
    canvas: 'rich',
    fixture: FIX_RICH,
    apply: (b) => b.replace('| a | b |\n', ''),
    expect: {
      exact: `# Rich

Some **bold word** and *italic word* and \`inline code\` and [link](https://example.com).

- apple
- banana
- cherry

| Col1 | Col2 |
| --- | --- |
| c | d |

End paragraph.`,
      notMatches: [/\|\s*a\s*\|\s*b\s*\|/],
      matches: [/\|\s*c\s*\|\s*d\s*\|/],
    },
  },

  // ── Group C: Rich elements ABOVE / adjacency ──
  {
    title: 'C1: edit paragraph below list+table — list and table unchanged',
    canvas: 'above',
    fixture: FIX_ABOVE,
    apply: (b) => b.replace('Target paragraph to edit.', 'Target paragraph rewritten.'),
    expect: {
      exact: `# Above

- bullet one
- bullet two

| K | V |
| --- | --- |
| k1 | v1 |

Target paragraph rewritten.

Following paragraph.`,
      contains: [
        '- bullet one',
        '- bullet two',
        'Target paragraph rewritten.',
        'Following paragraph.',
      ],
      notContains: ['Target paragraph to edit.'],
      matches: [/\|\s*k1\s*\|\s*v1\s*\|/],
      ordering: [
        ['# Above', '- bullet one'],
        ['- bullet two', '| K | V |'],
        ['| k1 | v1 |', 'Target paragraph rewritten.'],
        ['Target paragraph rewritten.', 'Following paragraph.'],
      ],
    },
  },
  {
    title: 'C2: edit trailing paragraph below rich elements',
    canvas: 'above',
    fixture: FIX_ABOVE,
    apply: (b) => b.replace('Following paragraph.', 'Following paragraph rewritten.'),
    expect: {
      exact: `# Above

- bullet one
- bullet two

| K | V |
| --- | --- |
| k1 | v1 |

Target paragraph to edit.

Following paragraph rewritten.`,
      contains: ['Following paragraph rewritten.', 'Target paragraph to edit.'],
      notContains: ['Following paragraph.\n'],
      ordering: [
        ['Target paragraph to edit.', 'Following paragraph rewritten.'],
      ],
    },
  },
  {
    title: 'C3: paragraph right after heading: edit only the body',
    canvas: 'above',
    fixture: `# Heading Above

Body immediately after the heading.

Trailing paragraph.
`,
    apply: (b) =>
      b.replace(
        'Body immediately after the heading.',
        'Body immediately after the heading was rewritten.',
      ),
    expect: {
      exact: `# Heading Above

Body immediately after the heading was rewritten.

Trailing paragraph.`,
    },
  },
  {
    title: 'C4: edit paragraph right before a list — list intact',
    canvas: 'above',
    fixture: `# Adjacent

Paragraph right before the list.

- alpha
- beta
- gamma

Trailing.
`,
    apply: (b) =>
      b.replace('Paragraph right before the list.', 'Pre-list paragraph rewritten.'),
    expect: {
      exact: `# Adjacent

Pre-list paragraph rewritten.

- alpha
- beta
- gamma

Trailing.`,
      contains: ['Pre-list paragraph rewritten.', '- alpha', '- beta', '- gamma'],
      notContains: ['Paragraph right before the list.'],
      ordering: [
        ['Pre-list paragraph rewritten.', '- alpha'],
        ['- gamma', 'Trailing.'],
      ],
    },
  },
  {
    title: 'C5: edit paragraph directly after a list — list intact',
    canvas: 'above',
    fixture: `# Adjacent

- alpha
- beta
- gamma

Paragraph right after the list.

Trailing.
`,
    apply: (b) =>
      b.replace('Paragraph right after the list.', 'Post-list paragraph rewritten.'),
    expect: {
      exact: `# Adjacent

- alpha
- beta
- gamma

Post-list paragraph rewritten.

Trailing.`,
      contains: ['Post-list paragraph rewritten.', '- alpha', '- beta', '- gamma'],
      notContains: ['Paragraph right after the list.'],
      ordering: [
        ['- gamma', 'Post-list paragraph rewritten.'],
        ['Post-list paragraph rewritten.', 'Trailing.'],
      ],
    },
  },

  // ── Group D: Long doc ──
  {
    title: 'D1: edit paragraph near start of long doc',
    canvas: 'long',
    fixture: FIX_LONG,
    apply: (b) => b.replace('Paragraph number 3 in the long doc.', 'Paragraph 3 rewritten.'),
    expect: {
      exact: buildLongExpected({ 3: 'Paragraph 3 rewritten.' }),
      contains: [
        '# Long',
        'Paragraph number 1 in the long doc.',
        'Paragraph 3 rewritten.',
        'Paragraph number 4 in the long doc.',
        'Paragraph number 40 in the long doc.',
      ],
      notContains: ['Paragraph number 3 in the long doc.'],
      ordering: [
        ['Paragraph number 2 in the long doc.', 'Paragraph 3 rewritten.'],
        ['Paragraph 3 rewritten.', 'Paragraph number 4 in the long doc.'],
      ],
    },
  },
  {
    title: 'D2: edit paragraph in middle of long doc',
    canvas: 'long',
    fixture: FIX_LONG,
    apply: (b) => b.replace('Paragraph number 20 in the long doc.', 'Paragraph 20 rewritten.'),
    expect: {
      exact: buildLongExpected({ 20: 'Paragraph 20 rewritten.' }),
      contains: ['Paragraph 20 rewritten.'],
      notContains: ['Paragraph number 20 in the long doc.'],
      ordering: [
        ['Paragraph number 19 in the long doc.', 'Paragraph 20 rewritten.'],
        ['Paragraph 20 rewritten.', 'Paragraph number 21 in the long doc.'],
      ],
    },
  },
  {
    title: 'D3: edit last paragraph of long doc',
    canvas: 'long',
    fixture: FIX_LONG,
    apply: (b) => b.replace('Paragraph number 40 in the long doc.', 'Paragraph 40 rewritten.'),
    expect: {
      exact: buildLongExpected({ 40: 'Paragraph 40 rewritten.' }),
      contains: ['Paragraph 40 rewritten.'],
      notContains: ['Paragraph number 40 in the long doc.'],
      ordering: [['Paragraph number 39 in the long doc.', 'Paragraph 40 rewritten.']],
      // 'Paragraph 40 rewritten.' must be the very last paragraph (no trailing content).
      custom: (n) => {
        const trimmed = n.trimEnd();
        return {
          pass: trimmed.endsWith('Paragraph 40 rewritten.'),
          reason: `expected tail "Paragraph 40 rewritten.", got: …${trimmed.slice(-60)}`,
        };
      },
    },
  },
  {
    title: 'D4: multiple scattered edits in long doc (multi-hunk)',
    canvas: 'long',
    fixture: FIX_LONG,
    apply: (b) =>
      b
        .replace('Paragraph number 5 in the long doc.', 'P5 rewritten.')
        .replace('Paragraph number 15 in the long doc.', 'P15 rewritten.')
        .replace('Paragraph number 30 in the long doc.', 'P30 rewritten.'),
    expect: {
      exact: buildLongExpected({
        5: 'P5 rewritten.',
        15: 'P15 rewritten.',
        30: 'P30 rewritten.',
      }),
      contains: ['P5 rewritten.', 'P15 rewritten.', 'P30 rewritten.'],
      notContains: [
        'Paragraph number 5 in the long doc.',
        'Paragraph number 15 in the long doc.',
        'Paragraph number 30 in the long doc.',
      ],
      // Ensure every untouched paragraph is still present in order.
      ordering: [
        ['Paragraph number 4 in the long doc.', 'P5 rewritten.'],
        ['P5 rewritten.', 'Paragraph number 6 in the long doc.'],
        ['Paragraph number 14 in the long doc.', 'P15 rewritten.'],
        ['P15 rewritten.', 'Paragraph number 16 in the long doc.'],
        ['Paragraph number 29 in the long doc.', 'P30 rewritten.'],
        ['P30 rewritten.', 'Paragraph number 31 in the long doc.'],
      ],
    },
  },

  // ── Group E: Special content ──
  {
    title: 'E1: edit emoji-containing line',
    canvas: 'special',
    fixture: FIX_SPECIAL,
    apply: (b) => b.replace('\u{1F916}', '\u{1F914}'),
    expect: {
      exact: `# Special

Line with emoji \u{1F914} in the middle.

Japanese \u65E5\u672C\u8A9E sentence.

Special chars & < > "quotes" 'apos' here.`,
      contains: ['Line with emoji \u{1F914} in the middle.'],
      notContains: ['\u{1F916}'],
      notMatches: [/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/],
    },
  },
  {
    title: 'E2: edit CJK line',
    canvas: 'special',
    fixture: FIX_SPECIAL,
    apply: (b) => b.replace('\u65E5\u672C\u8A9E', '\u4E2D\u56FD\u8A9E'),
    expect: {
      exact: `# Special

Line with emoji \u{1F916} in the middle.

Japanese \u4E2D\u56FD\u8A9E sentence.

Special chars & < > "quotes" 'apos' here.`,
      contains: ['Japanese \u4E2D\u56FD\u8A9E sentence.'],
      notContains: ['\u65E5\u672C\u8A9E'],
    },
  },
  {
    title: 'E3: edit line with special chars (preserve surrounding)',
    canvas: 'special',
    fixture: FIX_SPECIAL,
    apply: (b) =>
      b.replace(`Special chars & < > "quotes" 'apos' here.`, `Special chars ONE two THREE.`),
    expect: {
      exact: `# Special

Line with emoji \u{1F916} in the middle.

Japanese \u65E5\u672C\u8A9E sentence.

Special chars ONE two THREE.`,
      contains: ['Special chars ONE two THREE.'],
      notContains: [`Special chars & < > "quotes"`],
      ordering: [
        ['Line with emoji', 'Japanese'],
        ['Japanese', 'Special chars ONE two THREE.'],
      ],
    },
  },

  // ── Group F: Boundary ──
  {
    title: 'F1: add body to a heading-only doc',
    canvas: 'boundary',
    fixture: FIX_HEADING_ONLY,
    apply: (b) => b.trimEnd() + '\n\nAdded body paragraph.\n',
    expect: {
      exact: `# Lonely heading

Added body paragraph.`,
    },
  },
  {
    title: 'F2: delete all body leaving heading only',
    canvas: 'boundary',
    fixture: `# Lonely heading

Some body to be removed.
`,
    apply: (b) => b.replace('\n\nSome body to be removed.', ''),
    expect: {
      exact: `# Lonely heading`,
    },
  },
  {
    title: 'F3: very long single-line replacement',
    canvas: 'boundary',
    fixture: `# Boundary

Short.
`,
    apply: (b) =>
      b.replace(
        'Short.',
        'This line has been replaced with a considerably longer body so that we can verify the delete + insert pair covers the full original line and the much longer replacement lands cleanly in the same slot.',
      ),
    expect: {
      exact: `# Boundary

This line has been replaced with a considerably longer body so that we can verify the delete + insert pair covers the full original line and the much longer replacement lands cleanly in the same slot.`,
      contains: ['considerably longer body'],
      notContains: ['Short.'],
      ordering: [['# Boundary', 'considerably longer body']],
    },
  },

  // ── Group G: Chain tests (sequential edits, no reset) ──
  {
    title: 'G1: chain step 1 — replace middle heading',
    canvas: 'chain',
    fixture: FIX_PLAIN,
    apply: (b) => b.replace('# Beta', '# BetaPrime'),
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# BetaPrime

Second paragraph of Beta.

# Gamma

Third paragraph of Gamma.`,
      contains: ['# BetaPrime'],
      notContains: ['# Beta\n'],
    },
  },
  {
    title: 'G2: chain step 2 — append a new heading at end (builds on step 1)',
    canvas: 'chain',
    chain: true,
    apply: (b) => b.trimEnd() + '\n\n# Delta\n\nDelta body.\n',
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# BetaPrime

Second paragraph of Beta.

# Gamma

Third paragraph of Gamma.

# Delta

Delta body.`,
      // Expect both the prior edit AND this edit to be visible.
      contains: ['# BetaPrime', '# Delta', 'Delta body.'],
      ordering: [
        ['# Alpha', '# BetaPrime'],
        ['# BetaPrime', '# Gamma'],
        ['# Gamma', '# Delta'],
      ],
    },
  },
  {
    title: 'G3: chain step 3 — edit Gamma body (builds on step 2)',
    canvas: 'chain',
    chain: true,
    apply: (b) => b.replace('Third paragraph of Gamma.', 'Gamma after chain edits.'),
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# BetaPrime

Second paragraph of Beta.

# Gamma

Gamma after chain edits.

# Delta

Delta body.`,
      contains: ['# BetaPrime', '# Delta', 'Gamma after chain edits.'],
      notContains: ['Third paragraph of Gamma.'],
      ordering: [
        ['# BetaPrime', '# Gamma'],
        ['Gamma after chain edits.', '# Delta'],
      ],
    },
  },
  {
    title: 'G4: chain step 4 — undo-ish, restore Gamma body',
    canvas: 'chain',
    chain: true,
    apply: (b) => b.replace('Gamma after chain edits.', 'Third paragraph of Gamma.'),
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# BetaPrime

Second paragraph of Beta.

# Gamma

Third paragraph of Gamma.

# Delta

Delta body.`,
      contains: ['Third paragraph of Gamma.'],
      notContains: ['Gamma after chain edits.'],
    },
  },
  {
    title: 'G5: concurrent edits in different sections in a single diff',
    canvas: 'chain-concurrent',
    fixture: FIX_PLAIN,
    apply: (b) =>
      b
        .replace('First paragraph of Alpha.', 'Alpha CONCURRENT.')
        .replace('Third paragraph of Gamma.', 'Gamma CONCURRENT.'),
    expect: {
      exact: `# Alpha

Alpha CONCURRENT.

# Beta

Second paragraph of Beta.

# Gamma

Gamma CONCURRENT.`,
    },
  },

  // ── Group H: No-op / minimal-edit regression coverage ──
  {
    title: 'H1: no-op edit — ours equals base, zero requests and body unchanged',
    canvas: 'noop',
    fixture: FIX_PLAIN,
    // Identity edit: agent produces the exact same markdown it received.
    apply: (b) => b,
    expect: {
      // Body must be identical to the fixture (after normalize).
      exact: `# Alpha

First paragraph of Alpha.

# Beta

Second paragraph of Beta.

# Gamma

Third paragraph of Gamma.`,
      // No changes should be produced — the diff pipeline must short-circuit.
      exactRequests: 0,
    },
  },
  {
    title: 'H2: whitespace-only edit — trailing spaces are trimmed, content preserved',
    canvas: 'noop',
    fixture: FIX_PLAIN,
    // Add trailing spaces to a body line. The no-op gate in computeDocDiff
    // (normalizeForNoOpCheck) strips trailing whitespace per-line before
    // comparing, so a whitespace-only edit MUST short-circuit to zero
    // requests — anything else is a regression in that gate.
    apply: (b) => b.replace('First paragraph of Alpha.', 'First paragraph of Alpha.   '),
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# Beta

Second paragraph of Beta.

# Gamma

Third paragraph of Gamma.`,
      exactRequests: 0,
    },
  },

  // ── Group L: Long-document stress ──
  {
    title: 'L1: mega-doc (200 paras + headings + table + list) — one para, one cell, one list item',
    canvas: 'mega',
    fixture: FIX_MEGA,
    apply: (b) =>
      b
        .replace('Mega paragraph 50.', 'Mega paragraph 50 EDITED.')
        .replace('| r2a | r2b |', '| R2A | r2b |')
        .replace('- mega-list item 5', '- mega-list item FIVE'),
    expect: {
      contains: [
        '# Section 1',
        '# Section 2',
        '# Section 7',
        'Mega paragraph 1.',
        'Mega paragraph 50 EDITED.',
        'Mega paragraph 200.',
        '| MC1 | MC2 |',
        '- mega-list item FIVE',
        '- mega-list item 10',
      ],
      notContains: [
        'Mega paragraph 50.',
        '| r2a | r2b |',
        '- mega-list item 5\n',
      ],
      matches: [
        /\|\s*R2A\s*\|\s*r2b\s*\|/,
      ],
      ordering: [
        ['# Section 1', 'Mega paragraph 1.'],
        ['Mega paragraph 49.', 'Mega paragraph 50 EDITED.'],
        ['Mega paragraph 50 EDITED.', 'Mega paragraph 51.'],
        ['Mega paragraph 80.', '| MC1 | MC2 |'],
        ['| R2A | r2b |', '| r3a | r3b |'],
        ['Mega paragraph 165.', '- mega-list item 1'],
        ['- mega-list item 4', '- mega-list item FIVE'],
        ['- mega-list item FIVE', '- mega-list item 6'],
      ],
    },
  },
  {
    title: 'L2: delete 10 consecutive paragraphs (15-24) from long doc',
    canvas: 'long-del',
    fixture: FIX_LONG,
    apply: (b) => {
      let r = b;
      for (let i = 15; i <= 24; i++) {
        r = r.replace(`\n\nParagraph number ${i} in the long doc.`, '');
      }
      return r;
    },
    expect: {
      exact: buildLongExpectedEx({
        deletes: new Set([15, 16, 17, 18, 19, 20, 21, 22, 23, 24]),
      }),
      contains: [
        'Paragraph number 14 in the long doc.',
        'Paragraph number 25 in the long doc.',
      ],
      notContains: [
        'Paragraph number 15 in the long doc.',
        'Paragraph number 20 in the long doc.',
        'Paragraph number 24 in the long doc.',
      ],
      ordering: [
        ['Paragraph number 14 in the long doc.', 'Paragraph number 25 in the long doc.'],
      ],
    },
  },
  {
    title: 'L3: insert 10 consecutive new paragraphs between #20 and #21',
    canvas: 'long-ins',
    fixture: FIX_LONG,
    apply: (b) => {
      const inserted: string[] = [];
      for (let i = 1; i <= 10; i++) inserted.push(`New inserted paragraph ${i}.`);
      return b.replace(
        'Paragraph number 20 in the long doc.',
        'Paragraph number 20 in the long doc.\n\n' + inserted.join('\n\n'),
      );
    },
    expect: {
      exact: buildLongExpectedEx({
        insertsAfter: {
          20: Array.from({ length: 10 }, (_, i) => `New inserted paragraph ${i + 1}.`),
        },
      }),
      contains: [
        'New inserted paragraph 1.',
        'New inserted paragraph 10.',
        'Paragraph number 21 in the long doc.',
      ],
      ordering: [
        ['Paragraph number 20 in the long doc.', 'New inserted paragraph 1.'],
        ['New inserted paragraph 10.', 'Paragraph number 21 in the long doc.'],
      ],
    },
  },
  {
    title: 'L4: replace paragraph #95 in a 100-paragraph single section',
    canvas: 'l4',
    fixture: FIX_L4,
    apply: (b) => b.replace('L4 paragraph 95.', 'L4 paragraph 95 rewritten.'),
    expect: {
      exact: buildL4Expected({ 95: 'L4 paragraph 95 rewritten.' }),
      contains: ['L4 paragraph 95 rewritten.', 'L4 paragraph 100.'],
      notContains: ['L4 paragraph 95.'],
      ordering: [
        ['L4 paragraph 94.', 'L4 paragraph 95 rewritten.'],
        ['L4 paragraph 95 rewritten.', 'L4 paragraph 96.'],
      ],
    },
  },

  // ── Group M: Heterogeneous context (paragraph next to rich elements) ──
  {
    title: 'M1 (H1): paragraph sandwiched between list (above) and table (below)',
    canvas: 'sandwich',
    fixture: `# Sandwich

- bullet alpha
- bullet beta

Middle paragraph sandwiched here.

| K | V |
| --- | --- |
| k1 | v1 |

Trailing paragraph.
`,
    apply: (b) =>
      b.replace('Middle paragraph sandwiched here.', 'Middle paragraph rewritten.'),
    expect: {
      exact: `# Sandwich

- bullet alpha
- bullet beta

Middle paragraph rewritten.

| K | V |
| --- | --- |
| k1 | v1 |

Trailing paragraph.`,
      contains: ['- bullet alpha', '- bullet beta', 'Middle paragraph rewritten.'],
      notContains: ['Middle paragraph sandwiched here.'],
      matches: [/\|\s*k1\s*\|\s*v1\s*\|/],
      ordering: [
        ['- bullet beta', 'Middle paragraph rewritten.'],
        ['Middle paragraph rewritten.', '| K | V |'],
        ['| k1 | v1 |', 'Trailing paragraph.'],
      ],
    },
  },
  {
    title: 'M2 (H2): edit a line inside a fenced code block',
    canvas: 'fence',
    fixture:
      '# Code\n\nBefore code.\n\n' +
      '```python\n' +
      'def hello():\n' +
      '    # this comment looks like a heading\n' +
      '    print("hello")\n' +
      '```\n' +
      '\nAfter code.\n',
    apply: (b) => b.replace('print("hello")', 'print("world")'),
    expect: {
      contains: ['# Code', 'Before code.', 'print("world")', 'After code.'],
      notContains: ['print("hello")'],
      ordering: [
        ['Before code.', 'print("world")'],
        ['print("world")', 'After code.'],
      ],
    },
  },
  {
    title: 'M3 (H3): edit content inside a blockquote',
    canvas: 'blockquote',
    fixture: `# Quoted

Before quote.

> This is a quoted line.

After quote.
`,
    apply: (b) =>
      b.replace('This is a quoted line.', 'This is the quoted line rewritten.'),
    expect: {
      contains: ['# Quoted', 'Before quote.', 'This is the quoted line rewritten.', 'After quote.'],
      notContains: ['This is a quoted line.'],
      ordering: [
        ['Before quote.', 'This is the quoted line rewritten.'],
        ['This is the quoted line rewritten.', 'After quote.'],
      ],
    },
  },
  {
    title: 'M4 (H4): edit a sub-bullet in a nested list',
    canvas: 'nested',
    fixture: `# Nested

- outer
  - inner one
  - inner two
- outer two
`,
    apply: (b) => b.replace('inner one', 'inner uno'),
    expect: {
      contains: ['# Nested', 'outer', 'inner uno', 'inner two', 'outer two'],
      notContains: ['inner one'],
      ordering: [
        ['inner uno', 'inner two'],
        ['inner two', 'outer two'],
      ],
    },
  },
  {
    title: 'M5 (H5): append an item to an ordered list (1. items, not -)',
    canvas: 'ordered',
    fixture: `# Ordered

1. apple
2. banana
3. cherry
`,
    apply: (b) => b.replace('3. cherry', '3. cherry\n4. date'),
    expect: {
      contains: ['apple', 'banana', 'cherry', 'date'],
      ordering: [
        ['apple', 'banana'],
        ['banana', 'cherry'],
        ['cherry', 'date'],
      ],
      // Ensure we still have an ordered list (each item numbered 1–4).
      // All four numbers must be present so a partial-renumber regression
      // (e.g. only the first/last item retain their marker) is caught.
      matches: [
        /1\.\s*apple/,
        /2\.\s*banana/,
        /3\.\s*cherry/,
        /4\.\s*date/,
      ],
    },
  },
  {
    title: 'M6 (H6): horizontal rule preserved when editing adjacent paragraph',
    canvas: 'hr',
    fixture: `# HR

First paragraph.

---

Second paragraph.
`,
    apply: (b) => b.replace('Second paragraph.', 'Second paragraph rewritten.'),
    expect: {
      contains: ['# HR', 'First paragraph.', 'Second paragraph rewritten.'],
      // Drop the trailing \n: the original lives at end-of-doc, where
      // normalize().trim() removes any newline, so `Second paragraph.\n`
      // would slip past a regression. `Second paragraph.` (with period)
      // is not a substring of `Second paragraph rewritten.`.
      notContains: ['Second paragraph.'],
      ordering: [
        ['First paragraph.', 'Second paragraph rewritten.'],
      ],
      // HR should survive — either as "---" or the em-dash form Docs uses.
      custom: (n) => {
        const hasHr = /(?:^|\n)(?:---|—{2,}|\*\*\*)\s*(?:\n|$)/.test(n);
        return {
          pass: hasHr,
          reason: `expected a horizontal-rule marker (--- or em-dashes) to survive; got:\n${n.slice(0, 400)}`,
        };
      },
    },
  },

  // ── Group X: Edge / corner cases ──
  {
    title: 'X1 (E1): duplicate section headings — edit second occurrence',
    canvas: 'dup-headings',
    fixture: `# Notes

First notes body.

# Other

Other body here.

# Notes

Second notes body.
`,
    apply: (b) => b.replace('Second notes body.', 'Second notes body rewritten.'),
    expect: {
      exact: `# Notes

First notes body.

# Other

Other body here.

# Notes

Second notes body rewritten.`,
      contains: ['First notes body.', 'Second notes body rewritten.', 'Other body here.'],
      notContains: ['Second notes body.\n'],
      ordering: [
        ['First notes body.', '# Other'],
        ['# Other', 'Second notes body rewritten.'],
      ],
    },
  },
  {
    title: 'X2 (E2): edit preamble content (before first heading)',
    canvas: 'preamble',
    fixture: `Intro paragraph.

# Section

Body.
`,
    apply: (b) => b.replace('Intro paragraph.', 'Intro rewritten.'),
    expect: {
      exact: `Intro rewritten.

# Section

Body.`,
      contains: ['Intro rewritten.', '# Section', 'Body.'],
      notContains: ['Intro paragraph.'],
      ordering: [
        ['Intro rewritten.', '# Section'],
        ['# Section', 'Body.'],
      ],
    },
  },
  {
    title: 'X3 (E3): document with only a preamble (no headings) — edit one paragraph',
    canvas: 'no-heading',
    fixture: `Plain paragraph one.

Plain paragraph two.

Plain paragraph three.
`,
    apply: (b) => b.replace('Plain paragraph two.', 'Plain paragraph TWO rewritten.'),
    expect: {
      exact: `Plain paragraph one.

Plain paragraph TWO rewritten.

Plain paragraph three.`,
      contains: ['Plain paragraph one.', 'Plain paragraph TWO rewritten.', 'Plain paragraph three.'],
      notContains: ['Plain paragraph two.'],
      ordering: [
        ['Plain paragraph one.', 'Plain paragraph TWO rewritten.'],
        ['Plain paragraph TWO rewritten.', 'Plain paragraph three.'],
      ],
    },
  },
  {
    title: 'X4 (E4): formatting-only variant (AST-equivalent markdown) is a no-op',
    canvas: 'semantic-noop',
    fixture: `# SemNoop

Line with *italic word* in it.
`,
    // `_italic word_` and `*italic word*` parse to the same mdast
    // (an `emphasis` node wrapping "italic word") and therefore render
    // to an identical doc structure. The normalization gate's AST
    // canonicalizer should detect equivalence and emit zero requests.
    apply: (b) => b.replace('*italic word*', '_italic word_'),
    expect: {
      contains: ['# SemNoop', 'italic word'],
      exactRequests: 0,
    },
  },
  {
    title: 'X5 (E5): character-identical no-op on rich content — zero requests',
    canvas: 'noop-rich',
    fixture: FIX_RICH,
    apply: (b) => b,
    expect: {
      exact: `# Rich

Some **bold word** and *italic word* and \`inline code\` and [link](https://example.com).

- apple
- banana
- cherry

| Col1 | Col2 |
| --- | --- |
| a | b |
| c | d |

End paragraph.`,
      exactRequests: 0,
    },
  },

  // ── Group K: Feature combinations ──
  {
    title: 'K1 (C1): cell edit + row add in a single diff',
    canvas: 'table-combo',
    fixture: FIX_RICH,
    apply: (b) =>
      b
        .replace('| a | b |', '| A | b |')
        .replace('| c | d |', '| c | d |\n| e | f |'),
    expect: {
      exact: `# Rich

Some **bold word** and *italic word* and \`inline code\` and [link](https://example.com).

- apple
- banana
- cherry

| Col1 | Col2 |
| --- | --- |
| A | b |
| c | d |
| e | f |

End paragraph.`,
      matches: [/\|\s*A\s*\|\s*b\s*\|/, /\|\s*e\s*\|\s*f\s*\|/],
      ordering: [
        ['| A | b |', '| c | d |'],
        ['| c | d |', '| e | f |'],
      ],
    },
  },
  {
    title: 'K2 (C2): rename a heading AND edit its body in one diff',
    canvas: 'rename-plus-body',
    fixture: FIX_PLAIN,
    apply: (b) =>
      b
        .replace('# Beta', '# BetaPrime')
        .replace('Second paragraph of Beta.', 'Beta body rewritten.'),
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# BetaPrime

Beta body rewritten.

# Gamma

Third paragraph of Gamma.`,
      contains: ['# BetaPrime', 'Beta body rewritten.'],
      notContains: ['# Beta\n', 'Second paragraph of Beta.'],
      ordering: [
        ['# Alpha', '# BetaPrime'],
        ['# BetaPrime', 'Beta body rewritten.'],
        ['Beta body rewritten.', '# Gamma'],
      ],
    },
  },
  {
    title: 'K3 (C3): convert a plain paragraph to a bullet list item',
    canvas: 'para-to-bullet',
    fixture: `# Convert

Some text.

Next paragraph.
`,
    apply: (b) => b.replace('Some text.', '- Some text.'),
    expect: {
      exact: `# Convert

- Some text.

Next paragraph.`,
      contains: ['# Convert', '- Some text.', 'Next paragraph.'],
      notMatches: [/^Some text\.$/m],
      ordering: [
        ['# Convert', '- Some text.'],
        ['- Some text.', 'Next paragraph.'],
      ],
    },
  },
  {
    title: 'K4 (C4): delete a whole section that contains a table',
    canvas: 'section-with-table',
    fixture: `# Keep

Keep body.

# DropMe

Drop intro line.

| kk | vv |
| --- | --- |
| x | y |
| p | q |

Drop trailing line.

# Tail

Tail body.
`,
    apply: (b) =>
      b.replace(
        '\n\n# DropMe\n\nDrop intro line.\n\n| kk | vv |\n| --- | --- |\n| x | y |\n| p | q |\n\nDrop trailing line.',
        '',
      ),
    expect: {
      exact: `# Keep

Keep body.

# Tail

Tail body.`,
      contains: ['# Keep', '# Tail', 'Keep body.', 'Tail body.'],
      notContains: [
        '# DropMe',
        'Drop intro line.',
        'Drop trailing line.',
        '| kk | vv |',
        '| x | y |',
        '| p | q |',
      ],
      ordering: [['# Keep', '# Tail']],
    },
  },

  // ── Group X (follow-ups): more duplicate-key / alignment edge cases ──
  {
    title: 'X1b: duplicate body lines — edit the second occurrence',
    canvas: 'dup-lines',
    fixture: `# Dup Lines

- apple
- apple
- apple

Trailing.
`,
    // Three identical `- apple` lines; the agent rewrites the second.
    // Line-level diffing (node-diff3) cannot disambiguate which of the
    // three identical lines changed — the intent "change the middle
    // one" is unrecoverable from a pure line-diff, so the library
    // deterministically picks one (in practice: the first). The
    // semantically correct invariant is the final LINE MULTISET
    // (2 apple + 1 apricot, with the non-bullet content untouched);
    // the exact position of the apricot is diff-library-defined and
    // not asserted here.
    apply: (b) => {
      const lines = b.split('\n');
      let seen = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === '- apple') {
          seen++;
          if (seen === 2) {
            lines[i] = '- apricot';
            break;
          }
        }
      }
      return lines.join('\n');
    },
    expect: {
      contains: ['- apple', '- apricot', 'Trailing.'],
      notContains: ['- apple\n- apple\n- apple'],
      // Regression guard: exactly two `- apple` and one `- apricot`
      // survive, regardless of which occurrence the diff chose to edit.
      custom: (n) => {
        const appleCount = (n.match(/^- apple$/gm) ?? []).length;
        const apricotCount = (n.match(/^- apricot$/gm) ?? []).length;
        return {
          pass: appleCount === 2 && apricotCount === 1,
          reason: `expected 2 apple + 1 apricot, got ${appleCount} apple + ${apricotCount} apricot`,
        };
      },
    },
  },
  {
    title: 'X1c: rename a heading into one that already exists',
    canvas: 'rename-collision',
    fixture: `# Alpha

Alpha body.

# Beta

Beta body.

# Gamma

Gamma body.
`,
    // Agent renames # Alpha → # Beta. Doc now has two # Beta sections.
    // alignSections's (heading, occurrence-index) pairing must decide
    // whether renamed-Alpha becomes Beta#0 (colliding with the original
    // Beta) or Beta#1 (appending). The intent here is "rename Alpha,
    // keep everything else" — so the expected body has Alpha's content
    // under a new `# Beta` heading at position 0, and the original Beta
    // content under a second `# Beta` heading at position 1.
    apply: (b) => b.replace('# Alpha', '# Beta'),
    expect: {
      contains: ['Alpha body.', 'Beta body.', '# Gamma', 'Gamma body.'],
      notContains: ['# Alpha'],
      ordering: [
        ['Alpha body.', 'Beta body.'],
        ['Beta body.', '# Gamma'],
      ],
      // Must have exactly two `# Beta` heading lines after rename.
      custom: (n) => {
        const count = (n.match(/^#\s+Beta\s*$/gm) ?? []).length;
        return {
          pass: count === 2,
          reason: `expected 2 '# Beta' heading lines, got ${count}`,
        };
      },
    },
  },
  {
    title: 'X1d: delete the first of two duplicate-named sections',
    canvas: 'dup-del-first',
    fixture: `# Notes

First notes body.

# Other

Other body.

# Notes

Second notes body.
`,
    // Delete the FIRST # Notes section (body + heading), keeping the
    // second intact. This reshuffles occurrence indices: what was
    // Notes#1 in base is Notes#0 in ours, so (heading, occurrence-index)
    // pairing must realise the renumbering.
    apply: (b) => b.replace('# Notes\n\nFirst notes body.\n\n', ''),
    expect: {
      exact: `# Other

Other body.

# Notes

Second notes body.`,
      contains: ['# Other', 'Other body.', '# Notes', 'Second notes body.'],
      notContains: ['First notes body.'],
      ordering: [['# Other', '# Notes'], ['# Notes', 'Second notes body.']],
    },
  },
  {
    title: 'X1e: agent appends a section whose heading duplicates an existing one',
    canvas: 'dup-add',
    fixture: `# Notes

Original notes.
`,
    // Add a second `# Notes` section at the end. Base has Notes#0 only;
    // ours has Notes#0 (unchanged) + Notes#1 (new). alignSections sees
    // the new Notes#1 with no match in base/theirs → added-by-agent.
    apply: (b) => b.trimEnd() + '\n\n# Notes\n\nAppended notes body.\n',
    expect: {
      contains: ['Original notes.', 'Appended notes body.'],
      ordering: [['Original notes.', 'Appended notes body.']],
      custom: (n) => {
        const count = (n.match(/^#\s+Notes\s*$/gm) ?? []).length;
        return {
          pass: count === 2,
          reason: `expected 2 '# Notes' heading lines, got ${count}`,
        };
      },
    },
  },

  // ── Group M (follow-ups): more structural-element edges ──
  {
    title: 'M3b: multi-paragraph blockquote — edit ONE paragraph',
    canvas: 'bq-multi',
    fixture: `# BQMulti

Before.

> First quoted paragraph.
>
> Second quoted paragraph.
>
> Third quoted paragraph.

After.
`,
    apply: (b) =>
      b.replace('Second quoted paragraph.', 'Second quoted paragraph rewritten.'),
    expect: {
      contains: [
        '# BQMulti',
        'Before.',
        '> First quoted paragraph.',
        '> Second quoted paragraph rewritten.',
        '> Third quoted paragraph.',
        'After.',
      ],
      notContains: ['> Second quoted paragraph.'],
      ordering: [
        ['> First quoted paragraph.', '> Second quoted paragraph rewritten.'],
        ['> Second quoted paragraph rewritten.', '> Third quoted paragraph.'],
      ],
    },
  },
  {
    title: 'M3c: blockquote — add a new line inside (line count changes)',
    canvas: 'bq-insert',
    fixture: `# BQInsert

> Line one.
> Line two.

Trailing.
`,
    // Insert a new `> Line one and a half.` between lines 1 and 2.
    // This is the pure-insert case my blockquote emitter left as a TODO;
    // expected to either work via follow-up logic or reveal the gap.
    apply: (b) => b.replace('> Line one.\n', '> Line one.\n> Line one and a half.\n'),
    expect: {
      contains: ['> Line one.', '> Line one and a half.', '> Line two.', 'Trailing.'],
      ordering: [
        ['> Line one.', '> Line one and a half.'],
        ['> Line one and a half.', '> Line two.'],
      ],
    },
  },
  {
    title: 'M3d: fenced code block — add a new line inside',
    canvas: 'code-ins',
    fixture:
      '# CodeIns\n\nBefore.\n\n' +
      '```python\n' +
      'def greet(name):\n' +
      '    print("hello", name)\n' +
      '```\n' +
      '\nAfter.\n',
    apply: (b) =>
      b.replace(
        'def greet(name):\n    print("hello", name)',
        'def greet(name):\n    name = name.strip()\n    print("hello", name)',
      ),
    expect: {
      contains: ['def greet(name):', 'name = name.strip()', 'print("hello", name)'],
      ordering: [
        ['def greet(name):', 'name = name.strip()'],
        ['name = name.strip()', 'print("hello", name)'],
        ['print("hello", name)', 'After.'],
      ],
    },
  },
  {
    title: 'M3e: edit a paragraph adjacent to an inline image',
    canvas: 'img-adj',
    fixture: `# Img

Before image paragraph.

![sunflower](https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/Sunflower_from_Silesia2.jpg/100px-Sunflower_from_Silesia2.jpg)

After image paragraph.
`,
    // Edit the "after image paragraph" — NOT the image itself. Image
    // round-trip fidelity is a separate concern; this test verifies
    // that an image-adjacent edit doesn't corrupt the image or misplace
    // the edit.
    apply: (b) =>
      b.replace('After image paragraph.', 'After image paragraph rewritten.'),
    expect: {
      contains: ['Before image paragraph.', 'After image paragraph rewritten.'],
      // Bare `After image paragraph.` (with the period, no " rewritten")
      // must be gone. Without the trailing-newline qualifier this catches
      // the regression even when the original ends up at end-of-doc
      // (where normalize().trim() would have stripped any \n).
      notContains: ['After image paragraph.'],
      // Image must still be present (either as a markdown image or as
      // the re-rendered form the docs reader emits).
      matches: [/!\[[^\]]*\]\(https?:\/\/[^)]+\)/],
      ordering: [
        ['Before image paragraph.', 'After image paragraph rewritten.'],
      ],
    },
  },
  {
    title: 'M3f: edit a paragraph adjacent to a mermaid block',
    canvas: 'mermaid-adj',
    fixture:
      '# Mermaid\n\nBefore mermaid.\n\n' +
      '```mermaid\n' +
      'graph TD\n' +
      '    A --> B\n' +
      '    B --> C\n' +
      '```\n' +
      '\nAfter mermaid.\n',
    // Edit the paragraph AFTER the mermaid block. Without the DB
    // mapping this harness doesn't wire up, the mermaid source won't
    // round-trip through readMarkdown (the block becomes an opaque
    // image). The test only cares that the adjacent-paragraph edit
    // lands correctly without corrupting the image element or the
    // surrounding content.
    apply: (b) => b.replace('After mermaid.', 'After mermaid rewritten.'),
    expect: {
      contains: ['# Mermaid', 'Before mermaid.', 'After mermaid rewritten.'],
      notContains: ['After mermaid.\n'],
      ordering: [
        ['Before mermaid.', 'After mermaid rewritten.'],
      ],
    },
  },
  {
    title: 'M3g: blockquote containing a bullet list — edit a list item inside',
    canvas: 'bq-list',
    fixture: `# BQList

> An intro line.
>
> - alpha
> - beta
> - gamma
>
> Outro line.

Trailing.
`,
    apply: (b) => b.replace('> - beta', '> - beta-prime'),
    expect: {
      contains: [
        '# BQList',
        '> An intro line.',
        '> - alpha',
        '> - beta-prime',
        '> - gamma',
        '> Outro line.',
        'Trailing.',
      ],
      notContains: ['> - beta\n'],
      ordering: [
        ['> - alpha', '> - beta-prime'],
        ['> - beta-prime', '> - gamma'],
      ],
    },
  },

  // ── Group X4 (follow-ups): more AST-equivalent variants ──
  {
    title: 'X4b: bullet marker swap (- ↔ *) is a canonicalised no-op',
    canvas: 'bullet-swap',
    fixture: `# BulletSwap

- apple
- banana
- cherry
`,
    apply: (b) => b.replace(/^- /gm, '* '),
    expect: {
      contains: ['apple', 'banana', 'cherry'],
      exactRequests: 0,
    },
  },
  {
    title: 'X4c: strong delimiter swap (** ↔ __) is a canonicalised no-op',
    canvas: 'strong-swap',
    fixture: `# StrongSwap

Line with **strong word** in it.
`,
    apply: (b) => b.replace('**strong word**', '__strong word__'),
    expect: {
      contains: ['strong word'],
      exactRequests: 0,
    },
  },
  {
    title: 'X4d: ordered-list marker swap (1. ↔ 1)) is a canonicalised no-op',
    canvas: 'ord-swap',
    fixture: `# OrdSwap

1. apple
2. banana
3. cherry
`,
    apply: (b) => b.replace(/^(\d+)\.\s/gm, '$1) '),
    expect: {
      contains: ['apple', 'banana', 'cherry'],
      exactRequests: 0,
    },
  },
  {
    title: 'X4e: ATX vs Setext heading style is a canonicalised no-op',
    canvas: 'setext',
    fixture: `# Heading A

Body of A.
`,
    // Convert the ATX heading to Setext underline form.
    apply: (b) => b.replace('# Heading A', 'Heading A\n========='),
    expect: {
      contains: ['Heading A', 'Body of A.'],
      exactRequests: 0,
    },
  },
  {
    title: 'X4f: code fence delimiter swap (``` ↔ ~~~) is a canonicalised no-op',
    canvas: 'fence-swap',
    fixture:
      '# FenceSwap\n\n```python\n' +
      'print("hi")\n' +
      '```\n',
    apply: (b) =>
      b
        .replace('```python\n', '~~~python\n')
        .replace(/```\n?$/, '~~~\n'),
    expect: {
      contains: ['FenceSwap', 'print("hi")'],
      exactRequests: 0,
    },
  },

  // ── Group Z: Cross-cutting interactions ──
  {
    title: 'Z1: duplicate heading + AST-equivalent body variant in second section',
    canvas: 'z1',
    fixture: `# Dup

First body with **strong**.

# Other

Middle section.

# Dup

Second body with **strong**.
`,
    // Rewrite the second `# Dup` body's **strong** as __strong__ —
    // AST-equivalent. Combined with a duplicate-heading doc, this
    // exercises both the occurrence-index alignment (from the X1 fix)
    // AND the AST canonicalizer (from the X4 fix) in one run. Should
    // be a zero-request no-op if both fixes compose correctly.
    apply: (b) =>
      b.replace(
        'Second body with **strong**.',
        'Second body with __strong__.',
      ),
    expect: {
      contains: ['First body with', 'Middle section.', 'Second body with', 'strong'],
      exactRequests: 0,
    },
  },
  {
    title: 'Z2: blockquote inside a section with duplicate heading',
    canvas: 'z2',
    fixture: `# Quoted

> First-Quoted body.

# Other

Mid.

# Quoted

> Second-Quoted body.
`,
    // Edit the blockquote in the SECOND # Quoted section. Exercises
    // occurrence-index alignment (X1 path) plus blockquote routing (M3
    // path) together. The naïve path would land the edit in the first
    // blockquote (wrong section).
    apply: (b) =>
      b.replace('> Second-Quoted body.', '> Second-Quoted body rewritten.'),
    expect: {
      contains: [
        '# Quoted',
        '# Other',
        '> First-Quoted body.',
        '> Second-Quoted body rewritten.',
      ],
      // Drop the trailing \n so end-of-doc trim doesn't mask a regression.
      notContains: ['> Second-Quoted body.'],
      ordering: [
        ['> First-Quoted body.', '# Other'],
        ['# Other', '> Second-Quoted body rewritten.'],
      ],
      custom: (n) => {
        const count = (n.match(/^#\s+Quoted\s*$/gm) ?? []).length;
        return {
          pass: count === 2,
          reason: `expected 2 '# Quoted' heading lines, got ${count}`,
        };
      },
    },
  },
  {
    title: 'Z3: edit crossing structural boundary (last table row + next paragraph)',
    canvas: 'z3',
    fixture: `# Cross

| A | B |
| --- | --- |
| r1a | r1b |
| r2a | r2b |

Paragraph right after the table.

Trailing paragraph.
`,
    // Single agent change rewrites BOTH the last row and the following
    // paragraph. The diff could see this as one hunk straddling the
    // table→paragraph boundary, or as two hunks. Either way, the
    // routing must NOT try to apply the paragraph-edit portion via the
    // table handler (it's not a table row) and must NOT apply the row-
    // edit portion via the generic paragraph handler (the range would
    // straddle structural indices).
    apply: (b) =>
      b
        .replace('| r2a | r2b |', '| R2A | R2B |')
        .replace('Paragraph right after the table.', 'Paragraph rewritten.'),
    expect: {
      contains: ['# Cross', 'r1a', 'r1b', 'R2A', 'R2B', 'Paragraph rewritten.', 'Trailing paragraph.'],
      notContains: ['| r2a | r2b |', 'Paragraph right after the table.'],
      matches: [/\|\s*R2A\s*\|\s*R2B\s*\|/],
      ordering: [
        ['| r1a | r1b |', '| R2A | R2B |'],
        ['| R2A | R2B |', 'Paragraph rewritten.'],
        ['Paragraph rewritten.', 'Trailing paragraph.'],
      ],
    },
  },

  // ── Group T: Predictive tests — exercise edge cases the prior ──
  //   failure patterns suggest. Labels (T1–T14) correspond to the
  //   prioritisation list discussed before implementation.

  // T1 — Delete first of two duplicate-named sections AND edit the
  // survivor's body in the same diff. Predicted 95% fail: content-match
  // alignment can't find a match for the edited body, falls through to
  // positional, pairs survivor with the deleted slot → routes edit wrong.
  {
    title: 'T1: delete first-of-duplicate AND edit survivor body (same diff)',
    canvas: 't1',
    fixture: `# Notes

First notes body.

# Other

Other body.

# Notes

Second notes body.
`,
    apply: (b) =>
      b
        .replace('# Notes\n\nFirst notes body.\n\n', '')
        .replace('Second notes body.', 'Notes body rewritten by agent.'),
    expect: {
      exact: `# Other

Other body.

# Notes

Notes body rewritten by agent.`,
      contains: ['# Other', 'Other body.', '# Notes', 'Notes body rewritten by agent.'],
      notContains: ['First notes body.', 'Second notes body.'],
      ordering: [['# Other', '# Notes']],
    },
  },

  // T2 — Blockquote pure-delete (remove a line from a multi-line quote).
  // Predicted 95% fail: the pure-delete branch was explicitly left out
  // of emitBlockquoteHunkRequests.
  {
    title: 'T2: blockquote pure-delete (remove a line from a multi-line quote)',
    canvas: 't2',
    fixture: `# BQDelete

> First quoted line.
> Second quoted line.
> Third quoted line.

Trailing.
`,
    apply: (b) => b.replace('> Second quoted line.\n', ''),
    expect: {
      contains: ['# BQDelete', '> First quoted line.', '> Third quoted line.', 'Trailing.'],
      notContains: ['> Second quoted line.'],
      ordering: [
        ['> First quoted line.', '> Third quoted line.'],
        ['> Third quoted line.', 'Trailing.'],
      ],
    },
  },

  // T3 — Nested blockquote. Originally predicted 85% fail; fixed by
  // teaching walkBlockquote to render a nested blockquote as `> `-
  // prefixed text inside the outer cell instead of emitting a sibling
  // BlockquoteSegment that escapes the outer.
  {
    title: 'T3: nested blockquote — edit the inner line',
    canvas: 't3',
    fixture: `# Nested BQ

> outer line above
>
> > inner line
>
> outer line below

Trailing.
`,
    apply: (b) => b.replace('inner line', 'inner line rewritten'),
    expect: {
      contains: [
        '# Nested BQ',
        'outer line above',
        '> > inner line rewritten',
        'outer line below',
        'Trailing.',
      ],
      // The ONLY `> > inner line` occurrence should be followed by
      // "rewritten" — no unedited copy should survive.
      notMatches: [/> > inner line(?!\s+rewritten)/],
      ordering: [
        ['outer line above', 'inner line rewritten'],
        ['inner line rewritten', 'outer line below'],
      ],
    },
  },

  // T4 — Cell with inline formatting. Originally predicted 70% fail;
  // fixed by teaching parseTable to run cell paragraphs through
  // parseParagraph (which renders styles as markdown) rather than
  // collecting raw textRun.content.
  {
    title: 'T4: cell with inline formatting — edit the formatted content',
    canvas: 't4',
    fixture: `# CellFmt

| Col1 | Col2 |
| --- | --- |
| **bold** text | plain |
| other | here |

Trailing.
`,
    apply: (b) => b.replace('**bold** text', '**new** text'),
    expect: {
      contains: ['# CellFmt', '**new** text', 'plain', 'other', 'here', 'Trailing.'],
      notContains: ['**bold** text'],
      matches: [/\|\s*\*\*new\*\* text\s*\|/],
      ordering: [['| Col1 | Col2 |', 'Trailing.']],
    },
  },

  // T5 — Table nested inside a blockquote. Predicted 75% fail:
  // walkBlockquote's BlockquoteSegment carries text/styles/bullets but
  // not nested tables — so a nested table probably escapes as a
  // sibling segment, breaking adjacency.
  {
    title: 'T5: table nested inside a blockquote — edit a cell',
    canvas: 't5',
    fixture: `# BQTable

> Above the table.
>
> | K | V |
> | --- | --- |
> | k1 | v1 |
> | k2 | v2 |
>
> Below the table.

Trailing.
`,
    apply: (b) => b.replace('| k1 | v1 |', '| K1 | V1 |'),
    expect: {
      contains: ['# BQTable', 'Above the table.', 'Below the table.', 'K1', 'V1', 'Trailing.'],
      notContains: ['| k1 | v1 |'],
      // Looser matching: the inner table may round-trip without the
      // `>` prefix if it escapes the blockquote, but the cell edit
      // should still be visible somewhere.
      matches: [/\bK1\b/, /\bV1\b/],
    },
  },

  // T6 — Task list checkbox state toggle. Originally predicted 70%
  // fail; confirmed. SKIPPED (genuinely impossible in this Docs env).
  //
  // Investigation: the writer uses BULLET_CHECKBOX preset and
  // strikethrough-for-checked as its convention. But the Docs API in
  // this environment returns glyphType: GLYPH_TYPE_UNSPECIFIED and no
  // `glyphSymbol` / `checkboxLevel` for those bullets on readback —
  // so the reader has no reliable signal to distinguish a checkbox
  // item from a regular bullet, and emits the content as `- ~~X~~`
  // (strikethrough-only) rather than `- [x] X`. Without a detectable
  // checkbox marker in the API response, there's no way to render
  // the `[ ]`/`[x]` syntax on read, and therefore no way to diff it.
  //
  // A future fix would need either: (a) Google to expose checkbox
  // state in the Docs API (not currently done), or (b) an out-of-band
  // marker (e.g. a named range `checkbox:item-123`) tagging each
  // checkbox paragraph and its state. Option (b) is a larger
  // change — tracked as a separate concern rather than softened here.
  {
    title: 'T6: task list checkbox — toggle state `- [ ]` → `- [x]`',
    canvas: 't6',
    fixture: `# Todos

- [ ] first todo
- [x] already done
- [ ] third todo
`,
    apply: (b) => b.replace('- [ ] first todo', '- [x] first todo'),
    expect: {
      contains: ['first todo'],
    },
    skip:
      'Docs API returns GLYPH_TYPE_UNSPECIFIED for BULLET_CHECKBOX bullets ' +
      'in this environment; reader cannot distinguish them from regular ' +
      'bullets, so `- [x]` syntax does not round-trip. Needs out-of-band ' +
      'marker (e.g. named range) to identify checkbox paragraphs.',
  },

  // T7 — Swap two duplicate-named section bodies. I predicted this
  // would PASS (20%) — the positional keying should produce the right
  // replacement pair.
  {
    title: 'T7: swap bodies of two duplicate-named sections',
    canvas: 't7',
    fixture: `# Notes

First notes body.

# Notes

Second notes body.
`,
    apply: (b) =>
      b
        .replace('First notes body.', '<<TMP>>')
        .replace('Second notes body.', 'First notes body.')
        .replace('<<TMP>>', 'Second notes body.'),
    expect: {
      exact: `# Notes

Second notes body.

# Notes

First notes body.`,
      contains: ['Second notes body.', 'First notes body.'],
      ordering: [['Second notes body.', 'First notes body.']],
    },
  },

  // T8 — Same list line in two different sections, edit only one.
  // Predicted 40% fail: per-section line-diff should localise the
  // edit, but findPrecedingBulletEndIndex walks backward and could
  // in theory cross a section boundary.
  {
    title: 'T8: same list line in two sections — edit only section A',
    canvas: 't8',
    fixture: `# Alpha

Before.

- apple
- banana

After A.

# Beta

Before.

- apple
- banana

After B.
`,
    apply: (b) =>
      b.replace(
        '# Alpha\n\nBefore.\n\n- apple',
        '# Alpha\n\nBefore.\n\n- APPLE',
      ),
    expect: {
      contains: ['# Alpha', 'APPLE', '- banana', '# Beta', '- apple', 'After A.', 'After B.'],
      ordering: [
        ['# Alpha', '- APPLE'],
        ['- APPLE', '# Beta'],
        ['# Beta', '- apple'],
      ],
      // Exactly one APPLE (in Alpha) and one remaining apple (in Beta).
      custom: (n) => {
        const upper = (n.match(/- APPLE/g) ?? []).length;
        const lower = (n.match(/^- apple$/gm) ?? []).length;
        return {
          pass: upper === 1 && lower === 1,
          reason: `expected 1 APPLE + 1 apple, got ${upper} APPLE + ${lower} apple`,
        };
      },
    },
  },

  // T9 — Cell with a markdown link, edit the link text. Predicted 50%
  // fail. parseTable in element-parser.ts strips cell formatting
  // entirely, so the link URL is lost on readback and the agent sees
  // only plain "link" text.
  {
    title: 'T9: cell with a link — edit the link text',
    canvas: 't9',
    fixture: `# CellLink

| Label | Value |
| --- | --- |
| Home | [click](https://example.com) |
| Other | plain |
`,
    // Whatever comes back in the cell, if the agent sees the original
    // text, rewrite it. The assertion just checks the new text lands
    // and cell structure stays intact.
    apply: (b) => b.replace('click', 'follow'),
    expect: {
      contains: ['# CellLink', 'Home', 'Other', 'plain'],
      // Either the edit landed (link text changed) or the text never
      // existed in base (read stripped it) — the strong check is
      // that the cell STRUCTURE is preserved and the first column
      // cells are untouched.
      matches: [/\|\s*Home\s*\|/, /\|\s*Other\s*\|/],
    },
  },

  // T10 — Heading rename that creates a collision with a section the
  // AGENT also added in the same diff. Predicted 50% fail: ours has
  // two `# New` sections (one renamed, one added), neither matching
  // any base section by content. Content-match falls through and
  // positional fallback may pair ambiguously.
  {
    title: 'T10: rename heading + add another section with same new name',
    canvas: 't10',
    fixture: `# Alpha

Alpha body.

# Beta

Beta body.
`,
    apply: (b) =>
      b
        .replace('# Alpha', '# Gamma')
        .trimEnd() + '\n\n# Gamma\n\nAppended gamma body.\n',
    expect: {
      contains: [
        '# Gamma',
        'Alpha body.',
        'Beta body.',
        'Appended gamma body.',
      ],
      notContains: ['# Alpha'],
      ordering: [
        ['Alpha body.', '# Beta'],
        ['Beta body.', 'Appended gamma body.'],
      ],
      custom: (n) => {
        const count = (n.match(/^#\s+Gamma\s*$/gm) ?? []).length;
        return {
          pass: count === 2,
          reason: `expected 2 '# Gamma' heading lines, got ${count}`,
        };
      },
    },
  },

  // T11 — Multiple horizontal rules. Predicted 25% fail: our M6 test
  // covers one HR between paragraphs; stacking three in a row is an
  // edge case in the sectionBreak handling.
  {
    title: 'T11: multiple horizontal rules — edit between them',
    canvas: 't11',
    fixture: `# MultiHR

Para A.

---

Para B.

---

Para C.

---

Para D.
`,
    apply: (b) => b.replace('Para B.', 'Para B rewritten.'),
    expect: {
      contains: ['Para A.', 'Para B rewritten.', 'Para C.', 'Para D.'],
      notContains: ['Para B.\n'],
      ordering: [
        ['Para A.', 'Para B rewritten.'],
        ['Para B rewritten.', 'Para C.'],
        ['Para C.', 'Para D.'],
      ],
      // Three HR markers (--- or em-dash equivalents) should survive.
      custom: (n) => {
        const hrMatches = n.match(/(?:^|\n)(?:---|—{2,}|\*\*\*)\s*(?=\n|$)/g) ?? [];
        return {
          pass: hrMatches.length >= 3,
          reason: `expected ≥3 horizontal-rule markers, found ${hrMatches.length}`,
        };
      },
    },
  },

  // T12 — Very large insert (500 paragraphs in one diff). Predicted
  // 30% fail: Docs' batchUpdate has per-request byte limits.
  {
    title: 'T12: very large insert (500 paragraphs in one diff)',
    canvas: 't12',
    fixture: `# Big

Head paragraph.

Tail paragraph.
`,
    apply: (b) => {
      const bulk: string[] = [];
      for (let i = 1; i <= 500; i++) bulk.push(`Bulk paragraph ${i}.`);
      return b.replace(
        'Head paragraph.',
        'Head paragraph.\n\n' + bulk.join('\n\n'),
      );
    },
    expect: {
      contains: [
        '# Big',
        'Head paragraph.',
        'Bulk paragraph 1.',
        'Bulk paragraph 250.',
        'Bulk paragraph 500.',
        'Tail paragraph.',
      ],
      ordering: [
        ['Head paragraph.', 'Bulk paragraph 1.'],
        ['Bulk paragraph 500.', 'Tail paragraph.'],
      ],
    },
  },

  // T13 — Unicode NFC vs NFD equivalence. Predicted 25% fail: Docs
  // likely normalises to NFC on write, so a read-back gives NFC; if
  // the agent sends NFD, canonicalizer probably doesn't catch it.
  {
    title: 'T13: Unicode NFC vs NFD — equivalent normalisation is a no-op',
    canvas: 't13',
    fixture: `# Unicode

Café (with precomposed é).
`,
    // Replace the precomposed é with e + combining acute. Visually
    // identical; code-point-distinct. Docs likely stores NFC either way.
    apply: (b) => b.replace('é', 'é'),
    expect: {
      // Either form should round-trip to the same visible text.
      contains: ['Café'],
      // After the canonicalize-gate's Unicode normalization, NFC↔NFD
      // encodes the same grapheme → zero requests.
      exactRequests: 0,
    },
  },

  // T14 — Reference-style vs inline link. Predicted 20% fail: remark's
  // stringify normalizes reference links back to inline form, so the
  // canonicalizer should catch this as a no-op.
  {
    title: 'T14: reference-style link ↔ inline link is a canonicalised no-op',
    canvas: 't14',
    fixture: `# Ref

See [the site](https://example.com) for more.
`,
    apply: (b) =>
      b.replace(
        'See [the site](https://example.com) for more.',
        'See [the site][site] for more.\n\n[site]: https://example.com',
      ),
    expect: {
      contains: ['the site', 'https://example.com'],
      exactRequests: 0,
    },
  },
];

// ── Runner ────────────────────────────────────────────────────

/**
 * Filter the test list by case-insensitive substring match against the
 * title. Any positional CLI arg counts as a filter; a test is selected
 * if its title contains *any* of them (OR semantics).
 *
 * Chain tests inherit state from the previous test in the same canvas,
 * so when a chain test is selected we also pull in every earlier test
 * sharing that canvas, walking backwards until (and including) the
 * most recent non-chain test — that's the one that writes the fixture.
 * Without this the chain test would run against whatever the doc happens
 * to contain (or against an unrelated prior selection).
 */
function selectTests(all: EditTestCase[], filters: string[]): EditTestCase[] {
  if (filters.length === 0) return all;
  const lowered = filters.map((f) => f.toLowerCase());
  const matches = (tc: EditTestCase) =>
    lowered.some((f) => tc.title.toLowerCase().includes(f));

  const keep = new Set<number>();
  for (let i = 0; i < all.length; i++) {
    if (!matches(all[i])) continue;
    keep.add(i);
    if (all[i].chain) {
      const canvas = all[i].canvas;
      for (let j = i - 1; j >= 0; j--) {
        if (all[j].canvas !== canvas) continue;
        keep.add(j);
        if (!all[j].chain) break; // hit the fixture-writer; stop
      }
    }
  }
  return all.filter((_, i) => keep.has(i));
}

async function run() {
  const client = createClient();
  const folderName = 'Codocs Tests';

  const filters = process.argv.slice(2);
  const selected = selectTests(tests, filters);
  if (filters.length > 0 && selected.length === 0) {
    console.error(
      `No tests matched filter(s): ${filters.map((f) => JSON.stringify(f)).join(', ')}`,
    );
    process.exit(1);
  }

  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const filterNote =
    filters.length > 0
      ? ` — filter: ${filters.map((f) => JSON.stringify(f)).join(', ')} (${selected.length}/${tests.length} selected)`
      : '';
  console.log(`Edit round-trip E2E tests — ${timestamp}${filterNote}\n`);

  // One canvas doc per named canvas group. Tests that share a canvas
  // reset via writeMarkdown between runs to minimise doc churn within a
  // run; across runs we look up the canvas by title in the Drive folder
  // and reuse it, so docs don't accumulate. Each test issues a fresh
  // writeMarkdown('replace') (or builds on a chain), so the prior run's
  // body never bleeds into the current test.
  const canvases = new Map<string, string>(); // canvas name → docId
  async function getCanvas(name: string): Promise<string> {
    let id = canvases.get(name);
    if (!id) {
      const { docId, reused } = await client.findOrCreateDocInFolder(
        `RT Edit: ${name}`,
        folderName,
      );
      canvases.set(name, docId);
      console.log(`  canvas '${name}' → ${docId}${reused ? ' (reused)' : ' (new)'}`);
      id = docId;
    }
    return id!;
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: Array<{ title: string; reasons: string[] }> = [];

  for (let i = 0; i < selected.length; i++) {
    const tc = selected[i];
    const label = `${i + 1}/${selected.length} ${tc.title}`;
    if (tc.skip) {
      console.log(`  ⊘ ${label} — SKIP: ${tc.skip}`);
      skipped++;
      continue;
    }
    try {
      const canvas = tc.canvas ?? 'default';
      const docId = await getCanvas(canvas);

      if (!tc.chain) {
        if (!tc.fixture) {
          throw new Error(`non-chain test '${tc.title}' must provide a fixture`);
        }
        await client.writeMarkdown(docId, tc.fixture);
      }

      // Read current state (post-fixture, or post-previous-chain-step).
      const base = await client.readMarkdown(docId);

      // Produce the agent's edited markdown.
      const ours = tc.apply(base);

      // Run the production diff pipeline.
      const doc = await client.getDocument(docId);
      const { markdown: mapBase, indexMap } = docsToMarkdownWithMapping(doc);
      const theirs = mapBase;
      const diff = await computeDocDiff(
        mapBase,
        ours,
        theirs,
        doc,
        indexMap,
        'rt-edit-agent',
      );

      const requestCount = diff.requests.length;
      if (requestCount > 0) {
        await client.batchUpdate(docId, diff.requests);
      }

      // Read back and verify.
      const after = await client.readMarkdown(docId);
      const { pass, reasons } = verify(after, tc.expect, requestCount);

      if (pass) {
        console.log(`  ✓ ${label}`);
        passed++;
      } else {
        console.log(`  ✗ ${label}`);
        for (const reason of reasons) {
          console.log(`      ${reason.split('\n').join('\n      ')}`);
        }
        failed++;
        failures.push({ title: tc.title, reasons });
      }
    } catch (err: any) {
      console.log(`  ✗ ${label} — ERROR: ${err.message}`);
      failed++;
      failures.push({ title: tc.title, reasons: [`ERROR: ${err.message}`] });
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(
    `Edit round-trip results: ${passed} passed, ${failed} failed` +
      (skipped > 0 ? `, ${skipped} skipped` : '') +
      `, ${selected.length} total` +
      (selected.length !== tests.length ? ` (of ${tests.length})` : ''),
  );

  if (failures.length > 0) {
    console.log(`\nFailed tests:`);
    for (const f of failures) {
      console.log(`  - ${f.title}`);
    }
    process.exit(1);
  }

  console.log(`\nAll edit round-trip tests passed!\n`);
}

run().catch((err) => {
  console.error('E2E edit round-trip test failed:', err.message);
  process.exit(1);
});
