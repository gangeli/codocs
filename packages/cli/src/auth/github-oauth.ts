/**
 * GitHub OAuth device authorization flow.
 *
 * 1. Request a device code from GitHub
 * 2. Show the user a URL + code to enter in the browser
 * 3. Poll for the access token until the user approves
 *
 * See: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */

import open from 'open';
import { spin } from '../util.js';
import type { GitHubTokens } from './token-store.js';

/**
 * Codocs GitHub OAuth App client ID.
 * Device flow does not require a client secret.
 */
const GITHUB_CLIENT_ID = 'Ov23liXXXXXXXXXXXXXX'; // TODO: Register a GitHub OAuth App and fill in the real client ID

const SCOPES = 'repo';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

interface ErrorResponse {
  error: string;
  error_description?: string;
}

async function requestDeviceCode(clientId: string): Promise<DeviceCodeResponse> {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      scope: SCOPES,
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub device code request failed: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<DeviceCodeResponse>;
}

async function pollForToken(
  clientId: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<TokenResponse> {
  const deadline = Date.now() + expiresIn * 1000;
  let pollInterval = interval * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    if (!res.ok) {
      throw new Error(`GitHub token request failed: ${res.status} ${res.statusText}`);
    }

    const body = await res.json() as TokenResponse & ErrorResponse;

    if ('access_token' in body && body.access_token) {
      return body as TokenResponse;
    }

    const error = (body as ErrorResponse).error;

    if (error === 'authorization_pending') {
      // User hasn't entered the code yet — keep polling
      continue;
    }

    if (error === 'slow_down') {
      // GitHub is asking us to poll less frequently
      pollInterval += 5000;
      continue;
    }

    if (error === 'expired_token') {
      throw new Error('Device code expired. Please try again.');
    }

    if (error === 'access_denied') {
      throw new Error('Authorization was denied by the user.');
    }

    throw new Error(`GitHub OAuth error: ${error} — ${(body as ErrorResponse).error_description ?? ''}`);
  }

  throw new Error('Device code expired. Please try again.');
}

/**
 * Run the GitHub device authorization flow.
 *
 * Displays a user code and opens the browser to GitHub's verification URL.
 * Polls until the user authorizes or the code expires.
 */
export async function runGitHubOAuthFlow(
  clientId: string = GITHUB_CLIENT_ID,
): Promise<GitHubTokens> {
  const s = spin('Requesting GitHub device code...');

  try {
    const device = await requestDeviceCode(clientId);
    s.succeed('Device code received');

    console.error('');
    console.error(`  Enter this code on GitHub: \x1b[1m${device.user_code}\x1b[0m`);
    console.error(`  URL: ${device.verification_uri}`);
    console.error('');

    await open(device.verification_uri);

    const s2 = spin('Waiting for GitHub authorization in browser...');
    try {
      const token = await pollForToken(clientId, device.device_code, device.interval, device.expires_in);
      s2.succeed('GitHub authorization received');

      return {
        access_token: token.access_token,
        scope: token.scope,
      };
    } catch (err) {
      s2.fail('GitHub authentication failed');
      throw err;
    }
  } catch (err) {
    s.fail('GitHub device code request failed');
    throw err;
  }
}
