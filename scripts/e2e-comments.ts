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
 * IMPORTANT: `FakeDocsClient.batchUpdate` does NOT apply the Docs API
 * `requests` payload. It records the call and substitutes the agent's
 * captured `.codocs/design-doc.md` as the new doc state. That means
 * these tests prove "the orchestrator called batchUpdate with a non-
 * empty request list," but NOT that the requests are semantically
 * correct — diff/request generation is covered by diff.test.ts.
 *
 * Test scenarios:
 *   TC1  single doc-edit comment       — agent writes to design-doc.md,
 *                                        orchestrator calls batchUpdate,
 *                                        worktree torn down afterwards.
 *   TC2  two sequential doc edits      — each comment runs in its OWN
 *                                        worktree; the second sees the
 *                                        first's changes; no session-
 *                                        fork fallback fires.
 *   TC3  code-change comment           — agent creates a source file,
 *                                        orchestrator commits + pushes.
 *   TC4  concurrent code-change pair   — two comments fired together
 *                                        land in two isolated worktrees
 *                                        with no file cross-contamination.
 *   TC5  mixed code + doc edit         — single comment that changes
 *                                        BOTH a source file and the
 *                                        design doc; both branches
 *                                        fire in one processComment.
 *   TC6  thread follow-up              — a second comment event with
 *                                        the same comment.id reuses the
 *                                        existing worktree and adds a
 *                                        second commit on the same
 *                                        branch (rebase path).
 *   TC7  doc merge conflict            — "others" mutate the doc
 *                                        between the snapshot and the
 *                                        theirs-read, forcing a
 *                                        computeDocDiff conflict and
 *                                        triggering a second agent run
 *                                        via buildConflictPrompt.
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
import { openDatabase, QueueStore, CodeTaskStore } from '../packages/db/src/index.js';

