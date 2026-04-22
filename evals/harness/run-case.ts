/**
 * Execute a single EvalCase end-to-end.
 *
 * Order of operations:
 *   1. Hydrate the fixture (temp dir, bare origin, working clone, seed commit).
 *   2. Wire a FakeDocsClient + RecordingRunner + in-memory stores + real AgentOrchestrator.
 *   3. If the case has a predecessor (follow-up thread), run it first on the same orchestrator.
 *   4. Fire the case's CommentEvent and wait for idle.
 *   5. Collect a RunContext and dispatch all deterministic + behavior checks.
 *   6. Batch every Judge check into ONE Sonnet call and merge its verdicts.
 *   7. Tear down (unless DEBUG_KEEP_TMP=1) and return a CaseResult.
 */
import {
  AgentOrchestrator,
  ClaudeRunner,
  type CodocsClient,
  type CommentEvent,
  type SessionStore,
  type SessionMapping,
} from '@codocs/core';
import { openDatabase, QueueStore, CodeTaskStore } from '@codocs/db';

import { existsSync } from 'node:fs';
import type { EvalCase, CaseResult, CheckResult, Judge, Check } from '../types.js';
import { FakeDocsClient, RecordingRunner, getLastReplyForComment } from './fake-docs.js';
import { hydrate, teardown } from './hydrate.js';
import { runDeterministic, runBehavior, type RunContext } from './scorers.js';
import { batchJudge, type JudgeItem } from './judge.js';

function makeCommentEvent(docId: string, body: string, quotedText: string | undefined, id: string): CommentEvent {
  return {
    eventType: 'google.workspace.drive.comment.v3.created',
    documentId: docId,
    comment: {
      id,
      content: body,
      author: 'eval@codocs.test',
      quotedText: quotedText ?? '',
      createdTime: new Date().toISOString(),
      mentions: [],
    },
    eventTime: new Date().toISOString(),
  };
}

function memorySessionStore(): SessionStore {
  const store = new Map<string, SessionMapping>();
  return {
    getSession: (a, d) => store.get(`${a}:${d}`) ?? null,
    upsertSession: (a, d, sid) => {
      store.set(`${a}:${d}`, {
        agentName: a, documentId: d, sessionId: sid,
        createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(),
      });
    },
    touchSession: () => {},
    deleteSession: (a, d) => { store.delete(`${a}:${d}`); },
  };
}

/**
 * Render a check's target artifact (for the judge). Kept in run-case rather
 * than scorers.ts because it depends on RunContext + baseline diffs.
 */
function renderJudgeArtifact(judge: Judge, ctx: RunContext): string {
  switch (judge.target) {
    case 'reply':
      return ctx.reply ?? '(no reply posted)';
    case 'doc':
      return ctx.finalDoc;
    case 'diff':
      return simpleDiff(ctx.baselineDoc, ctx.finalDoc);
    case 'behavior':
      // For behavior, we expose the post-run worktree state as a
      // concise file listing so the judge can reason about it. For
      // rich behavior (stdout/exit codes) use a `run` check instead.
      return `(worktree path: ${ctx.worktreePath ?? 'none'})`;
  }
}

function simpleDiff(a: string, b: string): string {
  if (a === b) return '(no changes)';
  // Small, human-readable shape: before/after. The doc is small enough
  // that giving the judge both halves beats re-implementing unified diff.
  return `--- before ---\n${a}\n--- after ---\n${b}`;
}

export interface RunCaseOptions {
  model?: string;
  debug?: boolean;
}

