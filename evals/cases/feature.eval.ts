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
    reply: [{ kind: 'length', on: 'reply', min: 1 }],
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
    reply: [{ kind: 'length', on: 'reply', min: 1 }],
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
    reply: [{ kind: 'length', on: 'reply', min: 1 }],
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
    reply: [{ kind: 'length', on: 'reply', min: 1 }],
    doc: [
      { kind: 'judge', target: 'doc', rubric: 'The Stages section now mentions that each stage emits a structured log line.' },
    ],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'grep-count', path: 'scripts/run.mjs', pattern: /console\.log\(JSON\.stringify/, min: 3, label: 'one structured log call per stage (ingest, transform, load)' },
      // The user comment specified `{stage, event, ...}` shape — both keys
      // must appear at least once in run.mjs (single quote, double quote,
      // or unquoted property name all accepted).
      { kind: 'file-contains', path: 'scripts/run.mjs', pattern: /["']?stage["']?\s*:/, match: true, label: 'log payload includes a `stage` field' },
      { kind: 'file-contains', path: 'scripts/run.mjs', pattern: /["']?event["']?\s*:/, match: true, label: 'log payload includes an `event` field' },
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
    reply: [{ kind: 'length', on: 'reply', min: 1 }],
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

/**
 * Deletion symmetry — every other feature case ADDS; this REMOVES.
 * Tests whether the agent cleans both the code (file + dispatch) AND the
 * doc row. Partial removals (e.g., doc row gone but file lingers) fail.
 */
export const F_REMOVE_GREET: EvalCase = {
  id: 'F-09-remove-greet',
  category: 'feature',
  summary: 'Remove the `greet` command end-to-end: file, cli dispatch, doc row.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  comment: {
    quote: '| `cb-cli greet <name>` | Prints `Hello, <name>!` to stdout. |',
    body: "We're dropping the greet command entirely. Remove it from the CLI dispatch, delete the command file, and remove this row from the Commands table. After this change, `cb-cli greet alice` should be rejected like any other unknown command.",
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply confirms greet was removed end-to-end: dispatch, command file, AND doc row. Calling out at least two of the three is sufficient; silently saying only "removed greet" without naming what was touched is too thin.' },
    ],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /\|\s*`?cb-cli greet`?/, match: false, label: 'greet row gone from Commands table' },
    ],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'file-exists', path: 'src/commands/greet.mjs', expect: false, label: 'greet command file removed' },
      { kind: 'file-contains', path: 'src/cli.mjs', pattern: /['"]greet['"]|from\s+['"][^'"]*greet/, match: false, label: 'cli.mjs no longer references greet' },
      { kind: 'run', cmd: 'node', args: ['src/cli.mjs', 'greet', 'alice'], cwd: 'worktree',
        expect: { exit: 2 }, label: 'greet now rejected as unknown command' },
    ],
  },
};

/**
 * Test-writing case. The agent must produce an executable probe script
 * that asserts a documented behavior. Common failures: wrong file path,
 * wrong assertion shape, writing TDD-style tests without actually
 * verifying they pass. We deliberately pick limit=10 so BF-06's off-by-
 * one doesn't affect the test (only 3 users exist; both buggy and fixed
 * code return all 3 at limit=10).
 */
export const F_WRITE_TEST: EvalCase = {
  id: 'F-10-write-test-users-order',
  category: 'feature',
  summary: 'Author a probe script asserting GET /users insertion order.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: '`GET /users?limit=N&offset=K`',
    body: "Add a small test at `scripts/test-users.mjs` that starts the server on an ephemeral port, calls `GET /users?limit=10`, and asserts the response is exactly `['alice','bob','carol']` in that order. Exit 0 on success, non-zero (with a clear stderr message) on failure. Also add a short bullet in the Pagination section noting that the probe exists. Do not change the server code.",
  },
  expect: {
    reply: [
      // Negative intent claim — the agent must not falsely claim to have
      // changed src/ server code. (The actual src/ untouched-ness is
      // verified deterministically on the code axis below.)
      { kind: 'judge', target: 'reply', rubric: 'Reply does not claim to have changed src/ server code.' },
    ],
    doc: [
      { kind: 'judge', target: 'doc', rubric: 'The Pagination section mentions the new test / probe script. Other sections are untouched.' },
    ],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'file-exists', path: 'scripts/test-users.mjs', expect: true },
      // Baseline server code: must not touch handleUsers / listUsers.
      { kind: 'file-contains', path: 'src/server.mjs', pattern: /all\.slice\(offset, offset \+ limit \+ 1\)/, match: true, label: 'server.mjs handleUsers left untouched (bug preserved)' },
      { kind: 'run', cmd: 'node', args: ['scripts/test-users.mjs'], cwd: 'worktree',
        expect: { exit: 0 }, label: 'authored test passes' },
    ],
  },
};

