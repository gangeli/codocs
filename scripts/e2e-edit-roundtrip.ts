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
      // NOTE: output is ambiguous — adjacent bold runs "**Some** **bold word**"
      // may be re-rendered by the markdown serializer as either two separate
      // bold runs with a space between or a single merged "**Some bold word**"
      // run (since Docs stores textRun styling, not markdown delimiters).
      // Not asserting `exact` here because we can't deterministically pick
      // between those renderings without running the pipeline. Keeping the
      // loose ordering/contains checks as the authoritative assertion.
      contains: ['**Some**', '**bold word**'],
      ordering: [['**Some**', '**bold word**']],
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
    // Add trailing spaces to a body line. normalize() strips trailing spaces
    // on each line, so the `exact` check ignores this at the assertion layer,
    // but the production pipeline should also emit at most a tiny diff (if
    // any) since the visible content is unchanged.
    apply: (b) => b.replace('First paragraph of Alpha.', 'First paragraph of Alpha.   '),
    expect: {
      exact: `# Alpha

First paragraph of Alpha.

# Beta

Second paragraph of Beta.

# Gamma

Third paragraph of Gamma.`,
      contains: [
        'First paragraph of Alpha.',
        'Second paragraph of Beta.',
        'Third paragraph of Gamma.',
      ],
      // Either the trailing whitespace round-trips as a no-op (0 requests)
      // or requires a minimal delete+insert pair — bound the upper limit to
      // keep this a true "minimal edit" regression check.
      maxRequests: 4,
    },
  },
];

// ── Runner ────────────────────────────────────────────────────

async function run() {
  const client = createClient();
  const folderName = 'Codocs Tests';

  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  console.log(`Edit round-trip E2E tests — ${timestamp}\n`);

  // Create one canvas doc per named canvas group (tests that share a
  // canvas reset via writeMarkdown between runs to minimise doc churn).
  const canvases = new Map<string, string>(); // canvas name → docId
  async function getCanvas(name: string): Promise<string> {
    let id = canvases.get(name);
    if (!id) {
      const { docId } = await client.createDocInFolder(
        `RT Edit: ${name}`,
        folderName,
      );
      canvases.set(name, docId);
      console.log(`  canvas '${name}' → ${docId}`);
    }
    return id!;
  }

  let passed = 0;
  let failed = 0;
  const failures: Array<{ title: string; reasons: string[] }> = [];

  for (let i = 0; i < tests.length; i++) {
    const tc = tests[i];
    const label = `${i + 1}/${tests.length} ${tc.title}`;
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
    `Edit round-trip results: ${passed} passed, ${failed} failed, ${tests.length} total`,
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
