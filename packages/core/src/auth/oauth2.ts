import { google } from 'googleapis';

/**
 * Create an OAuth2 client from client credentials + refresh token.
 */
export function createOAuth2Auth(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}) {
  const client = new google.auth.OAuth2(opts.clientId, opts.clientSecret);
  client.setCredentials({ refresh_token: opts.refreshToken });
  return client;
}
