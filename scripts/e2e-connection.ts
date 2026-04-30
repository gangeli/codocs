#!/usr/bin/env node
/**
 * End-to-end longevity test for the live Pub/Sub comment-listener.
 *
 * Validates that the listener stays alive across real reconnect cycles
 * by routing live Pub/Sub traffic through the watchdog. The unit test
 * `listener-longevity.test.ts` already covers the recovery paths against
 * a fake subscription; this script's job is to confirm those paths
 * survive contact with the real gRPC stream.
 *
 * Strategy:
 *   - We can't actually wait 30 minutes per cycle in a test, so we
 *     configure the listener with a SHORT idleReconnectMs (~45 s) and
 *     watch the watchdog recycle the real stream within minutes.
 *   - After each forced reconnect, we post a fresh comment via Drive
 *     and assert the listener still receives it. That's the meaningful
 *     check — recovery isn't useful unless the new stream actually
 *     delivers events.
 *
 * Two modes:
 *
 *   CYCLE (default) — short idleReconnectMs, force reconnects, post a
 *     comment after each, assert delivery. ~3 min wall clock. Tests
 *     RECOVERY against the real stream.
 *
 *   SOAK (`--soak-ms=N`) — run with PRODUCTION listener options (i.e.,
 *     the listener.ts defaults: idleReconnectMs=30 min, health every
 *     60 s — matching what serve.ts uses), hold the listener open for
 *     N ms, then post a comment and assert it arrives. Tests the
 *     literal production question: "after hours of wait, does the
 *     server still respond to comments?" Reconnects fired during the
 *     soak are expected (one every ~30 min from the watchdog) and are
 *     logged but not the pass criterion; the only hard requirement is
 *     post-soak delivery.
 *
 * Phases (CYCLE mode):
 *   1. Baseline    — post a comment, assert it arrives (fresh stream).
 *   2. First idle  — wait past idleReconnectMs, assert onReconnect
 *                    fires, post comment, assert delivery.
 *   3. Second idle — repeat once more, to confirm recovery isn't
 *                    one-shot.
 *
 * Phases (SOAK mode):
 *   1. Baseline    — post a comment, assert it arrives.
 *   2. Soak        — sleep for soakMs (no traffic, periodic heartbeat
 *                    log lines so the user sees we're alive).
 *   3. Post-soak   — post a comment, assert it arrives.
 *
 * Cleanup runs unconditionally: closes the listener, deletes the
 * Workspace Events subscription, and trashes the test doc. Comments
 * go away with the doc.
 *
 * What this does NOT test:
 *   - The error-triggered reconnect path (L3 in the unit suite). That
 *     failure mode is hard to provoke deterministically from outside
 *     the gRPC library; the unit test is the appropriate level.
 *
 * Skips with exit 0 if the user hasn't run `codocs login` (no auth /
 * Pub/Sub config). Same skip semantics as other e2e scripts.
 *
 * Usage:
 *   make e2e/connection
 *   npx tsx scripts/e2e-connection.ts
 *   npx tsx scripts/e2e-connection.ts --debug
 *   npx tsx scripts/e2e-connection.ts --idle-ms=60000 --cycles=2
 *
 *   # 2-hour soak
 *   make e2e/connection CONNECTION_ARGS="--soak-ms=7200000"
 *   npx tsx scripts/e2e-connection.ts --soak-ms=7200000
 */

import {
  CodocsClient,
  createAuth,
  ensureSubscription,
  deleteSubscription,
  listenForComments,
  type CommentEvent,
  type CommentListenerHandle,
  type SubscriptionInfo,
} from '../packages/core/src/index.js';
import { DriveApi } from '../packages/core/src/client/drive-api.js';

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Args ─────────────────────────────────────────────────────

