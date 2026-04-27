/**
 * Bug-fix cases.
 *
 * Invariant: the doc is already correct; the code is not. After the agent
 * runs, the doc should be BYTE-IDENTICAL to baseline, and running the
 * fixed code should produce the behavior the doc claims. Every case here
 * uses at least one Behavior (`kind: 'run'`) check against a probe script
 * that ships with the fixture codebase.
 */
import type { EvalCase } from '../types.js';

export const BF_LOGIN_STATUS: EvalCase = {
  id: 'BF-01-login-status',
  category: 'bug-fix',
  summary: '/login returns 500 on bad password; doc says 401.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: 'On a bad password, /login returns HTTP 401.',
    body: "This is broken — /login currently returns 500 when the password is wrong, but the doc says it should return 401. Fix the code to match the doc. Do not change the doc.",
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply identifies the fix was to the CODE (not the doc) and names /login or the 401/500 contrast.' },
    ],
    doc: [
      { kind: 'doc-unchanged', label: 'doc untouched (code is SoT)' },
      { kind: 'no-batch-update' },
    ],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'git', assert: 'commit-on-branch' },
      { kind: 'run', cmd: 'node', args: ['scripts/probe-login.mjs', '--bad'], cwd: 'worktree',
        expect: { exit: 0, stdout: /status=401/ }, label: 'bad pw → 401' },
      { kind: 'run', cmd: 'node', args: ['scripts/probe-login.mjs', '--good'], cwd: 'worktree',
        expect: { exit: 0, stdout: /status=200/ }, label: 'good pw → 200 (regression guard)' },
      { kind: 'run', cmd: 'node', args: ['scripts/probe-login.mjs', '--unknown'], cwd: 'worktree',
        expect: { exit: 0, stdout: /status=401/ }, label: 'unknown user → 401' },
    ],
  },
};

export const BF_TRANSFORM_DROP: EvalCase = {
  id: 'BF-02-transform-null-email',
  category: 'bug-fix',
  summary: 'transform drops null-email rows; doc says keep them.',
  fixture: { codebase: 'cb-etl', doc: 'doc-etl.md' },
  comment: {
    quote: 'Rows with a missing or empty email are NOT dropped',
    body: "This is broken — `transform.ts` silently drops rows with a missing or empty email. Per the doc they should be preserved with email=\"\". Fix the code; leave the doc alone.",
  },
  expect: {
    reply: [
      // Code-fix behavior is verified by the probe-transform run below.
      // Reply just needs to identify the actual semantic (drop vs preserve).
      { kind: 'judge', target: 'reply', rubric: 'Reply names the drop-vs-preserve behavior — i.e., that rows with empty/missing email are now preserved (not dropped).' },
    ],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'run', cmd: 'node', args: ['scripts/probe-transform.mjs'], cwd: 'worktree',
        expect: { exit: 0, stdout: /kept=4 dropped=0 emails_all_string=true/ }, label: 'all 4 rows preserved (incl. missing-key row)' },
    ],
  },
};

export const BF_GREET_OUTPUT: EvalCase = {
  id: 'BF-03-greet-format',
  category: 'bug-fix',
  summary: 'greet prints "Hi, X"; doc says "Hello, X!".',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  comment: {
    quote: '`cb-cli greet <name>` | Prints `Hello, <name>!`',
    body: "`cb-cli greet alice` currently prints `Hi, alice` but the doc says it should print `Hello, alice!`. Fix the code.",
  },
  expect: {
    reply: [{ kind: 'length', on: 'reply', min: 1 }],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'run', cmd: 'node', args: ['src/cli.mjs', 'greet', 'alice'], cwd: 'worktree',
        expect: { exit: 0, stdout: /^Hello, alice!/ }, label: 'documented format' },
    ],
  },
};

export const BF_PORT_DEFAULT: EvalCase = {
  id: 'BF-04-port-default',
  category: 'bug-fix',
  summary: 'serve --port defaults to 8080; doc says 3000.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  comment: {
    quote: '`--port` defaults to 3000',
    body: 'When run without `--port`, `cb-cli serve` currently prints `serving on :8080`, but the doc says the default is 3000. Fix the code.',
  },
  expect: {
    reply: [{ kind: 'length', on: 'reply', min: 1 }],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'run', cmd: 'node', args: ['src/cli.mjs', 'serve'], cwd: 'worktree',
        expect: { exit: 0, stdout: /serving on :3000/ }, label: 'default port = 3000' },
      { kind: 'run', cmd: 'node', args: ['src/cli.mjs', 'serve', '--port', '9999'], cwd: 'worktree',
        expect: { exit: 0, stdout: /serving on :9999/ }, label: 'explicit port still honored' },
    ],
  },
};

export const BF_DEPLOY_REQUIRES_ENV: EvalCase = {
  id: 'BF-05-deploy-requires-env',
  category: 'bug-fix',
  summary: 'deploy silently defaults to staging; doc says refuse without --env.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  comment: {
    quote: 'Refuses to run (exit 2) if `--env` is missing',
    body: '`cb-cli deploy` currently runs and defaults to staging when `--env` is not provided. Per the doc it should exit 2 with an error message. Fix the code.',
  },
  expect: {
    reply: [{ kind: 'length', on: 'reply', min: 1 }],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'run', cmd: 'node', args: ['src/cli.mjs', 'deploy'], cwd: 'worktree',
        expect: { exit: 2, notStdout: /deploying/ }, label: 'no --env → exit 2, no deploy' },
      { kind: 'run', cmd: 'node', args: ['src/cli.mjs', 'deploy', '--env', 'prod'], cwd: 'worktree',
        expect: { exit: 0, stdout: /deploying to prod/ }, label: 'with --env, still deploys' },
    ],
  },
};

