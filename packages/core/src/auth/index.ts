import type { AuthConfig } from '../types.js';
import { createServiceAccountAuth } from './service-account.js';
import { createOAuth2Auth } from './oauth2.js';

/**
 * Create a Google auth client from the provided config.
 * Priority: authClient > serviceAccountKey > oauth2.
 */
export function createAuth(config: AuthConfig) {
  if (config.authClient) {
    return config.authClient;
  }
  if (config.serviceAccountKey) {
    return createServiceAccountAuth(config.serviceAccountKey);
  }
  if (config.oauth2) {
    return createOAuth2Auth(config.oauth2);
  }
  throw new Error(
    'AuthConfig must include one of: authClient, serviceAccountKey, or oauth2',
  );
}