interface Args {
  debug: boolean;
  idleMs: number;
  cycles: number;
  perCommentTimeoutMs: number;
  /** When > 0, run in SOAK mode: disable the watchdog reconnect, hold a
   *  single connection open for this many ms, then post a comment and
   *  assert delivery. Tests *natural* stream longevity, not recovery. */
  soakMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    debug: false,
    idleMs: 45_000,
    cycles: 2,
    perCommentTimeoutMs: 60_000,
    soakMs: 0,
  };
  for (const a of argv) {
    if (a === '--debug') args.debug = true;
    else if (a.startsWith('--idle-ms=')) args.idleMs = Number(a.slice('--idle-ms='.length));
    else if (a.startsWith('--cycles=')) args.cycles = Number(a.slice('--cycles='.length));
    else if (a.startsWith('--timeout-ms=')) args.perCommentTimeoutMs = Number(a.slice('--timeout-ms='.length));
    else if (a.startsWith('--soak-ms=')) args.soakMs = Number(a.slice('--soak-ms='.length));
  }
  if (!Number.isFinite(args.idleMs) || args.idleMs < 5_000) {
    throw new Error('--idle-ms must be at least 5000');
  }
  if (!Number.isInteger(args.cycles) || args.cycles < 1) {
    throw new Error('--cycles must be a positive integer');
  }
  if (!Number.isFinite(args.soakMs) || args.soakMs < 0) {
    throw new Error('--soak-ms must be a non-negative number');
  }
  return args;
}

// ── Config & auth ────────────────────────────────────────────

interface LoadedConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  gcpProjectId: string;
  pubsubTopic: string; // bare topic name (no projects/.../topics/ prefix)
}

/**
 * Load auth + Pub/Sub config from the user's local codocs install.
 * Returns null if the user hasn't logged in or hasn't configured
 * Pub/Sub yet — caller skips with a friendly message.
 */
