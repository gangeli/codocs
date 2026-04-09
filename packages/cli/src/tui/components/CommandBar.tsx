import React from 'react';
import { Box, Text } from 'ink';

interface CommandBarProps {
  paused: boolean;
  debugMode: boolean;
  view: 'main' | 'settings' | 'confirm-quit';
}

interface KeyHint {
  key: string;
  label: string;
}

export function CommandBar({ paused, debugMode, view }: CommandBarProps) {
  let hints: KeyHint[];

  switch (view) {
    case 'settings':
      hints = [
        { key: 'esc', label: 'close' },
        { key: '\u2191\u2193', label: 'navigate' },
        { key: '\u2190\u2192', label: 'change' },
      ];
      break;
    case 'confirm-quit':
      hints = [
        { key: 'y', label: 'quit' },
        { key: 'n', label: 'cancel' },
      ];
      break;
    default:
      hints = [
        { key: 'q', label: 'quit' },
        { key: 's', label: 'settings' },
        { key: 'p', label: paused ? 'resume' : 'pause' },
        { key: 'o', label: 'open doc' },
        { key: debugMode ? 'esc' : 'd', label: debugMode ? 'exit debug' : 'debug' },
      ];
      break;
  }

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
