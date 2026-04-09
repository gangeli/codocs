import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

interface GeneratingProps {
  /** Main status message, updated externally as steps progress. */
  message: string;
  /** Optional sub-status shown below the main message. */
  subMessage?: string;
}

const DOTS = ['   ', '.  ', '.. ', '...'];

export function Generating({ message, subMessage }: GeneratingProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  const dots = DOTS[elapsed % DOTS.length];

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Box marginBottom={1}>
        <Text bold>{message}{dots}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>{timeStr}</Text>
      </Box>

      {subMessage && <Text dimColor italic>{subMessage}</Text>}
    </Box>
  );
}
