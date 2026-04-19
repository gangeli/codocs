import React, { useState, useMemo, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Issue, Fix, FixResult, Severity } from '../../repair/types.js';

const LOGO = [
  '                _                ',
  '   ___ ___   __| | ___   ___ ___ ',
  '  / __/ _ \\ / _` |/ _ \\ / __/ __|',
  ' | (_| (_) | (_| | (_) | (__\\__ \\',
  '  \\___\\___/ \\__,_|\\___/ \\___|___/',
];

export type RepairAction =
  | { type: 'apply-fix'; issue: Issue; fix: Fix }
  | { type: 'rerun' }
  | { type: 'quit' };

interface RepairToastProp {
  ok: boolean;
  message: string;
}

interface RepairProps {
  issues: Issue[];
  /** Keyed by `${issue.code}:${fix.id}` — last result per issue/fix pair. */
  results: Map<string, FixResult>;
  onAction: (action: RepairAction) => void;
  /** "We found issues during startup" vs "Health check complete". */
  headerMessage?: string;
  /** True while a fix is running — disables input and shows a hint. */
  busy?: boolean;
  /** Transient banner shown above the issue list after a recheck. */
  toast?: RepairToastProp | null;
}

type Pane = 'issues' | 'fixes';

const SEVERITY_COLOR: Record<Severity, string> = {
  error: 'red',
  warning: 'yellow',
  info: 'blue',
};

const SEVERITY_ICON: Record<Severity, string> = {
  error: '\u25CF', // ●
  warning: '\u25B2', // ▲
  info: '\u25C6', // ◆
};

