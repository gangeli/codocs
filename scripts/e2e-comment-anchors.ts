#!/usr/bin/env node
/**
 * End-to-end COMMENT-ANCHOR preservation tests (interactive, single fixture).
 *
 * Companion to scripts/e2e-edit-roundtrip.ts. That script verifies
 * markdown edits round-trip through the production diff pipeline. This
 * one verifies the §3.7.1 splice/revert mechanism: when an agent edit
 * substantially rewrites a span of text that has an open comment, the
 * pipeline preserves the anchor (via splice) or backs out the edit
 * (via revert) instead of orphaning the comment.
 *
 * Why interactive: the Drive `comments.create` API stores anchors but
 * Google Docs explicitly ignores them in the editor UI — comments
 * created that way render as "Original content deleted" from the
 * moment of creation, and `quotedFileContent` is never bound to a
 * body span. The only way to get a properly-anchored comment is for a
 * human to create it from the Docs UI text-selection flow.
 *
 * Single-fixture flow (you anchor once, the suite runs many cases):
 *   1. writeMarkdown(FIXTURE) onto the canvas doc.
 *   2. Print the doc URL and the full list of spans to anchor.
 *   3. Wait for ENTER. Re-list comments; verify every expected span
 *      has a matching anchor. If any are missing, print what we DID
 *      see and prompt for a retry.
 *   4. For each case in order:
 *        a. Re-list comments (their `quotedFileContent.value` may have
 *           drifted after prior cases' splice ops).
 *        b. Build `commentAnchors` from ALL currently-alive anchors —
 *           same shape `collectCommentAnchors` produces in production.
 *        c. Compute the agent's edited markdown by applying the case's
 *           targeted text replacement to the current live body.
 *        d. Run computeDocDiff, batchUpdate, executeAnchorSpliceOps.
 *        e. Assert the case's PRIMARY anchor was classified correctly
 *           (splice / revert / noop) and that ALL anchors are still
 *           alive afterwards (id present, not auto-resolved,
 *           `quotedFileContent.value` non-empty).
 *
 * The body of the doc evolves across cases — each case's targeted
 * replacement is designed to leave every other case's anchor span
 * untouched, so the cases compose cleanly without resetting the
 * fixture (and orphaning every anchor) between them.
 *
 * Usage:
 *   make e2e/comment-anchors
 *   npx tsx scripts/e2e-comment-anchors.ts
 *   npx tsx scripts/e2e-comment-anchors.ts CA1 CA3
 *   npx tsx scripts/e2e-comment-anchors.ts --no-open    # don't auto-open browser
 *
 * Drive's API doesn't expose anchor orphan state directly (every
 * field — `quotedFileContent.value`, `anchor`, `resolved`, `deleted`
 * — is sticky and reads identically for an alive vs orphaned
 * comment). The suite's automated checks compensate by asserting on
 * what IS observable: the splice planner's classification (splice /
 * revert / noop), the rendered post-edit body, and that every
 * comment row survives the batchUpdate without being deleted or
 * auto-resolved. After-edit doc state stays on Drive (no auto-
 * resolve sweep) so visual inspection is still possible if needed.
 */

