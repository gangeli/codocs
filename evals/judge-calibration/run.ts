#!/usr/bin/env node
/**
 * Run the judge-calibration suite.
 *
 *   make eval/judge                          # everything, 3 samples each (default)
 *   make eval/judge FILTER=negation          # one group
 *   make eval/judge SAMPLES=5                # bump samples per case
 *
 * Each sample is one batchJudge call covering all selected cases at once;
 * the system-prompt cache makes follow-up samples cheap. A case is
 * STABLE-OK only if every sample matches the expected verdict — a
 * mismatched run anywhere in the sample window is a calibration failure.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { batchJudge, type JudgeItem, type JudgeVerdict } from '../harness/judge.js';
import { CASES, type CalibrationCase } from './cases.js';

const execFile = promisify(execFileCb);
const DEFAULT_SAMPLES = 3;

async function preflight(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set — required to run the judge suite.');
    process.exit(2);
  }
  try {
    await execFile('node', ['-v']);
  } catch { /* unreachable */ }
}

function parseArgs(argv: string[]): { filter?: string; samples: number } {
  let filter: string | undefined;
  let samples = DEFAULT_SAMPLES;
  for (const a of argv) {
    if (a.startsWith('--filter=')) filter = a.slice('--filter='.length);
    else if (a.startsWith('--samples=')) samples = Math.max(1, Number(a.slice('--samples='.length)));
  }
  return { filter, samples };
}

interface CalResult {
  case: CalibrationCase;
  /** Per-sample verdicts, in run order. */
  runs: JudgeVerdict[];
  /** Per-sample correctness flags, parallel to runs. */
  matches: boolean[];
  /** All samples matched expected. */
  stableOk: boolean;
  /** Some samples matched and some didn't. */
  flaky: boolean;
}

async function main(): Promise<void> {
  await preflight();

  const { filter, samples } = parseArgs(process.argv.slice(2));
  const selected: CalibrationCase[] = filter
    ? CASES.filter((c) => c.id.toLowerCase().includes(filter.toLowerCase()) || c.group === filter)
    : CASES;

  if (selected.length === 0) {
    console.error(`no calibration cases matched filter=${filter}`);
    process.exit(2);
  }

  console.log(`Calibrating judge against ${selected.length}/${CASES.length} case(s), ${samples} sample(s) each\n`);

  const items: JudgeItem[] = selected.map((c) => ({
    id: c.id, judge: c.judge, artifact: c.artifact,
  }));

  const t0 = Date.now();
  // Parallel samples — cache makes each subsequent run nearly free.
  const allRuns = await Promise.all(
    Array.from({ length: samples }, () => batchJudge(items)),
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const results: CalResult[] = selected.map((c) => {
    const runs = allRuns.map((r) => r[c.id] ?? { pass: false, reason: 'judge omitted' });
    const matches = runs.map((r) => r.pass === c.expected);
    const stableOk = matches.every((m) => m);
    const stableWrong = matches.every((m) => !m);
    const flaky = !stableOk && !stableWrong;
    return { case: c, runs, matches, stableOk, flaky };
  });

  console.log('──────────── per-case ────────────');
  for (const r of results) {
    const dots = r.matches.map((m) => (m ? '✓' : '✗')).join('');
    const status = r.stableOk ? '✅' : r.flaky ? '🔀' : '❌';
    const exp = r.case.expected ? 'pass' : 'fail';
    const matchedCount = r.matches.filter(Boolean).length;
    console.log(
      `${status} ${r.case.id.padEnd(6)} [${r.case.group.padEnd(14)}] expected=${exp}  ${dots}  ${matchedCount}/${samples}`,
    );
    if (!r.stableOk) {
      console.log(`    why: ${r.case.why}`);
      r.runs.forEach((run, i) => {
        const tag = r.matches[i] ? '✓' : '✗';
        console.log(`    [${i + 1}/${samples} ${tag}] pass=${run.pass}  reason: ${run.reason}`);
      });
    }
  }

  // Per-group summary buckets.
  const byGroup = new Map<string, { total: number; stableOk: number; flaky: number; stableWrong: number }>();
  for (const r of results) {
    const b = byGroup.get(r.case.group) ?? { total: 0, stableOk: 0, flaky: 0, stableWrong: 0 };
    b.total += 1;
    if (r.stableOk) b.stableOk += 1;
    else if (r.flaky) b.flaky += 1;
    else b.stableWrong += 1;
    byGroup.set(r.case.group, b);
  }

  console.log('\n──────────── by group ────────────');
  console.log('  group           ok     flaky  wrong  total');
  for (const [group, b] of byGroup) {
    console.log(
      `  ${group.padEnd(14)}  ${String(b.stableOk).padStart(2)}    ${String(b.flaky).padStart(2)}    ${String(b.stableWrong).padStart(2)}     ${b.total}`,
    );
  }

  const totals = results.reduce(
    (acc, r) => {
      if (r.stableOk) acc.stableOk += 1;
      else if (r.flaky) acc.flaky += 1;
      else acc.stableWrong += 1;
      return acc;
    },
    { stableOk: 0, flaky: 0, stableWrong: 0 },
  );
  const okPct = Math.round((100 * totals.stableOk) / results.length);
  console.log(
    `\n  TOTAL           ${totals.stableOk}/${results.length} stable-ok (${okPct}%)  • ${totals.flaky} flaky • ${totals.stableWrong} stable-wrong    [${elapsed}s, ${samples} batched call(s)]`,
  );

  // Exit non-zero if anything is not stable-ok. Flaky counts as failure
  // because non-determinism in judging silently corrupts every real run.
  process.exit(totals.stableOk === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
