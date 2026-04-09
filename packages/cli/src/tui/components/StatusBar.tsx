import React from 'react';
import { Box, Text } from 'ink';
import type { Stats } from '../state.js';
import { useElapsed, formatCost } from '../hooks.js';

interface StatusBarProps {
  stats: Stats;
  paused: boolean;
}

export function StatusBar({ stats, paused }: StatusBarProps) {
  const uptime = useElapsed(stats.startTime);

  return (
    <Box paddingX={1}>
      <Text dimColor>
        {stats.commentCount} comment{stats.commentCount !== 1 ? 's' : ''}
      </Text>
      <Text dimColor> {'\u2502'} </Text>
      <Text dimColor>cost: {formatCost(stats.totalCost)}</Text>
      {stats.budget > 0 && (
        <>
          <Text dimColor> / {formatCost(stats.budget)}</Text>
        </>
      )}
      <Text dimColor> {'\u2502'} </Text>
      <Text dimColor>uptime: {uptime}</Text>
      {paused && (
        <>
          <Text dimColor> {'\u2502'} </Text>
          <Text color="yellow" bold>PAUSED</Text>
        </>
      )}
    </Box>
  );
}
