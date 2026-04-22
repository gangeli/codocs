/**
 * Eval case shape. Each case is a single <document, comment> scenario that
 * the harness hydrates onto disk, runs the real AgentOrchestrator against,
 * and then scores along three axes: the agent's reply, the final document,
 * and the final code repo state.
 *
 * Design invariant: the document mirrors the code; code is the source of
 * truth. Any case that mutates code behavior MUST also update the doc
 * (category 'feature'). Bug-fix cases (category 'bug-fix') leave the doc
 * byte-identical and only change code so that it starts behaving the way
 * the doc already claims — use Behavior checks (`kind: 'run'`) to verify.
 */

export type Category =
  | 'doc-only'
  | 'bug-fix'
  | 'feature'
  | 'qa'
  | 'ambiguous'
  | 'followup'
  | 'edge'
  | 'safety';

export type CheckTarget = 'reply' | 'doc';

export type Deterministic =
  | { kind: 'regex'; on: CheckTarget; pattern: RegExp; match: boolean; label?: string }
  | { kind: 'exact'; on: CheckTarget; equals: string; label?: string }
  | { kind: 'length'; on: CheckTarget; min?: number; max?: number; label?: string }
  | { kind: 'file-exists'; path: string; expect: boolean; label?: string }
  | { kind: 'file-contains'; path: string; pattern: RegExp; match: boolean; label?: string }
  | { kind: 'grep-count'; path: string; pattern: RegExp; equals?: number; min?: number; max?: number; label?: string }
  /**
   * Scan every file under the worktree matching `pathGlob` (default `src/**\/*`)
   * for `pattern`. `match: true` passes if ANY file matches; `match: false`
   * passes only if NO file matches. Used for safety checks like "no secret
   * anywhere under src" regardless of which file the agent touched.
   */
  | { kind: 'worktree-grep'; pattern: RegExp; match: boolean; pathGlob?: string; label?: string }
  /**
   * Run `git diff main...HEAD` inside the worktree and test `pattern`
   * against the unified-diff output. `match: false` passes if the pattern
   * is not present in the diff (e.g., "no unqualified DROP TABLE").
   */
  | { kind: 'diff-grep'; pattern: RegExp; match: boolean; label?: string }
  | { kind: 'doc-unchanged'; label?: string }
  /**
   * Split baseline and final doc on ## headings and assert that exactly
   * `count` buckets differ (default 1). Used for "change exactly one
   * section" assertions where a judge can't see the baseline.
   */
  | { kind: 'sections-changed'; count: number; label?: string }
  | { kind: 'no-batch-update'; label?: string }
  | { kind: 'batch-update-count'; equals: number; label?: string }
  | {
      kind: 'git';
      assert: GitAssertion;
      /** When `assert` is 'commit-on-branch', optionally assert an exact commit count. */
      equals?: number;
      /** When `assert` is 'commit-on-branch', optionally assert max commits. */
      max?: number;
      label?: string;
    };

export type GitAssertion =
  | 'no-new-commits'       // main has only the seed commit; no codocs/* branches
  | 'branch-pushed'        // exactly one codocs/* branch exists on origin with ≥1 commit
  | 'commit-on-branch'     // the current worktree branch has ≥1 commit beyond main
  | 'worktree-retained'    // a code change → worktree kept (orchestrator convention)
  | 'worktree-torn-down';  // a doc-only edit → worktree removed

export type Judge = {
  kind: 'judge';
  target: 'reply' | 'doc' | 'diff' | 'behavior';
  rubric: string;
  /**
   * Optional ground-truth flavor. If set, the judge is told to specifically
   * evaluate against this truth statement. Keeps rubrics short.
   */
  truth?: string;
  label?: string;
};

/**
 * Behavior check — runs a shell command inside the worktree after the agent
 * finishes and asserts on exit code / stdout / stderr. Used primarily by
 * bug-fix cases to prove the fix actually restored documented behavior.
 *
 * `cwd: 'worktree'` runs inside the codocs-created worktree (where the
 * agent did its work); `cwd: 'repo'` runs inside the main repo root
 * (useful for assertions like "no uncommitted changes on main").
 */
export type Behavior = {
  kind: 'run';
  cmd: string;
  args?: string[];
  cwd: 'worktree' | 'repo';
  expect: {
    exit?: number;
    stdout?: RegExp;
    stderr?: RegExp;
    notStdout?: RegExp;
  };
  label?: string;
};

export type Check = Deterministic | Judge | Behavior;

export interface EvalCase {
  /** Stable ID — used in result filtering and artifact paths. */
  id: string;
  category: Category;
  /** One-line human summary; shows up in the per-case console header. */
  summary: string;
  fixture: {
    /** Directory name under evals/fixtures/codebases/ — copied recursively. */
    codebase: string;
    /** Filename under evals/fixtures/docs/ — copied as-is. */
    doc: string;
  };
  comment: {
    /** Optional quoted text the comment anchors to. */
    quote?: string;
    body: string;
    /** Follow-up on an existing thread: reuse this comment id. */
    threadId?: string;
  };
  /**
   * Optional predecessor that must run first in the same worktree before
   * this case fires. Used by followup cases (F-*) to build a thread.
   */
  predecessor?: Omit<EvalCase, 'predecessor' | 'expect'> & { expect?: EvalCase['expect'] };
  expect: {
    reply: Check[];
    doc: Check[];
    code: Check[];
  };
  notes?: string;
}

export interface CheckResult {
  check: Check;
  passed: boolean;
  detail: string;
  /** Arbitrary extra context attached to the result for artifact output. */
  metadata?: Record<string, unknown>;
}

export interface CaseResult {
  caseId: string;
  category: Category;
  summary: string;
  passed: boolean;
  durationMs: number;
  axes: {
    reply: CheckResult[];
    doc: CheckResult[];
    code: CheckResult[];
  };
  error?: string;
  artifactsDir?: string;
}

export interface RunSummary {
  startedAt: string;
  finishedAt: string;
  totalCases: number;
  passedCases: number;
  byCategory: Record<Category, { total: number; passed: number }>;
  cases: CaseResult[];
}
