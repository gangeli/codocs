import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { ALLOWED_TOOLS, DISALLOWED_TOOLS, type Settings } from '../state.js';
import type { PermissionMode, RunnerCapabilities } from '@codocs/core';

interface SettingsPanelProps {
  settings: Settings;
  onUpdate: (settings: Settings) => void;
  onClose: () => void;
  agentType: string;
  autoModeAvailable: boolean;
  githubConnected: boolean;
  capabilities?: RunnerCapabilities;
}

interface SettingRow {
  label: string;
  /** Which settings key this row controls, or 'harness.<key>' for harness-specific settings. */
  key: string;
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

/** Read the current value for a setting row. */
function getRowValue(row: SettingRow, settings: Settings, agentType: string): any {
  if (row.key === 'defaultModel') {
    return settings.defaultModel[agentType] || '';
  }
  if (row.key.startsWith('harness.')) {
    const harnessKey = `${agentType}.${row.key.slice('harness.'.length)}`;
    return settings.harnessSettings[harnessKey] ?? row.options[0]?.value ?? '';
  }
  return (settings as any)[row.key];
}

/** Write a new value for a setting row, returning updated settings. */
function setRowValue(row: SettingRow, value: any, settings: Settings, agentType: string): Settings {
  if (row.key === 'defaultModel') {
    const newMap = { ...settings.defaultModel };
    if (value) {
      newMap[agentType] = value;
    } else {
      delete newMap[agentType];
    }
    return { ...settings, defaultModel: newMap };
  }
  if (row.key.startsWith('harness.')) {
    const harnessKey = `${agentType}.${row.key.slice('harness.'.length)}`;
    const newHarness = { ...settings.harnessSettings };
    if (value) {
      newHarness[harnessKey] = value;
    } else {
      delete newHarness[harnessKey];
    }
    return { ...settings, harnessSettings: newHarness };
  }
  return { ...settings, [row.key]: value };
}

/** Check if a row option matches the current value. */
function isOptionSelected(row: SettingRow, optValue: any, currentValue: any): boolean {
  if (row.key === 'permissionMode') {
    return (optValue as PermissionMode).type === (currentValue as PermissionMode).type;
  }
  return optValue === currentValue;
}

export function SettingsPanel({ settings, onUpdate, onClose, agentType, autoModeAvailable, githubConnected, capabilities }: SettingsPanelProps) {
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

    // Permission mode — only if the runner supports it
    const supportsPermissions = capabilities?.supportsPermissionMode ?? (agentType === 'claude');
    if (supportsPermissions) {
      r.push({
        label: 'Agent permissions',
        key: 'permissionMode',
        options: buildPermissionOptions(autoModeAvailable),
      });
    }

    // Code mode
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

    // Model — from capabilities or fallback for claude
    const modelOpts = capabilities?.models ?? (agentType === 'claude'
      ? [
          { label: 'default', value: '' },
          { label: 'haiku', value: 'haiku' },
          { label: 'sonnet', value: 'sonnet' },
          { label: 'opus', value: 'opus' },
        ]
      : []);
    if (modelOpts.length > 0) {
      r.push({
        label: 'Model',
        key: 'defaultModel',
        options: modelOpts,
      });
    }

    // Harness-specific settings (dynamic from capabilities)
    if (capabilities?.harnessSettings) {
      for (const hs of capabilities.harnessSettings) {
        r.push({
          label: hs.label,
          key: `harness.${hs.key}`,
          options: hs.options,
        });
      }
    }

    return r;
  }, [agentType, autoModeAvailable, githubConnected, capabilities]);

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
      const currentValue = getRowValue(row, settings, agentType);
      const currentIdx = row.options.findIndex((o) => isOptionSelected(row, o.value, currentValue));
      const dir = (key.rightArrow || input === 'l') ? 1 : -1;
      const nextIdx = Math.max(0, Math.min(row.options.length - 1, currentIdx + dir));
      if (nextIdx !== currentIdx) {
        onUpdate(setRowValue(row, row.options[nextIdx].value, settings, agentType));
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
        const currentValue = getRowValue(row, settings, agentType);

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
                const isSelected = isOptionSelected(row, opt.value, currentValue);
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
