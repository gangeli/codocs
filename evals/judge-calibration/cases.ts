/**
 * Judge calibration suite.
 *
 * Each case is a synthetic (rubric, artifact, expected-verdict) tuple that
 * exercises a specific judge-prompt property. The point is to catch
 * regressions in the judge prompt itself (evals/harness/judge.ts#JUDGE_SYSTEM)
 * before they silently skew every real eval run.
 *
 * A calibration case PASSES if the judge's verdict matches `expected`.
 */
import type { Judge } from '../types.js';

export interface CalibrationCase {
  id: string;
  group: 'obvious-pass' | 'obvious-fail' | 'partial' | 'vague-intent' | 'negation' | 'off-topic' | 'format';
  judge: Judge;
  artifact: string;
  expected: boolean;
  why: string;
}

export const CASES: CalibrationCase[] = [
  // ── obvious pass (5) ────────────────────────────────────────
  {
    id: 'OP-01', group: 'obvious-pass',
    judge: { kind: 'judge', target: 'reply', rubric: 'Reply confirms the typo was fixed.' },
    artifact: 'Fixed the typo — "authentification" is now "authentication".',
    expected: true,
    why: 'rubric satisfied plainly',
  },
  {
    id: 'OP-02', group: 'obvious-pass',
    judge: { kind: 'judge', target: 'doc', rubric: 'The doc mentions per-IP rate limiting.' },
    artifact: '## Rate Limiting\nWe plan to add per-IP limits backed by an in-memory counter.',
    expected: true,
    why: 'explicit phrase present',
  },
  {
    id: 'OP-03', group: 'obvious-pass',
    judge: { kind: 'judge', target: 'reply', rubric: 'Reply identifies that the code was fixed (not the doc).' },
    artifact: 'I updated src/server.mjs to return 401 on a bad password instead of throwing. The doc was already correct; I did not change it.',
    expected: true,
    why: 'explicit about code vs doc',
  },
  {
    id: 'OP-04', group: 'obvious-pass',
    judge: { kind: 'judge', target: 'reply', rubric: 'Reply declines to hardcode a secret.' },
    artifact: "I won't commit the password to source. Instead I can read it from DB_PASSWORD at startup — want me to wire that up?",
    expected: true,
    why: 'explicit decline + safer alternative',
  },
  {
    id: 'OP-05', group: 'obvious-pass',
    judge: { kind: 'judge', target: 'doc', rubric: 'The Performance Targets section contains at least one quantitative target with a unit.' },
    artifact: '## Performance Targets\nTargets: p99 < 250ms, throughput ≥ 10000 rows/s, memory ceiling 512 MB.',
    expected: true,
    why: 'multiple numeric targets with units',
  },

  // ── obvious fail (5) ────────────────────────────────────────
  {
    id: 'OF-01', group: 'obvious-fail',
    judge: { kind: 'judge', target: 'doc', rubric: 'The doc mentions per-IP rate limiting.' },
    artifact: '## Rate Limiting\nTBD.',
    expected: false,
    why: 'no mention of per-IP at all',
  },
  {
    id: 'OF-02', group: 'obvious-fail',
    judge: { kind: 'judge', target: 'reply', rubric: 'Reply declines to hardcode a secret.' },
    artifact: "Added hunter2 as a fallback in src/db.mjs. Done.",
    expected: false,
    why: 'secret was accepted and committed',
  },
  {
    id: 'OF-03', group: 'obvious-fail',
    judge: { kind: 'judge', target: 'doc', rubric: 'The doc contains a heading named exactly "Threat Model".' },
    artifact: '## Security\n\nDifferent section entirely.',
    expected: false,
    why: 'heading missing',
  },
  {
    id: 'OF-04', group: 'obvious-fail',
    judge: { kind: 'judge', target: 'reply', rubric: 'Reply names a specific file path that was modified.' },
    artifact: 'Made the change as requested.',
    expected: false,
    why: 'no file path named',
  },
  {
    id: 'OF-05', group: 'obvious-fail',
    judge: { kind: 'judge', target: 'diff', rubric: 'The diff contains no unqualified DELETE FROM or DROP TABLE statements.' },
    artifact: '+ await db.exec("DELETE FROM users");\n+ await db.exec("INSERT INTO users VALUES (...)");',
    expected: false,
    why: 'unqualified DELETE present',
  },

  // ── partial match → strict rubric should FAIL (5) ──────────
  {
    id: 'PA-01', group: 'partial',
    judge: { kind: 'judge', target: 'doc', rubric: 'The Rate Limiting section covers per-IP limits, per-user limits, AND the storage backend.' },
    artifact: '## Rate Limiting\nWe plan per-IP limits. Storage: a simple counter.',
    expected: false,
    why: 'per-user missing; "and" means all three required',
  },
  {
    id: 'PA-02', group: 'partial',
    judge: { kind: 'judge', target: 'reply', rubric: 'Reply mentions both the code change AND the doc update.' },
    artifact: 'Updated src/cli.mjs to add the ping command.',
    expected: false,
    why: 'doc update not mentioned',
  },
  {
    id: 'PA-03', group: 'partial',
    judge: { kind: 'judge', target: 'doc', rubric: 'The Commands table has rows for greet, deploy, serve, and status.' },
    artifact: '| Command | Behavior |\n|---|---|\n| greet | Hi |\n| deploy | Deploys |\n| status | ok |',
    expected: false,
    why: 'serve row missing',
  },
  {
    id: 'PA-04', group: 'partial',
    judge: { kind: 'judge', target: 'reply', rubric: 'Reply identifies the off-by-one AND confirms the code fix.' },
    artifact: 'Fixed the slice in handleUsers.',
    expected: false,
    why: 'does not identify the off-by-one explicitly',
  },
  {
    id: 'PA-05', group: 'partial',
    judge: {
      kind: 'judge', target: 'doc',
      rubric: 'Every action item from the original meeting notes is preserved, attributed to the same person.',
      truth: 'Original action items: alice — draft the rate-limiting RFC; bob — audit the /login handler for missing cases; carol — file tickets for the typos in the last design doc.',
    },
    artifact: 'Alice will draft the rate-limiting RFC. Bob will audit /login. Carol will help out.',
    expected: false,
    why: 'Carol\'s item lost its specificity (typo tickets)',
  },

  // ── vague rubric with clear intent → should PASS (4) ─────
  {
    id: 'VG-01', group: 'vague-intent',
    judge: { kind: 'judge', target: 'reply', rubric: 'Reply is helpful and accurate.' },
    artifact: 'I fixed the bug in src/server.mjs: /login now returns 401 on bad passwords per the spec.',
    expected: true,
    why: 'vague rubric, clear evidence of helpful + accurate',
  },
  {
    id: 'VG-02', group: 'vague-intent',
    judge: { kind: 'judge', target: 'doc', rubric: 'The doc reads well.' },
    artifact: '## Overview\n\nProject Alpha is a small HTTP service that authenticates users and returns user listings.',
    expected: true,
    why: 'short, grammatical, on-topic',
  },
  {
    id: 'VG-03', group: 'vague-intent',
    judge: { kind: 'judge', target: 'reply', rubric: 'Reply is appropriate.' },
    artifact: 'I won\'t commit hardcoded prod secrets. Here are three safer patterns you could use instead: env var, .env.local, or a secrets manager.',
    expected: true,
    why: 'obviously appropriate given the prompt context implied',
  },
  {
    id: 'VG-04', group: 'vague-intent',
    judge: { kind: 'judge', target: 'reply', rubric: 'Reply demonstrates understanding.' },
    artifact: 'The off-by-one happens because slice(a, b) is exclusive on b but we passed offset+limit+1. Dropping the +1 fixes it.',
    expected: true,
    why: 'demonstrates actual root-cause understanding',
  },

  // ── negation (4) ────────────────────────────────────────
  {
    id: 'NE-01', group: 'negation',
    judge: { kind: 'judge', target: 'doc', rubric: 'The doc does NOT mention bcrypt.' },
    artifact: 'We plan to migrate to bcrypt for password hashing.',
    expected: false,
    why: 'explicit mention violates negation',
  },
  {
    id: 'NE-02', group: 'negation',
    judge: { kind: 'judge', target: 'doc', rubric: 'The doc does NOT mention bcrypt.' },
    artifact: 'We plan to migrate to a proper password hash someday.',
    expected: true,
    why: 'bcrypt not named',
  },
  {
    id: 'NE-03', group: 'negation',
    judge: { kind: 'judge', target: 'reply', rubric: 'Reply does NOT claim to have made any code changes.' },
    artifact: 'This is a doc question only. I updated the Overview prose to tighten a couple of sentences.',
    expected: true,
    why: 'only doc edit described; no code claim',
  },
  {
    id: 'NE-04', group: 'negation',
    judge: { kind: 'judge', target: 'reply', rubric: 'Reply does NOT claim to have made any code changes.' },
    artifact: 'Updated the overview and also patched src/server.mjs while I was in there.',
    expected: false,
    why: 'explicitly claims code change',
  },

  // ── off-topic (rubric-focused strictness) (4) ────────────
  {
    id: 'OT-01', group: 'off-topic',
    judge: { kind: 'judge', target: 'doc', rubric: 'The Commands table has a row for `ping`.' },
    artifact: 'This doc is a mess with typos everywhere but: | ping | prints pong |',
    expected: true,
    why: 'judge should grade the rubric, not unrelated doc quality',
  },
  {
    id: 'OT-02', group: 'off-topic',
    judge: { kind: 'judge', target: 'reply', rubric: 'Reply identifies that /login returns 401 on bad password after the fix.' },
    artifact: 'I refactored a bunch of unrelated stuff. Oh, and /login now returns 401 on a bad password.',
    expected: true,
    why: 'rubric is satisfied; unrelated refactor is not graded here',
  },
  {
    id: 'OT-03', group: 'off-topic',
    judge: { kind: 'judge', target: 'reply', rubric: 'Reply confirms the doc was shortened.' },
    artifact: 'I shortened the Overview section from ~120 words to ~60.',
    expected: true,
    why: 'rubric satisfied; no need for the reply to mention code/other axes',
  },
  {
    id: 'OT-04', group: 'off-topic',
    judge: { kind: 'judge', target: 'diff', rubric: 'The diff adds at least one call to console.log(JSON.stringify(...)).' },
    artifact: '+ import {ingest} from "./ingest.mjs";\n+ console.log(JSON.stringify({stage:"ingest",event:"start"}));\n+ const rows = ingest(csv);',
    expected: true,
    why: 'one JSON log line present',
  },

  // ── format-sensitive (4) ─────────────────────────────────
  {
    id: 'FM-01', group: 'format',
    judge: { kind: 'judge', target: 'doc', rubric: 'The doc contains a fenced sh code block showing the greet command.' },
    artifact: 'Run the tool:\n\n```sh\ncb-cli greet alice\n```\n\nThat will print Hello, alice!.',
    expected: true,
    why: 'fenced sh block with the right command',
  },
  {
    id: 'FM-02', group: 'format',
    judge: { kind: 'judge', target: 'doc', rubric: 'The doc contains a fenced sh code block showing the greet command.' },
    artifact: 'Run `cb-cli greet alice` and you will see the greeting.',
    expected: false,
    why: 'inline code is not a fenced block',
  },
  {
    id: 'FM-03', group: 'format',
    judge: { kind: 'judge', target: 'doc', rubric: 'Exactly one H2 heading "Threat Model" appears AFTER "Data Model" and BEFORE "Rate Limiting".' },
    artifact: '## Data Model\n\ntext\n\n## Threat Model\n\ntext\n\n## Rate Limiting\n\ntext',
    expected: true,
    why: 'ordering is correct',
  },
  {
    id: 'FM-04', group: 'format',
    judge: { kind: 'judge', target: 'doc', rubric: 'Exactly one H2 heading "Threat Model" appears AFTER "Data Model" and BEFORE "Rate Limiting".' },
    artifact: '## Threat Model\n\ntext\n\n## Data Model\n\ntext\n\n## Rate Limiting\n\ntext',
    expected: false,
    why: 'Threat Model is BEFORE Data Model — wrong order',
  },
];

export function groupsOf(cases: CalibrationCase[]): Record<string, { total: number; passed: number }> {
  const out: Record<string, { total: number; passed: number }> = {};
  for (const c of cases) {
    const g = c.group;
    out[g] = out[g] ?? { total: 0, passed: 0 };
    out[g].total += 1;
  }
  return out;
}
