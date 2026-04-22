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
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { EvalCase, CaseResult, CheckResult, Judge, Check } from '../types.js';
import { FakeDocsClient, RecordingRunner, getLastReplyForComment } from './fake-docs.js';
import { hydrate, teardown } from './hydrate.js';
import { runDeterministic, runBehavior, type RunContext } from './scorers.js';
import { batchJudge, type JudgeItem } from './judge.js';

const execFile = promisify(execFileCb);

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
 * than scorers.ts because it depends on RunContext + baseline diffs + git.
 *
 * Judge targets expose progressively more context:
 *   'reply'    — just the agent's reply text.
 *   'doc'      — final doc + baseline + what changed (headings touched).
 *                The judge sees before/after so it can reason about
 *                "section X was preserved" / "section Y was reworded".
 *   'diff'     — doc diff PLUS code diff (git diff main...HEAD) PLUS a
 *                list of committed files, so safety / change-shape
 *                rubrics can look at what actually landed on disk.
 *   'behavior' — post-run file listing for the worktree and any code
 *                diff. For exit-code / stdout rubrics prefer a `run`
 *                behavior check.
 */
async function renderJudgeArtifact(judge: Judge, ctx: RunContext): Promise<string> {
  switch (judge.target) {
    case 'reply':
      return ctx.reply ?? '(no reply posted)';
    case 'doc':
      return renderDocArtifact(ctx);
    case 'diff':
      return renderDiffArtifact(ctx);
    case 'behavior':
      return renderBehaviorArtifact(ctx);
  }
}

function renderDocArtifact(ctx: RunContext): string {
  if (ctx.baselineDoc === ctx.finalDoc) {
    return [
      '<DOC_STATE>unchanged from baseline</DOC_STATE>',
      '<FINAL_DOC>',
      ctx.finalDoc,
      '</FINAL_DOC>',
    ].join('\n');
  }
  return [
    '<BASELINE_DOC>',
    ctx.baselineDoc,
    '</BASELINE_DOC>',
    '<FINAL_DOC>',
    ctx.finalDoc,
    '</FINAL_DOC>',
    '<NOTE>The doc was modified. Judge the FINAL_DOC against the rubric; use BASELINE_DOC only to verify claims like "section X preserved" or "only Y was changed".</NOTE>',
  ].join('\n');
}

async function renderDiffArtifact(ctx: RunContext): Promise<string> {
  const parts: string[] = [];
  if (ctx.baselineDoc === ctx.finalDoc) {
    parts.push('<DOC_DIFF>(no doc changes)</DOC_DIFF>');
  } else {
    parts.push('<DOC_DIFF>');
    parts.push(`--- baseline\n+++ final`);
    parts.push(unifiedDiffApprox(ctx.baselineDoc, ctx.finalDoc));
    parts.push('</DOC_DIFF>');
  }
  const code = await getCodeContext(ctx);
  parts.push(code);
  return parts.join('\n');
}

async function renderBehaviorArtifact(ctx: RunContext): Promise<string> {
  return [
    `<WORKTREE_PATH>${ctx.worktreePath ?? 'none'}</WORKTREE_PATH>`,
    await getCodeContext(ctx),
    '<NOTE>For exit codes / stdout assertions prefer a `run` behavior check over the judge.</NOTE>',
  ].join('\n');
}

async function getCodeContext(ctx: RunContext): Promise<string> {
  if (!ctx.worktreePath || !existsSync(ctx.worktreePath)) {
    return '<CODE_DIFF>(no worktree — no code changes)</CODE_DIFF>';
  }
  let diff = '';
  let files: string[] = [];
  try {
    const { stdout } = await execFile('git', ['diff', 'main...HEAD'], {
      cwd: ctx.worktreePath, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
    });
    diff = stdout;
  } catch { /* no commits yet */ }
  try {
    const { stdout } = await execFile('git', ['diff', '--name-status', 'main...HEAD'], {
      cwd: ctx.worktreePath, maxBuffer: 1 * 1024 * 1024, encoding: 'utf8',
    });
    files = stdout.split('\n').filter(Boolean);
  } catch { /* ditto */ }
  const trimmed = diff.length > 8000 ? diff.slice(0, 8000) + '\n…(truncated)…' : diff;
  return [
    '<COMMITTED_FILES>',
    files.length === 0 ? '(no committed changes)' : files.join('\n'),
    '</COMMITTED_FILES>',
    '<CODE_DIFF>',
    trimmed || '(empty)',
    '</CODE_DIFF>',
  ].join('\n');
}

function unifiedDiffApprox(a: string, b: string): string {
  // Minimal diff: mark every distinct line with '-' from a and '+' from b.
  // Enough signal for the judge without shipping a real diff algorithm.
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const setA = new Set(aLines);
  const setB = new Set(bLines);
  const out: string[] = [];
  for (const l of aLines) if (!setB.has(l)) out.push(`- ${l}`);
  for (const l of bLines) if (!setA.has(l)) out.push(`+ ${l}`);
  return out.slice(0, 400).join('\n');
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
    // Default to Sonnet: Haiku is too weak to surface meaningful prompt
    // regressions, Opus is too expensive for routine runs. Override via
    // opts.model / CLI --model=<alias>.
    model: () => (opts.model ?? 'sonnet'),
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
          item: { id, judge: chk, artifact: await renderJudgeArtifact(chk, ctx) },
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