import {
  CodocsClient,
  computeDocDiff,
  docsToMarkdownWithMapping,
  executeAnchorSpliceOps,
  type CommentAnchor,
  type DocComment,
} from '../packages/core/src/index.js';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { createInterface, Interface as ReadlineInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import type { docs_v1 } from 'googleapis';

// ── Auth (mirrors e2e-edit-roundtrip.ts) ─────────────────────

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

// ── Normalization (mirrors e2e-edit-roundtrip.ts) ────────────

function normalize(md: string): string {
  return md
    .replace(/\r\n/g, '\n')
    .replace(/^---\n\n/, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

// ── Test model ───────────────────────────────────────────────

interface AnchorSpec {
  /** Stable id used in the prompt + assertions. */
  key: string;
  /** Exact text the user is asked to highlight in the Docs UI. */
  span: string;
  /** Plain-language hint shown in the prompt for this anchor. */
  hint: string;
}

interface AnchorTestCase {
  title: string;
  /** Which AnchorSpec.key this case exercises. */
  anchorKey: string;
  /**
   * The agent's edit, expressed in one of two forms:
   *   - `edits`: a list of `{from, to}` replacements applied sequentially.
   *     Each `from` must occur uniquely in the live body; sanity-checked
   *     at runtime. Multiple entries cover same-section multi-edit cases.
   *   - `apply`: an arbitrary `(base) => ours` function. Use when a
   *     simple `replace` can't express the mutation (e.g. deleting a
   *     whole section spanning heading + body).
   * Exactly one of `edits` or `apply` must be set.
   */
  edits?: Array<{ from: string; to: string }>;
  apply?: (base: string) => string;
  /**
   * Outcome the planner must produce for the PRIMARY anchor:
   *   'splice' — diff.spliceOps must contain an op for this anchor
   *   'revert' — diff.preservedAnchors must label it via:'revert'
   *   'noop'   — anchor unchanged; no splice op, no preserve entry
   */
  outcome: 'splice' | 'revert' | 'noop';
  /** For 'splice', exact `newText` the planner should compute. */
  expectedSpliceNewText?: string;
  /**
   * Substring the surviving anchor should cover after the edit. Must
   * appear in the post-edit body — sanity check against fixture typos.
   */
  expectedAnchorTextAfter: string;
  /**
   * Per-case override of the body-progression logic. Default: the
   * cumulative expectedBody is updated with every `edits[]` entry
   * (revert outcomes don't update). Set this when the body should
   * end up somewhere the default replace-loop can't compute (e.g.
   * the agent's `apply` did a structural delete that revert restores).
   */
  bodyProgression?: 'apply-edits' | 'unchanged';
  /**
   * Additional anchors this case expects to remain alive AND
   * classified as a particular outcome. Used for multi-anchor-in-
   * one-section cases where we want to assert both the primary AND
   * secondary anchors get the right planner classification.
   */
  additionalExpectations?: Array<{
    anchorKey: string;
    outcome: 'splice' | 'revert' | 'noop';
    expectedSpliceNewText?: string;
  }>;
  skip?: string;
}

// ── Fixture ──────────────────────────────────────────────────

// The fixture is also the user's instruction sheet. Each section
// contains an action blockquote describing what to anchor, followed
// by the body text the test will edit. Designed so:
//   - Each anchor span is unique in the doc body.
//   - Each test's `edit.from` is unique in the doc body (does NOT
//     appear in any instruction blockquote — that would make the
//     replace ambiguous and is sanity-checked at runtime).
const FIXTURE = `# Comment Anchor E2E Tests

This doc walks you through 13 anchor cases. For each section below, follow the action instruction (in the blockquote) and add a comment on the indicated body text using the Docs UI. Once all comments are anchored, return to your terminal and press ENTER to run the tests.

# CA1 — replace a word inside the anchored span

> **Action [fox]:** highlight the fox sentence below (period included) and add a comment.

The quick brown fox jumps over the lazy dog.

# CA2 — replace a substring near the start of the anchored span

> **Action [sha1]:** highlight the authentication-scheme sentence below (period included) and add a comment.

Authentication uses the legacy SHA1 scheme today.

# CA3 — replace a substring at the end of the anchored span

> **Action [tls]:** highlight the HTTPS/TLS sentence below (period included) and add a comment.

We use HTTPS over TLS 1.2 today.

# CA4 — replace the whole anchored span

> **Action [deprecated]:** highlight the entire "Deprecated..." sentence below (period included) and add a comment.

Deprecated paragraph that needs replacement.

# CA5 — edit elsewhere (noop)

> **Action [stable]:** highlight the entire stable-opening sentence below (period included) and add a comment.

Stable opening paragraph that should not be touched.

# CA6 — single-character anchor (revert)

> **Action [xchar]:** highlight just the single capital letter at the start of the marker line below and add a comment.

X is a marker character we comment on.

# CA7 — multi-edit in the same section

> **Action [multi]:** highlight the FIRST body sentence in this section (the one immediately below this instruction) and add a comment.

Multi-edit anchored sentence.

Companion sentence in the same section that the agent will also rewrite.

# CA8 — two anchors in the same section

> **Action [pair-a]:** highlight the FIRST body sentence in this section (the one immediately below this instruction) and add a comment.

First pair sentence here.

> **Action [pair-b]:** highlight the SECOND body sentence in this section (the one immediately below this instruction) and add a comment.

Second pair sentence here.

# CA9 — agent deletes this whole section

> **Action [doomed]:** highlight the body sentence in this section and add a comment.

This whole section gets removed.

# CA10 — anchor on a heading

> **Action [head]:** highlight the H2 heading text below and add a comment.

## Renameable Heading

Body sentence under the renameable heading.

# CA11 — anchor inside a table cell

> **Action [cell]:** highlight the all-caps cell text in the first data row of the table below and add a comment.

| Col1 | Col2 |
| --- | --- |
| TARGETED | other |
| more | data |

# CA12 — anchor inside a fenced code block

> **Action [code]:** highlight the variable-assignment line (the one initializing target) inside the code block below and add a comment.

\`\`\`ts
function compute() {
  const target = 1;
  return target;
}
\`\`\`

# CA13 — anchor starting with an emoji

> **Action [emoji]:** highlight the entire emoji-prefixed sentence below (the line starting with the robot emoji) and add a comment.

🤖 happy bot says hello.

# Trailing content

Closing paragraph rounds it off.
`;

const ANCHORS: AnchorSpec[] = [
  {
    key: 'fox',
    span: 'The quick brown fox jumps over the lazy dog.',
    hint: 'highlight the fox sentence (period included) — see CA1 in the doc',
  },
  {
    key: 'sha1',
    span: 'Authentication uses the legacy SHA1 scheme today.',
    hint: 'highlight the entire authentication-scheme sentence (period included) — see CA2 in the doc',
  },
  {
    key: 'tls',
    span: 'We use HTTPS over TLS 1.2 today.',
    hint: 'highlight the entire HTTPS/TLS sentence (period included) — see CA3 in the doc',
  },
  {
    key: 'deprecated',
    span: 'Deprecated paragraph that needs replacement.',
    hint: 'highlight the entire "Deprecated..." sentence — see CA4 in the doc',
  },
  {
    key: 'stable',
    span: 'Stable opening paragraph that should not be touched.',
    hint: 'highlight the entire stable-opening sentence — see CA5 in the doc',
  },
  {
    key: 'xchar',
    span: 'X',
    hint: 'highlight just the capital letter X at the start of the marker line — see CA6 in the doc',
  },
  {
    key: 'multi',
    span: 'Multi-edit anchored sentence.',
    hint: 'highlight the entire "Multi-edit anchored sentence." line — see CA7 in the doc',
  },
  {
    key: 'pair-a',
    span: 'First pair sentence here.',
    hint: 'highlight the entire "First pair sentence here." line — see CA8 in the doc',
  },
  {
    key: 'pair-b',
    span: 'Second pair sentence here.',
    hint: 'highlight the entire "Second pair sentence here." line — see CA8 in the doc',
  },
  {
    key: 'doomed',
    span: 'This whole section gets removed.',
    hint: 'highlight the entire "This whole section gets removed." line — see CA9 in the doc',
  },
  {
    key: 'head',
    span: 'Renameable Heading',
    hint: 'highlight the H2 heading text "Renameable Heading" — see CA10 in the doc',
  },
  {
    key: 'cell',
    span: 'TARGETED',
    hint: 'highlight the cell text "TARGETED" inside the table — see CA11 in the doc',
  },
  {
    key: 'code',
    span: 'const target = 1;',
    hint: 'highlight the line `const target = 1;` inside the code block — see CA12 in the doc',
  },
  {
    key: 'emoji',
    span: '🤖 happy bot says hello.',
    hint: 'highlight the emoji-prefixed sentence "🤖 happy bot says hello." — see CA13 in the doc',
  },
];

// ── Test cases ───────────────────────────────────────────────

const tests: AnchorTestCase[] = [
  // CA1 — Replace a word INSIDE the anchored span. Wider anchor than
  // the edit; line-diff replaces only "brown" → "red". Drive preserves
  // anchors across partial deletes inside the anchored range, so this
  // is the easy case for splice.
  {
    title: 'CA1: replace a word inside the anchored span',
    anchorKey: 'fox',
    edits: [{ from: 'brown', to: 'red' }],
    outcome: 'splice',
    expectedSpliceNewText: 'The quick red fox jumps over the lazy dog.',
    expectedAnchorTextAfter: 'The quick red fox jumps over the lazy dog.',
  },

  // CA2 — Edit a substring near the START of the anchored span. The
  // anchor covers the whole "Authentication uses the legacy SHA1
  // scheme today." sentence; the edit rewrites "legacy SHA1" →
  // "modern Argon2", a few words in from the start.
  {
    title: 'CA2: replace a substring near the start of the anchored span',
    anchorKey: 'sha1',
    edits: [{ from: 'legacy SHA1', to: 'modern Argon2' }],
    outcome: 'splice',
    expectedSpliceNewText: 'Authentication uses the modern Argon2 scheme today.',
    expectedAnchorTextAfter: 'Authentication uses the modern Argon2 scheme today.',
  },

  // CA3 — Edit a substring at the END of the anchored span. Anchor
  // covers the whole "We use HTTPS over TLS 1.2 today." sentence; the
  // edit rewrites the trailing "TLS 1.2 today" → "TLS 1.3 in
  // production", right before the period.
  {
    title: 'CA3: replace a substring at the end of the anchored span',
    anchorKey: 'tls',
    edits: [{ from: 'TLS 1.2 today', to: 'TLS 1.3 in production' }],
    outcome: 'splice',
    expectedSpliceNewText: 'We use HTTPS over TLS 1.3 in production.',
    expectedAnchorTextAfter: 'We use HTTPS over TLS 1.3 in production.',
  },

  // CA4 — Replace the WHOLE anchored span. Hardest case: line-diff
  // produces a single replace covering the full anchor. Splice's
  // two-step insert+trim is what's supposed to keep the anchor alive.
  {
    title: 'CA4: replace the whole anchored span',
    anchorKey: 'deprecated',
    edits: [{
      from: 'Deprecated paragraph that needs replacement.',
      to: 'Updated paragraph with completely fresh content.',
    }],
    outcome: 'splice',
    expectedSpliceNewText: 'Updated paragraph with completely fresh content.',
    expectedAnchorTextAfter: 'Updated paragraph with completely fresh content.',
  },

  // CA5 — Edit ELSEWHERE; the "stable" anchor's span isn't touched.
  // The edit lands on the closing paragraph, but the planner should
  // classify the stable anchor as noop. Trivial baseline.
  {
    title: 'CA5: edit elsewhere leaves the anchored span unchanged (noop)',
    anchorKey: 'stable',
    edits: [{
      from: 'Closing paragraph rounds it off.',
      to: 'Closing paragraph rewritten by the agent.',
    }],
    outcome: 'noop',
    expectedAnchorTextAfter: 'Stable opening paragraph that should not be touched.',
  },

  // CA6 — Single-character anchor falls back to REVERT. With
  // anchor.length < MIN_SPLICE_LEN there's no interior splice point,
  // so the planner downgrades to revert: the section holding "X" is
  // restored to its `theirs` content; the edit gets undone.
  {
    title: 'CA6: single-character anchor falls back to revert',
    anchorKey: 'xchar',
    edits: [{ from: 'X is a marker', to: 'Y is a marker' }],
    outcome: 'revert',
    expectedAnchorTextAfter: 'X',
  },

  // CA7 — Multi-edit in the same section. The agent edits BOTH the
  // anchored sentence AND a non-anchored companion sentence in the
  // SAME section. The current fix reverts the entire section to keep
  // the anchor alive, which silently DROPS the companion edit. This
  // case is expected to FAIL until the splice/revert is finer-grained
  // than whole-section.
  {
    title: 'CA7: multi-edit in the same section',
    anchorKey: 'multi',
    edits: [
      { from: 'Multi-edit anchored sentence.', to: 'Multi-edit anchored sentence rewritten.' },
      { from: 'Companion sentence in the same section that the agent will also rewrite.', to: 'Companion sentence updated by the agent.' },
    ],
    outcome: 'splice',
    expectedSpliceNewText: 'Multi-edit anchored sentence rewritten.',
    expectedAnchorTextAfter: 'Multi-edit anchored sentence rewritten.',
  },

  // CA8 — Two anchors in the same section. Both produce splice ops;
  // they execute sequentially on the live doc and each one's index
  // math depends on prior one's body shifts. Exercises ordering and
  // index-revalidation in executeAnchorSpliceOps.
  {
    title: 'CA8: two anchors in the same section',
    anchorKey: 'pair-a',
    edits: [
      { from: 'First pair sentence here.', to: 'First pair sentence rewritten.' },
      { from: 'Second pair sentence here.', to: 'Second pair sentence rewritten.' },
    ],
    outcome: 'splice',
    expectedSpliceNewText: 'First pair sentence rewritten.',
    expectedAnchorTextAfter: 'First pair sentence rewritten.',
    additionalExpectations: [
      {
        anchorKey: 'pair-b',
        outcome: 'splice',
        expectedSpliceNewText: 'Second pair sentence rewritten.',
      },
    ],
  },

  // CA9 — Agent deletes the whole section that holds the anchor.
  // Whole-section delete is an explicit structural intent: the
  // splice/revert pipeline is scoped to in-place edits and does NOT
  // re-insert the section to protect the anchor. The agent's delete
  // wins, the section is gone from the body, and the doomed comment
  // becomes orphaned in the Docs UI ("Original content deleted") —
  // matches normal editor behaviour when a paragraph holding a
  // comment is removed. The planner still labels the anchor as
  // 'revert' descriptively because there's no splice available;
  // that label doesn't imply any actual restore action.
  {
    title: 'CA9: agent deletes the section holding the anchor (comment orphans)',
    anchorKey: 'doomed',
    apply: (b) => {
      // Delete from "# CA9" through end of section (next "# " heading
      // at column 0, or end of doc).
      const start = b.indexOf('# CA9');
      if (start < 0) throw new Error('CA9 heading not found in live body');
      const next = b.indexOf('\n# ', start + 1);
      const end = next < 0 ? b.length : next + 1; // keep the leading \n of the next section
      return b.slice(0, start) + b.slice(end);
    },
    outcome: 'revert',
    // The section is gone — the doomed anchor text doesn't appear
    // anywhere in the final body. Use a token from the SURROUNDING
    // structure (the section that follows CA9 in the fixture) so
    // the test's substring sanity check still has something concrete
    // to verify against.
    expectedAnchorTextAfter: '# CA10',
    bodyProgression: 'apply-edits',
  },

  // CA10 — Anchor on a heading. The agent renames the heading. The
  // doc-side paragraph carrying the heading has HEADING_2 style; the
  // splice's insert+trim must not strip the named style.
  {
    title: 'CA10: anchor on a heading',
    anchorKey: 'head',
    edits: [{ from: '## Renameable Heading', to: '## Renamed Heading' }],
    outcome: 'splice',
    expectedSpliceNewText: 'Renamed Heading',
    expectedAnchorTextAfter: 'Renamed Heading',
  },

  // CA11 — Anchor inside a table cell. Tables route through their own
  // diff handler (emitTableHunkRequests); the splice path was
  // designed against paragraph-level body indices and may not
  // interact correctly with table-cell paragraphs.
  {
    title: 'CA11: anchor inside a table cell',
    anchorKey: 'cell',
    edits: [{ from: '| TARGETED | other |', to: '| EDITED | other |' }],
    outcome: 'splice',
    expectedSpliceNewText: 'EDITED',
    expectedAnchorTextAfter: 'EDITED',
  },

  // CA12 — Anchor inside a fenced code block. Code blocks have a
  // `codelang:*` named range plus monospace styling. Splice
  // insert+trim might disrupt the run boundaries or strip the code
  // formatting.
  {
    title: 'CA12: anchor inside a fenced code block',
    anchorKey: 'code',
    edits: [{ from: 'const target = 1;', to: 'const target = 42;' }],
    outcome: 'splice',
    expectedSpliceNewText: 'const target = 42;',
    expectedAnchorTextAfter: 'const target = 42;',
  },

  // CA13 — Anchor starts with an emoji (multi-code-unit surrogate
  // pair in UTF-16). The splice picks splicePoint = startIndex + 1
  // — between the high and low surrogate of the leading 🤖 — which
  // could either land cleanly (if Drive treats the codepoint as
  // atomic) or corrupt the encoding.
  {
    title: 'CA13: anchor starting with an emoji (surrogate pair)',
    anchorKey: 'emoji',
    edits: [{ from: 'happy bot', to: 'cheerful bot' }],
    outcome: 'splice',
    expectedSpliceNewText: '🤖 cheerful bot says hello.',
    expectedAnchorTextAfter: '🤖 cheerful bot says hello.',
  },
];

// ── Helpers ──────────────────────────────────────────────────

async function clearComments(client: CodocsClient, docId: string): Promise<void> {
  const comments = await client.listComments(docId);
  for (const c of comments) {
    if (c.resolved) continue;
    try { await client.resolveComment(docId, c.id); } catch { /* ignore */ }
  }
}

/**
 * After the user has anchored, find the comment matching each
 * AnchorSpec by `quotedFileContent.value`. Returns a map keyed by
 * AnchorSpec.key, plus a list of expected keys that didn't resolve.
 *
 * Match strategy: prefer exact-trim equality, then bidirectional
 * substring containment so a slightly-off highlight (extra trailing
 * space, partial selection) still resolves correctly.
 */
async function resolveAnchors(
  client: CodocsClient,
  docId: string,
  specs: AnchorSpec[],
): Promise<{ found: Map<string, DocComment>; missing: AnchorSpec[]; allOpen: DocComment[] }> {
  const allOpen = (await client.listComments(docId)).filter((c) => !c.resolved);
  const found = new Map<string, DocComment>();
  const used = new Set<string>(); // comment ids already claimed
  for (const spec of specs) {
    const wanted = spec.span.trim();
    // Exact-trim match first.
    let hit = allOpen.find(
      (c) => !used.has(c.id) && (c.quotedText ?? '').trim() === wanted,
    );
    if (!hit) {
      // Substring match either direction.
      hit = allOpen.find((c) => {
        if (used.has(c.id)) return false;
        const q = (c.quotedText ?? '').trim();
        if (!q) return false;
        return q.includes(wanted) || wanted.includes(q);
      });
    }
    if (hit) {
      found.set(spec.key, hit);
      used.add(hit.id);
    }
  }
  const missing = specs.filter((s) => !found.has(s.key));
  return { found, missing, allOpen };
}

function indent(s: string, prefix: string): string {
  return s.split('\n').map((l) => prefix + l).join('\n');
}

/**
 * One-line summary of the diff between two normalised bodies. Used
 * in the console reasons array so a body mismatch doesn't print 200
 * lines of identical text. The full bodies are always written to
 * the case's artifact JSON.
 *
 * Strategy: find the first line that differs, plus a few lines of
 * context, and report the first divergent line on each side.
 */
function summarizeBodyDiff(expected: string, actual: string): string {
  const exp = expected.split('\n');
  const act = actual.split('\n');
  const max = Math.max(exp.length, act.length);
  for (let i = 0; i < max; i++) {
    if ((exp[i] ?? '') !== (act[i] ?? '')) {
      const e = (exp[i] ?? '<eof>').slice(0, 100);
      const a = (act[i] ?? '<eof>').slice(0, 100);
      return `first diff at line ${i + 1}: expected ${JSON.stringify(e)} vs actual ${JSON.stringify(a)}`;
    }
  }
  return `lengths: expected ${expected.length} chars, actual ${actual.length} chars`;
}

/**
 * Extract a `paragraphs` list from a live doc that's compatible with
 * the test-suite's `buildDocAndMap(md, paragraphs)` helper. Each
 * paragraph's mdOffset is recovered by finding its text in the live
 * markdown. Tables and code-block-internal paragraphs may not have
 * a clean mdOffset (the markdown form differs from the doc paragraph
 * boundaries) — recorded as `null` so the unit-test author knows.
 *
 * Used purely for diagnostic artifacts: a unit test reproducing a
 * failure can copy the recorded text+mdOffset list into
 * `buildDocAndMap` to recreate the live doc shape.
 */
function extractParagraphSpec(
  doc: docs_v1.Schema$Document,
  liveMd: string,
): Array<{
  text: string;
  mdOffset: number | null;
  namedStyleType?: string | null;
  startIndex?: number | null;
  endIndex?: number | null;
  textRuns?: Array<{ startIndex: number | null; endIndex: number | null; codeUnits: number[]; content: string }>;
}> {
  const out: Array<{
    text: string;
    mdOffset: number | null;
    namedStyleType?: string | null;
    startIndex?: number | null;
    endIndex?: number | null;
    textRuns?: Array<{ startIndex: number | null; endIndex: number | null; codeUnits: number[]; content: string }>;
  }> = [];
  for (const el of doc.body?.content ?? []) {
    if (!el.paragraph) continue;
    let t = '';
    const textRuns: Array<{ startIndex: number | null; endIndex: number | null; codeUnits: number[]; content: string }> = [];
    for (const e of el.paragraph.elements ?? []) {
      if (e.textRun?.content == null) continue;
      const c = e.textRun.content;
      t += c;
      // Capture per-textRun raw structure: code-unit dump (so a unit
      // test can reconstruct the Drive doc's exact byte sequence,
      // including any variation selectors / ZWJs / unexpected
      // chars), plus the index range. Critical for diagnosing
      // splice-exec locate failures where the doc text doesn't
      // match the comment's quotedText exactly.
      const codeUnits: number[] = [];
      for (let i = 0; i < c.length; i++) codeUnits.push(c.charCodeAt(i));
      textRuns.push({
        startIndex: e.startIndex ?? null,
        endIndex: e.endIndex ?? null,
        codeUnits,
        content: c,
      });
    }
    const text = t.replace(/\n+$/, '');
    if (!text) continue;
    const mdOffset = liveMd.indexOf(text);
    out.push({
      text,
      mdOffset: mdOffset >= 0 ? mdOffset : null,
      namedStyleType: el.paragraph.paragraphStyle?.namedStyleType ?? null,
      startIndex: el.startIndex ?? null,
      endIndex: el.endIndex ?? null,
      textRuns,
    });
  }
  return out;
}

/**
 * Snapshot of a single test case's interaction with the production
 * pipeline, captured to disk for offline diagnosis. Designed to
 * provide enough state to write a `diff.test.ts`-style unit test that
 * reproduces the failure: feed `theirs`/`ours`/`paragraphs`/
 * `commentAnchors` into `computeDocDiff`, apply `requests` via the
 * existing `applyRequests` simulator, then compare against
 * `bodyAfterMainBatch` / `bodyAfterSplice`.
 */
interface CaseArtifact {
  title: string;
  index: number;
  anchorKey: string;
  outcome: 'splice' | 'revert' | 'noop';
  expectedSpliceNewText?: string;
  expectedAnchorTextAfter: string;
  edits?: Array<{ from: string; to: string }>;
  applySource?: string; // when tc.apply is used; .toString() of the function
  commentAnchors: Array<{ commentId: string; quotedText: string }>;
  primaryCommentId: string;
  // Inputs sufficient to reconstruct the doc with buildDocAndMap.
  liveMarkdownBefore: string;
  ours: string;
  theirs: string;
  paragraphs: Array<{ text: string; mdOffset: number | null; namedStyleType?: string | null }>;
  // Diff output.
  diff: {
    requests: docs_v1.Schema$Request[];
    spliceOps: Array<{
      commentId: string;
      newText: string;
      oldText: string;
      currentRange: { startIndex: number; endIndex: number };
      splicePoint: number;
      trimRanges: Array<{ startIndex: number; endIndex: number }>;
    }>;
    preservedAnchors: Array<{ quotedText: string; via: string }>;
    conflictsResolved: number;
    hasChanges: boolean;
  };
  // Body snapshots at each apply phase.
  bodyAfterMainBatch: string;
  bodyAfterSplice: string;
  // Doc paragraph structure (with per-textRun code units) at the
  // moment splice exec runs locateOldTextRange. Lets us reproduce
  // splice-exec failures offline by reconstructing the exact doc
  // shape it saw. Null when no splice ops were generated.
  docAtSpliceExec: ReturnType<typeof extractParagraphSpec> | null;
  // Splice executor outcome + per-op log messages from the
  // executor's `log` callback (e.g. "anchor text not found in
  // current doc — skipping"). Captured one-to-one with the
  // operations.
  spliceExecResult: { spliced: string[]; restored: string[]; skipped: string[] } | null;
  spliceExecLog: string[];
  // Comment state at start of case (post-prior-cases) and at end.
  commentsBefore: Array<{
    id: string;
    content: string;
    quotedText: string | null;
    resolved: boolean;
  }>;
  commentsAfter: Array<{
    id: string;
    content: string;
    quotedText: string | null;
    resolved: boolean;
  }>;
  // Test outcome.
  pass: boolean;
  reasons: string[];
}

function writeArtifact(dir: string, index: number, key: string, art: CaseArtifact): string {
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fname = `${String(index).padStart(2, '0')}-${safeKey}.json`;
  const path = join(dir, fname);
  writeFileSync(path, JSON.stringify(art, null, 2), 'utf-8');
  return path;
}

/**
 * Best-effort: open `url` in the user's default browser. Detached so
 * the script doesn't block waiting for the browser process. Failures
 * are silent — a user can always copy-paste the URL from the console.
 */
function openInBrowser(url: string): void {
  const cmd =
    platform() === 'darwin' ? 'open' :
    platform() === 'win32' ? 'cmd' :
    'xdg-open';
  const args =
    platform() === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* swallow — user can open manually */ });
    child.unref();
  } catch {
    // Spawn failed entirely (e.g., command not on PATH). Silent.
  }
}