export async function runCase(tc: EvalCase, opts: RunCaseOptions = {}): Promise<CaseResult> {
  const started = Date.now();
  const { workdir, repoRoot, originPath, initialMarkdown } =
    await hydrate(tc.fixture.codebase, tc.fixture.doc);

  const docsClient = new FakeDocsClient(initialMarkdown);
  const db = await openDatabase(':memory:');
  const queueStore = new QueueStore(db);
  const codeTaskStore = new CodeTaskStore(db);
  const runner = new RecordingRunner(new ClaudeRunner());
  docsClient.attachRunner(runner);

  const orchestrator = new AgentOrchestrator({
    client: docsClient as unknown as CodocsClient,
    sessionStore: memorySessionStore(),
    queueStore,
    codeTaskStore,
    agentRunner: runner,
    fallbackAgent: 'aria',
    permissionMode: () => ({ type: 'bypass' }),
    codeMode: () => 'pr',
    githubToken: () => null,
    repoRoot,
    model: () => (opts.model ?? 'haiku'),
    debug: (m) => { if (opts.debug) console.error(`  [dbg] ${m}`); },
    idleDebounceMs: 500,
  });

  const docId = `doc-${tc.id}`;
  let runError: string | undefined;

  try {
    // Predecessor (optional, for follow-up cases).
    if (tc.predecessor) {
      const p = tc.predecessor;
      const predId = p.comment.threadId ?? `${tc.id}-pred`;
      await orchestrator.handleComment(makeCommentEvent(docId, p.comment.body, p.comment.quote, predId));
      await orchestrator.waitForIdle();
    }

    // Main comment event.
    const commentId = tc.comment.threadId ?? `${tc.id}-main`;
    await orchestrator.handleComment(
      makeCommentEvent(docId, tc.comment.body, tc.comment.quote, commentId),
    );
    await orchestrator.waitForIdle();

    const ctx: RunContext = {
      finalDoc: docsClient.markdown,
      baselineDoc: initialMarkdown,
      reply: getLastReplyForComment(docsClient, commentId),
      batchUpdateCount: docsClient.batchUpdateCalls.length,
      worktreePath: pickWorktree(runner.workingDirectories, tc.comment.threadId != null),
      repoRoot,
      originPath,
    };

    const reply = await scoreAxis(tc.expect.reply, ctx, 'r');
    const doc = await scoreAxis(tc.expect.doc, ctx, 'd');
    const code = await scoreAxis(tc.expect.code, ctx, 'c');

    // Collect every judge check across axes and batch into one call.
    const judgeItems: Array<{ axisKey: 'reply' | 'doc' | 'code'; idx: number; item: JudgeItem }> = [];
    for (const axisKey of ['reply', 'doc', 'code'] as const) {
      const axisChecks = tc.expect[axisKey];
      const axisResults = axisKey === 'reply' ? reply : axisKey === 'doc' ? doc : code;
      for (let i = 0; i < axisChecks.length; i += 1) {
        const chk = axisChecks[i];
        if (chk.kind !== 'judge') continue;
        const id = `${axisKey[0]}${i}`;
        judgeItems.push({
          axisKey, idx: i,
          item: { id, judge: chk, artifact: renderJudgeArtifact(chk, ctx) },
        });
        axisResults[i] = { check: chk, passed: false, detail: 'pending judge' };
      }
    }

    if (judgeItems.length > 0) {
      const verdicts = await batchJudge(judgeItems.map((j) => j.item));
      for (const j of judgeItems) {
        const v = verdicts[j.item.id] ?? { pass: false, reason: 'judge omitted' };
        const result: CheckResult = {
          check: j.item.judge,
          passed: v.pass,
          detail: v.reason,
          metadata: { judge: true, verdict: v },
        };
        if (j.axisKey === 'reply') reply[j.idx] = result;
        else if (j.axisKey === 'doc') doc[j.idx] = result;
        else code[j.idx] = result;
      }
    }

    const passed =
      reply.every((r) => r.passed) &&
      doc.every((r) => r.passed) &&
      code.every((r) => r.passed);

    return {
      caseId: tc.id,
      category: tc.category,
      summary: tc.summary,
      passed,
      durationMs: Date.now() - started,
      axes: { reply, doc, code },
    };
  } catch (err) {
    runError = (err as Error).message ?? String(err);
    if (opts.debug) console.error((err as Error).stack);
    return {
      caseId: tc.id, category: tc.category, summary: tc.summary,
      passed: false, durationMs: Date.now() - started,
      axes: {
        reply: tc.expect.reply.map((c) => ({ check: c, passed: false, detail: 'case failed before scoring' })),
        doc: tc.expect.doc.map((c) => ({ check: c, passed: false, detail: 'case failed before scoring' })),
        code: tc.expect.code.map((c) => ({ check: c, passed: false, detail: 'case failed before scoring' })),
      },
      error: runError,
    };
  } finally {
    orchestrator.cancelIdleCheck();
    db.close();
    await teardown(workdir);
  }
}

/**
 * Resolve which run to inspect. For thread follow-ups the last run is the
 * one we care about; for everything else the first (and only) run.
 */
function pickWorktree(dirs: string[], isThreadFollowup: boolean): string | null {
  if (dirs.length === 0) return null;
  const target = isThreadFollowup ? dirs[dirs.length - 1] : dirs[0];
  return existsSync(target) ? target : null;
}

async function scoreAxis(
  checks: Check[],
  ctx: RunContext,
  _prefix: string,
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const chk of checks) {
    if (chk.kind === 'judge') {
      // Placeholder — batch-filled after this pass.
      out.push({ check: chk, passed: false, detail: 'pending judge' });
    } else if (chk.kind === 'run') {
      out.push(await runBehavior(chk, ctx));
    } else {
      out.push(await runDeterministic(chk, ctx));
    }
  }
  return out;
}
