import React from 'react';
import { Box, Text } from 'ink';
import type { ActivityEvent } from '../state.js';
import { formatTime, formatCost } from '../hooks.js';

interface ActivityLogProps {
  events: ActivityEvent[];
  scrollOffset: number;
  maxVisible: number;
}

function eventIcon(type: ActivityEvent['type']): string {
  switch (type) {
    case 'comment':
      return '\uD83D\uDCAC'; // 💬
    case 'agent-reply':
      return '\u2192'; // →
    case 'system':
      return '\u2022'; // •
    case 'error':
      return '\u2716'; // ✖
  }
}

function eventColor(type: ActivityEvent['type']): string | undefined {
  switch (type) {
    case 'error':
      return 'red';
    case 'system':
      return 'gray';
    default:
      return undefined;
  }
}

export function ActivityLog({ events, scrollOffset, maxVisible }: ActivityLogProps) {
  // Show events newest-first, sliced for scroll
  const sorted = [...events].reverse();
  const visible = sorted.slice(scrollOffset, scrollOffset + maxVisible);
  const canScrollUp = scrollOffset > 0;
  const canScrollDown = scrollOffset + maxVisible < sorted.length;

  return (
    <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
      <Box marginBottom={1}>
        <Text bold dimColor>ACTIVITY</Text>
        {(canScrollUp || canScrollDown) && (
          <Text dimColor>
            {' '}({scrollOffset + 1}-{Math.min(scrollOffset + maxVisible, sorted.length)}/{sorted.length})
          </Text>
        )}
      </Box>

      {visible.map((event) => (
        <Box key={event.id} flexDirection="column" marginBottom={1}>
          <Box>
            <Text dimColor>{formatTime(event.time)}</Text>
            <Text>  </Text>
            <Text color={eventColor(event.type)}>
              {eventIcon(event.type)}
            </Text>
            <Text> </Text>
            {event.author && <Text bold>{event.author}</Text>}
            {event.quotedText && (
              <Text dimColor> on &quot;{event.quotedText.length > 30 ? event.quotedText.slice(0, 30) + '...' : event.quotedText}&quot;</Text>
            )}
          </Box>
          <Box paddingLeft={10}>
            <Text color={eventColor(event.type)} wrap="truncate-end">
              {event.content}
            </Text>
          </Box>
          {(event.agent || event.durationMs !== undefined || event.cost !== undefined) && (
            <Box paddingLeft={10}>
              <Text dimColor>
                {'\u2192 '}
                {event.agent && `${event.agent} `}
                {event.durationMs !== undefined && `(${(event.durationMs / 1000).toFixed(1)}s`}
                {event.cost !== undefined && `, ${formatCost(event.cost)}`}
                {event.durationMs !== undefined && ')'}
              </Text>
            </Box>
          )}
        </Box>
      ))}

      {visible.length === 0 && (
        <Text dimColor italic>  No activity yet</Text>
      )}
    </Box>
  );
}
