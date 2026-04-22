/**
 * Doc-only cases.
 *
 * Each case edits the document and MUST NOT touch the code. The whole
 * point of the mirror invariant is that prose work has no code side
 * effect; if the agent changes code here it's a regression.
 */
import type { EvalCase } from '../types.js';

export const DO_TYPO_FIX: EvalCase = {
  id: 'DO-01-typo-fix',
  category: 'doc-only',
  summary: 'Fix a typo in a prose section without touching code.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: 'plaintext today',
    body: "There's a typo in the word 'authentification' somewhere in this doc — it should be 'authentication'. Fix it in place; don't reword anything else.",
  },
  expect: {
    reply: [
      { kind: 'length', on: 'reply', max: 600, label: 'reply is short' },
      { kind: 'judge', target: 'reply', rubric: 'Reply briefly confirms the typo was fixed. Does not claim to have made code changes.' },
    ],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /authentification/, match: false, label: 'typo removed' },
      { kind: 'regex', on: 'doc', pattern: /plaintext today/, match: true, label: 'unrelated text preserved' },
    ],
    code: [
      { kind: 'git', assert: 'no-new-commits', label: 'no code commits' },
      { kind: 'batch-update-count', equals: 1, label: 'doc was updated' },
    ],
  },
};

export const DO_EXPAND_SECTION: EvalCase = {
  id: 'DO-02-expand-section',
  category: 'doc-only',
  summary: 'Expand the Rate Limiting section with a 3-part plan.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: '## Rate Limiting (TBD)',
    body: 'Expand this section into a ~3-paragraph plan covering (1) per-IP limits, (2) per-user limits, and (3) the storage backend for the counters. Keep it prose, no bullets.',
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply names that Rate Limiting was expanded; does not claim code changes.' },
    ],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /per-?IP/i, match: true },
      { kind: 'regex', on: 'doc', pattern: /per-?user/i, match: true },
      { kind: 'judge', target: 'doc', rubric: 'The "Rate Limiting" section is substantially longer than before and discusses per-IP, per-user, and a storage backend.' },
    ],
    code: [
      { kind: 'git', assert: 'no-new-commits' },
    ],
  },
};

export const DO_ADD_SECTION: EvalCase = {
  id: 'DO-03-add-section',
  category: 'doc-only',
  summary: 'Insert a new H2 "Threat Model" section in a specific place.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: '## Data Model',
    body: "Add a new H2 section called 'Threat Model' that appears AFTER Data Model and BEFORE Rate Limiting. ~2 paragraphs on spoofing and credential stuffing.",
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Confirms the section was added in the requested position.' },
    ],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /##\s+Threat Model/, match: true, label: 'Threat Model heading present' },
      { kind: 'judge', target: 'doc', rubric: 'The new "Threat Model" H2 section appears AFTER the "Data Model" section and BEFORE the "Rate Limiting" section in the document order.' },
    ],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

export const DO_BULLETS_TO_PROSE: EvalCase = {
  id: 'DO-04-bullets-to-prose',
  category: 'doc-only',
  summary: 'Convert bullet-heavy meeting notes to tight prose, preserving information.',
  fixture: { codebase: 'cb-empty', doc: 'doc-scratch.md' },
  comment: {
    body: 'Convert this whole doc from bullets to tight prose. Preserve every piece of information; attribute actions to the right person. Do not delete any items.',
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Briefly confirms the conversion.' },
    ],
    doc: [
      { kind: 'judge', target: 'doc', rubric: 'The converted doc preserves every named person (alice, bob, carol) and every action item previously listed.', truth: 'Original contained: alice drafts rate-limiting RFC, bob audits /login, carol files typo tickets.' },
    ],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

export const DO_ADD_TABLE_ROW: EvalCase = {
  id: 'DO-05-add-table-row',
  category: 'doc-only',
  summary: 'Add a new row to the Commands table, preserving structure.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  comment: {
    quote: '| Command | Behavior |',
    body: 'Add a new row to the Commands table for `cb-cli status` — prints a one-line summary of auth + queue state. Keep the existing rows unchanged and the column shape intact. Do NOT implement the command itself; this is a doc-only change describing a future command.',
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply confirms the table row was added. Does not claim to have implemented the `status` subcommand.' },
    ],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /\|\s*`?cb-cli status`?\s*\|/, match: true, label: 'status row present' },
      { kind: 'judge', target: 'doc', rubric: 'The Commands table is still a well-formed markdown table (same column count as before) and existing rows are intact.' },
    ],
    code: [{ kind: 'git', assert: 'no-new-commits', label: 'no code changes' }],
  },
};