export const BF_PAGINATION: EvalCase = {
  id: 'BF-06-pagination-off-by-one',
  category: 'bug-fix',
  summary: 'GET /users returns limit+1 items; doc says exactly limit.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: 'the half-open range `[offset, offset+limit)`',
    body: 'GET /users is returning one more item than it should — the spec is the half-open range `[offset, offset+limit)`. Off-by-one in the slice. Fix the code.',
  },
  expect: {
    reply: [
      // Code-fix behavior is verified by probe-users runs below. Reply
      // just needs to diagnose the bug as an off-by-one.
      { kind: 'judge', target: 'reply', rubric: 'Reply diagnoses the bug as a slice/range error returning one extra item — phrasings like "off-by-one", "ends one past the limit", or "slice goes too far" all qualify. The point is correct diagnosis, not specific wording.' },
    ],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      // `db.mjs` seeds 3 users: alice, bob, carol — enough for limit=2 to
      // discriminate (fixed: 2 items starting at alice; buggy: 3 items).
      { kind: 'run', cmd: 'node', args: ['scripts/probe-users.mjs', '1', '0'], cwd: 'worktree',
        expect: { exit: 0, stdout: /count=1 first=alice/ }, label: 'limit=1 offset=0 → 1 item starting at alice' },
      { kind: 'run', cmd: 'node', args: ['scripts/probe-users.mjs', '2', '0'], cwd: 'worktree',
        expect: { exit: 0, stdout: /count=2 first=alice/ }, label: 'limit=2 offset=0 → 2 items' },
      { kind: 'run', cmd: 'node', args: ['scripts/probe-users.mjs', '1', '1'], cwd: 'worktree',
        expect: { exit: 0, stdout: /count=1 first=bob/ }, label: 'limit=1 offset=1 → 1 item starting at bob' },
      { kind: 'run', cmd: 'node', args: ['scripts/probe-users.mjs', '10', '0'], cwd: 'worktree',
        expect: { exit: 0, stdout: /count=3/ }, label: 'limit=10 over 3 users → 3 items (no over-slice)' },
    ],
  },
};

export const BF_INGEST_EMPTY: EvalCase = {
  id: 'BF-07-ingest-empty',
  category: 'bug-fix',
  summary: 'ingest crashes on empty CSV; doc says empty-in → empty-out, exit 0.',
  fixture: { codebase: 'cb-etl', doc: 'doc-etl.md' },
  comment: {
    quote: 'tolerates empty input (empty in ⇒ empty out, exit 0)',
    body: 'If you hand `ingest` an empty CSV, the pipeline currently crashes. The doc says empty input should yield an empty output with exit 0. Fix the code.',
  },
  expect: {
    // The "non-empty path unchanged" claim is best verified by behavior,
    // not phrasing in the reply. Reply just needs to identify the fix.
    reply: [{ kind: 'judge', target: 'reply', rubric: 'Reply names the empty-input crash and confirms it was fixed.' }],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'run', cmd: 'node', args: ['scripts/probe-ingest.mjs'], cwd: 'worktree',
        expect: { exit: 0, stdout: /rows=0/ }, label: 'empty CSV → rows=0, exit 0' },
      { kind: 'run', cmd: 'node', args: ['-e', "import('./src/ingest.mjs').then(m => { const rows = m.ingest('id,email\\n1,a@x\\n2,b@x'); console.log(`rows=${rows.length}`); });"], cwd: 'worktree',
        expect: { exit: 0, stdout: /rows=2/ }, label: 'non-empty CSV still produces rows (regression check)' },
    ],
  },
};

/**
 * Undocumented bug: `deploy` emits a stray tab in front of its output line.
 * The doc is silent about this — it's a real-world "fix code; don't touch
 * the doc because it never made a claim either way" case.
 */
export const BF_DEPLOY_WHITESPACE: EvalCase = {
  id: 'BF-08-deploy-whitespace',
  category: 'bug-fix',
  summary: 'deploy prints its output with a stray leading tab; doc is silent. Clean the code.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  comment: {
    body: "`cb-cli deploy --env prod` prints `\\tdeploying to prod` — there's an unwanted leading tab before `deploying`. Clean it up. The doc doesn't claim anything specific about whitespace, so don't touch the doc.",
  },
  expect: {
    reply: [
      { kind: 'length', on: 'reply', min: 1 },
    ],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'run', cmd: 'node', args: ['src/cli.mjs', 'deploy', '--env', 'prod'], cwd: 'worktree',
        expect: { exit: 0, stdout: /^deploying to prod/m }, label: 'no leading whitespace in deploy output' },
      { kind: 'file-contains', path: 'src/commands/deploy.mjs', pattern: /\\t|\tdeploying/, match: false, label: 'source no longer prefixes a tab (escape sequence or raw)' },
    ],
  },
};
