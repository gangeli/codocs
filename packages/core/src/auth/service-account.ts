import { google } from 'googleapis';
import { readFileSync } from 'node:fs';

const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
];

/**
 * Create a GoogleAuth client from a service account key.
 * @param keyOrPath - Path to the JSON key file, or the parsed key object.
 */
export function createServiceAccountAuth(keyOrPath: string | object) : InstanceType<typeof google.auth.GoogleAuth> {
  const credentials =
    typeof keyOrPath === 'string'
      ? JSON.parse(readFileSync(keyOrPath, 'utf-8'))
      : keyOrPath;

  return new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
  });
}
