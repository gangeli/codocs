import type { Command } from 'commander';
import {
  readConfig,
  readTokens,
  writeTokens,
  clearTokens,
} from '../auth/token-store.js';
import { runOAuth2Flow } from '../auth/oauth2-flow.js';
import { withErrorHandler } from '../util.js';

export function registerAuthCommands(program: Command) {
  const auth = program
    .command('auth')
    .description('Manage Google authentication');

  auth
    .command('login')
    .description('Authenticate with Google via OAuth')
    .action(
      withErrorHandler(async () => {
        const config = readConfig();
        const tokens = await runOAuth2Flow(config.client_id, config.client_secret);
        writeTokens(tokens);
        console.error('Authentication successful! Tokens saved.');
      }),
    );

  auth
    .command('status')
    .description('Show authentication status')
    .action(
      withErrorHandler(async () => {
        const config = readConfig();
        const tokens = readTokens();

        if (!tokens) {
          console.log('Status: Not authenticated');
          console.log('Run `codocs auth login` to authenticate.');
          return;
        }

        if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
          console.log(
            'Status: Access token expired (will auto-refresh on next request)',
          );
        } else {
          console.log('Status: Authenticated');
        }

        console.log(`Refresh token: ${tokens.refresh_token.slice(0, 8)}...`);

        if (config.gcp_project_id) {
          console.log(`GCP Project: ${config.gcp_project_id}`);
          console.log(`Pub/Sub Topic: ${config.pubsub_topic ?? '(not set)'}`);
        }
      }),
    );

  auth
    .command('logout')
    .description('Clear stored tokens')
    .action(
      withErrorHandler(async () => {
        clearTokens();
        console.log('Tokens cleared. Run `codocs auth login` to re-authenticate.');
      }),
    );
}
