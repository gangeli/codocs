/**
 * Thread follow-up cases.
 *
 * Each case has a `predecessor` that runs first on the same orchestrator /
 * worktree / comment thread. The follow-up comment re-uses the predecessor's
 * threadId — the orchestrator should recognize the thread and reuse the
 * worktree + session rather than starting fresh.
 */
import type { EvalCase } from '../types.js';

export const FU_TIGHTEN: EvalCase = {
  id: 'FU-01-tighten-followup',
  category: 'followup',
  summary: 'After expanding a section, ask to tighten it back to one paragraph.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  predecessor: {
    id: 'FU-01-pred',
    category: 'followup',
    summary: 'expand rate limiting',
    fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
    comment: {
      quote: '## Rate Limiting (TBD)',
      body: 'Expand this section into a 3-paragraph plan covering per-IP, per-user, and storage backend.',
      threadId: 'FU-01-thread',
    },
  },
  comment: {
    threadId: 'FU-01-thread',
    body: 'Actually, tighten it back to a single paragraph. Keep the per-IP and per-user mentions.',
  },
  expect: {
    reply: [{ kind: 'judge', target: 'reply', rubric: 'Reply confirms the tightening in the same thread.' }],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /per-?IP/i, match: true, label: 'per-IP kept' },
      { kind: 'regex', on: 'doc', pattern: /per-?user/i, match: true, label: 'per-user kept' },
      { kind: 'judge', target: 'doc', rubric: 'The Rate Limiting section is now a single paragraph (not three).' },
    ],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

export const FU_RENAME: EvalCase = {
  id: 'FU-02-rename-command',
  category: 'followup',
  summary: 'After adding a command, rename it — same branch, same thread.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  predecessor: {
    id: 'FU-02-pred',
    category: 'followup',
    summary: 'add ping',
    fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
    comment: {
      body: 'Add a `cb-cli ping` subcommand that prints `pong`. Wire it through cli.mjs. Update the Commands table in the doc.',
      threadId: 'FU-02-thread',
    },
  },
  comment: {
    threadId: 'FU-02-thread',
    body: 'Rename `ping` to `health` throughout — code and doc. Same behavior.',
  },
  expect: {
    reply: [{ kind: 'judge', target: 'reply', rubric: 'Reply confirms the rename was applied in both code and doc.' }],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /\|\s*`?cb-cli health`?\s*\|/, match: true, label: 'health row present' },
      { kind: 'regex', on: 'doc', pattern: /\|\s*`?cb-cli ping`?\s*\|/, match: false, label: 'ping row gone' },
    ],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'run', cmd: 'node', args: ['src/cli.mjs', 'health'], cwd: 'worktree',
        expect: { exit: 0, stdout: /pong/ } },
      { kind: 'run', cmd: 'node', args: ['src/cli.mjs', 'ping'], cwd: 'worktree',
        expect: { exit: 2 }, label: 'ping no longer works' },
    ],
  },
};

/**
 * After the agent correctly declines an out-of-scope predecessor, the
 * user redirects in the same thread to an in-scope audit. Tests whether
 * the agent carries thread context and answers the second ask cleanly.
 */
export const FU_AFTER_DECLINE: EvalCase = {
  id: 'FU-04-after-decline',
  category: 'followup',
  summary: 'Follow-up redirects after the agent declined an out-of-scope predecessor.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  predecessor: {
    id: 'FU-04-pred',
    category: 'followup',
    summary: 'out-of-scope billing',
    fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
    comment: {
      body: 'Also please refactor our billing service while you are in here.',
      threadId: 'FU-04-thread',
    },
  },
  comment: {
    threadId: 'FU-04-thread',
    body: "OK forget billing — there is none here. While you're in this doc, audit the CLI error messages named in the Error Handling section and tell me if they're actually consistent with what the code prints today. Just a short findings summary; don't change anything.",
  },
  expect: {
    reply: [
      {
        kind: 'judge', target: 'reply',
        rubric: 'Reply gives a concrete audit grounded in the code — naming actual error strings (e.g., the "unknown command:" message in cli.mjs) — and does not re-raise the billing decline. The thread shift lands cleanly.',
      },
    ],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

/**
 * Idempotent re-ask: after the typo is fixed, the user asks again in the
 * same thread. The agent should recognize the typo is gone and not
 * fabricate a second "fix" (which would edit the doc needlessly).
 */
export const FU_IDEMPOTENT_REASK: EvalCase = {
  id: 'FU-05-idempotent-reask',
  category: 'followup',
  summary: 'After typo fix, re-ask in the same thread — agent should no-op honestly.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  predecessor: {
    id: 'FU-05-pred',
    category: 'followup',
    summary: 'fix authentification typo',
    fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
    comment: {
      quote: 'plaintext today',
      body: "There's a typo 'authentification' in this doc — fix it to 'authentication'.",
      threadId: 'FU-05-thread',
    },
  },
  comment: {
    threadId: 'FU-05-thread',
    body: "Also, please fix the typo in this section.",
  },
  expect: {
    reply: [
      {
        kind: 'judge', target: 'reply',
        rubric: 'Reply is an honest no-op: EITHER (a) reports the typo was already corrected in the prior turn and there is nothing left to fix, OR (b) asks a concrete clarifying question (e.g., "which typo do you mean? the previous authentification/authentication fix already landed"). Must NOT claim to have made a further edit and must NOT pretend to have found and fixed a different typo.',
      },
    ],
    doc: [
      // baselineDoc for followups is post-predecessor state (typo already
      // fixed). The follow-up should not touch the doc again.
      { kind: 'doc-unchanged', label: 'follow-up made no further doc edits' },
      { kind: 'no-batch-update', label: 'no batchUpdate call on the follow-up' },
    ],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

export const FU_PARTIAL_REVERT: EvalCase = {
  id: 'FU-03-partial-revert',
  category: 'followup',
  summary: 'After mixed code+doc edit, revert the doc portion but keep the code.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  predecessor: {
    id: 'FU-03-pred',
    category: 'followup',
    summary: 'add status + doc',
    fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
    comment: {
      body: 'Add a `cb-cli status` subcommand that prints `ok`, wire through cli.mjs, AND add a row to the Commands table in the doc.',
      threadId: 'FU-03-thread',
    },
  },
  comment: {
    threadId: 'FU-03-thread',
    body: 'Revert just the doc change — remove the status row from the table. Leave the code as-is.',
  },
  expect: {
    reply: [{ kind: 'judge', target: 'reply', rubric: 'Reply confirms the doc revert and that code was left alone.' }],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /\|\s*`?cb-cli status`?\s*\|/, match: false, label: 'status row removed' },
    ],
    code: [
      { kind: 'run', cmd: 'node', args: ['src/cli.mjs', 'status'], cwd: 'worktree',
        expect: { exit: 0, stdout: /ok/ }, label: 'status still works' },
      // The follow-up is doc-only — the code branch should still have
      // exactly the one commit the predecessor landed. A second commit
      // means the agent re-touched the code unnecessarily.
      { kind: 'git', assert: 'commit-on-branch', equals: 1, label: 'exactly one commit on branch (no extra code churn)' },
    ],
  },
};