// ── Interactive setup ────────────────────────────────────────

const SEPARATOR = '─'.repeat(72);

async function setupAnchors(
  client: CodocsClient,
  rl: ReadlineInterface,
  docId: string,
  needed: AnchorSpec[],
): Promise<Map<string, DocComment>> {
  console.log(`\n${SEPARATOR}`);
  console.log(`MANUAL SETUP — anchor ${needed.length} comment${needed.length === 1 ? '' : 's'} on the doc`);
  console.log(SEPARATOR);
  console.log(`  Doc: https://docs.google.com/document/d/${docId}/edit`);
  console.log(``);
  console.log(`  Open the doc above. Each section has an "Action" blockquote`);
  console.log(`  telling you which body text to highlight and add a comment on.`);
  console.log(`  We need ${needed.length} comment${needed.length === 1 ? '' : 's'} for this run:`);
  console.log(``);
  for (const spec of needed) {
    console.log(`    [${spec.key}] — ${spec.hint}`);
  }
  console.log(``);
  console.log(`  When all comments are anchored (yellow highlight in body),`);
  console.log(`  press ENTER here. If any are missing we'll show what we saw`);
  console.log(`  and let you try again. Type 'abort' to quit.`);
  console.log(SEPARATOR);

  while (true) {
    const answer = (await rl.question('> ')).trim().toLowerCase();
    if (answer === 'abort' || answer === 'quit' || answer === 'q') {
      throw new Error('aborted by user during anchor setup');
    }

    const { found, missing, allOpen } = await resolveAnchors(client, docId, needed);
    if (missing.length === 0) {
      console.log(`  ✓ All ${needed.length} anchor${needed.length === 1 ? '' : 's'} resolved:`);
      for (const spec of needed) {
        const c = found.get(spec.key)!;
        console.log(`    [${spec.key}] id=${c.id} quoted=${JSON.stringify((c.quotedText ?? '').trim())}`);
      }
      return found;
    }

    console.log(``);
    console.log(`  ✗ Missing ${missing.length} anchor(s):`);
    for (const spec of missing) {
      console.log(`    - [${spec.key}] expected ${JSON.stringify(spec.span)}`);
    }
    if (allOpen.length === 0) {
      console.log(`  (No unresolved comments on the doc yet.)`);
    } else {
      console.log(`  Unresolved comments currently on the doc:`);
      for (const c of allOpen) {
        console.log(`    - id=${c.id} quoted=${JSON.stringify((c.quotedText ?? '').trim() || null)}`);
      }
    }
    console.log(`  Anchor the missing span(s) and press ENTER (or 'abort' to quit).`);
  }
}

