#!/usr/bin/env node
/**
 * End-to-end comment-flow test runner.
 *
 * Exercises the full AgentOrchestrator comment pipeline against a real
 * Claude agent and a real on-disk git repository (with a bare "origin"),
 * while mocking only the Google Docs API layer. Each comment is expected
 * to produce real side effects on real worktrees, and those side effects
 * are asserted post-hoc.
 *
 * Test scenarios:
 *   TC1  single doc-edit comment       — agent writes to design-doc.md,
 *                                        orchestrator calls batchUpdate,
 *                                        worktree torn down afterwards.
 *   TC2  two sequential doc edits      — each comment runs in its OWN
 *                                        worktree; the second sees the
 *                                        first's changes.
 *   TC3  code-change comment           — agent creates a source file,
 *                                        orchestrator commits + pushes.
 *
 * Usage:
 *   npx tsx scripts/e2e-comments.ts
 *   npx tsx scripts/e2e-comments.ts TC1          # run a single case
 */

import {
  AgentOrchestrator,
  ClaudeRunner,
  docsToMarkdown,
  type AgentRunner,
  type AgentRunOptions,
  type AgentRunResult,
  type ActiveAgent,
  type RunnerCapabilities,
  type SessionStore,
  type SessionMapping,
  type CommentEvent,
  type CodocsClient,
} from '../packages/core/src/index.js';
import { openDatabase, QueueStore } from '../packages/db/src/index.js';

import { mkdtemp, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { docs_v1 } from 'googleapis';

const execFile = promisify(execFileCb);

// ── Mock Google Docs layer ───────────────────────────────────

/**
 * Build a minimal Schema$Document from plain markdown. Paragraphs are
 * separated by blank lines; lines starting with `#`, `##`, etc. become
 * HEADING_N. No rich formatting (bold/italic/tables) — those aren't
 * needed for the comment-flow tests.
 *
 * The docsToMarkdown round-trip over this shape is stable for the
 * inputs we use: `docsToMarkdown(mdToMinimalDoc(m)) === m` for any
 * `m` composed of headings + plain paragraphs separated by \n\n.
 */
function mdToMinimalDoc(markdown: string): docs_v1.Schema$Document {
  const paragraphs = markdown.replace(/\r\n/g, '\n').split(/\n\n+/).filter((p) => p.length > 0);
  const content: docs_v1.Schema$StructuralElement[] = [
    {
      startIndex: 0,
      endIndex: 1,
      sectionBreak: { sectionStyle: { sectionType: 'CONTINUOUS' } },
    },
  ];
  let idx = 1;
  for (const raw of paragraphs) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(raw);
    let style = 'NORMAL_TEXT';
    let text = raw;
    if (headingMatch) {
      style = `HEADING_${headingMatch[1].length}`;
      text = headingMatch[2];
    }
    const withNewline = text + '\n';
    const end = idx + withNewline.length;
    content.push({
      startIndex: idx,
      endIndex: end,
      paragraph: {
        elements: [
          {
            startIndex: idx,
            endIndex: end,
            textRun: { content: withNewline, textStyle: {} },
          },
        ],
        paragraphStyle: { namedStyleType: style },
      },
    });
    idx = end;
  }
  return {
    body: { content },
    namedRanges: {},
    lists: {},
    inlineObjects: {},
  };
}

interface FakeDocsCallLog {
  method: string;
  args: unknown[];
}

/**
 * Fake CodocsClient that stores the doc as a markdown string. `getDocument`
 * builds a Schema$Document on the fly via `mdToMinimalDoc`. `batchUpdate`
 * is recorded AND short-circuited: instead of applying the request stream
 * (which would require reimplementing a slice of the Docs API), the mock
 * pulls the markdown the agent just wrote to `.codocs/design-doc.md` from
 * the wired-up RecordingRunner. That makes subsequent `getDocument` calls
 * observe the prior comment's edits — essential for multi-comment tests.
 */
class FakeDocsClient {
  markdown: string;
  log: FakeDocsCallLog[] = [];
  replies: Array<{ commentId: string; content: string; replyId: string }> = [];
  batchUpdateCalls: Array<{ docId: string; requests: unknown[] }> = [];
  private replyCounter = 0;
  private runner?: RecordingRunner;

  constructor(initialMarkdown: string) {
    this.markdown = initialMarkdown;
  }