/**
 * Deprecation: keep --port working, but emit a stderr warning when it's
 * used. Also document it. Common failures: (a) removes the flag instead
 * of warning, (b) prints the warning on every invocation (even without
 * --port), (c) forgets the doc update.
 */
export const F_DEPRECATE_PORT: EvalCase = {
  id: 'F-11-deprecate-port-flag',
  category: 'feature',
  summary: 'Mark --port deprecated: warn on stderr, keep it working, note in doc.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  comment: {
    quote: '`cb-cli serve [--port <port>]` | Starts the dev server. `--port` defaults to 3000.',
    body: "We're deprecating the `--port` flag. When a user passes `--port`, print a one-line deprecation warning to stderr (mention the word 'deprecated') but keep the flag functioning — `serve --port 9999` should still serve on 9999. Update this Commands row to flag it as deprecated.",
  },
  expect: {
    reply: [
      { kind: 'length', on: 'reply', min: 1 },
    ],
    doc: [
      { kind: 'judge', target: 'doc', rubric: 'The serve row in the Commands table notes that --port is deprecated (or similar wording like "deprecated — will be removed").' },
    ],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'run', cmd: 'node', args: ['src/cli.mjs', 'serve', '--port', '9999'], cwd: 'worktree',
        expect: { exit: 0, stdout: /serving on :9999/, stderr: /deprecat/i }, label: '--port still works AND warns on stderr' },
      // Without --port the warning must NOT fire — catches an agent that
      // unconditionally prints the deprecation banner.
      { kind: 'run', cmd: 'node', args: ['src/cli.mjs', 'serve'], cwd: 'worktree',
        expect: { exit: 0, stdout: /serving on :3000/, notStderr: /deprecat/i }, label: 'no warning when --port omitted' },
    ],
  },
};

/**
 * Schema evolution end-to-end: thread an optional `createdAt` field
 * through ingest → transform → load and update the Schema section.
 * Common failures: (a) transform drops the field because its current
 * implementation hardcodes `{id, email}`, (b) doc not updated, (c) the
 * agent touches only one stage and claims done.
 */
export const F_CREATEDAT: EvalCase = {
  id: 'F-12-createdat-field',
  category: 'feature',
  summary: 'Thread an optional `createdAt` field through the pipeline; document in Schema.',
  fixture: { codebase: 'cb-etl', doc: 'doc-etl.md' },
  comment: {
    quote: 'Output row: `{id: string, email: string}`.',
    body: "Add an optional `createdAt` field (string, ISO-8601-ish, empty string if missing) to the pipeline. It must flow through ingest → transform → load — the current transform hardcodes the output shape and will drop it unless you update it. Update this Schema section to include createdAt and note it's optional.",
  },
  expect: {
    reply: [
      { kind: 'length', on: 'reply', min: 1 },
    ],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /createdAt/, match: true, label: 'createdAt mentioned in doc' },
      { kind: 'judge', target: 'doc', rubric: 'The Schema section documents createdAt as a (string, optional) field in the output row.' },
    ],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'file-contains', path: 'src/transform.mjs', pattern: /createdAt/, match: true, label: 'transform propagates createdAt' },
      { kind: 'run', cmd: 'node', args: ['scripts/probe-createdat.mjs'], cwd: 'worktree',
        expect: { exit: 0, stdout: /rows=2 all_have_createdAt=true first_createdAt=2024-01-01/ }, label: 'createdAt survives the pipeline' },
    ],
  },
};

