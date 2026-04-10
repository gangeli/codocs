import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import {
  readConfig,
  readTokens,
  writeTokens,
  clearTokens,
  readGitHubTokens,
  writeGitHubTokens,
  clearGitHubTokens,
} from '../auth/token-store.js';
import { runOAuth2Flow } from '../auth/oauth2-flow.js';
import { runGitHubOAuthFlow } from '../auth/github-oauth.js';
import { withErrorHandler } from '../util.js';

function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${question} (Y/n) `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === '' || trimmed.startsWith('y'));
    });
  });
}

export function registerAuthCommands(program: Command) {
  const auth = program
    .command('auth')
    .description('Manage Google and GitHub authentication');

  auth
    .command('login')
    .description(
      'Authenticate with Google (required) and GitHub (optional).\n' +
      'Google auth enables reading and editing Google Docs.\n' +
      'GitHub auth enables creating draft PRs for code changes via worktrees.\n' +
      'Without GitHub, code changes are made directly on the current branch.',
    )
    .option('--github', 'Only run the GitHub authentication step')
    .action(
      withErrorHandler(async (opts: { github?: boolean }) => {
        if (!opts.github) {
          // Google OAuth
          const config = readConfig();
          const tokens = await runOAuth2Flow(config.client_id, config.client_secret);
          writeTokens(tokens);
          console.error('Google authentication successful! Tokens saved.\n');
        }

        // GitHub OAuth — prompt unless --github flag was used (explicit intent)
        const existingGh = readGitHubTokens();
        if (existingGh && !opts.github) {
          console.error('GitHub: Already connected.\n');
        } else {
          const shouldConnect = opts.github || await promptYesNo(
            'Connect GitHub? This enables creating draft PRs for code changes (recommended).',
          );

          if (shouldConnect) {
            const ghTokens = await runGitHubOAuthFlow();
            writeGitHubTokens(ghTokens);
            console.error('GitHub authentication successful! Token saved.\n');
          } else {
            console.error(
              'Skipped GitHub. Code changes will be made directly on the current branch.\n' +
              'You can connect later with: codocs auth login --github\n',
            );
          }
        }
      }),
    );

  auth
    .command('status')
    .description('Show authentication status')
    .action(
      withErrorHandler(async () => {
        const config = readConfig();
        const tokens = readTokens();
        const ghTokens = readGitHubTokens();

        console.log('── Google ──');
        if (!tokens) {
          console.log('Status: Not authenticated');
          console.log('Run `codocs auth login` to authenticate.');
        } else if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
          console.log(
            'Status: Access token expired (will auto-refresh on next request)',
          );
          console.log(`Refresh token: ${tokens.refresh_token.slice(0, 8)}...`);
        } else {
          console.log('Status: Authenticated');
          console.log(`Refresh token: ${tokens.refresh_token.slice(0, 8)}...`);
        }

        if (config.gcp_project_id) {
          console.log(`GCP Project: ${config.gcp_project_id}`);
          console.log(`Pub/Sub Topic: ${config.pubsub_topic ?? '(not set)'}`);
        }

        console.log('');
        console.log('── GitHub ──');
        if (!ghTokens) {
          console.log('Status: Not connected');
          console.log('Code changes will be made directly on the current branch.');
          console.log('Run `codocs auth login --github` to enable draft PRs via worktrees.');
        } else {
          console.log('Status: Connected');
          console.log(`Scopes: ${ghTokens.scope}`);
          console.log(`Token: ${ghTokens.access_token.slice(0, 8)}...`);
        }
      }),
    );

  auth
    .command('logout')
    .description('Clear all stored tokens (Google and GitHub)')
    .action(
      withErrorHandler(async () => {
        clearTokens();
        clearGitHubTokens();
        console.log('All tokens cleared. Run `codocs auth login` to re-authenticate.');
      }),
    );
}
