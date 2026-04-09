import React from 'react';
import type { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { render } from 'ink';
import {
  CodocsClient,
  createAuth,
  createCommentSubscription,
  listSubscriptions,
  renewSubscription,
  listenForComments,
  AgentOrchestrator,
  ClaudeRunner,
  type AgentRunner,
  type CommentEvent,
  type CommentListenerHandle,
  type SubscriptionInfo,
} from '@codocs/core';
import { openDatabase, SessionStore } from '@codocs/db';
import { readConfig, readTokens } from '../auth/token-store.js';
import { withErrorHandler } from '../util.js';
import { App, createInitialState, type TuiStateRef, type ActivityEvent } from '../tui/index.js';

/** Registry of available agent runners. */
const AGENT_RUNNERS: Record<string, () => AgentRunner> = {
  claude: () => new ClaudeRunner(),
};

function generateDocName(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  return `Codocs ${date}`;
}

/** How often to renew subscriptions (6 days, well before 7-day expiry). */
const RENEWAL_INTERVAL_MS = 6 * 24 * 60 * 60 * 1000;

function formatCommentEvent(event: CommentEvent): string {
  const parts: string[] = [];
  const time = event.eventTime
    ? new Date(event.eventTime).toLocaleTimeString()
    : 'unknown time';
  const author = event.comment.author ?? 'Unknown';
  const docId = event.documentId;

  parts.push(`[${time}] Comment on ${docId}`);
  parts.push(`  Author: ${author}`);
  if (event.comment.quotedText) parts.push(`  On: "${event.comment.quotedText}"`);
  if (event.comment.content) parts.push(`  Content: ${event.comment.content}`);
  if (event.comment.mentions.length > 0) parts.push(`  Mentions: ${event.comment.mentions.join(', ')}`);
  return parts.join('\n');
}

/**
 * Unified event emitter that works in both TUI and plain-text mode.
 */
function createEventEmitter(tuiRef: TuiStateRef | null) {
  return (event: Omit<ActivityEvent, 'id'> & { id?: string }) => {
    const fullEvent = {
      ...event,
      id: event.id ?? `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    } as ActivityEvent;

    if (tuiRef) {
      tuiRef.addEvent(fullEvent);
    } else {
      const time = event.time.toLocaleTimeString();
      if (event.type === 'comment') {
        console.log(`[${time}] ${event.author ?? 'Unknown'}: ${event.content}`);
        if (event.quotedText) console.log(`  On: "${event.quotedText}"`);
      } else if (event.type === 'error') {
        console.error(`[${time}] ERROR: ${event.content}`);
      } else {
        console.error(`[${time}] ${event.content}`);
      }
    }
  };
}

export function registerServeCommand(program: Command) {
  program
    .command('serve', { isDefault: true })
    .description('Start the codocs server to listen for comment events')
    .argument('[docIds...]', 'Google Doc IDs or URLs to watch')
    .option('--debug', 'Enable verbose debug logging')
    .option('--no-tui', 'Disable the terminal UI (plain text output)')
    .option('--agent-type <type>', 'Agent runner type (e.g., claude)', 'claude')
    .option('--db-path <path>', 'SQLite database path')
    .option('--fallback-agent <name>', 'Default agent for unattributed text', 'coordinator')
    .action(
      withErrorHandler(async (docIds: string[], opts: {
        debug?: boolean;
        tui?: boolean;
        agentType?: string;
        dbPath?: string;
        fallbackAgent?: string;
      }) => {
        const debugMode = opts.debug ?? false;
        const useTui = opts.tui !== false;

        // ── Pre-TUI: interactive doc selection ────────────────────
        if (docIds.length === 0) {
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          const answer = await rl.question(
            'No document specified. Enter a Doc URL/ID, or press Enter to create a new one: ',
          );

          if (answer.trim()) {
            docIds = [answer.trim()];
          } else {
            rl.close();
            const config = readConfig();
            const tokens = readTokens();
            if (!tokens) { console.error('No tokens found. Run `codocs auth login` first.'); process.exit(1); }
            const client = new CodocsClient({
              oauth2: { clientId: config.client_id, clientSecret: config.client_secret, refreshToken: tokens.refresh_token },
            });
            const docName = generateDocName();
            console.error(`Creating "${docName}" in Codocs/ folder...`);
            const { docId } = await client.createDocInFolder(docName);
            console.error(`\nCreated: https://docs.google.com/document/d/${docId}/edit`);
            console.error(`Location: My Drive > Codocs > ${docName}\n`);
            docIds = [docId];
          }
          if (rl.terminal) rl.close();
        }

        // ── Auth & config ─────────────────────────────────────────
        const config = readConfig();
        const tokens = readTokens();
        if (!tokens) { console.error('No tokens found. Run `codocs auth login` first.'); process.exit(1); }
        if (!config.gcp_project_id || !config.pubsub_topic) {
          console.error('GCP Pub/Sub not configured. Run `codocs auth login` to set up.');
          process.exit(1);
        }

        const auth = createAuth({
          oauth2: { clientId: config.client_id, clientSecret: config.client_secret, refreshToken: tokens.refresh_token },
        });

        const gcpProjectId = config.gcp_project_id;
        const fullTopic = `projects/${gcpProjectId}/topics/${config.pubsub_topic}`;
        const subscriptionName = `${config.pubsub_topic}-sub`;
        const normalizedDocIds = docIds.map(extractDocId);
        const primaryDocId = normalizedDocIds[0];

        // ── TUI or plain mode ─────────────────────────────────────
        // Use a mutable container so callbacks can access the ref
        const tui: { ref: TuiStateRef | null } = { ref: null };
        let listener: CommentListenerHandle | null = null;
        let renewalTimer: ReturnType<typeof setInterval> | null = null;
        let db: Awaited<ReturnType<typeof openDatabase>> | null = null;

        const shutdown = async () => {
          if (renewalTimer) clearInterval(renewalTimer);
          if (listener) await listener.close();
          if (db) db.close();
          process.exit(0);
        };

        if (useTui) {
          const initialState = createInitialState(primaryDocId);
          if (debugMode) initialState.settings.debugMode = true;

          render(React.createElement(App, {
            initialState,
            onShutdown: shutdown,
            onStateRef: (ref: TuiStateRef) => { tui.ref = ref; },
          }));

          // Wait for ref to be set
          await new Promise((r) => setTimeout(r, 50));
        }

        const emit = createEventEmitter(tui.ref);

        const debug = debugMode
          ? (msg: string) => {
              if (useTui && tui.ref) {
                tui.ref!.addEvent({
                  id: `dbg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                  time: new Date(),
                  type: 'system',
                  content: `[debug] ${msg}`,
                });
              } else {
                console.error(`[debug] ${msg}`);
              }
            }
          : (_msg: string) => {};

        debug(`GCP Project: ${gcpProjectId}`);
        debug(`Pub/Sub Topic: ${fullTopic}`);

        // ── Subscriptions ─────────────────────────────────────────
        emit({ time: new Date(), type: 'system', content: `Setting up subscriptions for ${normalizedDocIds.length} document(s)...` });
        const subscriptions: SubscriptionInfo[] = [];

        for (const docId of normalizedDocIds) {
          try {
            const existing = await listSubscriptions(auth, docId);
            if (existing.length > 0) {
              for (const sub of existing) {
                const expiry = sub.expireTime ? new Date(sub.expireTime) : null;
                if (expiry && expiry < new Date()) continue;
                subscriptions.push(sub);
              }
              if (subscriptions.some((s) => existing.includes(s))) {
                emit({ time: new Date(), type: 'system', content: `Reusing subscription for ${docId.slice(0, 12)}...` });
                continue;
              }
            }
          } catch { /* fall through */ }

          try {
            const sub = await createCommentSubscription(auth, docId, fullTopic, debug);
            subscriptions.push(sub);
            emit({ time: new Date(), type: 'system', content: `Subscription created (expires ${sub.expireTime || 'unknown'})` });
          } catch (err: any) {
            if (err.message?.includes('ALREADY_EXISTS')) {
              try { subscriptions.push(...(await listSubscriptions(auth, docId))); } catch { /* ignore */ }
              emit({ time: new Date(), type: 'system', content: 'Reusing existing subscription' });
            } else {
              emit({ time: new Date(), type: 'error', content: `Subscription failed: ${err.message}` });
              process.exit(1);
            }
          }
        }

        // ── Agent orchestrator ────────────────────────────────────
        const agentType = opts.agentType ?? 'claude';
        const runnerFactory = AGENT_RUNNERS[agentType];
        if (!runnerFactory) {
          emit({ time: new Date(), type: 'error', content: `Unknown agent type "${agentType}". Available: ${Object.keys(AGENT_RUNNERS).join(', ')}` });
          process.exit(1);
        }
        const agentRunner = runnerFactory();
        debug(`Agent runner: ${agentRunner.name}`);

        db = await openDatabase(opts.dbPath);
        const sessionStore = new SessionStore(db);

        const client = new CodocsClient({
          oauth2: { clientId: config.client_id, clientSecret: config.client_secret, refreshToken: tokens.refresh_token },
        });

        const orchestrator = new AgentOrchestrator({
          client,
          sessionStore,
          agentRunner,
          fallbackAgent: opts.fallbackAgent ?? 'coordinator',
          debug,
        });

        // ── Pub/Sub listener ──────────────────────────────────────
        if (tui.ref) tui.ref.setConnected(true);
        emit({ time: new Date(), type: 'system', content: 'Listening for comments...' });

        listener = listenForComments(
          gcpProjectId,
          subscriptionName,
          { clientId: config.client_id, clientSecret: config.client_secret, refreshToken: tokens.refresh_token },
          (event: CommentEvent) => {
            if (tui.ref) tui.ref.incrementComments();

            emit({
              time: event.eventTime ? new Date(event.eventTime) : new Date(),
              type: 'comment',
              author: event.comment.author,
              quotedText: event.comment.quotedText,
              content: event.comment.content ?? '(no content)',
            });

            // Update TUI agent status
            if (tui.ref) {
              tui.ref.updateAgent('orchestrator', {
                status: 'processing',
                task: event.comment.content?.slice(0, 40),
                taskStartTime: new Date(),
              });
            }

            orchestrator.handleComment(event).then(() => {
              if (tui.ref) {
                tui.ref.updateAgent('orchestrator', { status: 'idle', task: undefined });
              }
              emit({ time: new Date(), type: 'agent-reply', content: 'Comment processed', agent: agentType });
            }).catch((err) => {
              if (tui.ref) {
                tui.ref.updateAgent('orchestrator', { status: 'error', task: err.message?.slice(0, 40) });
              }
              emit({ time: new Date(), type: 'error', content: `Agent error: ${err.message}` });
            });
          },
          (error: Error) => {
            emit({ time: new Date(), type: 'error', content: `Pub/Sub error: ${error.message}` });
          },
          { debug },
        );

        // ── Subscription renewal ──────────────────────────────────
        renewalTimer = setInterval(async () => {
          for (const sub of subscriptions) {
            try {
              await renewSubscription(auth, sub.name);
              emit({ time: new Date(), type: 'system', content: 'Subscription renewed' });
            } catch (err: any) {
              emit({ time: new Date(), type: 'error', content: `Renewal failed: ${err.message}` });
            }
          }
        }, RENEWAL_INTERVAL_MS);

        // Graceful shutdown for non-TUI mode
        if (!useTui) {
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
        }
      }),
    );
}

function extractDocId(input: string): string {
  const match = input.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : input;
}