import { mkdtemp, rm, writeFile, readFile, readdir, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
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
  /** getDocument call counter. 1-indexed after the first call. */
  getDocumentCalls = 0;
  /** Scheduled markdown swaps: on call N (1-indexed), set markdown to `md` before returning. */
  private scheduledSwaps = new Map<number, string>();
  private replyCounter = 0;
  private runner?: RecordingRunner;

  constructor(initialMarkdown: string) {
    this.markdown = initialMarkdown;
  }

  setMarkdown(md: string): void {
    this.markdown = md;
  }

  /**
   * Schedule a markdown swap for the Nth getDocument call (1-indexed).
   * When that call fires, the internal markdown is replaced with `md`
   * BEFORE the document is returned. Used by TC7 to simulate a
   * concurrent edit by "others" between the orchestrator's base-snapshot
   * read and its later "theirs" read.
   */
  setMarkdownOnGetDocument(nth: number, md: string): void {
    this.scheduledSwaps.set(nth, md);
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
    this.getDocumentCalls += 1;
    const swap = this.scheduledSwaps.get(this.getDocumentCalls);
    if (swap !== undefined) {
      this.markdown = swap;
      this.scheduledSwaps.delete(this.getDocumentCalls);
    }
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
    // Pull the agent's just-written markdown as the new doc state. FIFO
    // ordering keeps the sequential tests honest; concurrent tests
    // avoid doc changes, so the queue isn't drained there.
    const next = this.runner?.designDocQueue.shift();
    if (next != null) this.markdown = next;
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
  /**
   * Most recent design-doc.md captured across all runs (FIFO-drained by
   * FakeDocsClient.batchUpdate). Ordering works for the sequential
   * tests because each comment's run->batchUpdate pair is serialized
   * through its own processComment call; under true concurrency the
   * queue can interleave, but the concurrent test (TC4) makes no doc
   * changes so batchUpdate never fires.
   */
  designDocQueue: string[] = [];
  /** Back-compat: last captured content, convenient for single-shot checks. */
  lastDesignDocMarkdown: string | null = null;

  constructor(private inner: AgentRunner) {}

  async run(prompt: string, sessionId: string | null, opts?: AgentRunOptions): Promise<AgentRunResult> {
    if (opts?.workingDirectory) this.workingDirectories.push(opts.workingDirectory);
    this.promptHistory.push(prompt);
    const result = await this.inner.run(prompt, sessionId, opts);
    if (opts?.workingDirectory) {
      const designPath = join(opts.workingDirectory, '.codocs', 'design-doc.md');
      try {
        const md = await readFile(designPath, 'utf-8');
        this.designDocQueue.push(md);
        this.lastDesignDocMarkdown = md;
      } catch {
        // file may not exist in unusual error paths; ignore
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

/**
 * Stub AgentRunner that just writes a single file inside the working
 * directory and returns a canned stdout. Lets tests exercise the full
 * orchestrator + git pipeline without spinning up the real Claude CLI,
 * which is essential for tests that target flow-control bugs (e.g.
 * post-auto-merge cleanup) rather than agent intelligence.
 */
class StubFileCreatingRunner implements AgentRunner {
  readonly name = 'stub-file';
  constructor(
    private readonly filePath: string,
    private readonly fileContent: string,
    private readonly stdout: string = 'Done.',
  ) {}
  async run(_prompt: string, sessionId: string | null, opts?: AgentRunOptions): Promise<AgentRunResult> {
    if (opts?.workingDirectory) {
      const target = join(opts.workingDirectory, this.filePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, this.fileContent, 'utf-8');
    }
    return {
      sessionId: sessionId ?? 'stub-session',
      exitCode: 0,
      stdout: this.stdout,
      stderr: '',
    };
  }
  getActiveProcesses(): ActiveAgent[] { return []; }
  killAll(): string[] { return []; }
  getCapabilities(): RunnerCapabilities {
    return {
      supportsSessionResume: false,
      supportsSessionFork: false,
      models: [],
      harnessSettings: [],
      supportsPermissionMode: false,
    };
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
async function createTempRepo(): Promise<{ workdir: string; repoRoot: string; originPath: string }> {
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

  return { workdir, repoRoot: repoPath, originPath };
}

/**
 * List branch names present on the bare origin repo (i.e. the branches
 * that have been pushed). Used to assert `pushBranch` actually fired.
 */
async function listOriginBranches(originPath: string): Promise<string[]> {
  const { stdout } = await execFile(
    'git',
    ['--git-dir', originPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
  );
  return stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
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
  /**
   * Optional override of the agent runner. Defaults to a real ClaudeRunner;
   * tests that don't depend on agent intelligence can supply a fast stub
   * (e.g. StubFileCreatingRunner) so they run in <1s and stay deterministic.
   */
  innerRunnerFactory?: () => AgentRunner;
}

interface TestContext {
  workdir: string;
  repoRoot: string;
  originPath: string;
  docsClient: FakeDocsClient;
  orchestrator: AgentOrchestrator;
  runner: RecordingRunner;
  codeTaskStore: CodeTaskStore;
  docId: string;
  debug: string[];
  expect: (cond: boolean, message: string) => void;
}

async function runCase(tc: TestCase, debugFlag: boolean): Promise<boolean> {
  console.log(`\n\u2500\u2500 ${tc.title} \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);

  const { workdir, repoRoot, originPath } = await createTempRepo();
  const initialMarkdown = 'Project Alpha design.\n\nThe system currently has basic user login.\n';

  // Sanity: the mock doc builder must round-trip through docsToMarkdown.
  // Tests assume `docsToMarkdown(mdToMinimalDoc(m)) === m` for the inputs
  // used here; if that invariant ever breaks, every assertion downstream
  // becomes meaningless, so surface it at the top.
  const rt = docsToMarkdown(mdToMinimalDoc(initialMarkdown));
  if (rt !== initialMarkdown) {
    console.log(`  \u274c mdToMinimalDoc round-trip broken: ${JSON.stringify(rt)} !== ${JSON.stringify(initialMarkdown)}`);
    return false;
  }

  const docsClient = new FakeDocsClient(initialMarkdown);
  const db = await openDatabase(':memory:');
  const queueStore = new QueueStore(db);
  const codeTaskStore = new CodeTaskStore(db);
  const debug: string[] = [];

  const innerRunner = tc.innerRunnerFactory ? tc.innerRunnerFactory() : new ClaudeRunner();
  const runner = new RecordingRunner(innerRunner);
  docsClient.attachRunner(runner);

  const orchestrator = new AgentOrchestrator({
    client: docsClient as unknown as CodocsClient,
    sessionStore: createMemorySessionStore(),
    queueStore,
    codeTaskStore,
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
  const ctx: TestContext = { workdir, repoRoot, originPath, docsClient, orchestrator, runner, codeTaskStore, docId, debug, expect };

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

    // Exactly one agent run — no retry via the fresh-session fallback.
    expect(runner.workingDirectories.length === 1, `agent ran exactly once (saw ${runner.workingDirectories.length})`);
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

    // Exactly one final content reply (beyond the thinking emoji).
    const contentReplies = docsClient.replies.filter((r) => r.content !== '\u{1F916} is \u{1F914}');
    expect(contentReplies.length === 1, `exactly one content reply was posted (saw ${contentReplies.length})`);

    // Because this is a doc-only edit, the worktree was torn down — the
    // only observable record of the agent's edit is `docsClient.markdown`,
    // which the mock updated during `batchUpdate` from the captured
    // design-doc snapshot.
    const effective = docsClient.markdown;
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

    const contentReplies = docsClient.replies.filter((r) => r.content !== '\u{1F916} is \u{1F914}');
    expect(contentReplies.length === 2, `exactly two final content replies posted (saw ${contentReplies.length})`);
  },
};

const TC3: TestCase = {
  title: 'TC3  code-change comment auto-merges into main',
  fn: async ({ docsClient, orchestrator, runner, repoRoot, originPath, docId, expect }) => {
    // After commitAll succeeds the orchestrator auto-squash-merges the
    // agent branch into base, advances main via fast-forward, and tears
    // down the worktree + branches. The test asserts the post-merge state
    // (file on main, no worktree, no codocs branch on origin) rather than
    // the now-obsolete "branch retained" view from before the auto-merge
    // feature landed.
    const initialMainSha = await git(repoRoot, 'rev-parse', 'main');

    await orchestrator.handleComment(
      makeCommentEvent(
        docId,
        'Please create a new file at src/hello.ts that exports a function named greet(name: string): string which returns `Hello, ${name}!`. Keep the file minimal.',
        { id: 'comment-code' },
      ),
    );
    await orchestrator.waitForIdle();

    expect(runner.workingDirectories.length === 1, `agent ran exactly once (saw ${runner.workingDirectories.length})`);
    const wtPath = runner.workingDirectories[0];
    expect(wtPath.includes('.codocs/worktrees/'), 'agent ran inside a worktree');

    // Code-only change: no doc edits should have been applied.
    expect(docsClient.batchUpdateCalls.length === 0, `no doc edits triggered (saw ${docsClient.batchUpdateCalls.length})`);

    // Auto-merge cleanup: worktree torn down, main advanced, file on main.
    const wts = await listWorktrees(repoRoot);
    expect(wts.length === 0, `worktree torn down after auto-merge (saw ${JSON.stringify(wts)})`);

    const finalMainSha = await git(repoRoot, 'rev-parse', 'main');
    expect(
      finalMainSha !== initialMainSha,
      `main advanced past the seed commit (was ${initialMainSha.slice(0, 7)}, now ${finalMainSha.slice(0, 7)})`,
    );

    let onMain = '';
    try { onMain = await git(repoRoot, 'show', 'main:src/hello.ts'); } catch { /* surfaced below */ }
    expect(/greet/.test(onMain), `src/hello.ts is on main with greet() (saw: ${onMain.slice(0, 80)})`);

    // No codocs branches remain on origin after deleteRemoteBranch.
    const originBranches = await listOriginBranches(originPath);
    const codocsBranches = originBranches.filter((b) => b.startsWith('codocs/'));
    expect(
      codocsBranches.length === 0,
      `no codocs branches on origin after auto-merge (origin has: ${JSON.stringify(originBranches)})`,
    );
  },
};

const TC4: TestCase = {
  title: 'TC4  concurrent comments serialize via docSerializer; both auto-merge into main',
  fn: async ({ docsClient, orchestrator, runner, repoRoot, originPath, docId, expect }) => {
    // Two code-change comments fired simultaneously on the same doc.
    // The doc-serializer keeps them sequential, so the second worktree is
    // created from main AFTER the first comment's auto-merge has already
    // advanced main. Both files therefore land cleanly on main with no
    // tree-clobbering between merges.
    const initialMainSha = await git(repoRoot, 'rev-parse', 'main');
    const [aResult, bResult] = await Promise.all([
      orchestrator.handleComment(
        makeCommentEvent(
          docId,
          'Create a new file at src/alpha.ts whose only contents are: export const ALPHA_MARKER = "alpha-marker-v1";',
          { id: 'comment-concurrent-a' },
        ),
      ),
      orchestrator.handleComment(
        makeCommentEvent(
          docId,
          'Create a new file at src/beta.ts whose only contents are: export const BETA_MARKER = "beta-marker-v1";',
          { id: 'comment-concurrent-b' },
        ),
      ),
    ]);
    // handleComment returns immediately with empty editSummary in
    // fork-mode; real work finishes during waitForIdle.
    void aResult;
    void bResult;
    await orchestrator.waitForIdle();

    // Two runs in two distinct worktree paths. The paths differ because
    // the first worktree is torn down (post-auto-merge) before the second
    // is created, so the random slug suffix is fresh for each.
    const uniqueWorktrees = new Set(runner.workingDirectories);
    expect(
      uniqueWorktrees.size === 2,
      `exactly two distinct worktree paths (saw ${uniqueWorktrees.size}, total runs: ${runner.workingDirectories.length})`,
    );
    expect(
      runner.workingDirectories.length === 2,
      `no retry-with-fresh-session fallback (runs: ${runner.workingDirectories.length})`,
    );

    // Neither comment should have triggered a doc edit.
    expect(docsClient.batchUpdateCalls.length === 0, `no doc edits triggered (saw ${docsClient.batchUpdateCalls.length})`);

    // Both auto-merges fired: worktrees gone.
    const wts = await listWorktrees(repoRoot);
    expect(wts.length === 0, `both worktrees torn down after auto-merges (saw ${JSON.stringify(wts)})`);

    // main advanced past the seed and now contains BOTH files. Tree
    // safety check: the second auto-merge must take the second worktree's
    // tree built off the already-advanced main, otherwise alpha.ts would
    // get clobbered by the beta merge.
    const finalMainSha = await git(repoRoot, 'rev-parse', 'main');
    expect(finalMainSha !== initialMainSha, `main advanced past the seed commit`);

    let alphaOnMain = '';
    let betaOnMain = '';
    try { alphaOnMain = await git(repoRoot, 'show', 'main:src/alpha.ts'); } catch { /* surfaced below */ }
    try { betaOnMain = await git(repoRoot, 'show', 'main:src/beta.ts'); } catch { /* surfaced below */ }
    expect(
      /ALPHA_MARKER/.test(alphaOnMain) && /alpha-marker-v1/.test(alphaOnMain),
      `src/alpha.ts on main with ALPHA_MARKER (saw: ${alphaOnMain.slice(0, 80)})`,
    );
    expect(
      /BETA_MARKER/.test(betaOnMain) && /beta-marker-v1/.test(betaOnMain),
      `src/beta.ts on main with BETA_MARKER (saw: ${betaOnMain.slice(0, 80)})`,
    );

    // main has exactly 3 commits: seed + alpha auto-merge + beta auto-merge.
    const log = await git(repoRoot, 'log', '--oneline');
    const lineCount = log.split('\n').filter((l) => l.length > 0).length;
    expect(
      lineCount === 3,
      `main has 3 commits: seed + 2 auto-merges (saw ${lineCount}: ${log.replace(/\n/g, ' | ').slice(0, 200)})`,
    );

    // Both codocs branches were deleted from origin after merge.
    const originBranches = await listOriginBranches(originPath);
    const codocsBranches = originBranches.filter((b) => b.startsWith('codocs/'));
    expect(
      codocsBranches.length === 0,
      `no codocs branches on origin (origin has: ${JSON.stringify(originBranches)})`,
    );
  },
};

const TC5: TestCase = {
  title: 'TC5  mixed code + doc edit: code auto-merges and doc edit applies',
  fn: async ({ docsClient, orchestrator, runner, repoRoot, originPath, docId, expect }) => {
    // Single comment that requires BOTH a code change and a doc edit.
    // Guards against a regression where the orchestrator runs only one
    // of its post-hoc detection branches. With deferred auto-merge
    // cleanup, step 3 (doc-diff) runs against the still-alive worktree
    // before step 5 tears it down — so both branches fire end-to-end.
    const before = docsClient.markdown;
    const initialMainSha = await git(repoRoot, 'rev-parse', 'main');

    await orchestrator.handleComment(
      makeCommentEvent(
        docId,
        'Please do BOTH of the following in a single pass: '
        + '(1) create a new file at src/mixed.ts whose only contents are: export const MIX_MARKER = "mix-marker-v1"; '
        + 'AND (2) append a one-sentence paragraph to the design doc stating that we will add rate limiting. '
        + 'Both must be done — do not skip either step.',
        { id: 'comment-mixed' },
      ),
    );
    await orchestrator.waitForIdle();

    expect(runner.workingDirectories.length === 1, `agent ran exactly once (saw ${runner.workingDirectories.length})`);

    // Code branch — auto-merged into main.
    const wts = await listWorktrees(repoRoot);
    expect(wts.length === 0, `worktree torn down after auto-merge (saw ${JSON.stringify(wts)})`);

    const finalMainSha = await git(repoRoot, 'rev-parse', 'main');
    expect(finalMainSha !== initialMainSha, `main advanced past the seed commit`);

    let onMain = '';
    try { onMain = await git(repoRoot, 'show', 'main:src/mixed.ts'); } catch { /* surfaced below */ }
    expect(
      onMain.includes('MIX_MARKER') && onMain.includes('mix-marker-v1'),
      `src/mixed.ts is on main with MIX_MARKER (saw: ${onMain.slice(0, 80)})`,
    );

    const originBranches = await listOriginBranches(originPath);
    const codocsBranches = originBranches.filter((b) => b.startsWith('codocs/'));
    expect(
      codocsBranches.length === 0,
      `no codocs branches on origin after merge (origin has: ${JSON.stringify(originBranches)})`,
    );

    // Doc branch fired: batchUpdate called exactly once, markdown changed.
    expect(docsClient.batchUpdateCalls.length === 1, `batchUpdate called exactly once (saw ${docsClient.batchUpdateCalls.length})`);
    expect(docsClient.markdown !== before, 'design doc content changed from the baseline');
    expect(/rate/i.test(docsClient.markdown), 'design doc mentions rate limiting');
  },
};

const TC6: TestCase = {
  title: 'TC6  follow-up after auto-merge starts a fresh task on a new branch',
  fn: async ({ orchestrator, runner, repoRoot, originPath, codeTaskStore, docId, expect }) => {
    // First comment auto-merges its branch into main. The code task is
    // marked completed, so getByComment (which filters status='active')
    // returns null. A follow-up comment with the same comment.id therefore
    // starts a fresh task — new worktree, new branch — which itself
    // auto-merges. Both files end up on main as separate commits.
    //
    // The original "follow-up reuses the same worktree" semantic only
    // applies when the prior auto-merge bailed (overlap, conflict, mid-
    // flight base movement); that path is exercised separately by the
    // squashMergeIntoBase unit tests and not re-asserted here.
    const threadId = 'comment-thread-followup';

    await orchestrator.handleComment(
      makeCommentEvent(
        docId,
        'Create a new file at src/first.ts whose only contents are: export const FIRST_MARKER = "first-v1";',
        { id: threadId },
      ),
    );
    await orchestrator.waitForIdle();

    expect(runner.workingDirectories.length === 1, `first comment: one run (saw ${runner.workingDirectories.length})`);
    const firstWt = runner.workingDirectories[0];

    // First auto-merge fired: worktree gone, file on main, no active task.
    const wtsAfterFirst = await listWorktrees(repoRoot);
    expect(wtsAfterFirst.length === 0, `worktree torn down after first auto-merge (saw ${JSON.stringify(wtsAfterFirst)})`);
    let firstOnMain = '';
    try { firstOnMain = await git(repoRoot, 'show', 'main:src/first.ts'); } catch { /* surfaced below */ }
    expect(/FIRST_MARKER/.test(firstOnMain), 'src/first.ts on main after first auto-merge');
    expect(
      codeTaskStore.getByComment(docId, threadId) === null,
      'first task no longer "active" after auto-merge marked it completed',
    );

    // Follow-up comment with the SAME comment.id. existingTask lookup
    // returns null (filtered out), so this becomes a fresh task with a
    // new branch + worktree, NOT a reuse of the gone-and-deleted prior.
    await orchestrator.handleComment(
      makeCommentEvent(
        docId,
        'Create a new file at src/second.ts whose only contents are: export const SECOND_MARKER = "second-v2";',
        { id: threadId },
      ),
    );
    await orchestrator.waitForIdle();

    expect(runner.workingDirectories.length === 2, `total runs after follow-up: 2 (saw ${runner.workingDirectories.length})`);
    const secondWt = runner.workingDirectories[1];
    expect(secondWt !== firstWt, `follow-up used a fresh worktree (${secondWt} !== ${firstWt})`);

    // Both auto-merges complete: no worktrees, both files on main.
    const wtsAfterSecond = await listWorktrees(repoRoot);
    expect(wtsAfterSecond.length === 0, `worktree torn down after second auto-merge (saw ${JSON.stringify(wtsAfterSecond)})`);
    let firstStill = '';
    let secondOnMain = '';
    try { firstStill = await git(repoRoot, 'show', 'main:src/first.ts'); } catch { /* surfaced below */ }
    try { secondOnMain = await git(repoRoot, 'show', 'main:src/second.ts'); } catch { /* surfaced below */ }
    expect(/FIRST_MARKER/.test(firstStill), 'src/first.ts still on main after second auto-merge');
    expect(/SECOND_MARKER/.test(secondOnMain), 'src/second.ts on main after second auto-merge');

    // main has 3 commits: seed + two auto-merged squashes.
    const log = await git(repoRoot, 'log', '--oneline');
    const lineCount = log.split('\n').filter((l) => l.length > 0).length;
    expect(
      lineCount === 3,
      `main has 3 commits (saw ${lineCount}: ${log.replace(/\n/g, ' | ').slice(0, 200)})`,
    );

    // No codocs branches on origin (deleteRemoteBranch fired on each merge).
    const originBranches = await listOriginBranches(originPath);
    const codocsBranches = originBranches.filter((b) => b.startsWith('codocs/'));
    expect(
      codocsBranches.length === 0,
      `no codocs branches on origin (origin has: ${JSON.stringify(originBranches)})`,
    );
  },
};

const TC7: TestCase = {
  title: 'TC7  doc merge conflict triggers a conflict-resolution sub-run',
  fn: async ({ docsClient, orchestrator, runner, docId, expect }) => {
    // Set up a doc with two paragraphs. The agent will rewrite the second
    // one; "others" will ALSO rewrite the second one between the
    // orchestrator's base snapshot and its "theirs" read. The two edits
    // are incompatible, forcing a merge conflict that the orchestrator
    // resolves via a second agent run (orchestrator.ts:812–824).
    const original = 'Line A.\n\nLine B.\n';
    const concurrent = 'Line A.\n\nLine D, edited by someone else.\n';
    docsClient.setMarkdown(original);

    // getDocument call accounting:
    //   call #1 — handleComment (agent assignment)
    //   call #2 — processComment base snapshot
    //   call #3 — processComment "theirs" read (post-agent)
    // Swap to the concurrent version right at call #3 so the base is
    // clean but theirs has diverged.
    docsClient.setMarkdownOnGetDocument(3, concurrent);

    await orchestrator.handleComment(
      makeCommentEvent(
        docId,
        'In the design doc, replace the "Line B." paragraph with "Line C." Preserve Line A unchanged.',
        { id: 'comment-conflict' },
      ),
    );
    await orchestrator.waitForIdle();

    // Main run + conflict-resolution sub-run = exactly 2 runs.
    expect(
      runner.workingDirectories.length === 2,
      `main run + conflict resolution: 2 runs (saw ${runner.workingDirectories.length})`,
    );

    // Both runs happened in the SAME worktree — the conflict resolver
    // reuses the current worktree, not a fresh one.
    const uniqueWorktrees = new Set(runner.workingDirectories);
    expect(uniqueWorktrees.size === 1, `both runs used the same worktree (saw ${uniqueWorktrees.size})`);

    // The second prompt is the conflict-resolution prompt, which contains
    // the literal word "conflict" (see buildConflictPrompt in prompt.ts).
    // This confirms the orchestrator actually took the resolver branch
    // rather than, say, running the main path twice.
    expect(
      /conflict/i.test(runner.promptHistory[1] ?? ''),
      'second run received a conflict-resolution prompt',
    );

    // batchUpdate was called exactly once after the merge was resolved.
    expect(
      docsClient.batchUpdateCalls.length === 1,
      `batchUpdate called exactly once after merge (saw ${docsClient.batchUpdateCalls.length})`,
    );

    // Exactly one final content reply was posted.
    const contentReplies = docsClient.replies.filter((r) => r.content !== '\u{1F916} is \u{1F914}');
    expect(contentReplies.length === 1, `exactly one content reply (saw ${contentReplies.length})`);
  },
};

const TC8: TestCase = {
  title: 'TC8  code-only auto-merge does not throw on missing design-doc snapshot',
  // Stub runner: the bug is in orchestrator flow control after the agent
  // commits, so a minimal "create one file" stub is sufficient to drive
  // the auto-squash-merge path. Keeping this off the real Claude CLI makes
  // the test fast (<1s) and immune to model variance.
  innerRunnerFactory: () => new StubFileCreatingRunner(
    'src/merged.ts',
    'export const MERGED_MARKER = "merged-v1";\n',
  ),
  fn: async ({ docsClient, orchestrator, runner, repoRoot, originPath, docId, debug, expect }) => {
    // After the agent commits, the orchestrator runs squashMergeIntoBase.
    // On success it advances `main` (ff), tears down the worktree, and
    // deletes the branch. The known bug: the doc-diff detection step
    // (orchestrator.ts step 3) then tries to read the design-doc snapshot
    // from the just-removed worktree, throws ENOENT, and the queue item is
    // marked failed even though every code-side action succeeded.
    const initialMainSha = await git(repoRoot, 'rev-parse', 'main');

    const commentId = 'comment-merge';
    await orchestrator.handleComment(
      makeCommentEvent(
        docId,
        'Add src/merged.ts.',
        { id: commentId },
      ),
    );
    await orchestrator.waitForIdle();

    expect(runner.workingDirectories.length === 1, `agent ran exactly once (saw ${runner.workingDirectories.length})`);

    // Auto-merge fired: main advanced past the seed commit and now contains
    // the new file via the merged tree.
    const finalMainSha = await git(repoRoot, 'rev-parse', 'main');
    expect(
      finalMainSha !== initialMainSha,
      `main advanced past the seed commit (was ${initialMainSha.slice(0, 7)}, now ${finalMainSha.slice(0, 7)})`,
    );
    let onMain = '';
    try { onMain = await git(repoRoot, 'show', 'main:src/merged.ts'); } catch { /* surfaced via expect below */ }
    expect(/MERGED_MARKER/.test(onMain), `src/merged.ts is on main with MERGED_MARKER (saw: ${onMain.slice(0, 80)})`);

    // Worktree was torn down by the auto-merge cleanup.
    const wts = await listWorktrees(repoRoot);
    expect(wts.length === 0, `worktree torn down after auto-merge (saw ${JSON.stringify(wts)})`);

    // The agent branch was removed locally and from origin.
    const localBranches = (await git(repoRoot, 'branch', '--list', 'codocs/*')).split('\n').filter((b) => b.trim().length > 0);
    expect(localBranches.length === 0, `no codocs branches locally (saw ${JSON.stringify(localBranches)})`);
    const originBranches = await listOriginBranches(originPath);
    const codocsBranches = originBranches.filter((b) => b.startsWith('codocs/'));
    expect(codocsBranches.length === 0, `no codocs branches on origin (saw ${JSON.stringify(codocsBranches)})`);

    // No doc edits triggered (this is a code-only comment).
    expect(docsClient.batchUpdateCalls.length === 0, `no doc edits triggered (saw ${docsClient.batchUpdateCalls.length})`);

    // ── Bug check ──
    // processComment must NOT throw after the worktree teardown. If it
    // did, drainQueue logs "Failed to process queue item ..." and the
    // queue row is marked failed. Both signals are independent and
    // both are checked so a regression can't sneak past either alarm.
    const queueErrors = debug.filter((d) => /Failed to process queue item/i.test(d));
    expect(queueErrors.length === 0, `no queue-failure log lines (saw: ${JSON.stringify(queueErrors)})`);
    const procErrors = debug.filter((d) => /Error during processing/i.test(d));
    expect(procErrors.length === 0, `no "Error during processing" log lines (saw: ${JSON.stringify(procErrors)})`);
    const enoentLines = debug.filter((d) => /ENOENT/i.test(d) && /design-doc/i.test(d));
    expect(enoentLines.length === 0, `no ENOENT against design-doc.md (saw: ${JSON.stringify(enoentLines)})`);

    // The user-visible reply should be the agent's stdout, not an error
    // string. There must be exactly one final content reply (beyond the
    // thinking emoji) and it must not mention the bug's signature.
    const contentReplies = docsClient.replies.filter((r) => r.content !== '\u{1F916} is \u{1F914}');
    expect(contentReplies.length === 1, `exactly one content reply (saw ${contentReplies.length})`);
    if (contentReplies.length === 1) {
      const reply = contentReplies[0].content;
      expect(
        !/ENOENT|design-doc\.md/i.test(reply),
        `reply does not mention the ENOENT/design-doc bug (saw: ${reply.slice(0, 120)})`,
      );
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

  const all: TestCase[] = [TC1, TC2, TC3, TC4, TC5, TC6, TC7, TC8];
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
