import React from 'react';
import { Box, Text } from 'ink';

interface HeaderProps {
  docTitle: string;
  docUrl: string;
  connected: boolean;
  debugMode: boolean;
  statusMessage: string;
}

export function Header({ docTitle, docUrl, connected, debugMode, statusMessage }: HeaderProps) {
  return (
    <Box paddingX={1}>
      <Text bold color="cyan">codocs</Text>
      <Text dimColor> {'\u2502'} </Text>
      <Text>{docTitle}</Text>
      <Box flexGrow={1} />
      {debugMode && (
        <>
          <Text color="yellow" bold>DEBUG</Text>
          <Text>  </Text>
        </>
      )}
      <Text color={connected ? 'green' : 'yellow'}>
        {connected ? '\u25CF' : '\u25CB'}
      </Text>
      <Text dimColor> {statusMessage}</Text>
    </Box>
  );
}
