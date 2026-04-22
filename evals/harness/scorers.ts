/**
 * Check dispatcher.
 *
 * Given a Check and a RunContext (worktree path, final doc, reply, etc.),
 * produce a CheckResult. Judge checks are deferred — we collect them
 * across all axes for a case and batch into one Sonnet call in run-case.
 */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  Check,
  CheckResult,
  Deterministic,
  Behavior,
  GitAssertion,
} from '../types.js';
import { listOriginBranches } from './hydrate.js';

const execFile = promisify(execFileCb);

export interface RunContext {
  /** Final markdown in the fake docs client. */
  finalDoc: string;
  /** Baseline doc markdown (before the agent ran). */
  baselineDoc: string;
  /** Latest non-placeholder reply posted for this comment. Null if none. */
  reply: string | null;
  /** Count of batchUpdate calls the orchestrator issued. */
  batchUpdateCount: number;
  /** Worktree the agent ran in (may be torn down — check existsSync before reading). */
  worktreePath: string | null;
  /** Repo root (where the seed commit lives). */
  repoRoot: string;
  /** Bare origin path — for branch inspection. */
  originPath: string;
}

export async function runDeterministic(check: Deterministic, ctx: RunContext): Promise<CheckResult> {
  switch (check.kind) {
    case 'regex': {
      const hay = check.on === 'reply' ? (ctx.reply ?? '') : ctx.finalDoc;
      const hit = check.pattern.test(hay);
      return mk(check, hit === check.match, `${check.on} ${check.match ? 'matches' : 'does not match'} ${check.pattern}`);
    }
    case 'exact': {
      const hay = check.on === 'reply' ? (ctx.reply ?? '') : ctx.finalDoc;
      return mk(check, hay === check.equals, `${check.on} equals expected string`);
    }
    case 'length': {
      const hay = check.on === 'reply' ? (ctx.reply ?? '') : ctx.finalDoc;
      const len = hay.length;
      const minOk = check.min == null || len >= check.min;
      const maxOk = check.max == null || len <= check.max;
      return mk(check, minOk && maxOk, `${check.on} length=${len} (min=${check.min ?? '—'}, max=${check.max ?? '—'})`);
    }
    case 'file-exists': {
      if (!ctx.worktreePath) return mk(check, !check.expect, 'no worktree exists');
      const p = join(ctx.worktreePath, check.path);
      const present = existsSync(p);
      return mk(check, present === check.expect, `${check.path} ${present ? 'exists' : 'absent'}`);
    }
    case 'file-contains': {
      if (!ctx.worktreePath) return mk(check, false, 'no worktree to inspect');
      const p = join(ctx.worktreePath, check.path);
      if (!existsSync(p)) return mk(check, false, `${check.path} absent`);
      const body = await readFile(p, 'utf-8');
      const hit = check.pattern.test(body);
      return mk(check, hit === check.match, `${check.path} ${check.match ? 'contains' : 'excludes'} ${check.pattern}`);
    }
    case 'grep-count': {
      if (!ctx.worktreePath) return mk(check, false, 'no worktree to grep');
      const p = join(ctx.worktreePath, check.path);
      if (!existsSync(p)) return mk(check, false, `${check.path} absent`);
      const body = await readFile(p, 'utf-8');
      const count = (body.match(new RegExp(check.pattern, flagsWithGlobal(check.pattern))) ?? []).length;
      let ok = true;
      if (check.equals != null) ok = ok && count === check.equals;
      if (check.min != null) ok = ok && count >= check.min;
      if (check.max != null) ok = ok && count <= check.max;
      return mk(check, ok, `${check.path}: ${count} matches of ${check.pattern}`);
    }
    case 'doc-unchanged': {
      return mk(check, ctx.finalDoc === ctx.baselineDoc, `doc byte-equal to baseline: ${ctx.finalDoc === ctx.baselineDoc}`);
    }
    case 'no-batch-update': {
      return mk(check, ctx.batchUpdateCount === 0, `batchUpdate count=${ctx.batchUpdateCount}`);
    }
    case 'batch-update-count': {
      return mk(check, ctx.batchUpdateCount === check.equals, `batchUpdate count=${ctx.batchUpdateCount} (expected ${check.equals})`);
    }
    case 'git':
      return gitAssertion(check.assert, ctx, check);
  }
}

