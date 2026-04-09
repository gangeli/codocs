import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Settings } from '../state.js';

interface SettingsPanelProps {
  settings: Settings;
  onUpdate: (settings: Settings) => void;
  onClose: () => void;
}

interface SettingRow {
  label: string;
  key: keyof Settings;
  options: { label: string; value: any }[];
}

const SETTING_ROWS: SettingRow[] = [
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
  {
    label: 'Debug mode',
    key: 'debugMode',
    options: [
      { label: 'off', value: false },
      { label: 'on', value: true },
    ],
  },
];

export function SettingsPanel({ settings, onUpdate, onClose }: SettingsPanelProps) {
  const [activeRow, setActiveRow] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.upArrow) {
      setActiveRow((r) => Math.max(0, r - 1));
    } else if (key.downArrow) {
      setActiveRow((r) => Math.min(SETTING_ROWS.length - 1, r + 1));
    } else if (key.leftArrow || key.rightArrow) {
      const row = SETTING_ROWS[activeRow];
      const currentValue = settings[row.key];
      const currentIdx = row.options.findIndex((o) => o.value === currentValue);
      const dir = key.rightArrow ? 1 : -1;
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
      width={50}
    >
      <Box marginBottom={1}>
        <Text bold>Settings</Text>
        <Box flexGrow={1} />
        <Text dimColor>esc to close</Text>
      </Box>

      {SETTING_ROWS.map((row, i) => {
        const isActive = i === activeRow;
        const currentValue = settings[row.key];

        return (
          <Box key={row.key} marginBottom={i < SETTING_ROWS.length - 1 ? 1 : 0}>
            <Box width={22}>
              <Text color={isActive ? 'cyan' : undefined} bold={isActive}>
                {isActive ? '\u25B6 ' : '  '}
                {row.label}
              </Text>
            </Box>
            <Box>
              {row.options.map((opt, j) => {
                const isSelected = opt.value === currentValue;
                return (
                  <React.Fragment key={j}>
                    {j > 0 && <Text> </Text>}
                    <Text
                      color={isSelected ? 'cyan' : 'gray'}
                      bold={isSelected}
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
