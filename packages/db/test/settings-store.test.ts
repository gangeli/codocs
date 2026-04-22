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

  it('saveAll accumulates keys across calls (merge, not replace)', () => {
    store.saveAll('/test', { alpha: 1 });
    store.saveAll('/test', { beta: 2 });

    expect(store.getAll('/test')).toEqual({
      alpha: JSON.stringify(1),
      beta: JSON.stringify(2),
    });
  });

  it('loadAll filters accumulated keys to those present in defaults', () => {
    store.saveAll('/test', { alpha: 1 });
    store.saveAll('/test', { beta: 2 });

    const defaults = { alpha: 0 };
    const loaded = store.loadAll('/test', defaults);
    expect(loaded).toEqual({ alpha: 1 });
  });

  describe('direct get/set/getAll', () => {
    it('set writes a raw value readable by get', () => {
      store.set('/a', 'theme', '"dark"');
      expect(store.get('/a', 'theme')).toBe('"dark"');
    });

    it('getAll returns every key/value pair for the directory', () => {
      store.set('/a', 'theme', '"dark"');
      expect(store.getAll('/a')).toEqual({ theme: '"dark"' });
    });

    it('get returns null for an unknown key', () => {
      expect(store.get('/a', 'missing')).toBeNull();
    });

    it('set replaces the existing value on conflict', () => {
      store.set('/a', 'theme', '"dark"');
      store.set('/a', 'theme', '"light"');
      expect(store.get('/a', 'theme')).toBe('"light"');
    });
  });

  describe('cross-directory isolation', () => {
    it('keeps /a and /b independent for the same key', () => {
      store.set('/a', 'k', 'v1');
      store.set('/b', 'k', 'v2');
      expect(store.get('/a', 'k')).toBe('v1');
      expect(store.get('/b', 'k')).toBe('v2');
      expect(store.getAll('/a')).toEqual({ k: 'v1' });
      expect(store.getAll('/b')).toEqual({ k: 'v2' });
    });

    it('ON CONFLICT(directory,key) does not bleed across directories', () => {
      store.set('/a', 'shared', 'original-a');
      store.set('/b', 'shared', 'original-b');
      store.set('/a', 'shared', 'updated-a');
      expect(store.get('/a', 'shared')).toBe('updated-a');
      expect(store.get('/b', 'shared')).toBe('original-b');
    });
  });

  describe('corrupt-JSON silent recovery', () => {
    it('loadAll returns defaults when a stored value is not valid JSON', () => {
      const defaults = {
        defaultModel: {} as Record<string, string>,
      };

      store.set('/a', 'defaultModel', 'not-json');

      let loaded: typeof defaults | undefined;
      expect(() => {
        loaded = store.loadAll('/a', defaults);
      }).not.toThrow();

      expect(loaded!.defaultModel).toEqual({});
    });
  });
});
