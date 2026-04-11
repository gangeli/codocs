import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../src/database.js';
import { SettingsStore } from '../src/settings-store.js';
import type { Database } from 'sql.js';

describe('SettingsStore', () => {
  let db: Database;
  let store: SettingsStore;

  beforeEach(async () => {
    db = await openDatabase(':memory:');
    store = new SettingsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('persists and loads defaultModel as part of settings', () => {
    const defaults = {
      maxAgents: 3,
      debugMode: false,
      defaultModel: {} as Record<string, string>,
    };

    // Save with a model configured
    store.saveAll('/test', { ...defaults, defaultModel: { claude: 'sonnet' } });

    const loaded = store.loadAll('/test', defaults);
    expect(loaded.defaultModel).toEqual({ claude: 'sonnet' });
  });

  it('defaults to empty map when no defaultModel is stored', () => {
    const defaults = {
      maxAgents: 3,
      defaultModel: {} as Record<string, string>,
    };

    const loaded = store.loadAll('/test', defaults);
    expect(loaded.defaultModel).toEqual({});
  });

  it('preserves multiple agent type entries in defaultModel', () => {
    const defaults = {
      defaultModel: {} as Record<string, string>,
    };

    store.saveAll('/test', {
      defaultModel: { claude: 'opus', future_agent: 'gpt-4o' },
    });

    const loaded = store.loadAll('/test', defaults);
    expect(loaded.defaultModel).toEqual({ claude: 'opus', future_agent: 'gpt-4o' });
  });

  it('overwrites defaultModel on re-save', () => {
    const defaults = { defaultModel: {} as Record<string, string> };

    store.saveAll('/test', { defaultModel: { claude: 'haiku' } });
    store.saveAll('/test', { defaultModel: { claude: 'opus' } });

    const loaded = store.loadAll('/test', defaults);
    expect(loaded.defaultModel).toEqual({ claude: 'opus' });
  });
});
