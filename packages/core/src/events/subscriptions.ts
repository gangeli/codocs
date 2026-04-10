/**
 * Manage Google Workspace Events API subscriptions for Google Docs comment events.
 *
 * Subscriptions expire after 7 days and must be renewed.
 */

import { google, type workspaceevents_v1 } from 'googleapis';

const COMMENT_EVENT_TYPES = [
  'google.workspace.drive.comment.v3.created',
  'google.workspace.drive.reply.v3.created',
];

export interface SubscriptionInfo {
  name: string;
  targetResource: string;
  eventTypes: string[];
  expireTime: string;
}

/**
 * Create a Workspace Events subscription for comment events on a Google Doc.
 * Returns the subscription resource name (used for renewal/deletion).
 */
export async function createCommentSubscription(
  auth: unknown,
  docId: string,
  pubsubTopic: string,
  debug?: (msg: string) => void,
): Promise<SubscriptionInfo> {
  const log = debug ?? (() => {});
  const client = google.workspaceevents({
    version: 'v1',
    auth: auth as any,
  });

  const res = await client.subscriptions.create({
    requestBody: {
      targetResource: `//drive.googleapis.com/files/${docId}`,
      eventTypes: COMMENT_EVENT_TYPES,
      notificationEndpoint: {
        pubsubTopic,
      },
      payloadOptions: {
        includeResource: true,
      },
    },
  });

  // subscriptions.create returns a long-running operation.
  // We need to poll it until done to get the actual subscription.
  const operation = res.data;
  log(`LRO created: name=${operation.name} done=${operation.done}`);

  if (operation.done && operation.response) {
    return extractSubscriptionFromResponse(operation.response as Record<string, any>);
  }

  if (!operation.name) {
    throw new Error(
      `Failed to create subscription: no operation name in response: ${JSON.stringify(operation)}`,
    );
  }

  // Poll the operation until complete
  const MAX_POLLS = 30;
  const POLL_INTERVAL_MS = 2_000;

  for (let i = 0; i < MAX_POLLS; i++) {
    log(`Polling LRO (attempt ${i + 1}/${MAX_POLLS})...`);
    await sleep(POLL_INTERVAL_MS);

    const pollRes = await client.operations.get({ name: operation.name });
    const op = pollRes.data;
    log(`  done=${op.done}`);

    if (op.done) {
      if ((op as any).error) {
        const err = (op as any).error;
        throw new Error(
          `Subscription creation failed: [${err.code}] ${err.message}`,
        );
      }

      const response = (op as any).response as Record<string, any> | undefined;
      if (response) {
        log(`  response: ${JSON.stringify(response)}`);
        return extractSubscriptionFromResponse(response);
      }

      // Sometimes the response is in metadata
      const metadata = (op as any).metadata as Record<string, any> | undefined;
      if (metadata?.name && !metadata.name.startsWith('operations/')) {
        log(`  metadata: ${JSON.stringify(metadata)}`);
        return extractSubscriptionFromResponse(metadata);
      }

      throw new Error(
        `Operation completed but no subscription in response: ${JSON.stringify(op)}`,
      );
    }
  }

  throw new Error(
    `Subscription creation timed out after ${MAX_POLLS * POLL_INTERVAL_MS / 1000}s. Operation: ${operation.name}`,
  );
}

function extractSubscriptionFromResponse(data: Record<string, any>): SubscriptionInfo {
  const name = data.name ?? '';
  if (!name || name.startsWith('operations/')) {
    throw new Error(`Invalid subscription name: ${name}`);
  }
  return {
    name,
    targetResource: data.targetResource ?? '',
    eventTypes: (data.eventTypes ?? []) as string[],
    expireTime: data.expireTime ?? '',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Renew an existing subscription (extends expiry by another 7 days).
 */
export async function renewSubscription(
  auth: unknown,
  subscriptionName: string,
): Promise<SubscriptionInfo> {
  const client = google.workspaceevents({
    version: 'v1',
    auth: auth as any,
  });

  const res = await client.subscriptions.patch({
    name: subscriptionName,
    updateMask: 'expire_time',
    requestBody: {},
  });

  const operation = res.data;
  const metadata = operation.metadata as
    | workspaceevents_v1.Schema$Subscription
    | undefined;

  return {
    name: metadata?.name ?? subscriptionName,
    targetResource: metadata?.targetResource ?? '',
    eventTypes: (metadata?.eventTypes ?? []) as string[],
    expireTime: metadata?.expireTime ?? '',
  };
}

/**
 * Delete a subscription.
 */
export async function deleteSubscription(
  auth: unknown,
  subscriptionName: string,
): Promise<void> {
  const client = google.workspaceevents({
    version: 'v1',
    auth: auth as any,
  });

  await client.subscriptions.delete({ name: subscriptionName });
}

/**
 * List existing subscriptions for a document to avoid creating duplicates.
 */
export async function listSubscriptions(
  auth: unknown,
  docId: string,
): Promise<SubscriptionInfo[]> {
  const client = google.workspaceevents({
    version: 'v1',
    auth: auth as any,
  });

  const targetResource = `//drive.googleapis.com/files/${docId}`;

  // Search broadly by target resource — don't filter by event type so we
  // find subscriptions even if they have an older set of event types.
  const res = await client.subscriptions.list({
    filter: `target_resource="${targetResource}"`,
  });

  return (res.data.subscriptions ?? []).map((sub) => ({
    name: sub.name ?? '',
    targetResource: sub.targetResource ?? '',
    eventTypes: (sub.eventTypes ?? []) as string[],
    expireTime: sub.expireTime ?? '',
  }));
}

/**
 * Ensure a subscription for a document has all required event types.
 * If an existing subscription is missing event types (e.g., after an upgrade
 * that added reply support), it is deleted and recreated.
 *
 * Returns the active subscription.
 */
export async function ensureSubscription(
  auth: unknown,
  docId: string,
  pubsubTopic: string,
  debug?: (msg: string) => void,
): Promise<SubscriptionInfo> {
  const log = debug ?? (() => {});

  const existing = await listSubscriptions(auth, docId);

  for (const sub of existing) {
    // Check if expired
    const expiry = sub.expireTime ? new Date(sub.expireTime) : null;
    if (expiry && expiry < new Date()) {
      log(`Subscription ${sub.name} expired, deleting`);
      await deleteSubscription(auth, sub.name);
      continue;
    }

    // Check if it has all required event types
    const missing = COMMENT_EVENT_TYPES.filter((t) => !sub.eventTypes.includes(t));
    if (missing.length === 0) {
      log(`Reusing subscription (has all ${COMMENT_EVENT_TYPES.length} event types)`);
      return sub;
    }

    // Missing event types — delete and recreate
    log(`Subscription missing event types: ${missing.join(', ')}. Recreating.`);
    await deleteSubscription(auth, sub.name);
  }

  // No valid subscription — create one
  return createCommentSubscription(auth, docId, pubsubTopic, debug);
}
