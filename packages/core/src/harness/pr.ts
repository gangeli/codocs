/**
 * GitHub PR lifecycle management.
 *
 * Uses the GitHub REST API directly via fetch (no extra dependency needed).
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export interface PRInfo {
  number: number;
  url: string;
}

export interface RepoInfo {
  owner: string;
  repo: string;
}

/**
 * Parse owner/repo from the git remote origin URL.
 *
 * Supports HTTPS (https://github.com/owner/repo.git) and
 * SSH (git@github.com:owner/repo.git) formats.
 */
export async function getRepoInfo(cwd: string): Promise<RepoInfo> {
  const { stdout } = await execFile('git', ['remote', 'get-url', 'origin'], { cwd });
  const url = stdout.trim();

  // SSH format: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/.]+)/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  throw new Error(`Could not parse GitHub owner/repo from remote URL: ${url}`);
}

async function githubApi(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * Create a draft pull request.
 */
export async function createDraftPR(opts: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}): Promise<PRInfo> {
  const data = await githubApi(
    'POST',
    `/repos/${opts.owner}/${opts.repo}/pulls`,
    opts.token,
    {
      title: opts.title,
      body: opts.body,
      head: opts.branch,
      base: opts.baseBranch,
      draft: true,
    },
  );

  return {
    number: data.number,
    url: data.html_url,
  };
}

/**
 * Add a comment to an existing PR.
 */
export async function addPRComment(opts: {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
}): Promise<void> {
  await githubApi(
    'POST',
    `/repos/${opts.owner}/${opts.repo}/issues/${opts.prNumber}/comments`,
    opts.token,
    { body: opts.body },
  );
}

/**
 * Build a PR description body that links back to the Google Doc.
 */
export function buildPRBody(opts: {
  commentText: string;
  documentId: string;
  agentName: string;
}): string {
  const docUrl = `https://docs.google.com/document/d/${opts.documentId}`;
  return [
    `Requested via [Google Doc comment](${docUrl}).`,
    '',
    `> ${opts.commentText}`,
    '',
    `Agent: **${opts.agentName}**`,
    '',
    '---',
    '*Created by [codocs](https://github.com/codocs)*',
  ].join('\n');
}
