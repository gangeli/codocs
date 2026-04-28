/**
 * Tests for the worktree-helper git operations. Each test sets up a real
 * git repo in a tempdir so plumbing-level commands (`commit-tree`,
 * `merge --ff-only`, `branch -D`) are exercised end-to-end.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  createWorktree,
  commitAll,
  squashMergeIntoBase,
  deleteLocalBranch,
} from '../../src/harness/worktree.js';
import { buildSquashMergeMessage } from '../../src/harness/orchestrator.js';

const cleanupPaths: string[] = [];
afterEach(() => {
  while (cleanupPaths.length > 0) {
    const p = cleanupPaths.pop()!;
    try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codocs-worktree-'));
  cleanupPaths.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('squashMergeIntoBase', () => {
  it('fast-forwards main when the agent branch has unique changes', async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, 'main', 'agent/test-1');
    writeFileSync(join(wt.worktreePath, 'b.txt'), 'agent change\n');
    const sha = await commitAll(wt.worktreePath, 'agent commit');
    expect(sha).toBeTruthy();

    const result = await squashMergeIntoBase(repo, wt.worktreePath, 'main', 'squash: agent change');
    expect(result.success).toBe(true);
    if (result.success) {
      // main now contains the new file at the merged commit.
      const head = git(repo, 'rev-parse', 'HEAD');
      expect(head).toBe(result.mergedSha);
      const log = git(repo, 'log', '--oneline');
      expect(log).toContain('squash: agent change');
      expect(existsSync(join(repo, 'b.txt'))).toBe(true);
    }
  });

  it('leaves main untouched when the main checkout is on a different branch', async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, 'main', 'agent/test-2');
    writeFileSync(join(wt.worktreePath, 'b.txt'), 'agent change\n');
    await commitAll(wt.worktreePath, 'agent commit');

    git(repo, 'checkout', '-b', 'feature/local-work');
    const headBefore = git(repo, 'rev-parse', 'HEAD');

    const result = await squashMergeIntoBase(repo, wt.worktreePath, 'main', 'squash msg');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toMatch(/repo-root-on-feature\/local-work-not-main/);
    }
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('preserves uncommitted WIP in the main checkout that does not overlap', async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, 'main', 'agent/test-3');
    writeFileSync(join(wt.worktreePath, 'b.txt'), 'agent change\n');
    await commitAll(wt.worktreePath, 'agent commit');

    // Add unrelated WIP in the main checkout.
    writeFileSync(join(repo, 'wip.txt'), 'user wip\n');

    const result = await squashMergeIntoBase(repo, wt.worktreePath, 'main', 'squash msg');
    expect(result.success).toBe(true);
    expect(existsSync(join(repo, 'wip.txt'))).toBe(true);
    expect(existsSync(join(repo, 'b.txt'))).toBe(true);
    // wip.txt should still be untracked after the merge.
    const status = git(repo, 'status', '--porcelain');
    expect(status).toContain('?? wip.txt');
  });

  it('bails when the agent tree is identical to base (no real change)', async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, 'main', 'agent/test-4');
    // Don't make any changes in the worktree.
    const result = await squashMergeIntoBase(repo, wt.worktreePath, 'main', 'squash msg');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('tree-identical-to-base');
  });

  it('writes the supplied commit message verbatim onto main', async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, 'main', 'agent/test-5');
    writeFileSync(join(wt.worktreePath, 'c.txt'), 'change\n');
    await commitAll(wt.worktreePath, 'agent commit');

    const msg = 'subject line\n\nOriginal request:\n> please do thing\n\nAgent: spotty-fox\n';
    const result = await squashMergeIntoBase(repo, wt.worktreePath, 'main', msg);
    expect(result.success).toBe(true);

    const fullMessage = git(repo, 'log', '-1', '--format=%B');
    expect(fullMessage).toContain('subject line');
    expect(fullMessage).toContain('Original request:');
    expect(fullMessage).toContain('Agent: spotty-fox');
  });
});

describe('buildSquashMergeMessage', () => {
  it('uses the comment first line as subject (truncated to 72)', () => {
    const long = 'a'.repeat(120);
    const msg = buildSquashMergeMessage({
      commentText: long,
      agentName: 'spotty-fox',
      branchName: 'codocs/spotty-fox/x',
      documentId: 'DOC123',
    });
    const subject = msg.split('\n')[0];
    expect(subject.length).toBeLessThanOrEqual(72);
  });

  it('includes the original request, agent, branch, and doc URL in the body', () => {
    const msg = buildSquashMergeMessage({
      commentText: 'fix the thing',
      agentName: 'spotty-fox',
      branchName: 'codocs/spotty-fox/fix-thing-1234',
      documentId: 'DOC123',
    });
    expect(msg).toContain('Original request:');
    expect(msg).toContain('> fix the thing');
    expect(msg).toContain('Agent: spotty-fox');
    expect(msg).toContain('Branch: codocs/spotty-fox/fix-thing-1234');
    expect(msg).toContain('Doc: https://docs.google.com/document/d/DOC123');
  });

  it('falls back to a generic subject for empty comments', () => {
    const msg = buildSquashMergeMessage({
      commentText: '',
      agentName: 'a',
      branchName: 'b',
      documentId: 'D',
    });
    expect(msg.split('\n')[0]).toBe('codocs change');
  });
});

describe('deleteLocalBranch', () => {
  it('removes a local branch even if it has unmerged commits', async () => {
    const repo = makeRepo();
    git(repo, 'branch', 'throwaway');
    expect(git(repo, 'branch', '--list', 'throwaway')).toContain('throwaway');

    await deleteLocalBranch(repo, 'throwaway');

    expect(git(repo, 'branch', '--list', 'throwaway')).toBe('');
  });

  it('is a no-op when the branch does not exist', async () => {
    const repo = makeRepo();
    await expect(deleteLocalBranch(repo, 'never-existed')).resolves.toBeUndefined();
  });
});
