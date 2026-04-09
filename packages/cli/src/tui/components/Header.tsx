import React from 'react';
import { Box, Text } from 'ink';

interface HeaderProps {
  docTitle: string;
  docUrl: string;
  connected: boolean;
}

export function Header({ docTitle, docUrl, connected }: HeaderProps) {
  // Shorten URL for display
  const shortUrl = docUrl.replace('https://', '').replace('/edit', '');

  return (
    <Box borderStyle="single" borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
      <Text bold color="cyan">codocs</Text>
      <Text color="gray"> {' \u2500\u2500 '} </Text>
      <Text bold>{docTitle}</Text>
      <Text color="gray"> {' \u2500\u2500 '} </Text>
      <Text dimColor>{shortUrl}</Text>
      <Box flexGrow={1} />
      <Text color={connected ? 'green' : 'yellow'}>
        {connected ? '\u25CF connected' : '\u25CB connecting...'}
      </Text>
    </Box>
  );
}
