import React, { useState, useCallback } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import open from 'open';
import { Header } from './components/Header.js';
import { AgentList } from './components/AgentList.js';
import { ActivityLog } from './components/ActivityLog.js';
import { StatusBar } from './components/StatusBar.js';
import { CommandBar } from './components/CommandBar.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import type { TuiState, ActivityEvent, Agent, Settings } from './state.js';

interface AppProps {
  initialState: TuiState;
  /** Called when user requests shutdown */
  onShutdown: () => Promise<void>;
  /** Ref callback to let serve.ts push state updates */
  onStateRef?: (ref: TuiStateRef) => void;
}

export interface TuiStateRef {
  addEvent: (event: ActivityEvent) => void;
  updateAgent: (name: string, update: Partial<Agent>) => void;
  removeAgent: (name: string) => void;
  setConnected: (connected: boolean) => void;
  incrementComments: () => void;
  addCost: (amount: number) => void;
  setDocTitle: (title: string) => void;
}

export function App({ initialState, onShutdown, onStateRef }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;

  const [state, setState] = useState<TuiState>(initialState);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Expose state mutation methods to the serve command
  const stateRef: TuiStateRef = {
    addEvent: (event) =>
      setState((s) => ({
        ...s,
        events: [...s.events, event],
      })),
    updateAgent: (name, update) =>
      setState((s) => {
        const existing = s.agents.find((a) => a.name === name);
        if (existing) {
          return {
            ...s,
            agents: s.agents.map((a) =>
              a.name === name ? { ...a, ...update } : a,
            ),
          };
        }
        // Add new agent
        return {
          ...s,
          agents: [...s.agents, { name, status: 'idle', ...update }],
        };
      }),
    removeAgent: (name) =>
      setState((s) => ({
        ...s,
        agents: s.agents.filter((a) => a.name !== name),
      })),
    setConnected: (connected) =>
      setState((s) => ({ ...s, connected })),
    incrementComments: () =>
      setState((s) => ({
        ...s,
        stats: { ...s.stats, commentCount: s.stats.commentCount + 1 },
      })),
    addCost: (amount) =>
      setState((s) => ({
        ...s,
        stats: { ...s.stats, totalCost: s.stats.totalCost + amount },
      })),
    setDocTitle: (title) =>
      setState((s) => ({ ...s, docTitle: title })),
  };

  // Register ref on first render
  React.useEffect(() => {
    onStateRef?.(stateRef);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleShutdown = useCallback(async () => {
    await onShutdown();
    exit();
  }, [onShutdown, exit]);

  // Keyboard input (only when settings panel is not open)
  useInput(
    (input, key) => {
      if (state.showSettings) {
        // Settings panel handles its own input
        return;
      }

      if (input === 'q' || (key.ctrl && input === 'c')) {
        handleShutdown();
      } else if (input === 's') {
        setState((s) => ({ ...s, showSettings: true }));
      } else if (input === 'p') {
        setState((s) => ({ ...s, paused: !s.paused }));
      } else if (input === 'o') {
        open(state.docUrl);
      } else if (input === 'd') {
        setState((s) => ({
          ...s,
          settings: { ...s.settings, debugMode: !s.settings.debugMode },
        }));
      } else if (key.upArrow) {
        setScrollOffset((o) => Math.max(0, o - 1));
      } else if (key.downArrow) {
        setScrollOffset((o) =>
          Math.min(Math.max(0, state.events.length - 3), o + 1),
        );
      }
    },
    { isActive: !state.showSettings },
  );

  // Calculate available height for the activity log
  // Header(2) + StatusBar(1) + CommandBar(2) + margins(2) = ~7 lines overhead
  const logMaxVisible = Math.max(3, termHeight - 7);

  return (
    <Box flexDirection="column" height={termHeight}>
      <Header
        docTitle={state.docTitle}
        docUrl={state.docUrl}
        connected={state.connected}
      />

      <Box flexGrow={1}>
        <AgentList
          agents={state.agents}
          maxAgents={state.settings.maxAgents}
        />

        <Box
          borderStyle="single"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderLeft={true}
        >
          <Text> </Text>
        </Box>

        <ActivityLog
          events={state.events}
          scrollOffset={scrollOffset}
          maxVisible={logMaxVisible}
        />
      </Box>

      <StatusBar stats={state.stats} paused={state.paused} />
      <CommandBar paused={state.paused} showSettings={state.showSettings} />

      {state.showSettings && (
        <Box
          position="absolute"
          marginTop={3}
          marginLeft={4}
        >
          <SettingsPanel
            settings={state.settings}
            onUpdate={(settings: Settings) =>
              setState((s) => ({ ...s, settings }))
            }
            onClose={() => setState((s) => ({ ...s, showSettings: false }))}
          />
        </Box>
      )}
    </Box>
  );
}