/**
 * Cross-file literal rename. The example username `alice` is the "good"
 * user in probe-login.mjs and the first key in db.mjs. A partial rename
 * breaks `probe-login --good`. Doc does not contain `alice`, so it should
 * remain byte-identical.
 */
export const F_RENAME_ALICE: EvalCase = {
  id: 'F-13-rename-alice-to-ada',
  category: 'feature',
  summary: 'Rename the example username `alice` to `ada` across code + probe scripts.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    body: "Rename the example username `alice` to `ada` everywhere it appears under src/ and scripts/ — that includes the db seed in src/db.mjs (key, password 'alicepw' → 'adapw'), and the probe scripts that hardcode 'alice' as the good user. After the rename, `node scripts/probe-login.mjs --good` must still return status=200. The doc does not name alice, so leave it alone.",
  },
  expect: {
    reply: [
      { kind: 'length', on: 'reply', min: 1 },
    ],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'worktree-grep', pathGlob: 'src/**/*', pattern: /\balice\b/i, match: false, label: 'no alice references under src/' },
      { kind: 'worktree-grep', pathGlob: 'scripts/**/*', pattern: /\balice\b/i, match: false, label: 'no alice references under scripts/' },
      { kind: 'file-contains', path: 'src/db.mjs', pattern: /['"]ada['"]/, match: true, label: 'db.mjs seeds ada' },
      { kind: 'run', cmd: 'node', args: ['scripts/probe-login.mjs', '--good'], cwd: 'worktree',
        expect: { exit: 0, stdout: /status=200/ }, label: 'good-login probe still succeeds after rename' },
    ],
  },
};

/**
 * Pure refactor. Must preserve (a) doc byte-identical and (b) observed
 * behavior. Extracts `readJsonBody` out of server.mjs into a new module.
 * An agent that "improves" the doc prose or changes semantics fails.
 */
export const F_REFACTOR_BODY: EvalCase = {
  id: 'F-14-refactor-body-parser',
  category: 'feature',
  summary: 'Extract readJsonBody into src/body.mjs. No behavior change; doc untouched.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: '## Authentication',
    body: 'Refactor only: extract the `readJsonBody` helper from src/server.mjs into a new module `src/body.mjs` and import it back. No behavior change — the probes must still produce identical output. Do not modify the doc; this is an internal code tidy-up.',
  },
  expect: {
    reply: [
      // Negative intent claim — refactor-only cases must not falsely claim
      // a doc change. (The actual doc-unchanged-ness is verified on the
      // doc axis below.)
      { kind: 'judge', target: 'reply', rubric: 'Reply does not falsely claim a doc change was made.' },
    ],
    doc: [{ kind: 'doc-unchanged' }, { kind: 'no-batch-update' }],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'file-exists', path: 'src/body.mjs', expect: true },
      { kind: 'file-contains', path: 'src/body.mjs', pattern: /readJsonBody/, match: true, label: 'readJsonBody lives in body.mjs' },
      { kind: 'file-contains', path: 'src/server.mjs', pattern: /from\s+['"]\.\/body\.mjs['"]/, match: true, label: 'server.mjs imports from body.mjs' },
      // Match `function readJsonBody`, `const/let readJsonBody = function`,
      // or `const/let readJsonBody = (...) =>` — server.mjs must not
      // re-define the helper alongside the import.
      { kind: 'file-contains', path: 'src/server.mjs', pattern: /function\s+readJsonBody|(?:const|let|var)\s+readJsonBody\s*=/, match: false, label: 'server.mjs no longer defines readJsonBody' },
      { kind: 'run', cmd: 'node', args: ['scripts/probe-login.mjs', '--good'], cwd: 'worktree',
        expect: { exit: 0, stdout: /status=200/ }, label: 'good login still works after refactor' },
      { kind: 'run', cmd: 'node', args: ['scripts/probe-users.mjs', '2', '0'], cwd: 'worktree',
        expect: { exit: 0, stdout: /count=3 first=alice/ }, label: 'users probe behavior byte-identical (bug preserved)' },
    ],
  },
};

