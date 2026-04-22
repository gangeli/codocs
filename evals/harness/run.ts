#!/usr/bin/env node
/**
 * `npx tsx evals/harness/run.ts` — run the full eval suite.
 *
 * Usage:
 *   make eval                          # everything
 *   make eval FILTER=BF-01             # one case
 *   make eval FILTER=bug-fix           # one category (prefix-match on id OR category)
 *   CONCURRENCY=1 make eval            # serialize (default 2)
 *   DEBUG_KEEP_TMP=1 make eval         # keep temp dirs for post-mortem
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import type { EvalCase, CaseResult, Category, RunSummary } from '../types.js';
import { runCase } from './run-case.js';

const execFile = promisify(execFileCb);
const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(HERE, '..', 'cases');
const RUNS_DIR = join(HERE, '..', 'runs');

async function loadAllCases(): Promise<EvalCase[]> {
  const files = [
    'doc-only.eval.ts',
    'bug-fix.eval.ts',
    'feature.eval.ts',
    'qa.eval.ts',
    'ambiguous.eval.ts',
    'followup.eval.ts',
    'edge.eval.ts',
    'safety.eval.ts',
  ];
  const all: EvalCase[] = [];
  for (const f of files) {
    const mod = await import(join(CASES_DIR, f));
    const exported = Object.values(mod).filter(
      (v): v is EvalCase => !!v && typeof v === 'object' && 'id' in (v as object) && 'expect' in (v as object),
    );
    all.push(...exported);
  }
  return all;
}

function parseArgs(argv: string[]): { filter?: string; concurrency: number } {
  let filter: string | undefined;
  let concurrency = 2;
  for (const a of argv) {
    if (a.startsWith('--filter=')) filter = a.slice('--filter='.length);
    else if (a.startsWith('--concurrency=')) concurrency = Math.max(1, Number(a.slice('--concurrency='.length)));
  }
  return { filter, concurrency };
}

async function runInPool<T, R>(items: T[], concurrency: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const mine = i;
      i += 1;
      if (mine >= items.length) return;
      results[mine] = await fn(items[mine]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function preflight(): Promise<void> {
  try {
    await execFile('claude', ['--version']);
  } catch {
    console.error('claude CLI not on PATH — required to run eval cases.');
    process.exit(2);
  }
  try {
    await execFile('git', ['--version']);
  } catch {
    console.error('git not on PATH — required.');
    process.exit(2);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set — required for judge calls.');
    process.exit(2);
  }
}

function formatResult(r: CaseResult): string {
  const status = r.passed ? '✅' : '❌';
  const axis = (name: string, checks: CaseResult['axes']['reply']) => {
    const pass = checks.filter((c) => c.passed).length;
    return `${name} ${pass}/${checks.length}`;
  };
  const axes = [axis('reply', r.axes.reply), axis('doc', r.axes.doc), axis('code', r.axes.code)].join('  ');
  const ms = `${(r.durationMs / 1000).toFixed(1)}s`;
  return `${status} ${r.caseId.padEnd(24)} ${axes.padEnd(36)} ${ms}`;
}

function printReport(results: CaseResult[]): void {
  console.log('');
  console.log('──────────── per-case ────────────');
  for (const r of results) console.log(formatResult(r));

  const byCat = new Map<Category, { total: number; passed: number }>();
  for (const r of results) {
    const b = byCat.get(r.category) ?? { total: 0, passed: 0 };
    b.total += 1;
    if (r.passed) b.passed += 1;
    byCat.set(r.category, b);
  }

  console.log('\n──────────── by category ────────────');
  for (const [cat, { total, passed }] of byCat) {
    const pct = total === 0 ? 0 : Math.round((100 * passed) / total);
    console.log(`  ${cat.padEnd(12)} ${passed}/${total}  (${pct}%)`);
  }

  const totalPassed = results.filter((r) => r.passed).length;
  const pct = results.length === 0 ? 0 : Math.round((100 * totalPassed) / results.length);
  console.log(`\n  TOTAL        ${totalPassed}/${results.length}  (${pct}%)`);

  console.log('\n──────────── failures ────────────');
  for (const r of results) {
    if (r.passed) continue;
    console.log(`\n${r.caseId} — ${r.summary}`);
    if (r.error) console.log(`  error: ${r.error}`);
    for (const axisName of ['reply', 'doc', 'code'] as const) {
      for (const c of r.axes[axisName]) {
        if (c.passed) continue;
        const label = (c.check as { label?: string }).label ?? c.check.kind;
        console.log(`  [${axisName}] ${label}: ${c.detail}`);
      }
    }
  }
}

async function writeArtifacts(results: CaseResult[]): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(RUNS_DIR, timestamp);
  await mkdir(dir, { recursive: true });
  const summary: RunSummary = {
    startedAt: timestamp,
    finishedAt: new Date().toISOString(),
    totalCases: results.length,
    passedCases: results.filter((r) => r.passed).length,
    byCategory: {} as RunSummary['byCategory'],
    cases: results,
  };
  for (const r of results) {
    const b = summary.byCategory[r.category] ?? { total: 0, passed: 0 };
    b.total += 1;
    if (r.passed) b.passed += 1;
    summary.byCategory[r.category] = b;
  }
  await writeFile(
    join(dir, 'summary.json'),
    JSON.stringify(summary, null, 2).replace(/"check":\s*\{[^}]*\}/g, (m) => m.replace(/\s+/g, ' ')),
    'utf-8',
  );
  return dir;
}

async function main(): Promise<void> {
  await preflight();

  const { filter, concurrency } = parseArgs(process.argv.slice(2));
  const all = await loadAllCases();
  const selected = filter
    ? all.filter((c) => c.id.toLowerCase().includes(filter.toLowerCase()) || c.category === filter)
    : all;

  if (selected.length === 0) {
    console.error(`no matching cases (filter=${filter ?? '—'}, total=${all.length})`);
    process.exit(2);
  }

  console.log(`Running ${selected.length}/${all.length} eval case(s), concurrency=${concurrency}\n`);

  const results = await runInPool(selected, concurrency, async (tc) => {
    console.log(`▶ ${tc.id} — ${tc.summary}`);
    return runCase(tc, {});
  });

  printReport(results);
  const artifactsDir = await writeArtifacts(results);
  console.log(`\nArtifacts: ${artifactsDir}`);

  const allPassed = results.every((r) => r.passed);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
