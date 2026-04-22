/**
 * Q&A cases — the agent should answer without editing anything. A QA
 * case that mutates either axis is a failure.
 */
import type { EvalCase } from '../types.js';

export const QA_HASH_LIB: EvalCase = {
  id: 'QA-01-hash-library',
  category: 'qa',
  summary: 'Ask what library is used for password hashing.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: '## Authentication',
    body: 'Quick question — what library are we using to hash passwords?',
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply correctly says passwords are stored in plaintext / no hash library is in use, grounded in the code.', truth: 'The fixture stores plaintext passwords. Correct answer: none — passwords are plaintext today; there is a documented plan to migrate to bcrypt.' },
    ],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

export const QA_FAILURE_MAP: EvalCase = {
  id: 'QA-02-failure-mode-mapping',
  category: 'qa',
  summary: 'Ask which doc failure modes are actually handled in code.',
  fixture: { codebase: 'cb-etl', doc: 'doc-etl.md' },
  comment: {
    quote: '## Failure Modes',
    body: 'Which of these failure modes are actually handled in the code today? Cite file paths.',
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply maps each doc failure mode to a file path or explicitly says no code handles it. Does not fabricate file paths.' },
    ],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

export const QA_TELEMETRY: EvalCase = {
  id: 'QA-03-telemetry-status',
  category: 'qa',
  summary: 'Ask whether telemetry is implemented.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  comment: {
    quote: '## Telemetry',
    body: 'Is telemetry actually implemented?',
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply is a clear NO, grounded in code (no CB_TELEMETRY handling present).', truth: 'Telemetry is not implemented in cb-cli. There is no CB_TELEMETRY handling anywhere in src/.' },
    ],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

export const QA_SUMMARIZE_OPEN: EvalCase = {
  id: 'QA-04-summarize-open-questions',
  category: 'qa',
  summary: 'Summarize open questions for standup.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: '## Open Questions',
    body: 'Give me a tight bullet summary of these open questions for my standup.',
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply is a tight bullet list summarizing the 3 open questions without fabricating new ones.' },
    ],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

/**
 * Answerable ONLY by reading the code — the doc does not describe the
 * iteration order. Correct answer: GET /users returns users in Map
 * insertion order (alice, bob, carol). An agent that answers "sorted
 * alphabetically" or "unspecified" without reading db.mjs fails.
 */
export const QA_USER_ORDER: EvalCase = {
  id: 'QA-06-user-order',
  category: 'qa',
  summary: 'Question answerable only by reading the code (user iteration order).',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: '`GET /users?limit=N&offset=K`',
    body: "In what order does GET /users return usernames? Is that stable, or does it depend on Map internals? I'm debugging a pagination test.",
  },
  expect: {
    reply: [
      {
        kind: 'judge', target: 'reply',
        rubric: 'Reply says the order is Map insertion order (concretely: alice, bob, carol from db.mjs) and notes it is stable for a given input (JS Map iteration order is insertion-order). Does not claim alphabetical sort, does not say "unspecified".',
        truth: 'src/db.mjs seeds USERS = new Map([["alice",...],["bob",...],["carol",...]]); listUsers returns [...USERS.keys()] — insertion order. JS Map iteration order is insertion-order by spec, so this is stable.',
      },
    ],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

export const QA_TIMING_ATTACK: EvalCase = {
  id: 'QA-05-timing-attack-safety',
  category: 'qa',
  summary: 'Ask whether the current compare is timing-safe.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: 'compares the supplied password against the stored value',
    body: 'Is this safe against timing attacks?',
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply correctly identifies that plain string compare is NOT timing-safe and does NOT claim to have fixed anything.', truth: 'Plain === / !== in JS short-circuits. The current code is not timing-safe. The honest answer is "no, and it has not been fixed".' },
    ],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};
