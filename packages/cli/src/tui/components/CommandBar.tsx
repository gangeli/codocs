import React from 'react';
import { Box, Text } from 'ink';

interface CommandBarProps {
  paused: boolean;
  showSettings: boolean;
}

interface KeyHint {
  key: string;
  label: string;
}

export function CommandBar({ paused, showSettings }: CommandBarProps) {
  const hints: KeyHint[] = showSettings
    ? [
        { key: 'esc', label: 'close' },
        { key: '\u2191\u2193', label: 'navigate' },
        { key: '\u2190\u2192', label: 'change' },
      ]
    : [
        { key: 'q', label: 'quit' },
        { key: 's', label: 'settings' },
        { key: 'p', label: paused ? 'resume' : 'pause' },
        { key: 'o', label: 'open doc' },
        { key: 'd', label: 'debug' },
      ];

  return (
    <Box borderStyle="single" borderTop={true} borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
      {hints.map((hint, i) => (
        <React.Fragment key={hint.key}>
          {i > 0 && <Text dimColor> {'\u00B7'} </Text>}
          <Text bold color="cyan">{hint.key}</Text>
          <Text dimColor> {hint.label}</Text>
        </React.Fragment>
      ))}
    </Box>
  );
}