export function Repair({
  issues,
  results,
  onAction,
  headerMessage,
  busy = false,
  toast = null,
}: RepairProps) {
  const [issueIdx, setIssueIdx] = useState(0);
  const [fixIdx, setFixIdx] = useState(0);
  const [focus, setFocus] = useState<Pane>('issues');
  const [confirmFixId, setConfirmFixId] = useState<string | null>(null);

  // Clamp indices when the issue list shrinks (e.g. after a fix resolves
  // the selected issue). Without this the cursor would silently point at
  // a different issue than the user was working on, which reads as "a
  // new error appeared."
  useEffect(() => {
    if (issues.length === 0) return;
    if (issueIdx >= issues.length) setIssueIdx(issues.length - 1);
  }, [issues, issueIdx]);

  const current: Issue | undefined = issues[issueIdx];
  const fixes = current?.fixes ?? [];

  useEffect(() => {
    if (fixIdx >= fixes.length) setFixIdx(0);
  }, [fixes.length, fixIdx]);

  // If focus lands on the fixes pane but there are no fixes, bounce back.
  useEffect(() => {
    if (focus === 'fixes' && fixes.length === 0) setFocus('issues');
  }, [focus, fixes.length]);

  const counts = useMemo(() => {
    const out = { error: 0, warning: 0, info: 0 };
    for (const i of issues) out[i.severity]++;
    return out;
  }, [issues]);

  useInput((ch, key) => {
    if (busy) return;

    // Global keys
    if (ch === 'q' || key.escape) {
      onAction({ type: 'quit' });
      return;
    }
    if (ch === 'r') {
      setConfirmFixId(null);
      onAction({ type: 'rerun' });
      return;
    }

    // Pane switching: ← / h  → issues pane;  → / l  → fixes pane
    if (key.leftArrow || ch === 'h') {
      setFocus('issues');
      setConfirmFixId(null);
      return;
    }
    if (key.rightArrow || ch === 'l') {
      if (fixes.length > 0) setFocus('fixes');
      setConfirmFixId(null);
      return;
    }

    // Vertical selection: ↑/k and ↓/j act on the focused pane
    if (key.upArrow || ch === 'k') {
      if (focus === 'issues') {
        setIssueIdx((i) => {
          const next = Math.max(0, i - 1);
          if (next !== i) {
            setFixIdx(0);
            setConfirmFixId(null);
          }
          return next;
        });
      } else {
        setFixIdx((f) => Math.max(0, f - 1));
        setConfirmFixId(null);
      }
      return;
    }
    if (key.downArrow || ch === 'j') {
      if (focus === 'issues') {
        setIssueIdx((i) => {
          const next = Math.min(issues.length - 1, i + 1);
          if (next !== i) {
            setFixIdx(0);
            setConfirmFixId(null);
          }
          return next;
        });
      } else {
        setFixIdx((f) => Math.min(Math.max(0, fixes.length - 1), f + 1));
        setConfirmFixId(null);
      }
      return;
    }

    // Tab also toggles panes (familiar keyboard-nav affordance).
    if (key.tab) {
      setFocus((p) => (p === 'issues' && fixes.length > 0 ? 'fixes' : 'issues'));
      setConfirmFixId(null);
      return;
    }

    // Enter: apply selected fix. If focus is on the issues pane and there
    // are fixes available, move focus to the fixes pane first rather than
    // silently swallowing the keystroke.
    if (key.return) {
      if (!current) return;
      if (focus === 'issues') {
        if (fixes.length > 0) setFocus('fixes');
        return;
      }
      const fix = fixes[fixIdx];
      if (!fix) return;
      if (fix.destructive && confirmFixId !== fix.id) {
        setConfirmFixId(fix.id);
        return;
      }
      setConfirmFixId(null);
      if (fix.id === 'quit-program') {
        onAction({ type: 'quit' });
        return;
      }
      onAction({ type: 'apply-fix', issue: current, fix });
    }
  });

  const issuesFocused = focus === 'issues';
  const fixesFocused = focus === 'fixes';

  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
      {/* Logo */}
      <Box flexDirection="column" alignItems="center" marginBottom={0}>
        {LOGO.map((line, i) => (
          <Text key={i} color="cyan">{line}</Text>
        ))}
      </Box>
      <Text dimColor>{headerMessage ?? 'System repair'}</Text>

      <Box marginTop={1} marginBottom={1}>
        <Text dimColor>{'\u2500'.repeat(72)}</Text>
      </Box>

      {/* Counts */}
      <Box marginBottom={1}>
        <Text color="red">{SEVERITY_ICON.error} {counts.error} error{counts.error === 1 ? '' : 's'}</Text>
        <Text>   </Text>
        <Text color="yellow">{SEVERITY_ICON.warning} {counts.warning} warning{counts.warning === 1 ? '' : 's'}</Text>
        <Text>   </Text>
        <Text color="blue">{SEVERITY_ICON.info} {counts.info} info</Text>
      </Box>

      {/* Toast: shown after a fix or a manual rerun so the user sees
          what just happened even when the issue list reshuffles. */}
      {toast && (
        <Box marginBottom={1}>
          <Text color={toast.ok ? 'green' : 'red'}>
            {toast.ok ? '\u2713' : '\u2717'} {toast.message}
          </Text>
        </Box>
      )}

      {issues.length === 0 ? (
        <Box marginY={1}>
          <Text color="green">{'\u2713'} Everything looks healthy.</Text>
        </Box>
      ) : (
        <Box>
          {/* Left: issue list */}
          <Box flexDirection="column" width={38}>
            <Text dimColor bold>{issuesFocused ? '\u25B8 Issues' : '  Issues'}</Text>
            {issues.map((issue, idx) => {
              const isSel = idx === issueIdx;
              const cursorColor = isSel && issuesFocused ? 'cyan' : 'gray';
              return (
                <Box key={`${issue.code}-${idx}`}>
                  <Text color={cursorColor}>
                    {isSel ? '\u25B8 ' : '  '}
                  </Text>
                  <Text color={SEVERITY_COLOR[issue.severity]}>
                    {SEVERITY_ICON[issue.severity]}{' '}
                  </Text>
                  <Text bold={isSel && issuesFocused} dimColor={!isSel} wrap="truncate-end">
                    {issue.title}
                  </Text>
                </Box>
              );
            })}
          </Box>

          {/* Right: detail + fixes */}
          <Box
            flexDirection="column"
            marginLeft={1}
            paddingLeft={2}
            width={40}
            borderStyle="single"
            borderTop={false}
            borderBottom={false}
            borderRight={false}
            borderLeft={true}
          >
            {current && (
              <>
                <Text bold color={SEVERITY_COLOR[current.severity]}>
                  {current.title}
                </Text>
                <Box marginTop={1}>
                  <Text wrap="wrap">{current.detail}</Text>
                </Box>

                {fixes.length === 0 && (
                  <Box marginTop={1}>
                    <Text dimColor italic>No automatic fix available.</Text>
                  </Box>
                )}

                {fixes.length > 0 && (
                  <Box flexDirection="column" marginTop={1}>
                    <Text dimColor bold>{fixesFocused ? '\u25B8 Fixes' : '  Fixes'}</Text>
                    {fixes.map((f, fi) => {
                      const isSel = fi === fixIdx;
                      const needsConfirm = confirmFixId === f.id;
                      const cursorColor = isSel && fixesFocused ? 'cyan' : 'gray';
                      return (
                        <Box key={f.id} flexDirection="column">
                          <Box>
                            <Text color={cursorColor}>
                              {isSel ? '\u25B8 ' : '  '}
                            </Text>
                            <Text
                              color={f.destructive ? 'yellow' : undefined}
                              bold={isSel && fixesFocused}
                              dimColor={!isSel}
                            >
                              {f.destructive ? '! ' : ''}{f.label}
                            </Text>
                          </Box>
                          {isSel && fixesFocused && (
                            <Box paddingLeft={4}>
                              <Text dimColor wrap="wrap">{f.description}</Text>
                            </Box>
                          )}
                          {isSel && fixesFocused && needsConfirm && (
                            <Box paddingLeft={4}>
                              <Text color="yellow">Press Enter again to confirm.</Text>
                            </Box>
                          )}
                        </Box>
                      );
                    })}
                  </Box>
                )}

                {/* Previous result, if any */}
                {(() => {
                  for (const fix of fixes) {
                    const r = results.get(`${current.code}:${fix.id}`);
                    if (!r) continue;
                    return (
                      <Box key={fix.id} marginTop={1}>
                        <Text color={r.ok ? 'green' : 'red'}>
                          {r.ok ? '\u2713' : '\u2717'} {fix.label}: {r.message}
                        </Text>
                      </Box>
                    );
                  }
                  return null;
                })()}
              </>
            )}
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>{'\u2500'.repeat(72)}</Text>
      </Box>
      <Box width={72} justifyContent="space-between">
        <Text dimColor>
          {'\u2190\u2192'}/hl pane  {'\u00B7'}  {'\u2191\u2193'}/jk select  {'\u00B7'}  enter apply  {'\u00B7'}  r rerun  {'\u00B7'}  q quit
        </Text>
        {busy && <Text color="yellow">applying{'\u2026'}</Text>}
      </Box>
    </Box>
  );
}
