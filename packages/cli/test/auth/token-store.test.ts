import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readConfig,
  writeConfig,
  readTokens,
  writeTokens,
  clearTokens,
  tokensPath,
  configPath,
  readGitHubTokens,
  writeGitHubTokens,
  clearGitHubTokens,
} from '../../src/auth/token-store.js';

let tempDir: string;
let origConfigHome: string | undefined;
let origDataHome: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'codocs-test-'));
  origConfigHome = process.env.XDG_CONFIG_HOME;
  origDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_CONFIG_HOME = join(tempDir, 'config');
  process.env.XDG_DATA_HOME = join(tempDir, 'data');
});

afterEach(() => {
  if (origConfigHome !== undefined) {
    process.env.XDG_CONFIG_HOME = origConfigHome;
  } else {
    delete process.env.XDG_CONFIG_HOME;
  }
  if (origDataHome !== undefined) {
    process.env.XDG_DATA_HOME = origDataHome;
  } else {
    delete process.env.XDG_DATA_HOME;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('config storage', () => {
  it('returns defaults when no config file exists', () => {
    const config = readConfig();
    expect(config.client_id).toBeTruthy();
    expect(config.client_secret).toBeTruthy();
  });

  it('writes and reads config', () => {
    const config = { client_id: 'test-id', client_secret: 'test-secret' };
    writeConfig(config);
    expect(readConfig()).toEqual(config);
  });

  it('overwrites existing config', () => {
    writeConfig({ client_id: 'old', client_secret: 'old' });
    writeConfig({ client_id: 'new', client_secret: 'new' });
    expect(readConfig()).toEqual({ client_id: 'new', client_secret: 'new' });
  });

  it('writeConfig creates the file with mode 0o600', () => {
    writeConfig({ client_id: 'a', client_secret: 'b' });
    const mode = statSync(configPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('token storage', () => {
  it('returns null when no tokens exist', () => {
    expect(readTokens()).toBeNull();
  });

  it('writes and reads tokens', () => {
    const tokens = {
      access_token: 'access',
      refresh_token: 'refresh',
      expiry_date: 1234567890,
    };
    writeTokens(tokens);
    expect(readTokens()).toEqual(tokens);
  });

  it('clears tokens', () => {
    writeTokens({
      access_token: 'a',
      refresh_token: 'r',
    });
    clearTokens();
    expect(readTokens()).toBeNull();
  });

  it('clearTokens is idempotent', () => {
    expect(() => {
      clearTokens();
      clearTokens();
    }).not.toThrow();
  });

  it('writeTokens creates the file with mode 0o600', () => {
    writeTokens({ access_token: 'a', refresh_token: 'r' });
    const mode = statSync(tokensPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('github token storage', () => {
  it('returns null when no tokens exist', () => {
    expect(readGitHubTokens()).toBeNull();
  });

  it('writes and reads tokens', () => {
    const tokens = { access_token: 'gho_abc', scope: 'repo,read:user' };
    writeGitHubTokens(tokens);
    expect(readGitHubTokens()).toEqual(tokens);
  });

  it('clears tokens', () => {
    writeGitHubTokens({ access_token: 'gho_abc', scope: 'repo' });
    clearGitHubTokens();
    expect(readGitHubTokens()).toBeNull();
  });

  it('clearGitHubTokens is idempotent', () => {
    expect(() => {
      clearGitHubTokens();
      clearGitHubTokens();
    }).not.toThrow();
  });
});
