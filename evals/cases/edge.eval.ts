/**
 * Structural edge cases that test how the agent handles unusual inputs:
 * comments with no clear anchor, quoted text that's already gone, code
 * blocks inside the doc itself.
 */
import type { EvalCase } from '../types.js';

export const ED_NO_QUOTE: EvalCase = {
  id: 'ED-01-no-quote-anchor',
  category: 'edge',
  summary: 'Bare comment with no quoted text; agent must pick a section.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    body: "Add a caveat about PII handling somewhere appropriate in the doc. Keep it to one sentence.",
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply names which section the caveat was added to and why.' },
    ],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /PII/i, match: true, label: 'PII caveat landed' },
      // Deterministic: split baseline/final on ## headings; exactly one
      // section should differ. Replaces an unreliable "other sections
      // are byte-identical to baseline" judge rubric (the judge never
      // sees the baseline, and with the enriched artifact it now does
      // — but the deterministic check is cheaper and unambiguous).
      { kind: 'sections-changed', count: 1, label: 'exactly one H2 section modified' },
    ],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

export const ED_MISSING_ANCHOR: EvalCase = {
  id: 'ED-02-missing-anchor',
  category: 'edge',
  summary: 'Quoted text that does not exist in the current doc.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: 'The section on eventual consistency goes here.',
    body: 'Expand this section please.',
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply acknowledges the quoted text is not present in the doc and does NOT silently invent / edit a different section.' },
    ],
    doc: [
      { kind: 'judge', target: 'doc', rubric: 'Either (a) the doc is byte-identical to baseline, OR (b) if an edit was made, it is trivially small and the reply explained what was done — not a hallucinated expansion.' },
    ],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

export const ED_CODE_FENCE: EvalCase = {
  id: 'ED-03-code-fence-inside-doc',
  category: 'edge',
  summary: 'Fix an intentionally broken code snippet embedded in the doc.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  comment: {
    quote: '## Overview',
    body: "Add a small usage code block right after this Overview paragraph, fenced with ```sh, showing `cb-cli greet alice` and the expected output on the next line. Keep it to two lines.",
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply confirms a small shell code block was added with the usage example.' },
    ],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /```sh[\s\S]*?cb-cli greet alice[\s\S]*?```/m, match: true, label: 'sh fence with the command present' },
    ],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};