  setMarkdown(md: string): void {
    this.markdown = md;
  }

  /**
   * Wire up a recording runner whose last-captured design-doc content
   * will be applied when `batchUpdate` is called. This mimics Google
   * Docs applying edits to the canonical doc.
   */
  attachRunner(r: RecordingRunner): void {
    this.runner = r;
  }

  async getDocument(docId: string): Promise<docs_v1.Schema$Document> {
    this.log.push({ method: 'getDocument', args: [docId] });
    return mdToMinimalDoc(this.markdown);
  }

  async getAttributions(): Promise<[]> {
    this.log.push({ method: 'getAttributions', args: [] });
    return [];
  }

  async batchUpdate(docId: string, requests: unknown[]): Promise<void> {
    this.batchUpdateCalls.push({ docId, requests });
    this.log.push({ method: 'batchUpdate', args: [docId, requests.length] });
    // Pull the agent's just-written markdown as the new doc state. The
    // orchestrator only calls batchUpdate when the design-doc.md
    // changed, so this update is always meaningful.
    const latest = this.runner?.lastDesignDocMarkdown;
    if (latest != null) this.markdown = latest;
  }

  async replyToComment(docId: string, commentId: string, content: string): Promise<string> {
    const replyId = `reply-${++this.replyCounter}`;
    this.replies.push({ commentId, content, replyId });
    this.log.push({ method: 'replyToComment', args: [docId, commentId, content.slice(0, 40)] });
    return replyId;
  }

  async deleteReply(docId: string, commentId: string, replyId: string): Promise<void> {
    this.log.push({ method: 'deleteReply', args: [docId, commentId, replyId] });
    const idx = this.replies.findIndex((r) => r.replyId === replyId);
    if (idx >= 0) this.replies.splice(idx, 1);
  }

  async updateReply(): Promise<void> {
    // not used by the orchestrator path under test, but present for completeness
  }

  async canAccess(): Promise<boolean> {
    return true;
  }
}

// ── Recording runner (captures worktree paths) ────────────────

class RecordingRunner implements AgentRunner {
  readonly name = 'recording';
  workingDirectories: string[] = [];
  promptHistory: string[] = [];
  /** Last design-doc.md content read from the worktree after the agent ran. */
  lastDesignDocMarkdown: string | null = null;

  constructor(private inner: AgentRunner) {}

  async run(prompt: string, sessionId: string | null, opts?: AgentRunOptions): Promise<AgentRunResult> {
    if (opts?.workingDirectory) this.workingDirectories.push(opts.workingDirectory);
    this.promptHistory.push(prompt);
    const result = await this.inner.run(prompt, sessionId, opts);
    // After the agent completes, capture whatever it wrote to the design
    // doc snapshot — the orchestrator's next step is to apply that via
    // batchUpdate, and the FakeDocsClient uses this value as the new
    // canonical doc state.
    if (opts?.workingDirectory) {
      const designPath = join(opts.workingDirectory, '.codocs', 'design-doc.md');
      try {
        this.lastDesignDocMarkdown = await readFile(designPath, 'utf-8');
      } catch {
        this.lastDesignDocMarkdown = null;
      }
    }
    return result;
  }

  getActiveProcesses(): ActiveAgent[] {
    return this.inner.getActiveProcesses();
  }

  killAll(): string[] {
    return this.inner.killAll();
  }

  getCapabilities(): RunnerCapabilities {
    return this.inner.getCapabilities();
  }
}

// ── In-memory session store ──────────────────────────────────

function createMemorySessionStore(): SessionStore {
  const store = new Map<string, SessionMapping>();
  return {
    getSession: (agent, doc) => store.get(`${agent}:${doc}`) ?? null,
    upsertSession: (agent, doc, sessionId) => {
      store.set(`${agent}:${doc}`, {
        agentName: agent,
        documentId: doc,
        sessionId,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      });
    },
    touchSession: () => {},
    deleteSession: (agent, doc) => {
      store.delete(`${agent}:${doc}`);
    },
  };
}

// ── Git repo scaffolding ─────────────────────────────────────

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd });
  return stdout.trim();
}

/**
 * Create a fresh temp directory containing:
 *   - origin.git (bare repo, acts as "origin")
 *   - repo/       (working clone with one initial commit on main)
 *
 * Returns the absolute path to the working repo.
 */
