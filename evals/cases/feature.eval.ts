/**
 * Feature cases.
 *
 * Invariant: every case here CHANGES CODE BEHAVIOR and therefore the doc
 * MUST be updated to mirror it. A case that changes code without updating
 * the doc fails, and vice versa. The pass criterion is deliberately
 * symmetric across axes so prompt regressions on either side show up.
 */
import type { EvalCase } from '../types.js';

export const F_ADD_PING: EvalCase = {
  id: 'F-01-add-ping-command',
  category: 'feature',
  summary: 'Add a `ping` subcommand. Update CLI doc Commands table.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  comment: {
    quote: '## Commands',
    body: "Add a new `cb-cli ping` subcommand that prints `pong`. Wire it through src/cli.mjs. Add a row to this Commands table mirroring the new behavior.",
  },
  expect: {
    reply: [{ kind: 'judge', target: 'reply', rubric: 'Reply confirms both the code wiring AND the doc update were done.' }],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /\|\s*`?cb-cli ping`?\s*\|/, match: true, label: 'ping row in Commands table' },
    ],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'file-contains', path: 'src/cli.mjs', pattern: /ping/, match: true, label: 'ping wired in cli.mjs' },
      { kind: 'run', cmd: 'node', args: ['src/cli.mjs', 'ping'], cwd: 'worktree',
        expect: { exit: 0, stdout: /pong/ } },
    ],
  },
};

export const F_VALIDATE_STAGE: EvalCase = {
  id: 'F-02-validate-stage',
  category: 'feature',
  summary: 'Add a validate stage between ingest and transform. Document it.',
  fixture: { codebase: 'cb-etl', doc: 'doc-etl.md' },
  comment: {
    quote: '## Stages',
    body: 'Add a new `validate` stage between ingest and transform that checks each row has a non-empty `id`; drops rows with empty id. Wire it into scripts/run.mjs in the right position. Document the new stage here in the Stages list, between ingest and transform.',
  },
  expect: {
    reply: [{ kind: 'judge', target: 'reply', rubric: 'Reply describes the new stage, where it sits, and notes the doc was updated.' }],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /validate/i, match: true, label: 'validate mentioned' },
      { kind: 'judge', target: 'doc', rubric: 'The Stages list now includes a validate step BETWEEN ingest and transform — not before ingest, not after transform.' },
    ],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'file-contains', path: 'scripts/run.mjs', pattern: /validate/, match: true },
    ],
  },
};

export const F_DOCTOR: EvalCase = {
  id: 'F-03-doctor-command',
  category: 'feature',
  summary: 'Implement the doctor subcommand from Future Work; move it out of Future Work.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  comment: {
    quote: 'Add a `doctor` subcommand',
    body: "Ship the `doctor` subcommand. It should print `node=<version>` and exit 0. Wire through cli.mjs. Then update the doc: add a row to the Commands table, and REMOVE this item from Future Work (since it's no longer future).",
  },
  expect: {
    reply: [{ kind: 'judge', target: 'reply', rubric: 'Reply notes both the command landed and the Future Work entry was removed.' }],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /\|\s*`?cb-cli doctor`?\s*\|/, match: true, label: 'doctor in Commands table' },
      { kind: 'judge', target: 'doc', rubric: 'The "doctor" bullet under Future Work has been removed (not just struck through).' },
    ],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      // Accept both `process.version` ("v25.2.1") and `process.versions.node` ("25.2.1").
      { kind: 'run', cmd: 'node', args: ['src/cli.mjs', 'doctor'], cwd: 'worktree',
        expect: { exit: 0, stdout: /node=v?\d+/ } },
    ],
  },
};

export const F_RATE_LIMIT_STUB: EvalCase = {
  id: 'F-04-rate-limit-stub',
  category: 'feature',
  summary: 'Land a rateLimit stub (inert) + note its status in the doc.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: '## Rate Limiting (TBD)',
    body: "Stub out a `rateLimit()` function in a new src/rate-limit.mjs that returns `() => {}` for now (no-op middleware). Don't wire it into the server yet. Then update this section to say the stub exists but is not yet enabled.",
  },
  expect: {
    reply: [{ kind: 'judge', target: 'reply', rubric: 'Reply is explicit that the stub exists but is NOT active.' }],
    doc: [
      { kind: 'judge', target: 'doc', rubric: 'The Rate Limiting section mentions that a stub exists and is NOT yet enabled — a reader should not believe rate-limiting is active.' },
    ],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'file-exists', path: 'src/rate-limit.mjs', expect: true },
      // Accept a commented-out TODO hint; only fail if server.mjs actually
      // imports or calls rateLimit.
      { kind: 'file-contains', path: 'src/server.mjs', pattern: /import\s+[^;]*\brateLimit\b/, match: false, label: 'rateLimit not imported into server' },
      { kind: 'file-contains', path: 'src/server.mjs', pattern: /\brateLimit\s*\(/, match: false, label: 'rateLimit() not invoked in server' },
    ],
  },
};

