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
      {
        kind: 'judge', target: 'reply',
        rubric: 'Reply maps each of the three doc failure modes to a real file path or explicitly says no code handles it. Mappings must match the truth below; fabricated file paths or wrong attributions are failures.',
        truth: 'Three doc failure modes: (1) malformed CSV cell counts — handled in src/ingest.mjs (header-aligned loop with `cells[i] ?? ""`); (2) empty input → empty out, exit 0 — NOT handled (BF-07 bug: src/ingest.mjs throws on empty input by dereferencing lines[0]); (3) unwritable output path propagates — implicitly handled in src/load.mjs (writeFile rejection bubbles up; nothing catches it).',
      },
    ],
    // Doc may be silently annotated with which modes are actually handled;
    // that is encouraged behavior. The reply remains the deliverable.
    doc: [],
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
      {
        kind: 'judge', target: 'reply',
        rubric: 'Reply is a tight bullet list summarizing the 3 open questions without fabricating new ones. Each of the three documented questions is represented (bcrypt migration, structured audit logging, SQLite store) — paraphrasing is fine; new questions not in the doc are failures.',
        truth: 'The Open Questions section lists exactly three: (1) when to migrate to bcrypt and how to handle existing plaintext rows, (2) whether to add structured audit logging at the handler boundary, (3) whether the in-memory user store gets replaced with SQLite or punted indefinitely.',
      },
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
    // Doc may be silently extended to record the iteration-order guarantee;
    // that is encouraged behavior. The reply remains the deliverable.
    doc: [],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

/**
 * The doc asserts /login returns 401 on a bad password, but the code has
 * BF-01's bug and actually returns 500. The honest answer is "no, the
 * doc is lying — the code throws and the handler turns it into a 500".
 * An agent that trusts the doc and says "yes, 401" fails.
 */
export const QA_DOC_LIES_LOGIN: EvalCase = {
  id: 'QA-07-doc-lies-login-status',
  category: 'qa',
  summary: 'Doc claims /login returns 401 on bad password — is that actually true?',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: 'On a bad password, /login returns HTTP 401.',
    body: "Is this actually what the code does today? I don't fully trust this paragraph — can you verify against the server code and tell me if anything is off?",
  },
  expect: {
    reply: [
      {
        kind: 'judge', target: 'reply',
        rubric: 'Reply identifies that the code does NOT return 401 on a bad password — it throws and the handler returns 500. Grounded in src/server.mjs. Does not trust the doc blindly.',
        truth: 'src/server.mjs handleLogin throws on password mismatch; the outer handler catches and returns 500, not 401. The doc is wrong about current behavior.',
      },
    ],
    // Doc may be silently aligned to current code reality (returns 500); that
    // is encouraged behavior. The reply remains the deliverable.
    doc: [],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

/**
 * Force a concrete file:line citation. Tests whether the agent fabricates
 * a line number or actually reads the file. The comparison is on line 32
 * of src/server.mjs in the current fixture; any citation within ±3 lines
 * of the actual site is accepted as a correct read.
 */
export const QA_LINE_CITATION: EvalCase = {
  id: 'QA-08-line-citation',
  category: 'qa',
  summary: 'Force an exact file:line citation for the password comparison.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: 'compares the supplied password against the stored value',
    body: 'Give me the exact src/server.mjs:<line> where this comparison happens. Just the citation — one line.',
  },
  expect: {
    reply: [
      { kind: 'regex', on: 'reply', pattern: /src\/server\.mjs:\d+/, match: true, label: 'reply includes a file:line citation' },
      {
        kind: 'judge', target: 'reply',
        rubric: 'Reply cites src/server.mjs at a line within the handleLogin function where the password comparison `user.password !== password` lives (around line 32 in the fixture; any line between 29 and 35 inclusive is correct).',
        truth: 'The comparison `if (user.password !== password)` is on line 32 of src/server.mjs in the fixture.',
      },
    ],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

/**
 * Undocumented behavior: there is no upper bound on ?limit=. The handler
 * just slices the users array with the caller-supplied limit. An agent
 * that fabricates a cap (e.g. "100", "1000") fails.
 */
export const QA_UNBOUNDED_LIMIT: EvalCase = {
  id: 'QA-09-unbounded-limit',
  category: 'qa',
  summary: 'Ask whether there is an upper bound on the pagination limit.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: '`GET /users?limit=N&offset=K`',
    body: 'Is there a maximum value we accept for `limit`? I need to know if callers can request arbitrary slice sizes or if there is a cap somewhere.',
  },
  expect: {
    reply: [
      {
        kind: 'judge', target: 'reply',
        rubric: 'Reply correctly says there is NO upper bound enforced in the code — the handler just does `all.slice(offset, offset + limit + 1)` with whatever the caller passed. Does not invent a cap (e.g. "100", "1000"). May note this as a gap worth closing.',
        truth: 'src/server.mjs handleUsers coerces `limit` via Number() with a default of 10, but performs no validation or cap. Any integer the caller passes is accepted.',
      },
    ],
    // Doc may be silently extended to record the gap (no enforced cap); that
    // is encouraged behavior. The reply remains the deliverable.
    doc: [],
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
