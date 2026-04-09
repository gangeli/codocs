import React from 'react';
import { Box, Text } from 'ink';
import type { ActivityEvent } from '../state.js';
import { formatTime, formatCost } from '../hooks.js';

interface ActivityLogProps {
  events: ActivityEvent[];
  scrollOffset: number;
  maxVisible: number;
  debugMode: boolean;
  docUrl: string;
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
    case 'debug':
      return '\u2059'; // ⁙
  }
}

function eventColor(type: ActivityEvent['type']): string | undefined {
  switch (type) {
    case 'error':
      return 'red';
    case 'system':
      return 'gray';
    case 'debug':
      return 'gray';
    default:
      return undefined;
  }
}

function EmptyState({ docUrl }: { docUrl: string }) {
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Text dimColor>
        {'        ,___,'}
      </Text>
      <Text dimColor>
        {'        (o,o)'}
      </Text>
      <Text dimColor>
        {'        /)__)'}
      </Text>
      <Text dimColor>
        {'        -"-"-'}
      </Text>
      <Box marginTop={1}>
        <Text dimColor>Waiting for comments...</Text>
      </Box>
      <Box marginTop={0}>
        <Text dimColor italic>Add a comment in the doc to get started</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{docUrl}</Text>
      </Box>
      <Box marginTop={0}>
        <Text dimColor>Press </Text>
        <Text bold color="cyan">o</Text>
        <Text dimColor> to open in browser</Text>
      </Box>
    </Box>
  );
}

export function ActivityLog({ events, scrollOffset, maxVisible, debugMode, docUrl }: ActivityLogProps) {
  // Filter: hide system events from the log (they go to the header status).
  // Hide debug events unless debug mode is on.
  const filtered = events.filter((e) => {
    if (e.type === 'system') return false;
    if (e.type === 'debug' && !debugMode) return false;
    return true;
  });

  const sorted = [...filtered].reverse();
  const visible = sorted.slice(scrollOffset, scrollOffset + maxVisible);
  const canScrollUp = scrollOffset > 0;
  const canScrollDown = scrollOffset + maxVisible < sorted.length;

  // Show empty state if no real activity
  if (filtered.length === 0) {
    return (
      <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
        <Box marginBottom={1}>
          <Text bold dimColor>ACTIVITY</Text>
        </Box>
        <EmptyState docUrl={docUrl} />
      </Box>
    );
  }

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

      {visible.map((event) =>
        event.type === 'agent-reply' ? (
          <Box key={event.id} flexDirection="column" marginBottom={1}>
            <Box>
              <Text dimColor>{formatTime(event.time)}</Text>
              <Text>  </Text>
              <Text color="green">{'\u2192'}</Text>
              <Text> </Text>
              <Text bold>{event.agent ?? 'agent'}</Text>
              <Text dimColor>  {event.editSummary ?? 'done'}</Text>
            </Box>
            <Box paddingLeft={10}>
              <Text dimColor wrap="truncate-end">{event.content}</Text>
            </Box>
          </Box>
        ) : (
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
          </Box>
        ),
      )}
    </Box>
  );
}
