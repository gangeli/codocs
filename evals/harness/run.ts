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

// ── Tiny ANSI color helpers ───────────────────────────────────────
const TTY = process.stdout.isTTY ?? false;
const c = (code: string, s: string): string => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string): string => c('32', s);
const red = (s: string): string => c('31', s);
const yellow = (s: string): string => c('33', s);
const cyan = (s: string): string => c('36', s);
const dim = (s: string): string => c('2', s);
const bold = (s: string): string => c('1', s);

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visibleLength = (s: string): number => s.replace(ANSI_RE, '').length;
const padEndV = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - visibleLength(s)));
const padStartV = (s: string, n: number): string => ' '.repeat(Math.max(0, n - visibleLength(s))) + s;

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

function parseArgs(argv: string[]): { filter?: string; concurrency: number; model?: string; repeats: number } {
  let filter: string | undefined;
  let model: string | undefined;
  let concurrency = 2;
  let repeats = 1;
  for (const a of argv) {
    if (a.startsWith('--filter=')) filter = a.slice('--filter='.length);
    else if (a.startsWith('--concurrency=')) concurrency = Math.max(1, Number(a.slice('--concurrency='.length)));
    else if (a.startsWith('--model=')) model = a.slice('--model='.length);
    else if (a.startsWith('--repeats=')) repeats = Math.max(1, Number(a.slice('--repeats='.length)));
  }
  return { filter, concurrency, model, repeats };
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

/**
 * Live progress tracker with a sticky 3-line status block at the bottom of
 * the terminal. Log lines scroll above the block; the block redraws every
 * 500ms showing total progress, pass/fail counts, elapsed, and the set of
 * cases currently in flight (pnpm-style).
 *
 * Implementation: we reserve `stickyHeight` blank lines at construction so
 * the cursor sits BELOW the sticky region. Every write becomes a single
 * atomic stdout.write of the form:
 *     \x1b[<N>A     ← move up to top of sticky region
 *     \x1b[J        ← clear from cursor to end of screen
 *     <optional log line>\n
 *     <rendered sticky block>
 * Single atomic writes matter because a 500ms redraw timer and concurrent
 * worker completions can otherwise interleave and corrupt the output.
 *
 * Non-TTY (piped/CI): all the fancy stuff is bypassed; log lines stream
 * plainly with no sticky block and no timer.
 */
class LiveTracker {
  private completed = 0;
  private passed = 0;
  private failed = 0;
  private inFlight: EvalCase[] = [];
  private startTime = Date.now();
  /** Height of the sticky block actually drawn last — variable because the
   * "running" section grows one line per in-flight case. */
  private lastStickyHeight = 0;
  private timer?: NodeJS.Timeout;

  constructor(private total: number) {
    if (TTY) {
      // Seed an empty sticky block so subsequent redraws have something to
      // move up over. The initial block is just the progress line (no running
      // cases yet), so 2 lines: divider + progress.
      this.writeSticky();
      this.timer = setInterval(() => this.writeSticky(), 500);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (TTY && this.lastStickyHeight > 0) {
      // Erase the sticky block so the final report starts on a clean line.
      process.stdout.write(`\x1b[${this.lastStickyHeight}A\x1b[J`);
      this.lastStickyHeight = 0;
    }
  }

  start(tc: EvalCase): void {
    this.inFlight.push(tc);
    if (TTY) this.writeSticky();
  }

  complete(r: CaseResult): void {
    const idx = this.inFlight.findIndex((c) => c.id === r.caseId);
    if (idx >= 0) this.inFlight.splice(idx, 1);
    this.completed += 1;
    if (r.passed) this.passed += 1;
    else this.failed += 1;
    this.writeLog(formatCompletion(r, this.completed, this.total));
  }

  private writeLog(line: string): void {
    if (!TTY) {
      console.log(line);
      return;
    }
    // Atomic: move up over old sticky → clear → print log → reprint sticky.
    const moveUp = this.lastStickyHeight > 0 ? `\x1b[${this.lastStickyHeight}A\x1b[J` : '';
    const { block, height } = this.renderSticky();
    this.lastStickyHeight = height;
    process.stdout.write(moveUp + line + '\n' + block);
  }

  private writeSticky(): void {
    if (!TTY) return;
    const moveUp = this.lastStickyHeight > 0 ? `\x1b[${this.lastStickyHeight}A\x1b[J` : '';
    const { block, height } = this.renderSticky();
    this.lastStickyHeight = height;
    process.stdout.write(moveUp + block);
  }

  private renderSticky(): { block: string; height: number } {
    const cols = Math.max(40, (process.stdout.columns ?? 80) - 1);
    const elapsed = formatElapsed(Date.now() - this.startTime);
    const bar = pctBar(this.completed, this.total, 20);
    const counts =
      `${bold(`${this.completed}/${this.total}`)}  ` +
      green(`✓${this.passed}`) + ' ' +
      red(`✗${this.failed}`);
    const progressLine = `  ${bold('progress')}  ${bar}  ${counts}   ${dim(`elapsed ${elapsed}`)}`;

    const divider = dim('─'.repeat(cols));
    const lines: string[] = [divider, progressLine];

    if (this.inFlight.length === 0) {
      lines.push(`  ${bold('running ')}  ${dim('—')}`);
    } else {
      const MAX_ROWS = 5;
      const shown = this.inFlight.slice(0, MAX_ROWS);
      const overflow = this.inFlight.length - shown.length;
      const idWidth = Math.max(...shown.map((c) => visibleLength(c.id)));
      const summaryBudget = Math.max(10, cols - 14 - idWidth - 2);
      shown.forEach((tc, i) => {
        const label = i === 0 ? bold('running ') : '        ';
        const id = cyan(padEndV(tc.id, idWidth));
        const summary = dim(truncate(tc.summary, summaryBudget));
        lines.push(`  ${label}  ${id}  ${summary}`);
      });
      if (overflow > 0) lines.push(`  ${'        '}  ${dim(`… +${overflow} more`)}`);
    }

    return { block: lines.map((l) => l + '\n').join(''), height: lines.length };
  }
}

function formatCompletion(r: CaseResult, done: number, total: number): string {
  const status = r.passed ? green('✓') : red('✗');
  const id = padEndV(r.caseId, 28);
  const axes = ['reply', 'doc', 'code']
    .map((axis) => formatAxisInline(r.axes[axis as 'reply' | 'doc' | 'code'], axis))
    .join('  ');
  const dur = dim(padStartV(`${(r.durationMs / 1000).toFixed(1)}s`, 6));
  const progress = dim(`(${done}/${total})`);
  return `${status} ${id} ${padEndV(axes, 38)} ${dur}  ${progress}`;
}

function formatAxisInline(checks: CaseResult['axes']['reply'], name: string): string {
  if (checks.length === 0) return dim(`${name} —/—`);
  const passed = checks.filter((c) => c.passed).length;
  const txt = `${name} ${passed}/${checks.length}`;
  if (passed === checks.length) return green(txt);
  if (passed === 0) return red(txt);
  return yellow(txt);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** Visible-length-aware truncate; preserves ANSI escape sequences untouched. */
function truncateV(s: string, max: number): string {
  if (visibleLength(s) <= max) return s;
  // Slow path: walk chars, keeping escapes "free" and counting visible chars.
  let out = '';
  let visible = 0;
  const len = s.length;
  let i = 0;
  while (i < len && visible < max - 1) {
    if (s[i] === '\x1b') {
      const end = s.indexOf('m', i);
      if (end >= 0) {
        out += s.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    out += s[i];
    visible += 1;
    i += 1;
  }
  return out + '…';
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function printFailures(results: CaseResult[]): void {
  const failures = results.filter((r) => !r.passed);
  if (failures.length === 0) return;

  console.log('');
  console.log(bold(rule('failures')));
  for (const r of failures) {
    console.log(`\n${red('✗')} ${bold(r.caseId)} ${dim('—')} ${r.summary}`);
    if (r.error) console.log(`  ${red('error')}: ${r.error}`);
    for (const axisName of ['reply', 'doc', 'code'] as const) {
      for (const c of r.axes[axisName]) {
        if (c.passed) continue;
        const label = (c.check as { label?: string }).label ?? c.check.kind;
        console.log(`  ${dim('[')}${yellow(axisName)}${dim(']')} ${label}: ${c.detail}`);
      }
    }
  }
}

function printFinalSummary(results: CaseResult[]): void {
  const byCat = new Map<Category, { total: number; passed: number }>();
  for (const r of results) {
    const b = byCat.get(r.category) ?? { total: 0, passed: 0 };
    b.total += 1;
    if (r.passed) b.passed += 1;
    byCat.set(r.category, b);
  }

  console.log('');
  console.log(bold(rule('by category')));
  for (const [cat, { total, passed }] of byCat) {
    const pct = total === 0 ? 0 : Math.round((100 * passed) / total);
    const bar = pctBar(passed, total);
    const score =
      passed === total ? green(`${passed}/${total}`) :
      passed === 0 ? red(`${passed}/${total}`) :
      yellow(`${passed}/${total}`);
    console.log(`  ${padEndV(cat, 12)} ${bar}  ${score}  ${dim(`(${pct}%)`)}`);
  }

  const totalPassed = results.filter((r) => r.passed).length;
  const pct = results.length === 0 ? 0 : Math.round((100 * totalPassed) / results.length);
  const totalScore =
    totalPassed === results.length ? green(`${totalPassed}/${results.length}`) :
    totalPassed === 0 ? red(`${totalPassed}/${results.length}`) :
    yellow(`${totalPassed}/${results.length}`);
  console.log('');
  console.log(`  ${bold('TOTAL')}        ${pctBar(totalPassed, results.length)}  ${totalScore}  ${dim(`(${pct}%)`)}`);
}

function pctBar(passed: number, total: number, width = 20): string {
  if (total === 0) return dim('─'.repeat(width));
  const filled = Math.round((width * passed) / total);
  const empty = width - filled;
  const fillColor = passed === total ? green : passed === 0 ? red : yellow;
  return fillColor('█'.repeat(filled)) + dim('░'.repeat(empty));
}

function rule(label: string): string {
  const line = '─'.repeat(8);
  return `${line} ${label} ${line}`;
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

  const { filter, concurrency, model, repeats } = parseArgs(process.argv.slice(2));
  const all = await loadAllCases();
  const selected = filter
    ? all.filter((c) => c.id.toLowerCase().includes(filter.toLowerCase()) || c.category === filter)
    : all;

  if (selected.length === 0) {
    console.error(`no matching cases (filter=${filter ?? '—'}, total=${all.length})`);
    process.exit(2);
  }

  // Expand repeats by cloning each case N times with a `#<n>` id suffix when
  // N > 1. Cloned cases run as independent items in the pool so results
  // aggregate naturally into the per-category summary.
  const runs: EvalCase[] = [];
  for (const c of selected) {
    for (let i = 1; i <= repeats; i += 1) {
      runs.push(repeats === 1 ? c : { ...c, id: `${c.id}#${i}` });
    }
  }

  const agentModel = model ?? 'sonnet';
  const header = repeats === 1
    ? `Running ${selected.length}/${all.length} eval case(s), concurrency=${concurrency}, agent-model=${agentModel}`
    : `Running ${runs.length} total (${selected.length}/${all.length} case(s) × ${repeats} repeats), concurrency=${concurrency}, agent-model=${agentModel}`;
  console.log(bold(header));
  console.log('');

  const tracker = new LiveTracker(runs.length);
  let results: CaseResult[];
  try {
    results = await runInPool(runs, concurrency, async (tc) => {
      tracker.start(tc);
      const r = await runCase(tc, { model: agentModel });
      tracker.complete(r);
      return r;
    });
  } finally {
    tracker.stop();
  }

  // Failures first (the stuff you want to scroll back to), then the summary
  // as the last thing on screen so `make eval | tail` gives you the score.
  const artifactsDir = await writeArtifacts(results);
  printFailures(results);
  printFinalSummary(results);
  console.log(`\n${dim('Artifacts:')} ${artifactsDir}`);

  process.exit(results.every((r) => r.passed) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