async function gitAssertion(
  assert: GitAssertion,
  ctx: RunContext,
  source: Deterministic,
): Promise<CheckResult> {
  const origin = await listOriginBranches(ctx.originPath);
  const codocs = origin.filter((b) => b.startsWith('codocs/'));
  switch (assert) {
    case 'no-new-commits':
      return mk(source, codocs.length === 0, `origin codocs/* branches: ${codocs.length}`);
    case 'branch-pushed':
      return mk(source, codocs.length >= 1, `origin has ${codocs.length} codocs/* branch(es): ${JSON.stringify(codocs)}`);
    case 'commit-on-branch': {
      if (!ctx.worktreePath) return mk(source, false, 'no worktree');
      try {
        const { stdout: branch } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.worktreePath });
        const b = branch.trim();
        const { stdout: log } = await execFile('git', ['log', '--oneline', `main..${b}`], { cwd: ctx.worktreePath });
        const count = log.trim().split('\n').filter(Boolean).length;
        return mk(source, count >= 1, `${b} has ${count} commits beyond main`);
      } catch (err) {
        return mk(source, false, `git failed: ${(err as Error).message}`);
      }
    }
    case 'worktree-retained':
      return mk(source, !!ctx.worktreePath && existsSync(ctx.worktreePath), `worktree exists=${!!ctx.worktreePath && existsSync(ctx.worktreePath)}`);
    case 'worktree-torn-down':
      return mk(source, !ctx.worktreePath || !existsSync(ctx.worktreePath), `worktree torn down=${!ctx.worktreePath || !existsSync(ctx.worktreePath)}`);
  }
}

export async function runBehavior(check: Behavior, ctx: RunContext): Promise<CheckResult> {
  const cwd = check.cwd === 'worktree' ? ctx.worktreePath : ctx.repoRoot;
  if (!cwd || !existsSync(cwd)) {
    return mk(check, false, `cwd missing (${check.cwd}=${cwd})`);
  }
  try {
    const child = await execFile(check.cmd, check.args ?? [], {
      cwd,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
    });
    return checkBehaviorExpectations(check, {
      stdout: child.stdout ?? '',
      stderr: child.stderr ?? '',
      exit: 0,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: unknown; stderr?: unknown; code?: number | string };
    return checkBehaviorExpectations(check, {
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
      exit: typeof e.code === 'number' ? e.code : 1,
    });
  }
}

function checkBehaviorExpectations(
  check: Behavior,
  observed: { stdout: string; stderr: string; exit: number },
): CheckResult {
  const { stdout, stderr, exit } = observed;
  const { expect } = check;
  const failures: string[] = [];
  if (expect.exit != null && exit !== expect.exit) failures.push(`exit ${exit}≠${expect.exit}`);
  if (expect.stdout && !expect.stdout.test(stdout)) failures.push(`stdout !~ ${expect.stdout}`);
  if (expect.stderr && !expect.stderr.test(stderr)) failures.push(`stderr !~ ${expect.stderr}`);
  if (expect.notStdout && expect.notStdout.test(stdout)) failures.push(`stdout ~ ${expect.notStdout} (should not)`);
  const passed = failures.length === 0;
  const detail = passed
    ? `ok (exit=${exit}, stdout=${oneLine(stdout, 60)})`
    : `${failures.join(', ')} (exit=${exit}, stdout=${oneLine(stdout, 60)}, stderr=${oneLine(stderr, 60)})`;
  return { check, passed, detail, metadata: { stdout, stderr, exit } };
}

function mk(check: Check, passed: boolean, detail: string): CheckResult {
  return { check, passed, detail };
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

function flagsWithGlobal(re: RegExp): string {
  return re.flags.includes('g') ? re.flags : re.flags + 'g';
}
