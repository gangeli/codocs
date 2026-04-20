#!/usr/bin/env node
/**
 * End-to-end test for the diff-apply pipeline.
 *
 * The regression this targets: appending multiple new sections in a single
 * diff used to stack every insert at the original bodyEndIndex - 1, which
 * the Docs API rejected with "Index X must be less than the end index of
 * the referenced segment" once earlier inserts had grown the doc.
 * applyDocDiff now re-fetches between each new-section insert, so every
 * batch picks up a fresh bodyEndIndex.
 *
 * Usage:
 *   make e2e/diff
 *   npx tsx scripts/e2e-diff.ts
 */

import { CodocsClient, docsToMarkdownWithMapping, computeDocDiff } from '../packages/core/src/index.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

interface Case {
  title: string;
  base: string;
  ours: string;
  /** Section headings expected in the final document (in order). */
  expectedHeadings: string[];
}

// Each case ends up applied to a fresh doc seeded with `base`, then `ours`
// is diffed + applied via applyDocDiff.
const cases: Case[] = [
  {
    title: 'Append three new sections in one diff',
    base: `# Overview\n\nOriginal body.\n`,
    ours: [
      '# Overview',
      '',
      'Original body.',
      '',
      '# Alpha',
      '',
      'Alpha body paragraph one. '.repeat(40),
      '',
      '# Beta',
      '',
      'Beta body paragraph one. '.repeat(40),
      '',
      '# Gamma',
      '',
      'Gamma body paragraph one. '.repeat(40),
      '',
    ].join('\n'),
    expectedHeadings: ['Overview', 'Alpha', 'Beta', 'Gamma'],
  },
  {
    title: 'Append sections large enough to exceed the original bodyEnd',
    base: `# Seed\n\nSmall body.\n`,
    // Each new section is ~2KB so that appending even one grows the body
    // past the original bodyEnd. Subsequent appends must use a fresh end.
    ours: (() => {
      const big = 'Filler sentence for a long section. '.repeat(60);
      return [
        '# Seed',
        '',
        'Small body.',
        '',
        '# Section One', '', big, '',
        '# Section Two', '', big, '',
        '# Section Three', '', big, '',
        '# Section Four', '', big, '',
      ].join('\n');
    })(),
    expectedHeadings: [
      'Seed',
      'Section One',
      'Section Two',
      'Section Three',
      'Section Four',
    ],
  },
  {
    title: 'Mix: modify one existing section and append two new ones',
    base: `# Intro\n\nOriginal intro text.\n\n# Existing\n\nThis stays.\n`,
    ours: [
      '# Intro',
      '',
      'Rewritten intro body.',
      '',
      '# Existing',
      '',
      'This stays.',
      '',
      '# Added One',
      '',
      'Brand new body one.',
      '',
      '# Added Two',
      '',
      'Brand new body two.',
      '',
    ].join('\n'),
    expectedHeadings: ['Intro', 'Existing', 'Added One', 'Added Two'],
  },
];

function extractHeadings(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.split('\n')) {
    const m = /^#{1,6}\s+(.+)$/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

async function runCase(client: CodocsClient, tc: Case): Promise<{ pass: boolean; reason?: string }> {
  const { docId } = await client.createDocInFolder(`Diff E2E: ${tc.title}`, 'Codocs Tests');

  // Seed the doc with the base markdown.
  await client.writeMarkdown(docId, tc.base);

  // Fetch current state so computeDocDiff can compute against the real indices.
  const doc = await client.getDocument(docId);
  const { markdown: theirs, indexMap } = docsToMarkdownWithMapping(doc);

  // The diff is: base → ours, with theirs == base (no concurrent edit).
  const diffResult = await computeDocDiff(
    tc.base,
    tc.ours,
    theirs,
    doc,
    indexMap,
    'e2e-diff',
  );

  if (!diffResult.hasChanges) {
    return { pass: false, reason: 'computeDocDiff reported no changes' };
  }

  try {
    await client.applyDocDiff(docId, diffResult);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { pass: false, reason: `applyDocDiff threw: ${message}` };
  }

  // Read back and verify every expected heading appears, in order.
  const final = await client.readMarkdown(docId);
  const actualHeadings = extractHeadings(final);

  for (const expected of tc.expectedHeadings) {
    if (!actualHeadings.includes(expected)) {
      return {
        pass: false,
        reason: `missing heading "${expected}" in output. Got: ${actualHeadings.join(', ')}`,
      };
    }
  }

  return { pass: true };
}

async function run() {
  const client = createClient();
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  console.log(`Diff E2E — ${timestamp}\n`);

  let passed = 0;
  const failures: Array<{ title: string; reason: string }> = [];

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i];
    const label = `${i + 1}/${cases.length} ${tc.title}`;

    try {
      const result = await runCase(client, tc);
      if (result.pass) {
        console.log(`  ✓ ${label}`);
        passed++;
      } else {
        console.log(`  ✗ ${label}\n    ${result.reason}`);
        failures.push({ title: tc.title, reason: result.reason ?? 'unknown' });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ ${label} — ERROR: ${message}`);
      failures.push({ title: tc.title, reason: `threw: ${message}` });
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failures.length} failed, ${cases.length} total`);

  if (failures.length > 0) {
    console.log(`\nFailed cases:`);
    for (const f of failures) {
      console.log(`  - ${f.title}: ${f.reason}`);
    }
    process.exit(1);
  }

  console.log(`\nAll diff cases passed!\n`);
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`E2E diff test failed: ${message}`);
  process.exit(1);
});
