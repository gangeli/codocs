#!/usr/bin/env node
/**
 * End-to-end visual test runner.
 *
 * Creates a Google Doc with a series of test cases for visual inspection.
 * Each test case has a heading, an explanation of what to check, and the
 * rendered content.
 *
 * Usage:
 *   make e2e           # build + run
 *   node scripts/e2e-visual-test.ts
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

// ── Test cases ───────────────────────────────────────────────

interface TestCase {
  title: string;
  expect: string;
  markdown: string;
}

const testCases: TestCase[] = [
  // ── Table rendering ──────────────────────────────────────

  {
    title: 'Basic 2-column table',
    expect: 'Header row should have dark blue background with white bold text. Both columns should have reasonable widths. Cell padding should provide breathing room.',
    markdown: `| Name | Value |
| --- | --- |
| Alpha | 100 |
| Beta | 200 |
| Gamma | 300 |`,
  },

  {
    title: 'Table with short value column (auto-center)',
    expect: 'The "Rating" column values (4/5, 5/5, 3/5) should be center-aligned since they are all short. The "Haiku" column should be left-aligned.',
    markdown: `| Haiku | Rating |
| --- | --- |
| Green rind hides the sweet | 4/5 |
| Summer breeze through trees | 5/5 |
| Red flesh bursting forth | 3/5 |`,
  },

  {
    title: 'Table with many columns',
    expect: 'All columns should have at least 60pt width (minimum). Columns should not be crushed. Table may extend to full page width.',
    markdown: `| A | B | C | D | E |
| --- | --- | --- | --- | --- |
| one | two | three | four | five |
| alpha | beta | gamma | delta | epsilon |`,
  },

  {
    title: 'Table with very long content in one column',
    expect: 'The "Description" column should get proportionally more width than "ID" and "Status". The long text should wrap within the cell, not overflow.',
    markdown: `| ID | Description | Status |
| --- | --- | --- |
| 1 | This is a very long description that should cause the column to be wider than the others | Active |
| 2 | Short one | Done |
| 3 | Another moderately long description for testing purposes | Pending |`,
  },

  {
    title: 'Table with single column',
    expect: 'Single column should take reasonable width (not full page). Header should still be styled with blue background and white text.',
    markdown: `| Item |
| --- |
| Apple |
| Banana |
| Cherry |`,
  },

  {
    title: 'Table with empty cells',
    expect: 'Empty cells should render correctly without errors. Column widths should still be reasonable.',
    markdown: `| Feature | Supported | Notes |
| --- | --- | --- |
| Tables | Yes | |
| Images | No | Coming soon |
| Code blocks | Yes | With syntax highlighting |`,
  },

  // ── Text formatting ──────────────────────────────────────

  {
    title: 'Heading levels',
    expect: 'Each heading level should have distinct sizing. H1 largest, H3 smallest. All should be visually distinguishable.',
    markdown: `# Heading 1

Some text under H1.

## Heading 2

Some text under H2.

### Heading 3

Some text under H3.`,
  },

  {
    title: 'Inline formatting',
    expect: 'Bold, italic, strikethrough, inline code, and links should all render correctly. No formatting should bleed into adjacent text.',
    markdown: `This has **bold text** and *italic text* and ~~strikethrough~~ and \`inline code\` and [a link](https://example.com).

Normal text before **bold** normal after. No bleed.`,
  },

  {
    title: 'Inline code styling (standalone)',
    expect: 'The inline code spans (`const`, `foo.bar()`, `/usr/local/bin`) should each render in a monospace font (Courier New) with a light gray background shading, with no bleed into surrounding text.',
    markdown: `Use the \`const\` keyword to declare immutable bindings. Call \`foo.bar()\` to invoke the method. Files live in \`/usr/local/bin\`.`,
  },

  {
    title: 'Link styling (standalone)',
    expect: 'Each link should render in the default blue underlined link style. Clicking a link should open the target URL in a new tab. Plain text around the links should remain unstyled.',
    markdown: `Visit [Anthropic](https://www.anthropic.com) for more info. See also [Google Docs API](https://developers.google.com/docs/api) and [the spec](https://spec.commonmark.org).`,
  },

  {
    title: 'Paragraph after heading inherits NORMAL_TEXT',
    expect: 'The paragraph text should be normal body size, NOT heading size. This tests the NORMAL_TEXT style reset after headings.',
    markdown: `# Big Heading

This paragraph should be normal-sized text, not heading-sized.

Another normal paragraph.`,
  },

  // ── Lists ────────────────────────────────────────────────

  {
    title: 'Unordered and ordered lists',
    expect: 'Bullet points should use disc markers. Numbered list should use decimal numbers. Both should have proper indentation.',
    markdown: `Unordered list:

- First item
- Second item
- Third item

Ordered list:

1. Step one
2. Step two
3. Step three`,
  },

  {
    title: 'Checkbox (task) list',
    expect: 'Each item should have a native Google Docs checkbox (clickable, not a Unicode symbol). All boxes should start unchecked. Clicking a box should check it and strike through the text.',
    markdown: `- [ ] Buy groceries
- [ ] Review pull request
- [ ] Write tests
- [ ] Deploy to staging`,
  },

  {
    title: 'Checkbox list with mixed checked/unchecked state',
    expect: 'All four items should render as native Google Docs checkboxes. The two items marked [x] ("Write spec", "Draft PR") should appear already checked (strikethrough text, box filled). The two [ ] items should be unchecked.',
    markdown: `- [x] Write spec
- [ ] Implement feature
- [x] Draft PR
- [ ] Ship it`,
  },

  {
    title: 'Nested unordered list',
    expect: 'Three indentation levels of disc-style bullets. Each nesting level should use a visually distinct marker (disc / circle / square) per the BULLET_DISC_CIRCLE_SQUARE preset, with progressively deeper indentation.',
    markdown: `- Top level item
  - Second level
    - Third level
    - Another third level
  - Back to second
- Another top level`,
  },

  {
    title: 'Nested mixed list (ordered inside unordered)',
    expect: 'Top-level bullets (disc). Nested ordered sub-items should render with decimal numbering. Deeply nested items remain readable with progressive indentation.',
    markdown: `- Project phases
  1. Research
  2. Design
  3. Implementation
- Team members
  1. Alice
  2. Bob
    - Frontend work
    - Backend work
  3. Carol`,
  },

  // ── Code blocks ──────────────────────────────────────────

  {
    title: 'Code block',
    expect: 'Code should be in monospace font (Courier New) with a light gray background. Indentation should be preserved.',
    markdown: `Some text before the code.

\`\`\`
function hello() {
  console.log("Hello, world!");
  return 42;
}
\`\`\`

Some text after the code.`,
  },

  {
    title: 'Code block with language tag',
    expect: 'Code should render in monospace with a light gray background, identically to an untagged fence. The language tag (`javascript`) is currently discarded (no syntax highlighting) — this test guards against regressions in code-block styling when a lang is set.',
    markdown: `\`\`\`javascript
const answer = 42;
function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\``,
  },

  // ── Diagrams ─────────────────────────────────────────────

  {
    title: 'Mermaid diagram (flowchart)',
    expect: 'A rendered PNG flowchart should appear inline (not the raw mermaid source). Shapes: Start → Decision diamond → two branches (Yes/No) → End. The image should span the page width and not overflow margins.',
    markdown: `\`\`\`mermaid
flowchart TD
  A[Start] --> B{Decision}
  B -->|Yes| C[Do thing]
  B -->|No| D[Skip]
  C --> E[End]
  D --> E
\`\`\``,
  },

  {
    title: 'Mermaid diagram (sequence)',
    expect: 'A rendered PNG sequence diagram should appear inline, showing three participants (Client, Server, DB) with arrows between them. The image should be scaled to page width.',
    markdown: `\`\`\`mermaid
sequenceDiagram
  participant C as Client
  participant S as Server
  participant D as DB
  C->>S: request
  S->>D: query
  D-->>S: rows
  S-->>C: response
\`\`\``,
  },

  // ── Blockquotes and rules ────────────────────────────────

  {
    title: 'Blockquote',
    expect: 'The quoted text should render as a distinct blockquote — visually offset from surrounding body text with a left indent and/or a left vertical bar, clearly marking it as quoted. It must not read as ordinary body paragraphs.',
    markdown: `Some introductory text.

> This is a blockquote.
>
> It can span multiple paragraphs and should render as normal body text (no left border or indent today).

Text after the quote.`,
  },

  {
    title: 'Horizontal rule (thematic break)',
    expect: 'A true horizontal separator line should appear between the two paragraphs — a native Docs horizontal rule, not a row of em-dashes rendered as text.',
    markdown: `Paragraph before the rule.

---

Paragraph after the rule.`,
  },

  // ── Images ───────────────────────────────────────────────

  {
    title: 'Image (embedded inline)',
    expect: 'The image should be embedded inline in the document as a real image — the Anthropic favicon renders between the two paragraphs. Not an alt-text hyperlink.',
    markdown: `Before the image.

![Anthropic logo](https://www.anthropic.com/favicon.ico)

After the image.`,
  },

  {
    title: 'Image (wide image scaled to page width)',
    expect: 'The wide PNG should appear as an inline image, scaled to fit the text column (~468pt) rather than overflowing the page margins. Aspect ratio must be preserved (no squashing).',
    markdown: `A wide image, auto-scaled to fit the page:

![Wikipedia smiley](https://upload.wikimedia.org/wikipedia/commons/thumb/e/e0/SNice.svg/1200px-SNice.svg.png)

End of scaled image test.`,
  },

  // ── Mixed content ────────────────────────────────────────

  {
    title: 'Table after heading and paragraph',
    expect: 'Table should appear below the paragraph, not merged into it. There should be clear spacing between the paragraph text and the table.',
    markdown: `## Data Summary

Here is a summary of the results from our analysis:

| Metric | Value | Change |
| --- | --- | --- |
| Users | 1,234 | +12% |
| Revenue | $56K | +8% |
| Churn | 2.1% | -0.3% |`,
  },
];

// ── Runner ──────────────────────────────────────────────────

async function run() {
  const client = createClient();

  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const docName = `Visual E2E Tests — ${timestamp}`;

  console.log(`Creating "${docName}"...`);
  const { docId } = await client.createDocInFolder(docName, 'Codocs Tests');
  const url = `https://docs.google.com/document/d/${docId}/edit`;
  console.log(`Created: ${url}\n`);

  // Build the full document markdown
  const sections: string[] = [
    `# Visual E2E Tests\n\nGenerated: ${timestamp}\n\nEach section below is a test case. Visually inspect that the rendering matches the expectation.\n`,
  ];

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    sections.push(
      `## ${i + 1}. ${tc.title}\n\n` +
      `**Expected:** ${tc.expect}\n\n` +
      `\u00A0\n\n` +
      `${tc.markdown}\n`,
    );
  }

  const fullMarkdown = sections.join('\n');

  console.log(`Writing ${testCases.length} test cases (${fullMarkdown.length} chars)...`);
  await client.writeMarkdown(docId, fullMarkdown);

  console.log(`Done! Open the doc to inspect:\n  ${url}\n`);
}

run().catch((err) => {
  console.error('E2E test failed:', err.message);
  process.exit(1);
});
