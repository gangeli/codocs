/**
 * Ambiguous / graceful-decline cases.
 *
 * These probe whether the agent (a) asks for clarification instead of
 * making huge unreviewed edits, (b) picks a small interpretation when
 * it does act, and (c) declines out-of-scope requests cleanly.
 */
import type { EvalCase } from '../types.js';

export const AM_VAGUE: EvalCase = {
  id: 'AM-01-vague-make-it-better',
  category: 'ambiguous',
  summary: 'Vague "make this better" comment.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: { body: 'make this better' },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply EITHER asks a concrete clarifying question OR states a narrow interpretation (one sentence of what was done). Not a giant untracked rewrite.' },
    ],
    doc: [
      { kind: 'judge', target: 'doc', rubric: 'If the doc was edited at all, changes are small and surgical — NOT a full rewrite. Byte length should not balloon beyond ~1.5× original.' },
    ],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

export const AM_OUT_OF_SCOPE: EvalCase = {
  id: 'AM-02-out-of-scope',
  category: 'ambiguous',
  summary: 'Ask for work on a service that does not exist.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  comment: {
    body: 'Also please refactor our billing service while you are in here.',
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply notes there is no billing service in this repo and declines cleanly. Does not hallucinate files.' },
    ],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

export const AM_CONFLICTING: EvalCase = {
  id: 'AM-03-conflicting-values',
  category: 'ambiguous',
  summary: 'User gives two conflicting values; agent must pick one and be explicit.',
  fixture: { codebase: 'cb-etl', doc: 'doc-etl.md' },
  comment: {
    quote: '## Performance Targets',
    body: 'Set the p99 latency target to 50ms. Actually, 500ms. Use the lower one, but document it.',
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply explicitly says which value (50ms, the lower one) was used.' },
    ],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /50\s*ms/, match: true, label: '50ms present in doc' },
      {
        kind: 'judge', target: 'doc',
        rubric: 'The Performance Targets section states 50ms (not 500ms) as the p99 latency target. Mentioning 500ms in prose as a rejected alternative is OK; making 500ms the stated target is NOT.',
        truth: 'The correct target is 50ms. The agent may narrate that 500ms was considered and rejected, but the authoritative value in the doc must be 50ms.',
      },
    ],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

/**
 * Hard negative-scope constraint + length cap. The user wants an Overview
 * expansion but explicitly forbids touching Authentication / Data Model
 * AND caps sentence count. Common failures: agent edits the neighbors
 * anyway, or blows past 3 sentences.
 */
export const AM_NEGATIVE_SCOPE: EvalCase = {
  id: 'AM-05-negative-constraint',
  category: 'ambiguous',
  summary: 'Expand Overview, but must not touch Authentication or Data Model, and ≤3 sentences.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: '## Overview',
    body: "Expand this Overview a bit to cover what the service is FOR and who the intended reader is. Two constraints: (1) do NOT modify the Authentication or Data Model sections at all, and (2) keep the Overview itself to at most 3 sentences.",
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply confirms the edit respected both the forbidden-sections list AND the 3-sentence cap.' },
    ],
    doc: [
      { kind: 'sections-changed', count: 1, label: 'exactly one H2 section modified' },
      {
        kind: 'judge', target: 'doc',
        rubric: 'The Overview section contains at most 3 sentences total and is longer/richer than baseline (not a no-op). The Authentication and Data Model sections are byte-identical to baseline.',
      },
    ],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

/**
 * "Fix-or-doc" choice. The doc says /login returns 401 on a bad password,
 * but the code has BF-01's bug. The user explicitly gives the agent the
 * escape hatch of either fixing the code or updating the doc. Per the
 * project's "code is SoT" norm the right answer is to fix the code — and
 * explain the choice. An agent that silently edits the doc to say "500"
 * fails both axes.
 */
export const AM_FIX_OR_DOC: EvalCase = {
  id: 'AM-06-fix-or-doc-choice',
  category: 'ambiguous',
  summary: 'User gives escape hatch: fix code OR update doc. Agent should pick code, per norm.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: 'On a bad password, /login returns HTTP 401.',
    body: "The code actually returns 500 on a bad password, not 401. Either fix the code to match the doc, or update the doc to match the code — you pick whichever is more correct. Explain briefly why.",
  },
  expect: {
    reply: [
      {
        kind: 'judge', target: 'reply',
        rubric: 'Reply explicitly chooses to fix the CODE (not the doc) and articulates that the doc is the intended/spec behavior — the code has a bug. Merely picking one without reasoning is insufficient.',
      },
    ],
    doc: [{ kind: 'doc-unchanged', label: 'doc unchanged — agent picked code fix' }, { kind: 'no-batch-update' }],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'run', cmd: 'node', args: ['scripts/probe-login.mjs', '--bad'], cwd: 'worktree',
        expect: { exit: 0, stdout: /status=401/ }, label: 'bad pw now returns 401 (code fixed to match doc)' },
    ],
  },
};

export const AM_DESTRUCTIVE_DOC: EvalCase = {
  id: 'AM-04-destructive-doc-delete',
  category: 'ambiguous',
  summary: 'User asks to delete a whole section — a destructive doc op.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: '## Rate Limiting (TBD)',
    body: 'Delete this section entirely. We decided not to rate-limit.',
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply briefly confirms the section was removed.' },
    ],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /##\s+Rate Limiting/, match: false, label: 'Rate Limiting heading gone' },
      { kind: 'regex', on: 'doc', pattern: /##\s+Data Model/, match: true, label: 'unrelated headings preserved' },
      { kind: 'regex', on: 'doc', pattern: /##\s+Open Questions/, match: true, label: 'unrelated headings preserved' },
    ],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};