export const F_STRUCTURED_LOGGING: EvalCase = {
  id: 'F-05-structured-logging',
  category: 'feature',
  summary: 'Add JSON-per-line logging around each ETL stage; document it.',
  fixture: { codebase: 'cb-etl', doc: 'doc-etl.md' },
  comment: {
    quote: '## Stages',
    body: 'Add a single `console.log(JSON.stringify({stage, event, ...}))` call around each pipeline stage entry in scripts/run.mjs. Then update this section to note that each stage emits a structured log line.',
  },
  expect: {
    reply: [{ kind: 'judge', target: 'reply', rubric: 'Reply notes both code + doc updates.' }],
    doc: [
      { kind: 'judge', target: 'doc', rubric: 'The Stages section now mentions that each stage emits a structured log line.' },
    ],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'grep-count', path: 'scripts/run.mjs', pattern: /console\.log\(JSON\.stringify/, min: 2, label: 'at least 2 structured log calls' },
    ],
  },
};

export const F_GITIGNORE: EvalCase = {
  id: 'F-06-gitignore',
  category: 'feature',
  summary: 'Add .gitignore covering dist/ and .env; mention in the doc.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  comment: {
    body: 'Add a .gitignore that excludes dist/ and .env. In the CLI doc, add a short section or line noting the ignored paths.',
  },
  expect: {
    reply: [{ kind: 'judge', target: 'reply', rubric: 'Reply names both the .gitignore and the doc update.' }],
    doc: [
      { kind: 'judge', target: 'doc', rubric: 'Doc mentions the gitignored paths (dist/ and .env) somewhere — a dedicated section, a note, or an addition to an existing section all count.' },
    ],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'file-contains', path: '.gitignore', pattern: /dist\//, match: true },
      { kind: 'file-contains', path: '.gitignore', pattern: /\.env/, match: true },
    ],
  },
};

export const F_BCRYPT: EvalCase = {
  id: 'F-07-bcrypt-migration-stub',
  category: 'feature',
  summary: 'Wrap password compare in a pluggable hash function; document the migration plan.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: 'Passwords are stored in plaintext today.',
    body: "Refactor the password check into a single `verifyPassword(stored, provided)` function so we can swap in bcrypt later. Keep the existing plaintext behavior for now. Update this paragraph to say the comparison now goes through verifyPassword, even though plaintext is still the current implementation.",
  },
  expect: {
    reply: [{ kind: 'judge', target: 'reply', rubric: 'Reply confirms the indirection was added without changing observed behavior.' }],
    doc: [
      { kind: 'judge', target: 'doc', rubric: 'The Authentication section now mentions the verifyPassword indirection AND is honest that plaintext is still the current implementation.' },
    ],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'file-contains', path: 'src/server.mjs', pattern: /verifyPassword/, match: true },
      { kind: 'run', cmd: 'node', args: ['scripts/probe-login.mjs', '--good'], cwd: 'worktree',
        expect: { exit: 0, stdout: /status=200/ }, label: 'good pw still works' },
      { kind: 'run', cmd: 'node', args: ['scripts/probe-login.mjs', '--bad'], cwd: 'worktree',
        expect: { exit: 0, stdout: /status=401|status=500/ }, label: 'bad pw still rejected (existing bug fine)' },
    ],
  },
};

export const F_STATUS_CMD: EvalCase = {
  id: 'F-08-status-command',
  category: 'feature',
  summary: 'Add a `status` subcommand that prints a one-line summary; document it.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  comment: {
    quote: '## Commands',
    body: 'Add a `cb-cli status` subcommand that prints `ok` and exits 0. Add it to this Commands table.',
  },
  expect: {
    reply: [{ kind: 'judge', target: 'reply', rubric: 'Reply confirms status command added + doc row added.' }],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /\|\s*`?cb-cli status`?\s*\|/, match: true, label: 'status row in table' },
    ],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'run', cmd: 'node', args: ['src/cli.mjs', 'status'], cwd: 'worktree',
        expect: { exit: 0, stdout: /ok/ } },
    ],
  },
};
