import { describe, it, expect } from 'vitest';
import { createInitialState } from '../../src/tui/state.js';

describe('createInitialState', () => {
  it('defaults defaultModel to an empty map', () => {
    const state = createInitialState('doc-123');
    expect(state.settings.defaultModel).toEqual({});
  });

  it('includes defaultModel in settings so it can be persisted/restored', () => {
    const state = createInitialState('doc-123');
    expect(state.settings).toHaveProperty('defaultModel');
    expect(typeof state.settings.defaultModel).toBe('object');
  });
});