async function createTempRepo(): Promise<{ workdir: string; repoRoot: string }> {
  const workdir = await mkdtemp(join(tmpdir(), 'codocs-e2e-comments-'));
  const originPath = join(workdir, 'origin.git');
  const repoPath = join(workdir, 'repo');

  await execFile('git', ['init', '--bare', '--initial-branch=main', originPath]);
  await execFile('git', ['clone', originPath, repoPath]);
  // Need a user to commit
  await git(repoPath, 'config', 'user.email', 'e2e@codocs.test');
  await git(repoPath, 'config', 'user.name', 'e2e');
  // Seed a README so the repo has a commit on main.
  await writeFile(join(repoPath, 'README.md'), '# codocs e2e test repo\n', 'utf-8');
  await git(repoPath, 'add', 'README.md');
  await git(repoPath, 'commit', '-m', 'initial commit');
  await git(repoPath, 'push', '-u', 'origin', 'main');

  return { workdir, repoRoot: repoPath };
}

// ── Test primitives ──────────────────────────────────────────

function makeCommentEvent(
  documentId: string,
  content: string,
  opts?: { id?: string; quotedText?: string },
): CommentEvent {
  return {
    eventType: 'google.workspace.drive.comment.v3.created',
    documentId,
    comment: {
      id: opts?.id ?? `c-${Math.random().toString(36).slice(2, 8)}`,
      content,
      author: 'user@example.com',
      quotedText: opts?.quotedText ?? '',
      createdTime: new Date().toISOString(),
      mentions: [],
    },
    eventTime: new Date().toISOString(),
  };
}

interface TestCase {
  title: string;
  fn: (ctx: TestContext) => Promise<void>;
}

interface TestContext {
  workdir: string;
  repoRoot: string;
  docsClient: FakeDocsClient;
  orchestrator: AgentOrchestrator;
  runner: RecordingRunner;
  docId: string;
  debug: string[];
  expect: (cond: boolean, message: string) => void;
}

