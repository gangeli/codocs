import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  getStandalonePermissions,
  ALLOWED_TOOLS,
  DISALLOWED_TOOLS,
} from '../../src/tui/state.js';

describe('createInitialState', () => {
  it('matches the full default shape (autoModeAvailable=false, githubConnected=false)', () => {
    const state = createInitialState('doc-123');
    expect(state).toMatchObject({
      docUrl: 'https://docs.google.com/document/d/doc-123/edit',
      docTitle: 'doc-123...',
      connected: false,
      statusMessage: 'Starting up...',
      agents: [],
      events: [],
      stats: {
        commentCount: 0,
        totalCost: 0,
        budget: 1.0,
      },
      settings: {
        maxAgents: 3,
        onBudgetExhausted: 'pause',
        permissionMode: {
          type: 'allowedTools',
          tools: ALLOWED_TOOLS,
          disallowedTools: DISALLOWED_TOOLS,
        },
        codeMode: 'direct',
        debugMode: false,
        defaultModel: {},
        harnessSettings: {},
      },
      showSettings: false,
      paused: false,
      agentType: 'claude',
      autoModeAvailable: false,
      githubConnected: false,
    });
    expect(state.stats.startTime).toBeInstanceOf(Date);
    expect(state.runnerCapabilities).toBeUndefined();
  });

  it('uses auto permission mode when autoModeAvailable=true', () => {
    const state = createInitialState('doc-123', { autoModeAvailable: true });
    expect(state).toMatchObject({
      autoModeAvailable: true,
      settings: {
        permissionMode: { type: 'auto', allowedTools: ALLOWED_TOOLS },
      },
    });
  });

  it('uses pr code mode when githubConnected=true', () => {
    const state = createInitialState('doc-123', { githubConnected: true });
    expect(state).toMatchObject({
      githubConnected: true,
      settings: { codeMode: 'pr' },
    });
  });

  it('uses direct code mode when githubConnected=false', () => {
    const state = createInitialState('doc-123', { githubConnected: false });
    expect(state).toMatchObject({
      githubConnected: false,
      settings: { codeMode: 'direct' },
    });
  });

  it('propagates provided agentType, docTitle, and runnerCapabilities', () => {
    const caps = { supportsAutoMode: true } as any;
    const state = createInitialState('doc-123', {
      docTitle: 'My Doc',
      agentType: 'codex',
      runnerCapabilities: caps,
    });
    expect(state.docTitle).toBe('My Doc');
    expect(state.agentType).toBe('codex');
    expect(state.runnerCapabilities).toBe(caps);
  });
});

describe('getStandalonePermissions', () => {
  it('returns auto when autoModeAvailable=true', () => {
    const perm = getStandalonePermissions({ autoModeAvailable: true });
    expect(perm).toEqual({ type: 'auto', allowedTools: ALLOWED_TOOLS });
  });

  it('returns allowedTools when autoModeAvailable=false', () => {
    const perm = getStandalonePermissions({ autoModeAvailable: false });
    expect(perm).toEqual({
      type: 'allowedTools',
      tools: ALLOWED_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
    });
  });

  it('defaults to allowedTools when no opts are provided', () => {
    const perm = getStandalonePermissions();
    expect(perm).toEqual({
      type: 'allowedTools',
      tools: ALLOWED_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
    });
  });
});