// ── Per-case runner ──────────────────────────────────────────

interface CaseResult {
  pass: boolean;
  reasons: string[];
}

async function runCase(
  client: CodocsClient,
  docId: string,
  tc: AnchorTestCase,
  caseIndex: number,
  anchorByKey: Map<string, DocComment>,
  expectedBody: string,
  artifactDir: string | null,
): Promise<{ result: CaseResult; nextExpectedBody: string; artifactPath: string | null }> {
  const reasons: string[] = [];
  const primarySpec = ANCHORS.find((s) => s.key === tc.anchorKey)!;
  const primary = anchorByKey.get(tc.anchorKey);
  if (!primary) {
    reasons.push(`primary anchor [${tc.anchorKey}] not found in setup map — bailing`);
    return { result: { pass: false, reasons }, nextExpectedBody: expectedBody, artifactPath: null };
  }

  // Re-list comments to capture any drift in `quotedFileContent.value`
  // from prior cases' splice ops. We rebuild commentAnchors from the
  // FRESH state — this matches what the production orchestrator does
  // each time it processes a comment event.
  const liveAllRaw = await client.listComments(docId);
  const liveAll = liveAllRaw.filter((c) => !c.resolved);
  const liveById = new Map(liveAll.map((c) => [c.id, c]));
  const liveByKey = new Map<string, DocComment>();
  for (const [key, original] of anchorByKey) {
    const fresh = liveById.get(original.id);
    if (fresh) liveByKey.set(key, fresh);
  }

  // Capture comment state snapshot for the artifact, before any edit.
  const commentsBefore = liveAllRaw.map((c) => ({
    id: c.id,
    content: c.content,
    quotedText: c.quotedText ?? null,
    resolved: c.resolved,
  }));

  // Production-realistic input: ALL alive comment anchors, not just
  // this case's primary. Other anchors should classify as noop.
  const commentAnchors: CommentAnchor[] = [];
  for (const [, c] of liveByKey) {
    const q = (c.quotedText ?? '').trim();
    if (!q) continue;
    commentAnchors.push({ commentId: c.id, quotedText: q });
  }

  // Pull the live doc + index map.
  const doc = await client.getDocument(docId);
  const { markdown: base, indexMap } = docsToMarkdownWithMapping(doc);

  // Validate the test definition: exactly one of edits / apply.
  const hasEdits = Array.isArray(tc.edits) && tc.edits.length > 0;
  const hasApply = typeof tc.apply === 'function';
  if (hasEdits === hasApply) {
    reasons.push(
      `case ${JSON.stringify(tc.title)} must specify exactly one of "edits" or "apply" (got ` +
      `edits=${hasEdits ? tc.edits!.length : 0}, apply=${hasApply})`,
    );
    return { result: { pass: false, reasons }, nextExpectedBody: expectedBody, artifactPath: null };
  }

  // Sanity: each edit's `from` must occur uniquely in the live body.
  // Skipped for the `apply` path — the function takes responsibility.
  if (hasEdits) {
    for (const e of tc.edits!) {
      const occurs = base.split(e.from).length - 1;
      if (occurs === 0) {
        reasons.push(
          `edit.from ${JSON.stringify(e.from)} not found in live body — prior case may have already changed it`,
        );
        return { result: { pass: false, reasons }, nextExpectedBody: expectedBody, artifactPath: null };
      }
      if (occurs > 1) {
        reasons.push(
          `edit.from ${JSON.stringify(e.from)} occurs ${occurs} times in live body — must be unique`,
        );
        return { result: { pass: false, reasons }, nextExpectedBody: expectedBody, artifactPath: null };
      }
    }
  }

  // Body assertion: the LIVE body before this case's edit should
  // match the running expectedBody from cumulative prior cases. If
  // not, a prior case left the doc in an unexpected state and our
  // expectations have already drifted; surface that loudly.
  const baseNorm = normalize(base);
  const expectedNorm = normalize(expectedBody);
  if (baseNorm !== expectedNorm) {
    reasons.push(
      `live body does not match cumulative expectation BEFORE this case's edit.\n` +
      `      expected:\n${indent(expectedNorm, '        ')}\n` +
      `      actual:\n${indent(baseNorm, '        ')}`,
    );
    // Continue running so we still surface other failures, but flag this.
  }

  // Compute the agent's edited markdown.
  let ours: string;
  if (hasEdits) {
    ours = base;
    for (const e of tc.edits!) ours = ours.replace(e.from, e.to);
  } else {
    ours = tc.apply!(base);
  }
  const theirs = base; // single-author edit; no concurrent changes.

  const diff = await computeDocDiff(
    base, ours, theirs, doc, indexMap, 'rt-anchor-agent',
    undefined,
    { commentAnchors },
  );

  const primaryLive = liveByKey.get(tc.anchorKey)!;

  // ── Outcome shape for the PRIMARY anchor ──
  if (tc.outcome === 'splice') {
    const op = diff.spliceOps.find((o) => o.commentId === primaryLive.id);
    if (!op) {
      reasons.push(
        `expected a splice op for primary anchor [${tc.anchorKey}] (id=${primaryLive.id}), ` +
        `got spliceOps=${JSON.stringify(diff.spliceOps.map((o) => ({ id: o.commentId, newText: o.newText })))}, ` +
        `preservedAnchors=${JSON.stringify(diff.preservedAnchors)}`,
      );
    } else if (
      tc.expectedSpliceNewText !== undefined &&
      op.newText !== tc.expectedSpliceNewText
    ) {
      reasons.push(
        `splice newText mismatch for [${tc.anchorKey}].\n` +
        `      expected: ${JSON.stringify(tc.expectedSpliceNewText)}\n` +
        `      actual:   ${JSON.stringify(op.newText)}`,
      );
    }
  } else if (tc.outcome === 'revert') {
    if (diff.spliceOps.some((o) => o.commentId === primaryLive.id)) {
      reasons.push(
        `expected NO splice op for primary anchor [${tc.anchorKey}] (revert case), ` +
        `got ${JSON.stringify(diff.spliceOps.filter((o) => o.commentId === primaryLive.id))}`,
      );
    }
    const labelled = diff.preservedAnchors.find(
      (p) => p.via === 'revert' && (p.quotedText ?? '').trim() === (primaryLive.quotedText ?? '').trim(),
    );
    if (!labelled) {
      reasons.push(
        `expected preservedAnchors to include via:'revert' for [${tc.anchorKey}], ` +
        `got ${JSON.stringify(diff.preservedAnchors)}`,
      );
    }
  } else {
    // noop
    if (diff.spliceOps.some((o) => o.commentId === primaryLive.id)) {
      reasons.push(
        `expected NO splice op for primary anchor [${tc.anchorKey}] (noop case), ` +
        `got ${JSON.stringify(diff.spliceOps.filter((o) => o.commentId === primaryLive.id))}`,
      );
    }
    const labelled = diff.preservedAnchors.find(
      (p) => (p.quotedText ?? '').trim() === (primaryLive.quotedText ?? '').trim(),
    );
    if (labelled) {
      reasons.push(
        `expected NO preservedAnchors entry for [${tc.anchorKey}] (noop case), got ${JSON.stringify(labelled)}`,
      );
    }
  }

  // ── Outcome shape for ADDITIONAL anchors (multi-anchor cases) ──
  for (const extra of tc.additionalExpectations ?? []) {
    const extraLive = liveByKey.get(extra.anchorKey);
    if (!extraLive) {
      reasons.push(`additional anchor [${extra.anchorKey}] not found in live comment map`);
      continue;
    }
    if (extra.outcome === 'splice') {
      const op = diff.spliceOps.find((o) => o.commentId === extraLive.id);
      if (!op) {
        reasons.push(
          `expected a splice op for additional anchor [${extra.anchorKey}] (id=${extraLive.id}), ` +
          `got spliceOps=${JSON.stringify(diff.spliceOps.map((o) => ({ id: o.commentId, newText: o.newText })))}`,
        );
      } else if (
        extra.expectedSpliceNewText !== undefined &&
        op.newText !== extra.expectedSpliceNewText
      ) {
        reasons.push(
          `splice newText mismatch for additional anchor [${extra.anchorKey}].\n` +
          `      expected: ${JSON.stringify(extra.expectedSpliceNewText)}\n` +
          `      actual:   ${JSON.stringify(op.newText)}`,
        );
      }
    }
  }

  // Apply the diff (production order: main batch first, then splice).
  // Capture the body in between so the artifact records whether the
  // main batch alone preserved the anchored span — the key signal for
  // diagnosing splice failures (Drive orphans on whole-anchor delete).
  if (diff.requests.length > 0) {
    await client.batchUpdate(docId, diff.requests);
  }
  const bodyAfterMainBatch = await client.readMarkdown(docId);

  // Snapshot the live doc structure at the moment splice exec sees
  // it. When a splice op comes back 'skipped', the question is "what
  // did locateOldTextRange actually see?" — this snapshot is the
  // load-bearing input. Captured AFTER the main batch and BEFORE the
  // splice exec runs, so it matches what the splice's getDocument
  // call would return.
  let docAtSpliceExec: ReturnType<typeof extractParagraphSpec> | null = null;
  let spliceExecLog: string[] = [];
  let spliceExecResult: { spliced: string[]; restored: string[]; skipped: string[] } | null = null;
  if (diff.spliceOps.length > 0) {
    const docNow = await client.getDocument(docId);
    const liveMdNow = await client.readMarkdown(docId);
    docAtSpliceExec = extractParagraphSpec(docNow, liveMdNow);
    spliceExecResult = await executeAnchorSpliceOps(
      client, docId, diff.spliceOps,
      (msg) => spliceExecLog.push(msg),
    );
    // Every queued splice op MUST actually land. A 'skipped' or
    // 'restored' result means Drive rejected the splice (bad index,
    // grapheme boundary, anchor text disappeared), and the comment
    // is now orphaned even if the diff planner thought it had
    // covered the case. This catches things like the CA8 multi-
    // anchor regression where the second op's anchor text had
    // already been deleted by the main batch.
    for (const op of diff.spliceOps) {
      if (!spliceExecResult.spliced.includes(op.commentId)) {
        const where = spliceExecResult.skipped.includes(op.commentId) ? 'skipped'
          : spliceExecResult.restored.includes(op.commentId) ? 'restored'
            : 'missing';
        reasons.push(
          `splice op for [${op.commentId}] (oldText=${JSON.stringify(op.oldText.slice(0, 50))}) ` +
          `did not land (${where}); see spliceExecLog in the artifact for the Drive error.`,
        );
      }
    }
  }

  // ── Body assertion ──
  // - revert outcome OR explicit bodyProgression='unchanged': body
  //   should not have changed (the section was reverted to theirs).
  // - splice / noop with edits[]: each replace lands cumulatively.
  // - splice / noop with apply: we trust the test's apply function and
  //   re-run it against the running expectedBody for the diff.
  let nextExpectedBody = expectedBody;
  const progressionMode =
    tc.bodyProgression ?? (tc.outcome === 'revert' ? 'unchanged' : 'apply-edits');
  if (progressionMode === 'apply-edits') {
    if (hasEdits) {
      for (const e of tc.edits!) nextExpectedBody = nextExpectedBody.replace(e.from, e.to);
    } else {
      nextExpectedBody = tc.apply!(nextExpectedBody);
    }
  }

  const after = await client.readMarkdown(docId);
  const actual = normalize(after);
  const expectedAfter = normalize(nextExpectedBody);
  if (actual !== expectedAfter) {
    // Console output stays compact — full expected/actual bodies
    // are too big to read inline (especially with the instruction-
    // sheet fixture). Surface a one-line summary plus the offending
    // diff hunk; the artifact JSON has the complete bodies for
    // offline inspection.
    reasons.push(
      `body mismatch after edit (see artifact for full bodies). ` +
      summarizeBodyDiff(expectedAfter, actual),
    );
    // Re-baseline `nextExpectedBody` to the LIVE body so subsequent
    // cases don't cascade-fail on a mismatch that was already
    // reported here. Keeps the per-case "before-edit" check honest.
    nextExpectedBody = after;
  }
  if (!actual.includes(tc.expectedAnchorTextAfter)) {
    reasons.push(
      `expectedAnchorTextAfter ${JSON.stringify(tc.expectedAnchorTextAfter)} not found in final body — ` +
      `fixture/expectation mismatch`,
    );
  }

  // ── Comment row sanity check ──
  // Verify that every anchor we set up at the start is still on the
  // doc and wasn't auto-resolved or deleted by the batchUpdate.
  // Drive's API doesn't expose orphan state (every field is sticky),
  // but it does expose deletion + resolution, and combined with the
  // body assertion + the splice planner outcome assertions above
  // these checks catch the failure modes we care about.
  const liveAfter = await client.listComments(docId);
  const byIdAfter = new Map(liveAfter.map((c) => [c.id, c]));
  for (const spec of ANCHORS) {
    const original = anchorByKey.get(spec.key);
    if (!original) continue;
    const c = byIdAfter.get(original.id);
    if (!c) {
      reasons.push(`anchor [${spec.key}] (id=${original.id}) disappeared from the doc`);
      continue;
    }
    if (c.resolved) {
      reasons.push(`anchor [${spec.key}] (id=${original.id}) was unexpectedly auto-resolved`);
    }
  }

  // ── Diagnostic artifact ──
  // Capture every input + output + intermediate state for this case
  // so a unit test can be reconstructed offline. Always written, not
  // just on failure — the artifact is small and the next failure may
  // reveal info needed to understand a prior pass.
  let artifactPath: string | null = null;
  if (artifactDir) {
    const art: CaseArtifact = {
      title: tc.title,
      index: caseIndex,
      anchorKey: tc.anchorKey,
      outcome: tc.outcome,
      expectedSpliceNewText: tc.expectedSpliceNewText,
      expectedAnchorTextAfter: tc.expectedAnchorTextAfter,
      edits: tc.edits,
      applySource: tc.apply ? tc.apply.toString() : undefined,
      commentAnchors,
      primaryCommentId: primaryLive.id,
      liveMarkdownBefore: base,
      ours,
      theirs,
      paragraphs: extractParagraphSpec(doc, base),
      diff: {
        requests: diff.requests,
        spliceOps: diff.spliceOps.map((op) => ({
          commentId: op.commentId,
          newText: op.newText,
          oldText: op.oldText,
          currentRange: op.currentRange,
          splicePoint: op.splicePoint,
          trimRanges: op.trimRanges,
        })),
        preservedAnchors: diff.preservedAnchors,
        conflictsResolved: diff.conflictsResolved,
        hasChanges: diff.hasChanges,
      },
      bodyAfterMainBatch,
      bodyAfterSplice: after,
      docAtSpliceExec,
      spliceExecResult,
      spliceExecLog,
      commentsBefore,
      commentsAfter: liveAfter.map((c) => ({
        id: c.id,
        content: c.content,
        quotedText: c.quotedText ?? null,
        resolved: c.resolved,
      })),
      pass: reasons.length === 0,
      reasons,
    };
    artifactPath = writeArtifact(artifactDir, caseIndex, tc.anchorKey, art);
  }
  // unused-var note: primarySpec is only kept for future per-spec
  // assertions; reference it so the linter doesn't complain.
  void primarySpec;

  return {
    result: { pass: reasons.length === 0, reasons },
    nextExpectedBody,
    artifactPath,
  };
}