export const DO_SHORTEN: EvalCase = {
  id: 'DO-06-shorten-section',
  category: 'doc-only',
  summary: 'Shorten the Overview to ~half its length, preserving all named components.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: '## Overview',
    body: 'Shorten this Overview section by roughly half while preserving every named component and the overall meaning.',
  },
  expect: {
    reply: [{ kind: 'judge', target: 'reply', rubric: 'Reply briefly confirms the shortening.' }],
    doc: [
      { kind: 'judge', target: 'doc', rubric: 'The Overview section is noticeably shorter than before (roughly half the length) but still mentions the HTTP service, login, and paginated listing.' },
    ],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

export const DO_FILL_TBD: EvalCase = {
  id: 'DO-07-fill-tbd-with-numbers',
  category: 'doc-only',
  summary: 'Replace a TBD with concrete placeholder numbers.',
  fixture: { codebase: 'cb-etl', doc: 'doc-etl.md' },
  comment: {
    quote: '## Performance Targets',
    body: 'Fill in this section with concrete placeholder numbers for p99 latency, throughput (rows/sec), and memory ceiling (MB). Note that these are targets, not measurements.',
  },
  expect: {
    reply: [{ kind: 'judge', target: 'reply', rubric: 'Reply confirms that concrete numbers were added for p99 latency, throughput, and memory. (The reply does not need to use the word "placeholder" verbatim — merely reporting what was added is enough.)' }],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /\bTBD\b/, match: false, label: 'TBD removed' },
      { kind: 'regex', on: 'doc', pattern: /p99|latency/i, match: true },
      { kind: 'regex', on: 'doc', pattern: /\d+\s*(ms|rows\/s|rows\/sec|MB|rows)/i, match: true, label: 'latency placeholder present' },
      { kind: 'regex', on: 'doc', pattern: /\d+\s*(rows\/s|rows\/sec|r\/s)/i, match: true, label: 'throughput placeholder present' },
      { kind: 'regex', on: 'doc', pattern: /\d+\s*(MB|GB|KB)/i, match: true, label: 'memory placeholder present' },
      { kind: 'judge', target: 'doc', rubric: 'The Performance Targets section is clear these are targets/placeholders, not measured values. Honest language about their provisional nature is required.' },
    ],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

export const DO_CROSS_REF: EvalCase = {
  id: 'DO-08-cross-ref',
  category: 'doc-only',
  summary: 'Add a markdown cross-reference to another section in the same doc.',
  fixture: { codebase: 'cb-etl', doc: 'doc-etl.md' },
  comment: {
    quote: '## Failure Modes',
    body: 'Add an in-doc cross-reference to the Schema section where relevant. Use standard markdown link syntax.',
  },
  expect: {
    reply: [{ kind: 'judge', target: 'reply', rubric: 'Reply briefly confirms the link was added.' }],
    doc: [
      { kind: 'regex', on: 'doc', pattern: /\[[^\]]+\]\(#schema\)/i, match: true, label: 'markdown anchor link to #schema' },
    ],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

export const DO_STRIKE_SHIPPED: EvalCase = {
  id: 'DO-09-strike-shipped',
  category: 'doc-only',
  summary: 'Strikethrough Future Work items already shipped per current code.',
  fixture: { codebase: 'cb-cli', doc: 'doc-cli.md' },
  comment: {
    quote: '## Future Work',
    body: "For each item under Future Work, strikethrough (with markdown `~~...~~`) the ones that are already shipped in the current repo, and leave the rest alone. If none of them are shipped, say so and don't modify the doc.",
  },
  expect: {
    reply: [
      { kind: 'judge', target: 'reply', rubric: 'Reply states explicitly which items (if any) were struck through and WHY, grounded in what actually exists in the repo.', truth: 'None of the Future Work items — doctor subcommand, bash/zsh completion, bun --compile binaries — are actually shipped in cb-cli. The correct answer is to not strike any of them and say so.' },
    ],
    doc: [
      { kind: 'judge', target: 'doc', rubric: 'Either (a) no items were struck through and the section is unchanged, OR (b) items struck through are ones that genuinely exist in the repo. Hallucinated strikes are failures.' },
    ],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};

export const DO_TENSE: EvalCase = {
  id: 'DO-10-tense-correction',
  category: 'doc-only',
  summary: 'Reword the Data Model section to use present tense.',
  fixture: { codebase: 'cb-auth', doc: 'doc-auth.md' },
  comment: {
    quote: '## Data Model',
    body: 'Reword this section so every verb is in the simple present tense. Keep the meaning identical.',
  },
  expect: {
    reply: [{ kind: 'judge', target: 'reply', rubric: 'Briefly confirms the tense edit.' }],
    doc: [
      { kind: 'judge', target: 'doc', rubric: 'The Data Model section is all in present tense and preserves the original meaning.' },
    ],
    code: [{ kind: 'git', assert: 'no-new-commits' }],
  },
};
