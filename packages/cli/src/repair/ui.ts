/**
 * Orchestrates the Repair TUI screen: render, dispatch user actions,
 * re-run checks between fixes. Also handles --no-tui and --auto modes.
 */

import React from 'react';
import { render } from 'ink';
import { Repair, type RepairAction } from '../tui/index.js';
import { applyFix, runHealthChecks, sortIssues } from './runner.js';
import type { FixResult, Issue, RepairContext, Severity } from './types.js';

export interface RepairOutcome {
  /** True if all `error`-severity issues were resolved. */
  resolved: boolean;
  /** Issues still outstanding when the UI exits. */
  remaining: Issue[];
}

export interface RepairUiOptions {
  auto: boolean;
  useTui: boolean;
  /** Header message shown at the top of the TUI. */
  headerMessage?: string;
  /**
   * Re-run checks after a fix is applied or when the user hits 'r'.
   * Defaults to runHealthChecks. Startup uses runStartupChecks so the
   * list doesn't balloon with unrelated health warnings mid-fix.
   */
  rerunChecks?: (ctx: RepairContext) => Promise<Issue[]>;
}

/** Transient notification shown above the issue list after a fix runs. */
export interface RepairToast {
  ok: boolean;
  message: string;
}

export async function runRepairUi(
  initialIssues: Issue[],
  ctx: RepairContext,
  opts: RepairUiOptions,
): Promise<RepairOutcome> {
  const rerunChecks = opts.rerunChecks ?? runHealthChecks;
  const results = new Map<string, FixResult>();
  let issues = sortIssues(initialIssues);

  // --auto: apply every non-destructive fix, then re-check and return.
  if (opts.auto) {
    for (const issue of issues) {
      for (const fix of issue.fixes) {
        if (fix.destructive) continue;
        const r = await applyFix(fix, ctx, issue);
        results.set(`${issue.code}:${fix.id}`, r);
      }
    }
    issues = sortIssues(await rerunChecks(ctx));
  }

  if (!opts.useTui) {
    printIssuesPlain(issues, results);
    return outcome(issues);
  }

  if (issues.length === 0) {
    // Nothing to do in the TUI.
    return outcome(issues);
  }

  return new Promise<RepairOutcome>((resolve) => {
    let currentIssues = issues;
    let busy = false;
    let toast: RepairToast | null = null;

    const draw = () => {
      instance.rerender(
        React.createElement(Repair, {
          issues: currentIssues,
          results,
          busy,
          toast,
          headerMessage: opts.headerMessage,
          onAction: handle,
        }),
      );
    };

    const handle = async (action: RepairAction) => {
      if (action.type === 'quit') {
        instance.unmount();
        resolve(outcome(currentIssues));
        return;
      }
      if (action.type === 'rerun') {
        busy = true;
        toast = null;
        draw();
        currentIssues = sortIssues(await rerunChecks(ctx));
        busy = false;
        toast = { ok: true, message: `Re-checked — ${currentIssues.length} issue${currentIssues.length === 1 ? '' : 's'} remaining` };
        draw();
        return;
      }
      if (action.type === 'apply-fix') {
        busy = true;
        toast = null;
        draw();
        const r = await applyFix(action.fix, ctx, action.issue);
        results.set(`${action.issue.code}:${action.fix.id}`, r);
        const before = currentIssues.length;
        currentIssues = sortIssues(await rerunChecks(ctx));
        const delta = before - currentIssues.length;
        busy = false;
        toast = {
          ok: r.ok,
          message: r.ok
            ? `${action.fix.label}: ${r.message}${delta > 0 ? ` · ${delta} issue${delta === 1 ? '' : 's'} cleared` : ''}`
            : `${action.fix.label}: ${r.message}`,
        };
        draw();
      }
    };

    const instance = render(
      React.createElement(Repair, {
        issues: currentIssues,
        results,
        busy: false,
        toast: null,
        headerMessage: opts.headerMessage,
        onAction: handle,
      }),
      { exitOnCtrlC: true },
    );
  });
}

function outcome(issues: Issue[]): RepairOutcome {
  const errors = issues.filter((i) => i.severity === 'error');
  return { resolved: errors.length === 0, remaining: issues };
}

function severityLabel(s: Severity): string {
  return s.toUpperCase();
}

function printIssuesPlain(issues: Issue[], results: Map<string, FixResult>): void {
  if (issues.length === 0) {
    console.log('Everything looks healthy.');
    return;
  }
  console.log(`Found ${issues.length} issue(s):\n`);
  for (const issue of issues) {
    console.log(`[${severityLabel(issue.severity)}] ${issue.title}`);
    console.log(`  ${issue.detail}`);
    if (issue.fixes.length > 0) {
      console.log('  Fixes:');
      for (const f of issue.fixes) {
        const marker = f.destructive ? '!' : '-';
        console.log(`    ${marker} ${f.label} — ${f.description}`);
      }
    }
    for (const f of issue.fixes) {
      const r = results.get(`${issue.code}:${f.id}`);
      if (r) console.log(`  → ${r.ok ? 'OK' : 'FAIL'}: ${r.message}`);
    }
    console.log('');
  }
  console.log('Run `codocs repair` in a terminal with a TUI to apply destructive fixes.');
}
