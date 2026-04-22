/**
 * Per-case fixture hydration.
 *
 * Each eval case runs against a fresh temp directory that looks like:
 *
 *     <tmp>/origin.git        bare repo acting as "origin"
 *     <tmp>/repo/             working clone with one seed commit on main
 *       <codebase contents copied in from evals/fixtures/codebases/<name>/>
 *
 * The fixture doc is read from evals/fixtures/docs/<name> and returned as
 * a string; the harness hands it to FakeDocsClient as the initial state.
 *
 * Everything is torn down at end-of-case, except when DEBUG_KEEP_TMP=1
 * in the environment — useful when a case fails and you want to poke at
 * the worktree.
 */
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_ROOT = join(HERE, '..', 'fixtures');

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd });
  return stdout.trim();
}

export interface HydratedFixture {
  workdir: string;
  repoRoot: string;
  originPath: string;
  initialMarkdown: string;
}

export async function hydrate(codebase: string, doc: string): Promise<HydratedFixture> {
  const workdir = await mkdtemp(join(tmpdir(), 'codocs-eval-'));
  const originPath = join(workdir, 'origin.git');
  const repoPath = join(workdir, 'repo');

  await execFile('git', ['init', '--bare', '--initial-branch=main', originPath]);
  await execFile('git', ['clone', originPath, repoPath]);
  await git(repoPath, 'config', 'user.email', 'eval@codocs.test');
  await git(repoPath, 'config', 'user.name', 'codocs-eval');

  // Copy the fixture codebase into the repo root (preserving structure).
  const srcCb = join(FIXTURES_ROOT, 'codebases', codebase);
  await cp(srcCb, repoPath, { recursive: true });

  await git(repoPath, 'add', '-A');
  await git(repoPath, 'commit', '-m', `seed: ${codebase}`);
  await git(repoPath, 'push', '-u', 'origin', 'main');

  const docPath = join(FIXTURES_ROOT, 'docs', doc);
  const initialMarkdown = await readFile(docPath, 'utf-8');

  return { workdir, repoRoot: repoPath, originPath, initialMarkdown };
}

export async function teardown(workdir: string): Promise<void> {
  if (process.env.DEBUG_KEEP_TMP === '1') return;
  try {
    await rm(workdir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

export async function listOriginBranches(originPath: string): Promise<string[]> {
  const { stdout } = await execFile(
    'git',
    ['--git-dir', originPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
  );
  return stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
}

export { git };