/**
 * README synchronization — a multi-file doc-like change. The eval's
 * "doc" axis is the design doc; README.md is part of the codebase. An
 * agent that updates only one of the two fails.
 */
export const F_README_SYNC: EvalCase = {
  id: 'F-15-readme-sync',
  category: 'feature',
  summary: 'Add a `status` command to BOTH the doc Commands table AND README.md.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  comment: {
    quote: '## Commands',
    body: "We're going to add a `cb-cli status` subcommand (prints `ok`, exits 0). Wire it through cli.mjs and add a row to this Commands table AND a matching entry to README.md so the two stay in sync. Same wording in both.",
  },
  expect: {
    reply: [
      { kind: 'length', on: 'reply', min: 1 },
    ],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /\|\s*`?cb-cli status`?\s*\|/, match: true, label: 'status row in doc Commands table' },
    ],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      // README must mention the status command somewhere — format-agnostic
      // (bullet, table row, section, etc.). The judge below checks that
      // the entry is well-shaped; this regex just guards against an empty
      // README update.
      { kind: 'file-contains', path: 'README.md', pattern: /\bstatus\b/, match: true, label: 'README mentions status' },
      { kind: 'judge', target: 'diff', rubric: 'README.md gained an entry for the new `status` command alongside a description of what it does (prints `ok`). Any reasonable formatting is fine — bullet, table row, section, etc. — as long as the entry is non-empty and a reader could tell what status does. An entry that is just the word "status" with no description fails.' },
      { kind: 'run', cmd: 'node', args: ['src/cli.mjs', 'status'], cwd: 'worktree',
        expect: { exit: 0, stdout: /ok/ } },
    ],
  },
};

/**
 * Dependency-constrained feature. The agent must add id validation
 * without pulling in any new packages (package.json deps must stay
 * empty). Common failure: agent adds `zod` / `joi` / `ajv` "because it's
 * cleaner".
 */
export const F_STDLIB_ONLY: EvalCase = {
  id: 'F-16-stdlib-only-id-validation',
  category: 'feature',
  summary: 'Add id validation to transform using stdlib only — no new deps.',
  fixture: { codebase: 'cb-etl', doc: 'doc-etl.md' },
  comment: {
    quote: '## Schema',
    body: "Add validation to the transform stage: rows with an empty or missing `id` are dropped. Implement this with stdlib only — do NOT add any new runtime dependencies to package.json. Update the Schema section to note that rows with empty ids are dropped.",
  },
  expect: {
    // "No new deps" is verified deterministically on the code axis
    // (file-contains on package.json). Reply just confirms intent.
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply confirms id validation was added.' },
    ],
    doc: [
      { kind: 'judge', target: 'doc', rubric: 'The Schema section mentions that rows with empty/missing id are dropped in transform.' },
    ],
    code: [
      { kind: 'git', assert: 'branch-pushed' },
      { kind: 'file-contains', path: 'src/transform.mjs', pattern: /\brow\.id\b|\bid\b\s*(?:==|!=|===|!==|\?)/, match: true, label: 'transform references row.id' },
      // No `dependencies` object should appear in package.json (the
      // fixture ships with none). `devDependencies` are fine.
      { kind: 'file-contains', path: 'package.json', pattern: /"dependencies"\s*:\s*\{[^}]*"[^"]+"\s*:/, match: false, label: 'no runtime dependencies added to package.json' },
      // Runtime probe: rows with empty/missing id are dropped, valid rows
      // survive with their id intact. All emails are non-empty so this is
      // independent of BF-02's empty-email behavior.
      { kind: 'run', cmd: 'node', args: ['-e', "import('./src/transform.mjs').then(m => { const o = m.transform([{id:'1',email:'a@x'},{id:'',email:'b@x'},{email:'c@x'},{id:'2',email:'d@x'}]); console.log(`kept=${o.length} ids=${o.map(r=>r.id).join(',')}`); });"], cwd: 'worktree',
        expect: { exit: 0, stdout: /kept=2 ids=1,2/ }, label: 'empty/missing id rows dropped; valid ids survive' },
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
    reply: [{ kind: 'length', on: 'reply', min: 1 }],
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
