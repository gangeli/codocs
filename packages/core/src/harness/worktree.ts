/**
 * Git worktree and branch management for code modification tasks.
 *
 * All git operations use child_process.execFile for safety (no shell injection).
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const execFile = promisify(execFileCb);

/** Run a git command in the given directory. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd });
  return stdout.trim();
}

/**
 * Detect the default branch (main or master) for the repo.
 */
export async function getDefaultBranch(cwd: string): Promise<string> {
  try {
    // Check what the remote HEAD points to
    const ref = await git(cwd, 'symbolic-ref', 'refs/remotes/origin/HEAD');
    return ref.replace('refs/remotes/origin/', '');
  } catch {
    // Fallback: check if main or master exists
    try {
      await git(cwd, 'rev-parse', '--verify', 'main');
      return 'main';
    } catch {
      return 'master';
    }
  }
}

/**
 * Create a git worktree with a new branch.
 *
 * @param cwd - The main repo working directory.
 * @param baseBranch - The branch to base the new branch on.
 * @param branchName - The new branch name.
 * @returns The absolute path to the worktree directory.
 */
export async function createWorktree(
  cwd: string,
  baseBranch: string,
  branchName: string,
): Promise<{ worktreePath: string }> {
  // Ensure the worktrees directory exists
  const worktreesDir = join(cwd, '.codocs', 'worktrees');
  await mkdir(worktreesDir, { recursive: true });

  // Slug the branch name for the directory
  const slug = branchName.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
  const worktreePath = join(worktreesDir, slug);

  await git(cwd, 'worktree', 'add', '-b', branchName, worktreePath, baseBranch);

  return { worktreePath };
}

/**
 * Remove a git worktree and its branch.
 */
export async function removeWorktree(cwd: string, worktreePath: string): Promise<void> {
  try {
    await git(cwd, 'worktree', 'remove', worktreePath, '--force');
  } catch {
    // Worktree may already be gone
  }
}

/**
 * Stage all changes and commit in a worktree.
 *
 * @returns The commit SHA, or null if there were no changes to commit.
 */
export async function commitAll(
  worktreePath: string,
  message: string,
): Promise<string | null> {
  // Check if there are any changes to commit
  const status = await git(worktreePath, 'status', '--porcelain');
  if (!status) return null;

  await git(worktreePath, 'add', '-A');
  await git(worktreePath, 'commit', '-m', message);
  const sha = await git(worktreePath, 'rev-parse', 'HEAD');
  return sha;
}

/**
 * Push a branch to origin with tracking.
 */
export async function pushBranch(
  worktreePath: string,
  branchName: string,
): Promise<void> {
  await git(worktreePath, 'push', '-u', 'origin', branchName);
}

/**
 * Rebase the worktree branch onto the latest base branch.
 *
 * Fetches origin first to ensure we have the latest.
 */
export async function rebaseOnto(
  worktreePath: string,
  baseBranch: string,
): Promise<{ success: boolean; conflictFiles?: string[] }> {
  try {
    await git(worktreePath, 'fetch', 'origin', baseBranch);
    await git(worktreePath, 'rebase', `origin/${baseBranch}`);
    return { success: true };
  } catch (err: any) {
    // Check for rebase conflicts
    try {
      const status = await git(worktreePath, 'status', '--porcelain');
      const conflictFiles = status
        .split('\n')
        .filter((line) => line.startsWith('UU ') || line.startsWith('AA '))
        .map((line) => line.slice(3));

      if (conflictFiles.length > 0) {
        // Abort the rebase — the agent will deal with any drift
        await git(worktreePath, 'rebase', '--abort');
        return { success: false, conflictFiles };
      }
    } catch {
      // If we can't even check status, abort and report failure
      try { await git(worktreePath, 'rebase', '--abort'); } catch { /* already aborted */ }
    }
    return { success: false };
  }
}

/**
 * Force-push to update an existing remote branch (for follow-up commits).
 */
export async function forcePushBranch(
  worktreePath: string,
  branchName: string,
): Promise<void> {
  await git(worktreePath, 'push', '--force-with-lease', 'origin', branchName);
}
