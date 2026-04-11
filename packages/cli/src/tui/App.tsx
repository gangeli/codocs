import React, { useState, useCallback, useRef } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import open from 'open';
import { Header } from './components/Header.js';
import { AgentList } from './components/AgentList.js';
import { ActivityLog } from './components/ActivityLog.js';
import { StatusBar } from './components/StatusBar.js';
import { CommandBar } from './components/CommandBar.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import type { TuiState, ActivityEvent, Agent, Settings } from './state.js';

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m${secs}s`;
}

export interface ActiveAgentInfo {
  agentName: string;
  startedAt: Date;
}

interface AppProps {
  initialState: TuiState;
  /** Called when user requests shutdown */
  onShutdown: () => Promise<void>;
  /** Returns currently active agent processes (for quit confirmation). */
  getActiveAgents?: () => ActiveAgentInfo[];
  /** Ref callback to let serve.ts push state updates */
  onStateRef?: (ref: TuiStateRef) => void;
  /** Called when settings change (for persistence). */
  onSettingsChange?: (settings: Settings) => void;
}

export interface TuiStateRef {
  addEvent: (event: ActivityEvent) => void;
  updateAgent: (name: string, update: Partial<Agent>) => void;
  removeAgent: (name: string) => void;
  setConnected: (connected: boolean) => void;
  setStatus: (message: string) => void;
  incrementComments: () => void;
  addCost: (amount: number) => void;
  setDocTitle: (title: string) => void;
  getSettings: () => Settings;
}

type View = 'main' | 'settings' | 'confirm-quit';

export function App({ initialState, onShutdown, getActiveAgents, onStateRef, onSettingsChange }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;

  const [state, setState] = useState<TuiState>(initialState);
  const settingsRef = useRef(initialState.settings);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [view, setView] = useState<View>('main');

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
    setStatus: (message) =>
      setState((s) => ({ ...s, statusMessage: message })),
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
    getSettings: () => settingsRef.current,
  };

  React.useEffect(() => {
    onStateRef?.(stateRef);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleShutdown = useCallback(async () => {
    await onShutdown();
    exit();
  }, [onShutdown, exit]);

  // ── Keyboard: global (always active) ─────────────────────────
  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') {
      if (view === 'confirm-quit') {
        handleShutdown();
      } else {
        setView('confirm-quit');
      }
    }
  });

  // ── Keyboard: main view ──────────────────────────────────────
  useInput(
    (input, key) => {
      if (key.escape && state.settings.debugMode) {
        setState((s) => ({
          ...s,
          settings: { ...s.settings, debugMode: false },
        }));
      } else if (input === 'q') {
        setView('confirm-quit');
      } else if (input === 's') {
        setView('settings');
      } else if (input === 'p') {
        setState((s) => ({ ...s, paused: !s.paused }));
      } else if (input === 'o') {
        open(state.docUrl);
      } else if (input === 'd') {
        setState((s) => ({
          ...s,
          settings: { ...s.settings, debugMode: !s.settings.debugMode },
        }));
      } else if (key.upArrow || input === 'k') {
        setScrollOffset((o) => Math.max(0, o - 1));
      } else if (key.downArrow || input === 'j') {
        setScrollOffset((o) =>
          Math.min(Math.max(0, state.events.length - 3), o + 1),
        );
      }
    },
    { isActive: view === 'main' },
  );

  // ── Keyboard: confirm quit ───────────────────────────────────
  useInput(
    (input, key) => {
      if (input === 'y' || input === 'Y') {
        handleShutdown();
      } else {
        setView('main');
      }
    },
    { isActive: view === 'confirm-quit' },
  );

  // Calculate available height for the activity log
  const logMaxVisible = Math.max(3, termHeight - 7);

  return (
    <Box flexDirection="column" height={termHeight}>
      <Header
        docTitle={state.docTitle}
        docUrl={state.docUrl}
        connected={state.connected}
        debugMode={state.settings.debugMode}
        statusMessage={state.statusMessage}
      />

      {view === 'settings' ? (
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <SettingsPanel
            settings={state.settings}
            onUpdate={(settings: Settings) => {
              settingsRef.current = settings;
              setState((s) => ({ ...s, settings }));
              onSettingsChange?.(settings);
            }}
            onClose={() => setView('main')}
            agentType={state.agentType}
            autoModeAvailable={state.autoModeAvailable}
            githubConnected={state.githubConnected}
            capabilities={state.runnerCapabilities}
          />
        </Box>
      ) : view === 'confirm-quit' ? (
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Box
            flexDirection="column"
            borderStyle="round"
            paddingX={3}
            paddingY={1}
            alignItems="center"
          >
            <Text bold>Quit codocs?</Text>
            {(() => {
              const active = getActiveAgents?.() ?? [];
              if (active.length > 0) {
                return (
                  <Box flexDirection="column" marginTop={1} alignItems="center">
                    <Text color="yellow" bold>
                      {active.length} active agent{active.length !== 1 ? 's' : ''} will be killed:
                    </Text>
                    {active.map((a) => (
                      <Text key={a.agentName} dimColor>
                        {'  '}{a.agentName} (running {formatDuration(Date.now() - a.startedAt.getTime())})
                      </Text>
                    ))}
                  </Box>
                );
              }
              return <Text dimColor>This will close subscriptions and exit.</Text>;
            })()}
            <Box marginTop={1}>
              <Text bold color="cyan">y</Text>
              <Text> yes  </Text>
              <Text bold color="cyan">n</Text>
              <Text> cancel</Text>
            </Box>
          </Box>
        </Box>
      ) : (
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
            debugMode={state.settings.debugMode}
            docUrl={state.docUrl}
          />
        </Box>
      )}

      <StatusBar stats={state.stats} paused={state.paused} />
      <CommandBar paused={state.paused} debugMode={state.settings.debugMode} view={view} />
    </Box>
  );
}