function loadConfig(): LoadedConfig | { skip: string } {
  const configPath = join(homedir(), '.config', 'codocs', 'config.json');
  const tokensPath = join(homedir(), '.local', 'share', 'codocs', 'auth.json');

  let config: any;
  let tokens: any;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return { skip: `no config at ${configPath} — run \`codocs login\` first` };
  }
  try {
    tokens = JSON.parse(readFileSync(tokensPath, 'utf-8'));
  } catch {
    return { skip: `no tokens at ${tokensPath} — run \`codocs login\` first` };
  }
  if (!config.client_id || !config.client_secret || !tokens.refresh_token) {
    return { skip: 'config or tokens incomplete — run `codocs login` to refresh' };
  }
  if (!config.gcp_project_id || !config.pubsub_topic) {
    return { skip: 'GCP Pub/Sub not configured in codocs — run `codocs login`' };
  }
  return {
    clientId: config.client_id,
    clientSecret: config.client_secret,
    refreshToken: tokens.refresh_token,
    gcpProjectId: config.gcp_project_id,
    pubsubTopic: config.pubsub_topic,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function log(msg: string): void {
  console.log(`[${ts()}] ${msg}`);
}

function logDebug(debug: boolean, msg: string): void {
  if (debug) console.log(`[${ts()}] [debug] ${msg}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait until `predicate` is true, polling every 250 ms. Rejects if
 * `timeoutMs` elapses without success.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(250);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

// ── Test orchestration ───────────────────────────────────────

interface TestState {
  delivered: CommentEvent[];
  reconnects: Array<{ attempt: number; reason: string; at: number }>;
  errors: Error[];
}

async function postCommentAndAwaitDelivery(
  client: CodocsClient,
  docId: string,
  state: TestState,
  body: string,
  timeoutMs: number,
): Promise<{ commentId: string; deliveryLatencyMs: number }> {
  const beforeCount = state.delivered.length;
  const postedAt = Date.now();
  log(`Posting comment "${body}"...`);
  const commentId = await client.addComment(docId, { content: body });
  log(`  → posted commentId=${commentId.slice(0, 12)}…, awaiting delivery`);

  await waitFor(
    () => state.delivered.length > beforeCount &&
      state.delivered.slice(beforeCount).some((e) => (e.comment.content ?? '').includes(body)),
    timeoutMs,
    `comment "${body}" to arrive via listener`,
  );
  const latency = Date.now() - postedAt;
  log(`  ✅ delivered in ${latency}ms`);
  return { commentId, deliveryLatencyMs: latency };
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const soakMode = args.soakMs > 0;
  console.log('─── codocs e2e/connection — live listener longevity ───\n');
  console.log(`  mode            : ${soakMode ? 'SOAK (natural longevity)' : 'CYCLE (forced reconnects)'}`);
  if (soakMode) {
    const hours = (args.soakMs / 3_600_000).toFixed(2);
    console.log(`  soakMs          : ${args.soakMs}  (~${hours} h)`);
    console.log(`  idleReconnectMs : (listener default — matches prod)`);
  } else {
    console.log(`  idleReconnectMs : ${args.idleMs}`);
    console.log(`  cycles          : ${args.cycles}`);
  }
  console.log(`  per-comment t/o : ${args.perCommentTimeoutMs}ms`);
  console.log(`  debug           : ${args.debug}\n`);

  const cfg = loadConfig();
  if ('skip' in cfg) {
    console.log(`SKIP: ${cfg.skip}`);
    return 0;
  }

  const client = new CodocsClient({
    oauth2: { clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: cfg.refreshToken },
  });
  const auth = createAuth({
    oauth2: { clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: cfg.refreshToken },
  });
  const driveApi = new DriveApi(auth);
  const fullTopic = `projects/${cfg.gcpProjectId}/topics/${cfg.pubsubTopic}`;
  const subscriptionName = `${cfg.pubsubTopic}-sub`;

  let docId: string | null = null;
  let subscription: SubscriptionInfo | null = null;
  let listener: CommentListenerHandle | null = null;
  let failures = 0;

  const expect = (cond: boolean, message: string) => {
    if (cond) {
      log(`✅ ${message}`);
    } else {
      log(`❌ ${message}`);
      failures++;
    }
  };

  try {
    // ── 1. Doc ─────────────────────────────────────────────
    const docName = `e2e-connection-${Date.now()}`;
    log(`Creating test doc "${docName}"...`);
    const created = await client.createDocInFolder(docName, 'Codocs');
    docId = created.docId;
    log(`  → docId=${docId}`);
    await client.writeMarkdown(docId, '# e2e connection test\n\nSeed paragraph.\n');

    // ── 2. Workspace Events subscription ──────────────────
    log(`Ensuring Workspace Events subscription on doc → topic ${fullTopic}...`);
    subscription = await ensureSubscription(
      auth, docId, fullTopic,
      args.debug ? (m) => logDebug(true, `[subs] ${m}`) : undefined,
    );
    log(`  → subscription=${subscription.name} (expires ${subscription.expireTime})`);

    // ── 3. Pre-check: confirm no other codocs is active on this account ─
    // A parallel `codocs serve` shares the same Pub/Sub subscription
    // (`<topic>-sub`) and competes with us for pulled messages — and on
    // the messages it *does* pull, it auto-replies, polluting our doc's
    // comment thread and breaking our delivery checks.
    //
    // Detect this empirically: post a probe comment on our fresh doc,
    // wait, and re-read it via the Drive API. If anyone has replied,
    // someone else is pulling from this account's subscription. Fail
    // loudly before doing real work.
    log('\n── Pre-check: scanning for parallel codocs server ──────────');
    const probeMarker = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    log(`Posting probe comment (marker=${probeMarker})...`);
    const probeId = await client.addComment(docId, {
      content: `[e2e-connection probe] ${probeMarker} — please ignore`,
    });
    const probeWaitMs = 20_000;
    log(`Waiting ${probeWaitMs}ms for any auto-replies...`);
    await sleep(probeWaitMs);
    const probeAfter = await driveApi.getComment(docId, probeId);
    const probeReplies = (probeAfter.replies ?? []).filter((r) => !r.action);
    if (probeReplies.length > 0) {
      const r = probeReplies[0];
      const who = r.author?.displayName ?? r.author?.emailAddress ?? '(unknown)';
      const what = (r.content ?? '').slice(0, 80);
      throw new Error(
        `Another codocs server appears to be active on this account: ` +
        `the probe got ${probeReplies.length} reply(s) ` +
        `(first from "${who}": "${what}"). ` +
        `Stop your other \`codocs serve\` process and try again.`,
      );
    }
    log('  ✅ no replies on probe — account is quiet, proceeding');

    // ── 4. Listener ───────────────────────────────────────
    const state: TestState = { delivered: [], reconnects: [], errors: [] };

    log(`Starting listener (subscription="${subscriptionName}")...`);
    listener = listenForComments(
      cfg.gcpProjectId,
      subscriptionName,
      { clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: cfg.refreshToken },
      (e) => {
        state.delivered.push(e);
        log(`  ← delivered comment id=${e.comment.id?.slice(0, 12)}… body="${(e.comment.content ?? '').slice(0, 60)}"`);
      },
      (err) => {
        state.errors.push(err);
        log(`  ⚠ listener error: ${err.message}`);
      },
      {
        debug: args.debug ? (m) => logDebug(true, `[listener] ${m}`) : undefined,
        // SOAK mirrors prod — use listener defaults (idleReconnectMs
        // 30 min, healthCheckIntervalMs 60 s, the same values serve.ts
        // gets implicitly). CYCLE uses a short window so the watchdog
        // fires within minutes.
        ...(soakMode
          ? {}
          : { idleReconnectMs: args.idleMs, healthCheckIntervalMs: 5_000 }),
        onReconnect: ({ attempt, reason }) => {
          state.reconnects.push({ attempt, reason, at: Date.now() });
          log(`  ↻ reconnect (attempt=${attempt}, reason="${reason}")`);
        },
      },
    );

    // Give the subscription stream a moment to actually attach. Without
    // this, a comment posted right after listen-start can race ahead of
    // the gRPC stream attaching, and Pub/Sub won't deliver it.
    log('Waiting 5 s for stream to settle...');
    await sleep(5_000);

    if (soakMode) {
      // ── SOAK ─────────────────────────────────────────────
      // Verify a baseline delivery first so we know the stream attached.
      log('\n── Soak: baseline delivery ─────────────────────────────────');
      await postCommentAndAwaitDelivery(
        client, docId, state, `soak-baseline-${Date.now()}`, args.perCommentTimeoutMs,
      );
      expect(state.reconnects.length === 0, 'no reconnects during baseline');

      // Now sit idle for the full soak window. We don't post anything
      // during this time — we want to know whether the stream itself
      // stays alive without our help.
      const startedAt = Date.now();
      const reconnectsBefore = state.reconnects.length;
      const errorsBefore = state.errors.length;
      const hours = (args.soakMs / 3_600_000).toFixed(2);
      log(`\n── Soak: holding the connection idle for ~${hours} h ─────────`);
      log(`  (no traffic, no watchdog reconnects — just waiting)`);

      // Periodic heartbeats so the user sees we're alive.
      const heartbeatMs = Math.min(5 * 60_000, Math.max(60_000, Math.floor(args.soakMs / 12)));
      const heartbeat = setInterval(() => {
        const elapsedMs = Date.now() - startedAt;
        const remainMs = Math.max(0, args.soakMs - elapsedMs);
        log(`  · soak heartbeat: elapsed=${(elapsedMs / 60_000).toFixed(1)}m  remaining=${(remainMs / 60_000).toFixed(1)}m  reconnects=${state.reconnects.length - reconnectsBefore}  errors=${state.errors.length - errorsBefore}`);
      }, heartbeatMs);
      try {
        await sleep(args.soakMs);
      } finally {
        clearInterval(heartbeat);
      }

      const soakReconnects = state.reconnects.length - reconnectsBefore;
      const soakErrors = state.errors.length - errorsBefore;
      log(`\n── Soak: window elapsed (${((Date.now() - startedAt) / 60_000).toFixed(1)} min) ─────`);
      log(`  reconnects during soak : ${soakReconnects}`);
      log(`  errors during soak     : ${soakErrors}`);

      // Whether or not reconnects fired, the real question is: does a
      // freshly-posted comment still arrive? That's the production
      // symptom we care about.
      log('\n── Soak: post-soak delivery probe ──────────────────────────');
      await postCommentAndAwaitDelivery(
        client, docId, state, `soak-post-${Date.now()}`, args.perCommentTimeoutMs,
      );

      log('\n── Summary ────────────────────────────────────────────────');
      log(`  comments delivered    : ${state.delivered.length}`);
      log(`  reconnects total      : ${state.reconnects.length}`);
      log(`  errors total          : ${state.errors.length}`);
      // With production settings (idleReconnectMs=30 min), expect
      // roughly one reconnect per 30 min of idle soak. This is
      // informational — the only hard requirement is post-soak delivery.
      const expectedRecycles = Math.floor(args.soakMs / (30 * 60_000));
      log(`  reconnects in soak    : ${soakReconnects}  (≈${expectedRecycles} expected from the 30-min watchdog)`);
      expect(state.delivered.length >= 2, `at least 2 comments delivered (baseline + post-soak)`);
      log(`  ✅ post-soak delivery succeeded after ~${hours} h — prod-equivalent listener stayed responsive.`);
    } else {
      // ── Phase 1: baseline delivery ────────────────────────
      log('\n── Phase 1: baseline delivery ─────────────────────────────');
      await postCommentAndAwaitDelivery(
        client, docId, state, `phase1-baseline-${Date.now()}`, args.perCommentTimeoutMs,
      );
      expect(state.reconnects.length === 0, 'no reconnects during baseline');

      // ── Phases 2…N: forced reconnects via idle window ──────
      for (let cycle = 1; cycle <= args.cycles; cycle++) {
        log(`\n── Phase ${cycle + 1}: forced idle reconnect (cycle ${cycle}/${args.cycles}) ─`);
        const reconnectsBefore = state.reconnects.length;

        // Wait past the idle window. Add a buffer for the health-check
        // interval (~5 s) so we don't race the watchdog.
        const wait = args.idleMs + 10_000;
        log(`Waiting ${wait}ms (idleMs=${args.idleMs}) to provoke watchdog reconnect...`);
        await sleep(wait);

        expect(
          state.reconnects.length > reconnectsBefore,
          `watchdog fired a reconnect during idle (saw ${state.reconnects.length - reconnectsBefore} new)`,
        );
        if (state.reconnects.length > reconnectsBefore) {
          const latest = state.reconnects[state.reconnects.length - 1];
          expect(
            /idle/i.test(latest.reason),
            `latest reconnect was for an idle reason (got "${latest.reason}")`,
          );
        }

        // Confirm the new stream actually delivers.
        await postCommentAndAwaitDelivery(
          client, docId, state, `phase${cycle + 1}-after-reconnect-${Date.now()}`,
          args.perCommentTimeoutMs,
        );
      }

      log('\n── Summary ────────────────────────────────────────────────');
      log(`  comments delivered : ${state.delivered.length}`);
      log(`  reconnects fired   : ${state.reconnects.length}`);
      log(`  listener errors    : ${state.errors.length}`);
      expect(state.delivered.length >= 1 + args.cycles, `at least ${1 + args.cycles} comments delivered`);
      expect(state.reconnects.length >= args.cycles, `at least ${args.cycles} reconnects fired`);
    }
  } catch (err: any) {
    log(`❌ exception: ${err.message ?? err}`);
    if (args.debug && err.stack) console.log(err.stack);
    failures++;
  } finally {
    log('\n── Cleanup ────────────────────────────────────────────────');
    if (listener) {
      try { await listener.close(); log('  listener closed'); }
      catch (err: any) { log(`  listener close errored (ignored): ${err.message}`); }
    }
    if (subscription) {
      try {
        await deleteSubscription(auth, subscription.name);
        log(`  subscription ${subscription.name} deleted`);
      } catch (err: any) {
        log(`  subscription delete errored (ignored): ${err.message}`);
      }
    }
    if (docId) {
      try {
        await driveApi.deleteFile(docId);
        log(`  doc ${docId} deleted`);
      } catch (err: any) {
        log(`  doc delete errored (ignored): ${err.message}`);
      }
    }
  }

  console.log(`\n── Result: ${failures === 0 ? 'PASS' : `FAIL (${failures} failure${failures === 1 ? '' : 's'})`} ──\n`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
