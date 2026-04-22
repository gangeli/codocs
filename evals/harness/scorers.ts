/**
 * Check dispatcher.
 *
 * Given a Check and a RunContext (worktree path, final doc, reply, etc.),
 * produce a CheckResult. Judge checks are deferred — we collect them
 * across all axes for a case and batch into one Sonnet call in run-case.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
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
      // The canonical post-run source of truth is the worktree if one
      // exists. If the agent declined (no worktree), we fall back to the
      // repo root (seed state) — "did the agent leave things alone?" is a
      // valid question to answer against the seed.
      const base = ctx.worktreePath ?? ctx.repoRoot;
      const p = join(base, check.path);
      if (!existsSync(p)) return mk(check, !check.match, `${check.path} absent (treated as no match)`);
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
    case 'worktree-grep': {
      // Fall back to repo root when the agent declined — same reasoning
      // as `file-contains` above.
      const base = ctx.worktreePath ?? ctx.repoRoot;
      const globPattern = check.pathGlob ?? 'src/**/*';
      const files = await walkMatching(base, globPattern);
      const hits: string[] = [];
      for (const rel of files) {
        try {
          const body = await readFile(join(base, rel), 'utf-8');
          if (check.pattern.test(body)) hits.push(rel);
        } catch { /* unreadable = skip */ }
      }
      const any = hits.length > 0;
      const detail = any
        ? `${hits.length} file(s) match ${check.pattern}: ${hits.slice(0, 3).join(', ')}${hits.length > 3 ? '…' : ''}`
        : `no file under ${globPattern} matches ${check.pattern} (scanned ${files.length})`;
      return mk(check, any === check.match, detail);
    }
    case 'diff-grep': {
      if (!ctx.worktreePath) {
        // No worktree = empty diff = no match. Pass iff match=false.
        return mk(check, !check.match, 'no worktree (empty diff)');
      }
      let diff = '';
      try {
        const { stdout } = await execFile('git', ['diff', 'main...HEAD'], {
          cwd: ctx.worktreePath, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
        });
        diff = stdout;
      } catch (err) {
        // No main..HEAD path (e.g., no commits on branch) — empty diff.
        diff = '';
      }
      const hit = check.pattern.test(diff);
      return mk(check, hit === check.match, `diff ${hit ? 'contains' : 'excludes'} ${check.pattern} (diff size=${diff.length})`);
    }
    case 'doc-unchanged': {
      return mk(check, ctx.finalDoc === ctx.baselineDoc, `doc byte-equal to baseline: ${ctx.finalDoc === ctx.baselineDoc}`);
    }
    case 'sections-changed': {
      const observed = countChangedSections(ctx.baselineDoc, ctx.finalDoc);
      return mk(check, observed === check.count, `${observed} section(s) changed (expected ${check.count})`);
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
        const { equals, max } = source as { equals?: number; max?: number };
        let ok = count >= 1;
        if (equals != null) ok = count === equals;
        if (max != null) ok = ok && count <= max;
        const bound = equals != null ? ` (expected exactly ${equals})` : max != null ? ` (max ${max})` : '';
        return mk(source, ok, `${b} has ${count} commit(s) beyond main${bound}`);
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
  // `cwd: 'worktree'` falls back to repoRoot when the agent declined and
  // no worktree was ever created. The repo root has the seed code, so
  // "did the agent keep the baseline behavior?" is still answerable.
  const cwd = check.cwd === 'worktree'
    ? (ctx.worktreePath && existsSync(ctx.worktreePath) ? ctx.worktreePath : ctx.repoRoot)
    : ctx.repoRoot;
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

/**
 * Depth-first walk of `root` collecting every regular-file path whose
 * path (relative to root, using '/') matches `pattern`. `pattern` is a
 * minimal glob — supports `*`, `**`, and literal path components; not
 * a full minimatch. `.git/` and `node_modules/` are always skipped.
 */
async function walkMatching(root: string, pattern: string): Promise<string[]> {
  const re = globToRegex(pattern);
  const out: string[] = [];
  async function go(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch { return; }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await go(full);
      } else if (e.isFile()) {
        const rel = relative(root, full).split(/[\\/]/).join('/');
        if (re.test(rel)) out.push(rel);
      }
    }
  }
  await go(root);
  return out;
}

function globToRegex(glob: string): RegExp {
  // Tokenize on '/' so '**' as a whole segment means "zero or more path
  // components" (matching both `src/a.mjs` and `src/x/a.mjs` for `src/**/*`).
  // Within a segment: '*' → [^/]*.
  const segments = glob.split('/');
  const parts = segments.map((seg) => {
    if (seg === '**') return null; // sentinel — handled in join
    let s = '';
    for (const ch of seg) {
      if (ch === '*') s += '[^/]*';
      else if ('.+?()[]{}|^$\\'.includes(ch)) s += `\\${ch}`;
      else s += ch;
    }
    return s;
  });
  // Join parts with '/'; around a '**' sentinel use an optional-slash form
  // so the `**` can stand for zero path segments.
  let re = '';
  for (let i = 0; i < parts.length; i += 1) {
    const cur = parts[i];
    const nextIsStarStar = parts[i + 1] === null;
    const prevWasStarStar = i > 0 && parts[i - 1] === null;
    if (cur === null) {
      // '**' contributes any-prefix; slash-joining handled by neighbors.
      re += '.*';
    } else {
      if (i === 0) {
        re += cur;
      } else if (prevWasStarStar) {
        // No leading '/' — '**' already consumed optional prefix, but we
        // still need to allow an optional separator between prefix and cur.
        re = re.replace(/\.\*$/, '(?:.*/)?') + cur;
      } else if (nextIsStarStar) {
        re += '/' + cur;
      } else {
        re += '/' + cur;
      }
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Split baseline and final docs on `## ` level-2 headings and return the
 * number of buckets whose content differs. Preamble (before the first
 * heading) counts as a bucket. Whitespace-only differences are ignored.
 */
function countChangedSections(baseline: string, final: string): number {
  const a = splitOnH2(baseline);
  const b = splitOnH2(final);
  const keys = new Set([...a.keys(), ...b.keys()]);
  let changed = 0;
  for (const k of keys) {
    const av = (a.get(k) ?? '').replace(/\s+/g, ' ').trim();
    const bv = (b.get(k) ?? '').replace(/\s+/g, ' ').trim();
    if (av !== bv) changed += 1;
  }
  return changed;
}

function splitOnH2(doc: string): Map<string, string> {
  // Map key: heading text (or "__preamble__"), value: bucket content.
  // If two sections share a title we append a counter so they're distinct.
  const lines = doc.split('\n');
  const out = new Map<string, string>();
  let currentKey = '__preamble__';
  let currentBody = '';
  const seen = new Map<string, number>();
  const commit = (): void => {
    let k = currentKey;
    const n = seen.get(k) ?? 0;
    if (n > 0) k = `${k}#${n}`;
    seen.set(currentKey, n + 1);
    out.set(k, currentBody);
  };
  for (const line of lines) {
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      commit();
      currentKey = h2[1].trim();
      currentBody = '';
    } else {
      currentBody += line + '\n';
    }
  }
  commit();
  return out;
}
