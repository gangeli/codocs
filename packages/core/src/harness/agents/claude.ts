/**
 * Claude Code agent runner.
 *
 * Spawns the `claude` CLI as a child process with `-p` (print mode).
 * Sessions are managed via `--session-id` and `--resume`.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentRunner, AgentRunOptions, AgentRunResult, ActiveAgent, RunnerCapabilities } from '../agent.js';
import {
  type TrackedProcess,
  DEFAULT_TIMEOUT,
  spawnAgent,
  getTrackedProcesses,
  killTrackedProcesses,
} from './runner-utils.js';

/**
 * Claude stores per-session JSONL files under
 * `~/.claude/projects/<slug>/<sessionId>.jsonl`, where `<slug>` is
 * derived from the cwd (roughly: absolute path with `/` → `-` and `.`
 * dropped). Session lookup (`--resume <sid>`) only inspects the slug
 * for the *current* cwd.
 *
 * Our fork flow spawns the child in a different cwd than the parent
 * (each comment gets its own worktree), so `--resume <parent> --fork-
 * session` fails with exit 1 — Claude can't find the JSONL.
 *
 * Before spawning a forked child, we search every project dir for the
 * parent's JSONL and copy it into the child's expected slug directory
 * so `--resume` finds it. A no-op if the file is already in place, or
 * if we can't locate it anywhere.
 */
async function cwdToSlug(cwd: string): Promise<string> {
  // Matches Claude Code's observed per-project directory naming:
  // every non-alphanumeric character in the realpath cwd is replaced
  // with `-` (so `/`, `.`, `_` all collapse to `-`, including runs).
  // realpath matters on macOS where /var is a symlink to /private/var
  // and Claude uses the resolved /private/var/... form.
  let real = resolve(cwd);
  try {
    real = await realpath(real);
  } catch {
    // Worktree path may not exist yet at slug computation time; fall
    // back to the non-realpath form.
  }
  return real.replace(/[^a-zA-Z0-9]/g, '-');
}

async function findSessionFile(sessionId: string): Promise<string | null> {
  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return null;
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const d of entries) {
    const candidate = join(projectsDir, d, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function ensureSessionAvailable(
  sessionId: string,
  cwd: string,
): Promise<void> {
  const projectsDir = join(homedir(), '.claude', 'projects');
  const targetDir = join(projectsDir, await cwdToSlug(cwd));
  const targetFile = join(targetDir, `${sessionId}.jsonl`);
  if (existsSync(targetFile)) return;
  const src = await findSessionFile(sessionId);
  if (!src) return;
  try {
    await mkdir(targetDir, { recursive: true });
    await copyFile(src, targetFile);
  } catch {
    // If the copy fails we fall through; the caller's retry path
    // (fresh session) will absorb it.
  }
}

export class ClaudeRunner implements AgentRunner {
  readonly name = 'claude';
  private active = new Map<string, TrackedProcess>();

  constructor(private binaryPath: string = 'claude') {}

  async run(
    prompt: string,
    sessionId: string | null,
    opts?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    // When forking, we need a fresh child session ID distinct from the parent
    // so concurrent forks don't collide on the same JSONL file.
    const forking = !!sessionId && !!opts?.forkSession;
    const effectiveSessionId = forking ? randomUUID() : (sessionId ?? randomUUID());

    const args = ['-p', prompt, '--session-id', effectiveSessionId];

    const permMode = opts?.permissionMode ?? { type: 'auto' };
    switch (permMode.type) {
      case 'auto':
        args.push('--permission-mode', 'auto');
        // Also pass allowedTools as a fallback in case auto mode isn't
        // available for this account — without it the agent can't edit files.
        if (permMode.allowedTools?.length) {
          args.push('--allowedTools', ...permMode.allowedTools);
        }
        break;
      case 'bypass':
        args.push('--dangerously-skip-permissions');
        break;
      case 'allowedTools':
        args.push('--allowedTools', ...permMode.tools);
        if (permMode.disallowedTools?.length) {
          args.push('--disallowedTools', ...permMode.disallowedTools);
        }
        break;
    }

    if (opts?.model) {
      args.push('--model', opts.model);
    }

    if (forking) {
      // Claude looks up session JSONLs under the slug for the child's
      // cwd. The parent was created in a different cwd, so copy the
      // session file into the expected location before resuming.
      if (opts?.workingDirectory) {
        await ensureSessionAvailable(sessionId!, opts.workingDirectory);
      }
      args.push('--resume', sessionId!, '--fork-session');
    } else if (sessionId) {
      args.push('--resume');
    }

    // Strip ANTHROPIC_API_KEY so the child authenticates via the stored
    // Claude Code subscription credential rather than billing the API.
    // The eval harness sets ANTHROPIC_API_KEY for the judge SDK client;
    // letting that leak here would silently reroute agent calls to API
    // billing.
    const { ANTHROPIC_API_KEY: _unused, ...childEnv } = process.env;

    return spawnAgent(this.binaryPath, args, {
      cwd: opts?.workingDirectory,
      timeout: opts?.timeout ?? DEFAULT_TIMEOUT,
      agentName: opts?.agentName,
      sessionId: effectiveSessionId,
      env: childEnv,
    }, this.active);
  }

  getActiveProcesses(): ActiveAgent[] {
    return getTrackedProcesses(this.active);
  }

  killAll(): string[] {
    return killTrackedProcesses(this.active);
  }

  getCapabilities(): RunnerCapabilities {
    return {
      supportsSessionResume: true,
      supportsSessionFork: true,
      models: [
        { label: 'default', value: '' },
        { label: 'haiku', value: 'haiku' },
        { label: 'sonnet', value: 'sonnet' },
        { label: 'opus', value: 'opus' },
      ],
      harnessSettings: [],
      supportsPermissionMode: true,
    };
  }
}
