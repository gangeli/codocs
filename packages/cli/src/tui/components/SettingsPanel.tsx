import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { ALLOWED_TOOLS, DISALLOWED_TOOLS, type Settings } from '../state.js';
import type { PermissionMode } from '@codocs/core';

interface SettingsPanelProps {
  settings: Settings;
  onUpdate: (settings: Settings) => void;
  onClose: () => void;
  agentType: string;
  autoModeAvailable: boolean;
  githubConnected: boolean;
}

interface SettingRow {
  label: string;
  key: keyof Settings;
  options: { label: string; value: any }[];
}

function buildPermissionOptions(autoModeAvailable: boolean): { label: string; value: PermissionMode }[] {
  const options: { label: string; value: PermissionMode }[] = [];
  if (autoModeAvailable) {
    options.push({ label: 'auto', value: { type: 'auto' } });
  }
  options.push({ label: 'tools', value: { type: 'allowedTools', tools: ALLOWED_TOOLS, disallowedTools: DISALLOWED_TOOLS } });
  options.push({ label: 'bypass', value: { type: 'bypass' } });
  return options;
}

export function SettingsPanel({ settings, onUpdate, onClose, agentType, autoModeAvailable, githubConnected }: SettingsPanelProps) {
  const rows = useMemo(() => {
    const r: SettingRow[] = [
      {
        label: 'Max agents',
        key: 'maxAgents',
        options: [
          { label: '1', value: 1 },
          { label: '3', value: 3 },
          { label: '5', value: 5 },
          { label: '10', value: 10 },
        ],
      },
      {
        label: 'On budget exhausted',
        key: 'onBudgetExhausted',
        options: [
          { label: 'pause', value: 'pause' },
          { label: 'warn', value: 'warn' },
          { label: 'stop', value: 'stop' },
        ],
      },
    ];

    if (agentType === 'claude') {
      r.push({
        label: 'Agent permissions',
        key: 'permissionMode',
        options: buildPermissionOptions(autoModeAvailable),
      });
    }

    const codeModeOptions: { label: string; value: string }[] = [];
    if (githubConnected) {
      codeModeOptions.push({ label: 'PR', value: 'pr' });
    }
    codeModeOptions.push({ label: 'direct', value: 'direct' });
    codeModeOptions.push({ label: 'off', value: 'off' });
    r.push({
      label: 'Code changes',
      key: 'codeMode',
      options: codeModeOptions,
    });

    r.push({
      label: 'Debug mode',
      key: 'debugMode',
      options: [
        { label: 'off', value: false },
        { label: 'on', value: true },
      ],
    });

    return r;
  }, [agentType, autoModeAvailable, githubConnected]);

  const [activeRow, setActiveRow] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.upArrow || input === 'k') {
      setActiveRow((r) => Math.max(0, r - 1));
    } else if (key.downArrow || input === 'j') {
      setActiveRow((r) => Math.min(rows.length - 1, r + 1));
    } else if (key.leftArrow || key.rightArrow || input === 'h' || input === 'l') {
      const row = rows[activeRow];
      const currentValue = settings[row.key];
      const currentIdx = row.options.findIndex((o) =>
        row.key === 'permissionMode'
          ? (o.value as PermissionMode).type === (currentValue as PermissionMode).type
          : o.value === currentValue,
      );
      const dir = (key.rightArrow || input === 'l') ? 1 : -1;
      const nextIdx = Math.max(0, Math.min(row.options.length - 1, currentIdx + dir));
      if (nextIdx !== currentIdx) {
        onUpdate({ ...settings, [row.key]: row.options[nextIdx].value });
      }
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      paddingX={2}
      paddingY={1}
      width={55}
    >
      <Box marginBottom={1}>
        <Text bold>Settings</Text>
        <Box flexGrow={1} />
        <Text dimColor>esc to close</Text>
      </Box>

      {rows.map((row, i) => {
        const isActive = i === activeRow;
        const currentValue = settings[row.key];

        return (
          <Box key={row.key} marginBottom={i < rows.length - 1 ? 1 : 0}>
            <Box width={22} flexShrink={0}>
              <Text color={isActive ? 'cyan' : undefined} bold={isActive} wrap="truncate">
                {isActive ? '\u25B6 ' : '  '}
                {row.label}
              </Text>
            </Box>
            <Box flexShrink={0}>
              {row.options.map((opt, j) => {
                const isSelected = row.key === 'permissionMode'
                  ? (opt.value as PermissionMode).type === (currentValue as PermissionMode).type
                  : opt.value === currentValue;
                return (
                  <React.Fragment key={j}>
                    {j > 0 && <Text> </Text>}
                    <Text
                      color={isSelected ? 'cyan' : 'gray'}
                      bold={isSelected}
                      wrap="truncate"
                    >
                      {isSelected ? `[${opt.label}]` : ` ${opt.label} `}
                    </Text>
                  </React.Fragment>
                );
              })}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
