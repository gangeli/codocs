/**
 * Pub/Sub pull listener for Workspace Events comment notifications.
 *
 * Receives messages from a Pub/Sub subscription, parses the Workspace Events
 * payload, fetches full comment details from the Drive API, and invokes a
 * callback for each comment event.
 */

import { PubSub, type Subscription, type Message } from '@google-cloud/pubsub';
import { DriveApi } from '../client/drive-api.js';
import { createAuth } from '../auth/index.js';
import type { CommentEvent } from '../types.js';

/** Extract @mentions from comment content (patterns like +user@example.com or @user@example.com). */
function extractMentions(content: string): string[] {
  const matches = content.match(/[+@]([\w.+-]+@[\w.-]+\.\w+)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1)); // strip leading + or @
}

/**
 * Extract the document ID from a Pub/Sub message.
 * Checks ce-subject (has the file path) and payload.comment.fileId.
 */
function extractDocumentId(message: Message, payload: Record<string, any>): string {
  // ce-subject format: googleapis.com/drive/v3/files/DOC_ID
  const subject = message.attributes?.['ce-subject'] ?? '';
  const subjectMatch = subject.match(/\/files\/([a-zA-Z0-9_-]+)/);
  if (subjectMatch) return subjectMatch[1];

  // Fallback: payload.comment.fileId
  if (payload?.comment?.fileId) return payload.comment.fileId;

  // Last resort: try ce-source (older format)
  const source = message.attributes?.['ce-source'] ?? '';
  const sourceMatch = source.match(/\/documents\/(.+)$/);
  if (sourceMatch) return sourceMatch[1];

  return '';
}

/** Parse minimal info from a Pub/Sub message. Returns null if not a comment event. */
function parseEventStub(message: Message): {
  eventType: string;
  documentId: string;
  commentId: string;
  eventTime: string;
} | null {
  const eventType = message.attributes?.['ce-type'] ?? message.attributes?.['event_type'] ?? '';
  const eventTime = message.attributes?.['ce-time'] ?? message.attributes?.['event_time'] ?? '';

  if (!eventType.includes('comment')) {
    return null;
  }

  let payload: Record<string, any> = {};
  try {
    const raw = message.data.toString('utf-8');
    if (raw) payload = JSON.parse(raw);
  } catch {
    // continue with empty payload
  }

  const documentId = extractDocumentId(message, payload);
  const commentId = payload?.comment?.id ?? '';

  if (!documentId || !commentId) {
    return null;
  }

  return { eventType, documentId, commentId, eventTime };
}

export interface CommentListenerHandle {
  /** Stop listening and close the subscription. */
  close(): Promise<void>;
}

export interface PubSubAuth {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface ListenOptions {
  /** Log debug messages. Defaults to no-op. */
  debug?: (msg: string) => void;
}

/**
 * Start listening for comment events from a Pub/Sub subscription.
 *
 * When a comment event arrives, fetches the full comment from the Drive API
 * and invokes the callback with the complete CommentEvent.
 */
export function listenForComments(
  gcpProjectId: string,
  subscriptionName: string,
  auth: PubSubAuth,
  onComment: (event: CommentEvent) => void,
  onError?: (error: Error) => void,
  options?: ListenOptions,
): CommentListenerHandle {
  const debug = options?.debug ?? (() => {});

  const fullSubName = subscriptionName.includes('/')
    ? subscriptionName
    : `projects/${gcpProjectId}/subscriptions/${subscriptionName}`;

  debug(`Connecting to Pub/Sub subscription: ${fullSubName}`);
  debug(`Project: ${gcpProjectId}`);
  debug(`Auth client_id: ${auth.clientId.slice(0, 12)}...`);

  const pubsub = new PubSub({
    projectId: gcpProjectId,
    credentials: {
      type: 'authorized_user',
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      refresh_token: auth.refreshToken,
    },
  });
  const subscription: Subscription = pubsub.subscription(fullSubName);

  // Create a Drive API client for fetching full comment details
  const driveAuth = createAuth({
    oauth2: {
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      refreshToken: auth.refreshToken,
    },
  });
  const driveApi = new DriveApi(driveAuth);

  debug('Subscription object created, waiting for messages...');

  const messageHandler = async (message: Message) => {
    debug(`--- Raw Pub/Sub message received ---`);
    debug(`  Message ID: ${message.id}`);
    debug(`  Publish time: ${message.publishTime?.toISOString()}`);
    debug(`  Attributes: ${JSON.stringify(message.attributes)}`);

    let dataStr: string;
    try {
      dataStr = message.data.toString('utf-8');
      debug(`  Data (${dataStr.length} chars): ${dataStr.slice(0, 500)}${dataStr.length > 500 ? '...' : ''}`);
    } catch (e) {
      debug(`  Data: <failed to decode: ${e}>`);
    }

    const stub = parseEventStub(message);
    if (!stub) {
      debug(`  → Not a comment event or missing IDs (skipped)`);
      message.ack();
      return;
    }

    debug(`  → Comment event: type=${stub.eventType} doc=${stub.documentId} comment=${stub.commentId}`);

    // Fetch full comment details from Drive API
    try {
      debug(`  → Fetching full comment from Drive API...`);
      const comment = await driveApi.getComment(stub.documentId, stub.commentId);
      debug(`  → Got comment: author=${comment.author?.displayName} content="${comment.content?.slice(0, 100)}"`);

      const content = comment.content ?? '';
      const event: CommentEvent = {
        eventType: stub.eventType,
        documentId: stub.documentId,
        comment: {
          id: stub.commentId,
          content,
          author: comment.author?.displayName ?? comment.author?.emailAddress ?? undefined,
          quotedText: comment.quotedFileContent?.value ?? undefined,
          createdTime: comment.createdTime ?? undefined,
          mentions: extractMentions(content),
        },
        eventTime: stub.eventTime,
      };

      onComment(event);
    } catch (err: any) {
      debug(`  → Failed to fetch comment: ${err.message}`);
      // Still emit what we have from the event payload
      onComment({
        eventType: stub.eventType,
        documentId: stub.documentId,
        comment: {
          id: stub.commentId,
          content: undefined,
          author: undefined,
          quotedText: undefined,
          createdTime: undefined,
          mentions: [],
        },
        eventTime: stub.eventTime,
      });
    }

    message.ack();
    debug(`  → Acknowledged`);
  };

  const errorHandler = (error: Error) => {
    debug(`Pub/Sub error: ${error.message}`);
    if ((error as any).code) {
      debug(`  Error code: ${(error as any).code}`);
    }
    if (onError) {
      onError(error);
    }
  };

  subscription.on('message', messageHandler);
  subscription.on('error', errorHandler);

  subscription.on('close', () => {
    debug('Pub/Sub subscription stream closed');
  });

  return {
    async close() {
      debug('Closing listener...');
      subscription.removeListener('message', messageHandler);
      subscription.removeListener('error', errorHandler);
      await subscription.close();
      debug('Listener closed');
    },
  };
}
