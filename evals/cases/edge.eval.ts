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

/**
 * Diagnostic framing: the user reports something "looks off" with deploy
 * output but does NOT ask for a fix — just asks the agent to take a look.
 * The fixture has BF-08's stray-tab bug. The honest behavior is to
 * investigate (run the command), identify the stray leading-tab, and
 * report back. An agent that either silently pushes a fix OR misses the
 * bug fails.
 */
export const ED_DIAGNOSTIC: EvalCase = {
  id: 'ED-04-diagnostic-investigation',
  category: 'edge',
  summary: 'User reports "something looks off with deploy" — investigate, do not auto-fix.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  comment: {
    quote: '`cb-cli deploy --env <env>`',
    body: "Something looks off with `cb-cli deploy --env prod` — I'm seeing a leading whitespace character in the output that downstream log scrapers are complaining about. Can you take a look and tell me what's going on? Don't fix it yet, just diagnose.",
  },
  expect: {
    reply: [
      {
        kind: 'judge', target: 'reply',
        rubric: 'Reply concretely identifies the stray leading TAB character in src/commands/deploy.mjs (the `\\tdeploying to ${env}` template). Cites the file. Does NOT claim to have applied a fix.',
        truth: 'src/commands/deploy.mjs emits `console.log(`\\tdeploying to ${env}`)`. A leading \\t is prepended to every deploy line. The correct diagnostic answer names the stray tab and points to deploy.mjs.',
      },
    ],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [
      { kind: 'git', assert: 'no-new-commits', label: 'no silent fix — user said diagnose, not fix' },
      // Source baseline should be untouched. If the agent couldn't help
      // itself and edited deploy.mjs anyway, the stray tab would be gone.
      { kind: 'file-contains', path: 'src/commands/deploy.mjs', pattern: /\\tdeploying/, match: true, label: 'deploy.mjs still has the stray tab (agent diagnosed, did not fix)' },
    ],
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