// ── Test selection ───────────────────────────────────────────

function selectTests(all: AnchorTestCase[], filters: string[]): AnchorTestCase[] {
  if (filters.length === 0) return all;
  const lowered = filters.map((f) => f.toLowerCase());
  return all.filter((t) => lowered.some((f) => t.title.toLowerCase().includes(f)));
}

// ── Main ─────────────────────────────────────────────────────

async function run() {
  const client = createClient();
  const folderName = 'Codocs Tests';
  const argv = process.argv.slice(2);
  const noOpen = argv.includes('--no-open');
  const filters = argv.filter((a) => !a.startsWith('--'));
  const selected = selectTests(tests, filters);
  if (filters.length > 0 && selected.length === 0) {
    console.error(`No tests matched filter(s): ${filters.map((f) => JSON.stringify(f)).join(', ')}`);
    process.exit(1);
  }

  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const filterNote =
    filters.length > 0
      ? ` — filter: ${filters.map((f) => JSON.stringify(f)).join(', ')} (${selected.length}/${tests.length} selected)`
      : '';
  console.log(`Comment-anchor preservation E2E tests — ${timestamp}${filterNote}`);
  console.log(``);
  // Only require anchors that selected cases actually exercise.
  // Include both the primary anchorKey AND any additional anchors
  // declared via `additionalExpectations` — those need to be
  // anchored at setup so the planner sees them and the per-case
  // assertions can find their commentIds.
  const neededKeys = new Set<string>();
  for (const t of selected) {
    neededKeys.add(t.anchorKey);
    for (const extra of t.additionalExpectations ?? []) {
      neededKeys.add(extra.anchorKey);
    }
  }
  const neededAnchors = ANCHORS.filter((a) => neededKeys.has(a.key));

  console.log(`These tests are INTERACTIVE. You'll anchor ${neededAnchors.length} comment${neededAnchors.length === 1 ? '' : 's'} ONCE on a`);
  console.log(`single fixture doc; then ${selected.length} case${selected.length === 1 ? '' : 's'} run${selected.length === 1 ? 's' : ''} in sequence, each modifying`);
  console.log(`a different portion of the body. Comments must remain anchored throughout.`);

  const { docId, reused } = await client.findOrCreateDocInFolder(
    'RT Anchor: comment-anchors',
    folderName,
  );
  console.log(``);
  console.log(`canvas → https://docs.google.com/document/d/${docId}/edit ${reused ? '(reused)' : '(new)'}`);

  // Diagnostic artifact directory. Each case writes a JSON snapshot
  // here capturing inputs to computeDocDiff, the diff output, post-
  // batch body, splice exec result, and pre/post comment state —
  // sufficient to reconstruct the failure as a unit test offline.
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactDir = join('.codocs', 'e2e-anchor-runs', runStamp);
  mkdirSync(artifactDir, { recursive: true });
  console.log(`artifacts → ${artifactDir}/`);

  // Reset the doc to the fixture and clear stale anchors before
  // prompting. Anchors created on the prior body would now be
  // orphans and could confuse `resolveAnchors`.
  await clearComments(client, docId);
  await client.writeMarkdown(docId, FIXTURE);

  // Open the canvas in the user's default browser so they can anchor
  // comments without leaving the terminal first. Best-effort; pass
  // --no-open to suppress.
  if (!noOpen) {
    const docUrl = `https://docs.google.com/document/d/${docId}/edit`;
    console.log(`opening ${docUrl} in your default browser...`);
    openInBrowser(docUrl);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: Array<{ title: string; reasons: string[] }> = [];

  try {
    const anchorByKey = await setupAnchors(client, rl, docId, neededAnchors);

    // Capture the live baseline AFTER the round-trip through Drive — the
    // markdown writer/reader can normalize whitespace, blockquote form,
    // etc. Comparing each test's post-edit body against this baseline
    // (rather than against the literal FIXTURE source) keeps the body
    // assertion stable across reader/writer revisions.
    let expectedBody = await client.readMarkdown(docId);
    for (let i = 0; i < selected.length; i++) {
      const tc = selected[i];
      const label = `${i + 1}/${selected.length} ${tc.title}`;
      if (tc.skip) {
        console.log(`\n  ⊘ ${label} — SKIP: ${tc.skip}`);
        skipped++;
        continue;
      }
      try {
        const { result, nextExpectedBody, artifactPath } = await runCase(
          client, docId, tc, i + 1, anchorByKey, expectedBody, artifactDir,
        );
        if (result.pass) {
          console.log(`  ✓ ${label}`);
          if (artifactPath) console.log(`      artifact: ${artifactPath}`);
          passed++;
        } else {
          console.log(`  ✗ ${label}`);
          for (const r of result.reasons) {
            console.log(`      ${r.split('\n').join('\n      ')}`);
          }
          if (artifactPath) console.log(`      artifact: ${artifactPath}`);
          failed++;
          failures.push({ title: tc.title, reasons: result.reasons });
        }
        // Update expectedBody regardless of pass/fail — the live doc
        // already reflects the edit; the running expectation must
        // track that, otherwise every later case will spuriously fail
        // its before-edit body check.
        expectedBody = nextExpectedBody;
      } catch (err: any) {
        console.log(`  ✗ ${label} — ERROR: ${err?.message ?? err}`);
        failed++;
        failures.push({ title: tc.title, reasons: [`ERROR: ${err?.message ?? err}`] });
      }
    }

    // Deliberately NOT auto-resolving comments at end of run. Doing
    // so would mask the orphan/anchored state on the doc — the whole
    // point is to leave the post-edit comment state inspectable so
    // failures are debuggable. Each subsequent run starts with a
    // fresh `clearComments` + `writeMarkdown` before the prompt, so
    // stale comments don't leak between runs.
  } finally {
    rl.close();
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(
    `Comment-anchor results: ${passed} passed, ${failed} failed` +
      (skipped > 0 ? `, ${skipped} skipped` : '') +
      `, ${selected.length} total` +
      (selected.length !== tests.length ? ` (of ${tests.length})` : ''),
  );

  console.log(`\nArtifacts: ${artifactDir}/`);
  if (failures.length > 0) {
    console.log(`\nFailed tests:`);
    for (const f of failures) console.log(`  - ${f.title}`);
    console.log(`\nDiagnostic JSON for each case is in the artifacts dir above.`);
    console.log(`Each file captures inputs (theirs/ours/commentAnchors/paragraphs),`);
    console.log(`outputs (requests, spliceOps, preservedAnchors), intermediate body`);
    console.log(`after the main batch, final body, and splice exec result — enough`);
    console.log(`to reproduce the failure as a unit test using buildDocAndMap +`);
    console.log(`applyRequests in diff.test.ts.`);
    process.exit(1);
  }
  console.log(`\nAll comment-anchor tests passed!\n`);
}

run().catch((err) => {
  console.error('E2E comment-anchor test failed:', err.message ?? err);
  process.exit(1);
});
