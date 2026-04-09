import React from 'react';
import { Box, Text } from 'ink';
import type { Agent } from '../state.js';

interface AgentListProps {
  agents: Agent[];
  maxAgents: number;
}

function agentStatusIcon(status: Agent['status']): string {
  switch (status) {
    case 'processing':
      return '\u25CF'; // ●
    case 'idle':
      return '\u25CB'; // ○
    case 'paused':
      return '\u25A0'; // ■
    case 'error':
      return '\u2716'; // ✖
  }
}

function agentStatusColor(status: Agent['status']): string {
  switch (status) {
    case 'processing':
      return 'green';
    case 'idle':
      return 'gray';
    case 'paused':
      return 'yellow';
    case 'error':
      return 'red';
  }
}

export function AgentList({ agents, maxAgents }: AgentListProps) {
  const activeCount = agents.filter((a) => a.status === 'processing').length;

  return (
    <Box flexDirection="column" width={32} paddingRight={1}>
      <Box marginBottom={1}>
        <Text bold dimColor>AGENTS</Text>
        <Text dimColor> {activeCount}/{maxAgents}</Text>
      </Box>

      {agents.length === 0 && (
        <Text dimColor italic>  No agents active</Text>
      )}

      {agents.map((agent) => (
        <Box key={agent.name} flexDirection="column" marginBottom={1}>
          <Box>
            <Text color={agentStatusColor(agent.status)}>
              {agentStatusIcon(agent.status)}
            </Text>
            <Text> </Text>
            <Text bold>{agent.name}</Text>
            <Text dimColor>  {agent.status}</Text>
          </Box>
          {agent.task && (
            <Text dimColor wrap="truncate-end">
              {'  '}{agent.task.length > 26 ? agent.task.slice(0, 26) + '...' : agent.task}
            </Text>
          )}
        </Box>
      ))}

      <Box marginTop={1} flexDirection="column">
        <Box borderStyle="single" borderTop={true} borderBottom={false} borderLeft={false} borderRight={false}>
          <Text> </Text>
        </Box>
      </Box>
    </Box>
  );
}
