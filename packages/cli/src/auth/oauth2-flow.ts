/**
 * Full OAuth2 "installed app" flow:
 * 1. Open browser to Google consent screen
 * 2. Spin up localhost server to capture redirect
 * 3. Exchange auth code for tokens
 */

import { createServer, type Server } from 'node:http';
import { URL } from 'node:url';
import { google } from 'googleapis';
import open from 'open';
import type { StoredTokens } from './token-store.js';
import { spin } from '../util.js';

const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/pubsub',
];

const TIMEOUT_MS = 120_000; // 2 minutes

export async function runOAuth2Flow(
  clientId: string,
  clientSecret: string,
): Promise<StoredTokens> {
  let s = spin('Starting local callback server...');
  const { server, port } = await startCallbackServer();
  const redirectUri = `http://localhost:${port}/callback`;

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  s.succeed(`Callback server listening on port ${port}`);

  console.error(`If the browser doesn't open, visit:\n${authUrl}\n`);

  s = spin('Opening browser for Google authentication...');
  await open(authUrl);
  s.update('Waiting for Google authorization in browser...');

  try {
    const code = await waitForAuthCode(server, TIMEOUT_MS);
    s.succeed('Authorization received');

    s = spin('Exchanging authorization code for tokens...');
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      s.fail('No refresh token received');
      throw new Error(
        'No refresh token received. Try revoking app access at https://myaccount.google.com/permissions and re-authenticating.',
      );
    }

    s.succeed('Tokens received');

    return {
      access_token: tokens.access_token ?? '',
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date ?? undefined,
    };
  } catch (err) {
    s.fail('Authentication failed');
    throw err;
  } finally {
    server.close();
  }
}

function startCallbackServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to start callback server'));
        return;
      }
      resolve({ server, port: addr.port });
    });
    server.on('error', reject);
  });
}

// SVG favicon + page icon: a folded document with a pen nib
const DOC_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#faf9f6"/>
      <stop offset="100%" stop-color="#f0ece4"/>
    </linearGradient>
    <linearGradient id="fold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#e0dbd2"/>
      <stop offset="100%" stop-color="#d0cbbf"/>
    </linearGradient>
  </defs>
  <!-- Paper -->
  <path d="M12 4h28l12 12v40a4 4 0 01-4 4H16a4 4 0 01-4-4V8a4 4 0 014-4z" fill="url(#paper)" stroke="#c5bfb3" stroke-width="1.5"/>
  <!-- Fold -->
  <path d="M40 4v8a4 4 0 004 4h8" fill="url(#fold)" stroke="#c5bfb3" stroke-width="1.5"/>
  <!-- Text lines -->
  <line x1="20" y1="26" x2="44" y2="26" stroke="#bbb5a8" stroke-width="2" stroke-linecap="round"/>
  <line x1="20" y1="34" x2="40" y2="34" stroke="#ccc7bb" stroke-width="2" stroke-linecap="round"/>
  <line x1="20" y1="42" x2="36" y2="42" stroke="#ddd8ce" stroke-width="2" stroke-linecap="round"/>
  <!-- Pen nib -->
  <g transform="translate(38,44) rotate(-45)">
    <rect x="-2" y="-14" width="4" height="12" rx="1" fill="#5a5347"/>
    <polygon points="-2,-2 2,-2 0,4" fill="#3a352e"/>
    <rect x="-2" y="-14" width="4" height="3" rx="1" fill="#8a8477"/>
  </g>
</svg>`;

const FAVICON = `data:image/svg+xml,${encodeURIComponent(DOC_ICON_SVG)}`;

function renderPage(title: string, message: string, isError: boolean): string {
  const accentColor = isError ? '#9e4b4b' : '#5a7a5a';
  const checkOrX = isError
    ? `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" style="margin-bottom:12px">
        <circle cx="24" cy="24" r="22" stroke="${accentColor}" stroke-width="2.5" fill="none"/>
        <line x1="16" y1="16" x2="32" y2="32" stroke="${accentColor}" stroke-width="2.5" stroke-linecap="round"/>
        <line x1="32" y1="16" x2="16" y2="32" stroke="${accentColor}" stroke-width="2.5" stroke-linecap="round"/>
      </svg>`
    : `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" style="margin-bottom:12px">
        <circle cx="24" cy="24" r="22" stroke="${accentColor}" stroke-width="2.5" fill="none"/>
        <polyline points="14,25 21,32 34,18" stroke="${accentColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — codocs</title>
  <link rel="icon" href="${FAVICON}">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&family=IBM+Plex+Mono:wght@400&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #e8e4dc;
      background-image:
        radial-gradient(ellipse at 30% 20%, rgba(255,255,255,0.4) 0%, transparent 60%),
        radial-gradient(ellipse at 70% 80%, rgba(0,0,0,0.03) 0%, transparent 50%);
      font-family: 'Newsreader', 'Georgia', serif;
    }

    .page {
      position: relative;
      background: linear-gradient(175deg, #faf9f6 0%, #f5f2ec 100%);
      border: 1px solid #d5d0c7;
      border-radius: 2px;
      padding: 56px 52px 48px;
      max-width: 460px;
      width: 90vw;
      box-shadow:
        0 1px 3px rgba(0,0,0,0.06),
        0 8px 24px rgba(0,0,0,0.08),
        inset 0 1px 0 rgba(255,255,255,0.7);
    }

    /* Subtle fold in top-right corner */
    .page::before {
      content: '';
      position: absolute;
      top: 0; right: 0;
      width: 28px; height: 28px;
      background: linear-gradient(225deg, #e8e4dc 50%, #ebe7df 50.5%, #f0ece4 51%);
      border-bottom-left-radius: 4px;
    }

    /* Faint ruled lines */
    .page::after {
      content: '';
      position: absolute;
      top: 48px; left: 40px; right: 40px; bottom: 40px;
      background: repeating-linear-gradient(
        to bottom,
        transparent,
        transparent 31px,
        rgba(180, 170, 155, 0.15) 31px,
        rgba(180, 170, 155, 0.15) 32px
      );
      pointer-events: none;
      z-index: 0;
    }

    .content {
      position: relative;
      z-index: 1;
      text-align: center;
    }

    .icon {
      width: 52px;
      height: 52px;
      margin: 0 auto 20px;
      opacity: 0.85;
    }

    h1 {
      font-size: 22px;
      font-weight: 500;
      color: #2e2b26;
      letter-spacing: -0.01em;
      line-height: 1.3;
      margin-bottom: 14px;
    }

    p {
      font-size: 15px;
      color: #6b655b;
      line-height: 1.6;
    }

    .app-name {
      display: inline-block;
      margin-top: 28px;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 12px;
      color: #b0a998;
      letter-spacing: 0.08em;
    }

    .auto-close {
      margin-top: 16px;
      font-size: 13px;
      font-style: italic;
      color: #a09888;
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="content">
      ${checkOrX}
      <h1>${title}</h1>
      <p>${message}</p>
      <p class="auto-close">You may close this tab.</p>
      <span class="app-name">codocs</span>
    </div>
  </div>
</body>
</html>`;
}

function waitForAuthCode(server: Server, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Authentication timed out. Please try again.'));
    }, timeoutMs);

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderPage('Authentication Failed', 'Something went wrong. Please return to the terminal and try again.', true));
        clearTimeout(timer);
        reject(new Error(`Authentication failed: ${error}`));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400);
        res.end('Missing authorization code');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderPage('Authentication Successful', 'You can close this tab and return to the terminal.', false));
      clearTimeout(timer);
      resolve(code);
    });
  });
}