async function runCase(tc: TestCase, debugFlag: boolean): Promise<boolean> {
  console.log(`\n\u2500\u2500 ${tc.title} \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);

  const { workdir, repoRoot } = await createTempRepo();
  const initialMarkdown = 'Project Alpha design.\n\nThe system currently has basic user login.\n';
  const docsClient = new FakeDocsClient(initialMarkdown);
  const db = await openDatabase(':memory:');
  const queueStore = new QueueStore(db);
  const debug: string[] = [];

  const innerRunner = new ClaudeRunner();
  const runner = new RecordingRunner(innerRunner);
  docsClient.attachRunner(runner);

  const orchestrator = new AgentOrchestrator({
    client: docsClient as unknown as CodocsClient,
    sessionStore: createMemorySessionStore(),
    queueStore,
    agentRunner: runner,
    fallbackAgent: 'aria',
    permissionMode: () => ({ type: 'bypass' }),
    codeMode: () => 'pr',
    githubToken: () => null,
    repoRoot,
    model: () => 'haiku',
    debug: (m) => { debug.push(m); if (debugFlag) console.log(`  [debug] ${m}`); },
    idleDebounceMs: 500,
  });

  let failures = 0;
  const expect = (cond: boolean, message: string) => {
    if (cond) {
      console.log(`  \u2705 ${message}`);
    } else {
      console.log(`  \u274c ${message}`);
      failures++;
    }
  };

  const docId = 'doc-e2e-comments';
  const ctx: TestContext = { workdir, repoRoot, docsClient, orchestrator, runner, docId, debug, expect };

  try {
    await tc.fn(ctx);
  } catch (err: any) {
    console.log(`  \u274c exception: ${err.message ?? err}`);
    if (debugFlag) console.log(err.stack);
    failures++;
  } finally {
    orchestrator.cancelIdleCheck();
    db.close();
    // Always clean up the temp tree, even on failure, so repeated runs
    // don't pile up directories in /tmp.
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  return failures === 0;
}

// ── Helpers for assertions ───────────────────────────────────

/** List the worktree directory names currently on disk. */
async function listWorktrees(repoRoot: string): Promise<string[]> {
  const worktreesDir = join(repoRoot, '.codocs', 'worktrees');
  if (!existsSync(worktreesDir)) return [];
  const entries = await readdir(worktreesDir);
  const out: string[] = [];
  for (const e of entries) {
    const s = await stat(join(worktreesDir, e));
    if (s.isDirectory()) out.push(e);
  }
  return out;
}

/**
 * Read the content of the design-doc.md file inside a given worktree.
 * Returns null if the file doesn't exist (worktree torn down).
 */
async function readDesignDoc(worktreePath: string): Promise<string | null> {
  const designPath = join(worktreePath, '.codocs', 'design-doc.md');
  try {
    return await readFile(designPath, 'utf-8');
  } catch {
    return null;
  }
}

async function syncDocFromWorktree(docsClient: FakeDocsClient, worktreePath: string): Promise<void> {
  const md = await readDesignDoc(worktreePath);
  if (md != null) docsClient.setMarkdown(md);
}

// ── Test cases ───────────────────────────────────────────────

const TC1: TestCase = {
  title: 'TC1  single doc-edit comment',
  fn: async ({ docsClient, orchestrator, runner, repoRoot, docId, expect }) => {
    const before = docsClient.markdown;
    const event = makeCommentEvent(
      docId,
      'Please add a short paragraph at the end of the doc noting that we plan to add rate limiting to our authentication stack. Keep it to one sentence.',
    );
    await orchestrator.handleComment(event);
    await orchestrator.waitForIdle();

    // The agent should have run in a worktree (codeMode=pr).
    expect(runner.workingDirectories.length >= 1, 'agent ran at least once');
    const worktreePath = runner.workingDirectories[0];
    expect(
      worktreePath.includes('.codocs/worktrees/'),
      `agent ran inside a worktree (${worktreePath})`,
    );

    // batchUpdate was called because the doc changed.
    expect(docsClient.batchUpdateCalls.length === 1, 'batchUpdate called exactly once');
    if (docsClient.batchUpdateCalls[0]) {
      expect(
        (docsClient.batchUpdateCalls[0].requests as unknown[]).length > 0,
        'batchUpdate requests were non-empty',
      );
    }

    // A final reply was posted (beyond the thinking emoji).
    const contentReplies = docsClient.replies.filter((r) => r.content !== '\u{1F914}');
    expect(contentReplies.length >= 1, 'a content reply was posted on the comment');

    // The agent wrote something meaningful to the design-doc.md snapshot.
    // Since codeMode=pr, the worktree was either torn down (no code changes)
    // or preserved (code changes). In the no-code case the worktree is gone,
    // so we have to read the edited markdown from the sync'd mock state.
    const postEditMarkdown = docsClient.markdown;
    // Our mock doesn't apply batchUpdate requests — but we can also read
    // the agent's design-doc.md from the worktree IF it's still there.
    const stillOnDisk = await readDesignDoc(worktreePath);
    const effective = stillOnDisk ?? postEditMarkdown;
    expect(effective !== before, 'design doc content changed from the baseline');
    expect(
      /rate limit/i.test(effective),
      'design doc mentions "rate limit"',
    );

    // Because this is a doc-only edit, no commit should exist on any branch
    // beyond the initial "initial commit".
    const log = await git(repoRoot, 'log', '--oneline');
    expect(log.split('\n').length === 1, 'main branch has only the seed commit');

    // Worktree should have been torn down (no code change ⇒ no PR path).
    const wts = await listWorktrees(repoRoot);
    expect(wts.length === 0, `worktree torn down after doc-only edit (have: ${JSON.stringify(wts)})`);
  },
};

const TC2: TestCase = {
  title: 'TC2  two sequential comments use separate worktrees',
  fn: async ({ docsClient, orchestrator, runner, docId, expect }) => {
    const initial = docsClient.markdown;

    await orchestrator.handleComment(
      makeCommentEvent(
        docId,
        'Append a new one-sentence paragraph mentioning that the project supports OAuth for authentication.',
        { id: 'comment-a' },
      ),
    );
    await orchestrator.waitForIdle();

    expect(docsClient.batchUpdateCalls.length === 1, 'first comment triggered one batchUpdate');
    const afterFirst = docsClient.markdown;
    expect(afterFirst !== initial, 'doc state was updated after the first comment');
    expect(/oauth/i.test(afterFirst), 'first edit added OAuth mention');

    await orchestrator.handleComment(
      makeCommentEvent(
        docId,
        'Append another separate one-sentence paragraph mentioning that the project supports audit logging. Preserve the existing OAuth paragraph verbatim.',
        { id: 'comment-b' },
      ),
    );
    await orchestrator.waitForIdle();

    // With the session-fork fix (cross-cwd JSONL copy), exactly 2 runs
    // should happen — one per comment, no retry-with-fresh-session.
    expect(
      runner.workingDirectories.length === 2,
      `runner observed exactly two runs, no session-fork fallback (saw ${runner.workingDirectories.length})`,
    );

    // The isolation invariant: distinct worktrees per comment.
    const uniqueWorktrees = new Set(runner.workingDirectories);
    expect(
      uniqueWorktrees.size === 2,
      `two distinct worktrees were used (saw ${uniqueWorktrees.size})`,
    );

    expect(docsClient.batchUpdateCalls.length === 2, 'two batchUpdate calls (one per comment)');

    const finalMd = docsClient.markdown;
    expect(/oauth/i.test(finalMd), 'final doc still mentions OAuth');
    expect(/audit/i.test(finalMd), 'final doc mentions audit logging');

    const contentReplies = docsClient.replies.filter((r) => r.content !== '\u{1F914}');
    expect(contentReplies.length >= 2, 'two final content replies posted');
  },
};

const TC3: TestCase = {
  title: 'TC3  code-change comment creates a commit',
  fn: async ({ orchestrator, runner, repoRoot, docId, expect }) => {
    await orchestrator.handleComment(
      makeCommentEvent(
        docId,
        'Please create a new file at src/hello.ts that exports a function named greet(name: string): string which returns `Hello, ${name}!`. Keep the file minimal.',
        { id: 'comment-code' },
      ),
    );
    await orchestrator.waitForIdle();

    expect(runner.workingDirectories.length >= 1, 'agent ran');
    const wtPath = runner.workingDirectories[0];
    expect(wtPath.includes('.codocs/worktrees/'), 'agent ran inside a worktree');

    // The worktree should still exist because a code change was made.
    // (For pure doc edits the orchestrator tears down; for code changes
    // it keeps the worktree so follow-up comments can build on it.)
    const wts = await listWorktrees(repoRoot);
    expect(wts.length === 1, `worktree retained after code change (saw ${JSON.stringify(wts)})`);

    // A commit should exist on the new branch.
    if (existsSync(wtPath)) {
      const branchName = await git(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD');
      expect(branchName.startsWith('codocs/'), `branch name is a codocs branch (${branchName})`);

      const log = await git(wtPath, 'log', '--oneline', `main..${branchName}`);
      expect(log.length > 0, `branch has at least one commit beyond main (log: ${log.slice(0, 60)})`);

      // The expected file should be present in the worktree.
      const filePath = join(wtPath, 'src', 'hello.ts');
      expect(existsSync(filePath), `src/hello.ts was created in the worktree (${filePath})`);

      if (existsSync(filePath)) {
        const content = await readFile(filePath, 'utf-8');
        expect(/greet/.test(content), 'src/hello.ts defines greet()');
      }
    }
  },
};

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const debugFlag = args.includes('--debug');
  const filters = args.filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase());

  // Sanity: claude CLI must be available.
  try {
    await execFile('claude', ['--version']);
  } catch (err: any) {
    console.error('Claude CLI not available; cannot run these tests.');
    console.error(err.message ?? err);
    process.exit(2);
  }

  // Sanity: git must be available and usable.
  try {
    await execFile('git', ['--version']);
  } catch (err: any) {
    console.error('Git not available.');
    process.exit(2);
  }

  const all: TestCase[] = [TC1, TC2, TC3];
  const selected = filters.length
    ? all.filter((t) => filters.some((f) => t.title.toLowerCase().includes(f)))
    : all;

  if (selected.length === 0) {
    console.error('No matching test cases.');
    process.exit(2);
  }

  console.log(`Running ${selected.length} comment-flow test case(s) against the real Claude CLI.`);
  console.log('Each test scaffolds a temp git repo with a bare origin and exercises the full');
  console.log('AgentOrchestrator pipeline (worktree creation, agent execution, doc diff apply).\n');

  let passed = 0;
  let failed = 0;

  for (const tc of selected) {
    const ok = await runCase(tc, debugFlag);
    if (ok) passed++;
    else failed++;
  }

  console.log(`\n\u2500\u2500 Results: ${passed} passed, ${failed} failed \u2500\u2500\u2500\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
