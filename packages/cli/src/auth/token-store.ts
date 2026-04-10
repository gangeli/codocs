/**
 * Persistent storage for OAuth tokens and client config.
 *
 * Config (client_id, client_secret): ~/.config/codocs/config.json
 * Tokens (access, refresh, expiry):  ~/.local/share/codocs/auth.json
 *
 * Respects XDG_CONFIG_HOME and XDG_DATA_HOME environment variables.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface StoredConfig {
  client_id: string;
  client_secret: string;
  gcp_project_id?: string;
  pubsub_topic?: string;
}

/** Baked-in defaults — users don't need their own GCP project. */
export const DEFAULT_CONFIG: StoredConfig = {
  client_id: '529416565463-8jkg7gituq6r8uqmpsmt4d14ej0dhbpu.apps.googleusercontent.com',
  client_secret: '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',
  gcp_project_id: 'codocs-492718',
  pubsub_topic: 'codocs-comments',
};

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expiry_date?: number;
}

export interface GitHubTokens {
  access_token: string;
  scope: string;
}

function getConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'codocs');
}

function getDataDir(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'codocs');
}

function configPath(): string {
  return join(getConfigDir(), 'config.json');
}

function tokensPath(): string {
  return join(getDataDir(), 'auth.json');
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function writeJsonFile(path: string, data: unknown, mode = 0o644): void {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode });
}

export function readConfig(): StoredConfig {
  return readJsonFile<StoredConfig>(configPath()) ?? DEFAULT_CONFIG;
}

export function writeConfig(config: StoredConfig): void {
  writeJsonFile(configPath(), config);
}

export function readTokens(): StoredTokens | null {
  return readJsonFile<StoredTokens>(tokensPath());
}

export function writeTokens(tokens: StoredTokens): void {
  writeJsonFile(tokensPath(), tokens, 0o600);
}

export function clearTokens(): void {
  try {
    unlinkSync(tokensPath());
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// ── GitHub tokens ───────────────────────────────────────────────────

function githubTokensPath(): string {
  return join(getDataDir(), 'github-auth.json');
}

export function readGitHubTokens(): GitHubTokens | null {
  return readJsonFile<GitHubTokens>(githubTokensPath());
}

export function writeGitHubTokens(tokens: GitHubTokens): void {
  writeJsonFile(githubTokensPath(), tokens, 0o600);
}

export function clearGitHubTokens(): void {
  try {
    unlinkSync(githubTokensPath());
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
}
