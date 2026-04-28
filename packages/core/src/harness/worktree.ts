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

export type SquashMergeResult =
  | { success: true; mergedSha: string }
  | { success: false; reason: string };

/**
 * Squash the worktree branch into the repo's base branch without touching
 * either working tree's content beyond a fast-forward.
 *
 * Implementation uses plumbing — `commit-tree` builds a single commit
 * that captures the worktree HEAD's tree on top of the current base, and
 * `merge --ff-only` advances the base branch ref. The fast-forward keeps
 * any uncommitted edits in the main checkout that don't overlap the
 * merged change; if there is overlap (or the main checkout isn't on
 * `baseBranch`) we bail with `success: false` and leave the agent
 * branch alone for manual review.
 */
export async function squashMergeIntoBase(
  repoRoot: string,
  worktreePath: string,
  baseBranch: string,
  message: string,
): Promise<SquashMergeResult> {
  let currentBranch: string;
  try {
    currentBranch = await git(repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD');
  } catch (err: any) {
    return { success: false, reason: `rev-parse-head-failed: ${err.message ?? err}` };
  }
  if (currentBranch !== baseBranch) {
    return { success: false, reason: `repo-root-on-${currentBranch}-not-${baseBranch}` };
  }

  let tree: string;
  let baseSha: string;
  try {
    tree = await git(worktreePath, 'rev-parse', 'HEAD^{tree}');
    baseSha = await git(repoRoot, 'rev-parse', baseBranch);
  } catch (err: any) {
    return { success: false, reason: `rev-parse-failed: ${err.message ?? err}` };
  }

  if (tree === (await safeRevParse(repoRoot, `${baseBranch}^{tree}`))) {
    return { success: false, reason: 'tree-identical-to-base' };
  }

  let mergedSha: string;
  try {
    mergedSha = await git(worktreePath, 'commit-tree', tree, '-p', baseSha, '-m', message);
  } catch (err: any) {
    return { success: false, reason: `commit-tree-failed: ${err.message ?? err}` };
  }

  try {
    await git(repoRoot, 'merge', '--ff-only', mergedSha);
  } catch (err: any) {
    return { success: false, reason: `ff-merge-failed: ${err.message ?? err}` };
  }

  return { success: true, mergedSha };
}

async function safeRevParse(cwd: string, rev: string): Promise<string | null> {
  try {
    return await git(cwd, 'rev-parse', rev);
  } catch {
    return null;
  }
}

/**
 * Delete a local branch (force; the branch is presumed merged via squash so
 * git's "not fully merged" check would otherwise refuse).
 */
export async function deleteLocalBranch(cwd: string, branchName: string): Promise<void> {
  try {
    await git(cwd, 'branch', '-D', branchName);
  } catch {
    // Branch may already be gone (e.g. worktree removal pruned it).
  }
}

/**
 * Delete a remote branch on origin. Best-effort.
 */
export async function deleteRemoteBranch(cwd: string, branchName: string): Promise<void> {
  try {
    await git(cwd, 'push', 'origin', '--delete', branchName);
  } catch {
    // Branch may not exist on remote (was never pushed) or remote is offline.
  }
}
