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
import { classifyComment } from './classify.js';
import type { CommentEvent } from '../types.js';

/** Extract @mentions from comment content (patterns like +user@example.com or @user@example.com). */
export function extractMentions(content: string): string[] {
  const matches = content.match(/[+@]([\w.+-]+@[\w.-]+\.\w+)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1)); // strip leading + or @
}

/**
 * Extract the document ID from a Pub/Sub message.
 * Checks ce-subject (has the file path) and payload.comment.fileId.
 */
export function extractDocumentId(message: Message, payload: Record<string, any>): string {
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
export function parseEventStub(message: Message): {
  eventType: string;
  documentId: string;
  commentId: string;
  eventTime: string;
} | null {
  const eventType = message.attributes?.['ce-type'] ?? message.attributes?.['event_type'] ?? '';
  const eventTime = message.attributes?.['ce-time'] ?? message.attributes?.['event_time'] ?? '';

  if (!eventType.includes('comment') && !eventType.includes('reply')) {
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
  // For comment events: payload.comment.id
  // For reply events: the parent comment ID may be in payload.comment.id
  // or payload.reply.commentId
  const commentId = payload?.comment?.id ?? payload?.reply?.commentId ?? '';

  if (!documentId) {
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
  /** Email addresses of known bot identities. Used to skip events
   *  triggered by the bot's own replies (e.g., the 🤔 thinking emoji). */
  botEmails?: string[];
  /** Tracker of reply IDs posted by codocs itself. Used to break reply
   *  loops when codocs replies using the user's own OAuth credentials —
   *  in that case the author looks identical to a human reply. */
  replyTracker?: { has(id: string): boolean };
  /** Initial reconnect delay after the stream drops. Default 1000 ms. */
  reconnectInitialDelayMs?: number;
  /** Maximum backoff between reconnect attempts. Default 60_000 ms. */
  reconnectMaxDelayMs?: number;
  /** How often the watchdog checks subscription health. Default 60_000 ms.
   *  Set to 0 to disable. */
  healthCheckIntervalMs?: number;
  /** Force a reconnect if no message has been seen for this long. Defensive
   *  guard against half-open streams the library doesn't notice. Default
   *  0 (disabled). */
  idleReconnectMs?: number;
  /** Called whenever the listener reconnects to the subscription. Useful for
   *  surfacing reconnect events in UI/status. */
  onReconnect?: (info: { attempt: number; reason: string }) => void;
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

  // Create a Drive API client for fetching full comment details
  const driveAuth = createAuth({
    oauth2: {
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      refreshToken: auth.refreshToken,
    },
  });
  const driveApi = new DriveApi(driveAuth);

  const initialDelay = options?.reconnectInitialDelayMs ?? 1000;
  const maxDelay = options?.reconnectMaxDelayMs ?? 60_000;
  const healthInterval = options?.healthCheckIntervalMs ?? 60_000;
  const idleReconnectMs = options?.idleReconnectMs ?? 0;

  let subscription: Subscription = pubsub.subscription(fullSubName);
  let manuallyClosed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let healthTimer: NodeJS.Timeout | null = null;
  let lastActivityAt = Date.now();

  debug('Subscription object created, waiting for messages...');

  const messageHandler = async (message: Message) => {
    lastActivityAt = Date.now();
    reconnectAttempt = 0;
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

    debug(`  → Comment event: type=${stub.eventType} doc=${stub.documentId} comment=${stub.commentId || '(no id)'}`);

    // If we have a comment ID, fetch full details from Drive API
    if (stub.commentId) {
      try {
        debug(`  → Fetching full comment from Drive API...`);
        const comment = await driveApi.getComment(stub.documentId, stub.commentId);
        debug(`  → Got comment: author=${comment.author?.displayName} content="${comment.content?.slice(0, 100)}"`);

        // Build the thread history from the comment + its replies
        const thread: CommentEvent['thread'] = [
          {
            author: comment.author?.displayName ?? comment.author?.emailAddress ?? undefined,
            content: comment.content ?? undefined,
            createdTime: comment.createdTime ?? undefined,
          },
        ];
        for (const reply of comment.replies ?? []) {
          if (reply.action) continue; // skip resolve/reopen actions
          thread.push({
            author: reply.author?.displayName ?? reply.author?.emailAddress ?? undefined,
            content: reply.content ?? undefined,
            createdTime: reply.createdTime ?? undefined,
          });
        }

        // The "active" message is the last one in the thread
        const lastMessage = thread[thread.length - 1];
        const content = lastMessage.content ?? '';

        // Classify: only process events where the latest message is from a human
        const origin = classifyComment(comment, {
          botEmails: options?.botEmails ?? [],
          ownReplyIds: options?.replyTracker,
        });
        if (origin.type === 'bot') {
          debug(`  → Skipping: last message is from codocs (${origin.author})`);
          message.ack();
          return;
        }

        const event: CommentEvent = {
          eventType: stub.eventType,
          documentId: stub.documentId,
          comment: {
            id: stub.commentId,
            content,
            author: lastMessage.author,
            quotedText: comment.quotedFileContent?.value ?? undefined,
            createdTime: lastMessage.createdTime,
            mentions: extractMentions(content),
          },
          eventTime: stub.eventTime,
          thread: thread.length > 1 ? thread : undefined,
        };

        onComment(event);
      } catch (err: any) {
        debug(`  → Failed to fetch comment: ${err.message}`);
        // Fall through to payload-based approach
        emitFromPayload(stub, onComment);
      }
    } else {
      debug(`  → No comment ID in payload, using payload data directly`);
      emitFromPayload(stub, onComment);
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

  function emitFromPayload(
    stub: { eventType: string; documentId: string; commentId: string; eventTime: string },
    cb: (event: CommentEvent) => void,
  ) {
    cb({
      eventType: stub.eventType,
      documentId: stub.documentId,
      comment: {
        id: stub.commentId || undefined,
        content: undefined,
        author: undefined,
        quotedText: undefined,
        createdTime: undefined,
        mentions: [],
      },
      eventTime: stub.eventTime,
    });
  }

  const closeHandler = () => {
    debug('Pub/Sub subscription stream closed');
    if (manuallyClosed) return;
    scheduleReconnect('subscription emitted close');
  };

  function attachHandlers(sub: Subscription) {
    sub.on('message', messageHandler);
    sub.on('error', errorHandler);
    sub.on('close', closeHandler);
  }

  function detachHandlers(sub: Subscription) {
    sub.removeListener('message', messageHandler);
    sub.removeListener('error', errorHandler);
    sub.removeListener('close', closeHandler);
  }

  function scheduleReconnect(reason: string) {
    if (manuallyClosed || reconnectTimer) return;
    const delay = Math.min(maxDelay, initialDelay * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    debug(`Scheduling reconnect (attempt ${reconnectAttempt}) in ${delay}ms — ${reason}`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnect(reason).catch((err) => {
        debug(`Reconnect failed: ${(err as Error).message}`);
        scheduleReconnect(`retry after failure: ${(err as Error).message}`);
      });
    }, delay);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  async function reconnect(reason: string) {
    if (manuallyClosed) return;
    const old = subscription;
    detachHandlers(old);
    try {
      await old.close();
    } catch (err) {
      debug(`Old subscription close errored (ignored): ${(err as Error).message}`);
    }
    if (manuallyClosed) return;
    subscription = pubsub.subscription(fullSubName);
    attachHandlers(subscription);
    lastActivityAt = Date.now();
    debug(`Reconnected to ${fullSubName} (attempt ${reconnectAttempt}, reason: ${reason})`);
    options?.onReconnect?.({ attempt: reconnectAttempt, reason });
  }

  attachHandlers(subscription);

  if (healthInterval > 0) {
    healthTimer = setInterval(() => {
      if (manuallyClosed) return;
      if (!subscription.isOpen) {
        debug('Health check: subscription not open, recycling');
        scheduleReconnect('health check: not open');
        return;
      }
      if (idleReconnectMs > 0 && Date.now() - lastActivityAt > idleReconnectMs) {
        debug(`Health check: idle for ${Date.now() - lastActivityAt}ms, recycling`);
        lastActivityAt = Date.now(); // avoid retrigger while reconnect is pending
        scheduleReconnect('health check: idle');
      }
    }, healthInterval);
    if (typeof healthTimer.unref === 'function') healthTimer.unref();
  }

  return {
    async close() {
      debug('Closing listener...');
      manuallyClosed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (healthTimer) {
        clearInterval(healthTimer);
        healthTimer = null;
      }
      detachHandlers(subscription);
      await subscription.close();
      debug('Listener closed');
    },
  };
}
