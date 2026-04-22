# Codocs evaluation suite

End-to-end evals for the comment → agent → reply/doc/code pipeline.

## Running

```bash
make eval                          # full suite (~38 cases, spawns real Claude agents)
make eval FILTER=BF-01             # one case
make eval FILTER=bug-fix           # one category
make eval/judge                    # judge-prompt calibration (~30 synthetic cases, no agent)
make eval/judge FILTER=negation    # one calibration group
```

Results print per-category and per-case. Artifacts (JSON summary) land in `evals/runs/<timestamp>/`.

Environment variables:
- `ANTHROPIC_API_KEY` — required. The judge uses Sonnet (`claude-sonnet-4-6`).
- `DEBUG_KEEP_TMP=1` — keep per-case temp dirs for post-mortem inspection.
- `CONCURRENCY=<n>` — cap parallel cases (default 2 — each spawns a real Claude agent).

## Layout

```
evals/
  types.ts                        EvalCase / Check / CheckResult
  harness/
    hydrate.ts                    per-case git repo + fixture copy + teardown
    fake-docs.ts                  FakeDocsClient + RecordingRunner (from e2e-comments)
    scorers.ts                    dispatcher for deterministic + behavior checks
    judge.ts                      batched Sonnet judge (one call per case)
    run-case.ts                   single-case runner (wires orchestrator, runs checks)
    run.ts                        CLI entrypoint ← `make eval`
  cases/
    doc-only.eval.ts              10 cases
    bug-fix.eval.ts               7 cases (code only changes, doc unchanged)
    feature.eval.ts               8 cases (code + doc in lockstep)
    qa.eval.ts                    5 cases (read-only; agent must not edit)
    ambiguous.eval.ts             4 cases (clarify / decline / narrow interpretation)
    followup.eval.ts              3 cases (thread follow-ups, shared worktree)
    edge.eval.ts                  3 cases (missing anchor, code-in-doc, etc.)
    safety.eval.ts                2 cases (secrets, destructive ops)
  fixtures/
    codebases/
      cb-auth/    tiny HTTP service — /login + /users (has intentional bugs for BF-01, BF-06)
      cb-cli/     tiny CLI — greet/deploy/serve (has intentional bugs for BF-03, BF-04, BF-05)
      cb-etl/     tiny pipeline — ingest/transform/load (has intentional bugs for BF-02, BF-07)
      cb-empty/   placeholder
    docs/
      doc-auth.md  mirrors cb-auth
      doc-cli.md   mirrors cb-cli
      doc-etl.md   mirrors cb-etl
      doc-scratch.md  bullet-heavy meeting notes (used by DO-04)
  judge-calibration/
    cases.ts      ~30 synthetic (rubric, artifact, expected-verdict) tuples
    run.ts        CLI entrypoint ← `make eval/judge`
  runs/           timestamped artifact dirs (gitignored)
```

## Design invariants

- **Doc mirrors code; code is source of truth.** Any case that changes code behavior MUST also update the doc (see `feature.eval.ts`). Bug-fix cases leave the doc byte-identical and verify the fix with Behavior checks (`kind: 'run'`) that execute probe scripts.
- **Three axes, all must pass.** A case fails if any of reply / doc / code checks fail.
- **Judge batched per case.** Every `{kind: 'judge'}` check in a case is answered in ONE Sonnet call with system-prompt caching.
- **Fixtures live in files, not strings.** Each case references a codebase dir + doc filename; harness copies them onto disk per run.

## When to run what

| When | Command |
|---|---|
| Iterating on the agent prompt | `make eval FILTER=<narrow>` |
| Iterating on the judge prompt | `make eval/judge` — fast (~5s), no real agent |
| Before a release | `make eval` — full suite |

## Why hand-rolled (vs evalite)

We considered evalite. The current blocker is that evalite v1 beta requires `@vitest/runner@^4` while the workspace uses vitest 2, and its `better-sqlite3` peer dep won't build from source on Node 25. The harness here is ~600 LOC and mirrors the `scripts/e2e-comments.ts` patterns the project already uses. Swap in evalite when v1 stabilizes on vitest 4 and/or the better-sqlite3 prebuilt catches up.
