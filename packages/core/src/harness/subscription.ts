/**
 * Subscription and quota detection for agent harnesses.
 *
 * Determines which harnesses the user has access to, what billing tier each
 * is on, and (optionally) whether monthly quota is exhausted. Returns agent
 * types sorted by preference: monthly subscription > pay-as-you-go > free >
 * unavailable. When tiers are equal, Cerebras is preferred if the user has a
 * paid Cerebras account.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import type { AgentType } from './agent.js';

// ── Types ────────────────────────────────────────────────────────────────

export type BillingTier = 'subscription' | 'paygo' | 'free' | 'unavailable';

export interface HarnessSubscription {
  agentType: AgentType;
  tier: BillingTier;
  /** The underlying provider, when the agent type is a wrapper (e.g., "cerebras" for opencode). */
  provider?: string;
  /** Whether monthly quota is exhausted (only set when checkQuota is true). */
  quotaExhausted?: boolean;
  /** Utilization percentage (0–100) if available. */
  utilization?: number;
}

export interface SubscriptionCheckOptions {
  /**
   * When true, make network requests to check quota utilization.
   * This is slower but determines whether monthly quota is exhausted.
   */
  checkQuota?: boolean;
}

// ── Failure tracking ─────────────────────────────────────────────────────

/** In-memory record of recent quota-exhaustion failures per agent type. */
const quotaFailures = new Map<AgentType, { count: number; lastSeen: Date }>();

/** TTL for quota failure records (30 minutes). */
const FAILURE_TTL_MS = 30 * 60 * 1000;

/**
 * Record a quota-exhaustion failure for an agent type.
 * Call this when an agent run fails due to rate limiting or quota exceeded.
 */
export function recordQuotaFailure(agentType: AgentType): void {
  const existing = quotaFailures.get(agentType);
  quotaFailures.set(agentType, {
    count: (existing?.count ?? 0) + 1,
    lastSeen: new Date(),
  });
}

/** Clear failure records for an agent type (e.g., after a successful run). */
export function clearQuotaFailure(agentType: AgentType): void {
  quotaFailures.delete(agentType);
}

/** Check whether an agent type has recent quota failures. */
function hasRecentQuotaFailure(agentType: AgentType): boolean {
  const record = quotaFailures.get(agentType);
  if (!record) return false;
  if (Date.now() - record.lastSeen.getTime() > FAILURE_TTL_MS) {
    quotaFailures.delete(agentType);
    return false;
  }
  return true;
}

// ── Claude detection ─────────────────────────────────────────────────────

function detectClaudeTier(): BillingTier {
  try {
    const raw = readFileSync(join(homedir(), '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);
    const billing = config?.oauthAccount?.billingType;
    if (typeof billing === 'string' && billing.includes('subscription')) {
      return 'subscription';
    }
    // Has config but no subscription — treat as free (Claude Code free tier)
    if (config?.oauthAccount) return 'free';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * Read the Claude Code OAuth access token.
 *
 * On macOS, Claude Code stores credentials in the system keychain under
 * "Claude Code-credentials". On other platforms, falls back to reading
 * ~/.claude/.credentials.json.
 */
function readClaudeOAuthToken(): string | null {
  // macOS: read from keychain
  if (platform() === 'darwin') {
    try {
      const raw = execFileSync('security', [
        'find-generic-password',
        '-s', 'Claude Code-credentials',
        '-w',
      ], { timeout: 5000, encoding: 'utf-8' }).trim();
      const creds = JSON.parse(raw);
      return creds?.claudeAiOauth?.accessToken ?? null;
    } catch { /* fall through */ }
  }

  // Linux/Windows: try credentials file
  const credPaths = [
    join(homedir(), '.claude', '.credentials.json'),
    join(homedir(), '.claude', 'credentials.json'),
  ];
  for (const p of credPaths) {
    try {
      const raw = readFileSync(p, 'utf-8');
      const creds = JSON.parse(raw);
      const token = creds?.claudeAiOauth?.accessToken;
      if (token) return token;
    } catch { /* try next */ }
  }

  return null;
}

/**
 * Check Claude quota via the OAuth usage endpoint.
 * Returns utilization (0–100) or null if unavailable.
 */
async function checkClaudeQuota(): Promise<{ exhausted: boolean; utilization?: number } | null> {
  try {
    const token = readClaudeOAuthToken();
    if (!token) return null;

    const data = await httpGet('https://api.anthropic.com/api/oauth/usage', {
      'Authorization': `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    });

    const parsed = JSON.parse(data);
    // The endpoint returns nested objects with snake_case keys
    const fiveHourPct = parsed?.five_hour?.utilization ?? 0;
    const sevenDayPct = parsed?.seven_day?.utilization ?? 0;
    const maxUtil = Math.max(fiveHourPct, sevenDayPct);

    return {
      exhausted: maxUtil >= 100,
      utilization: maxUtil,
    };
  } catch {
    return null;
  }
}

// ── Codex detection ──────────────────────────────────────────────────────

function getOpenAIApiKey(): string | null {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;

  // Check common config locations for a stored key
  const configPaths = [
    join(homedir(), '.codex', 'config.json'),
    join(homedir(), '.config', 'codex', 'config.json'),
  ];
  for (const p of configPaths) {
    try {
      const raw = readFileSync(p, 'utf-8');
      const config = JSON.parse(raw);
      if (config?.apiKey) return config.apiKey;
    } catch { /* ignore */ }
  }

  return null;
}

function detectCodexTier(): BillingTier {
  return getOpenAIApiKey() ? 'paygo' : 'unavailable';
}

/**
 * Check Codex quota via the undocumented Codex usage endpoint.
 * The Codex TUI's /status command reads from this same backend.
 */
async function checkCodexQuota(): Promise<{ exhausted: boolean; utilization?: number } | null> {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) return null;

  try {
    const data = await httpGet('https://api.openai.com/api/codex/usage', {
      'Authorization': `Bearer ${apiKey}`,
    });
    const parsed = JSON.parse(data);

    // Look for rate limit / credit status indicators
    const credits = parsed?.creditStatus ?? parsed?.credit_status;
    const rateLimits = parsed?.rateLimitStatus ?? parsed?.rate_limit_status;

    // If we get a clear "exhausted" or "exceeded" signal
    if (credits?.remaining !== undefined && credits?.limit !== undefined) {
      const used = credits.limit - credits.remaining;
      const utilization = credits.limit > 0 ? Math.round((used / credits.limit) * 100) : 0;
      return { exhausted: credits.remaining <= 0, utilization };
    }

    // If the endpoint returns usage percentages
    if (parsed?.usagePercentage !== undefined || parsed?.usage_percentage !== undefined) {
      const pct = parsed.usagePercentage ?? parsed.usage_percentage ?? 0;
      return { exhausted: pct >= 100, utilization: pct };
    }

    // Got a response but couldn't parse quota info — not exhausted as far as we know
    return null;
  } catch {
    // Endpoint unavailable or key invalid — can't determine quota
    return null;
  }
}

// ── Cerebras detection ───────────────────────────────────────────────────

function detectCerebrasKey(): string | null {
  // Direct environment variable
  if (process.env.CEREBRAS_API_KEY) return process.env.CEREBRAS_API_KEY;

  // OpenCode auth store
  try {
    const authPaths = [
      join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode', 'auth.json'),
    ];
    for (const p of authPaths) {
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, 'utf-8');
      const auth = JSON.parse(raw);
      // OpenCode stores provider keys — look for cerebras
      const key = auth?.cerebras?.key ?? auth?.cerebras?.apiKey ?? auth?.cerebras?.api_key;
      if (key) return key;
    }
  } catch { /* ignore */ }

  return null;
}

/**
 * Probe Cerebras with a minimal API call to determine billing tier from
 * rate-limit headers. Free tier has ~60K TPM; paid has ~2M+ TPM.
 */
async function probeCerebrasTier(apiKey: string): Promise<{
  tier: BillingTier;
  exhausted: boolean;
  utilization?: number;
}> {
  try {
    const { headers, body } = await httpPostWithHeaders(
      'https://api.cerebras.ai/v1/chat/completions',
      {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      JSON.stringify({
        model: 'llama3.1-8b',
        messages: [{ role: 'user', content: 'hi' }],
        max_completion_tokens: 1,
      }),
    );

    const tpmLimit = parseInt(headers['x-ratelimit-limit-tokens-minute'] as string, 10);
    const remainingDaily = parseInt(headers['x-ratelimit-remaining-requests-day'] as string, 10);
    const limitDaily = parseInt(headers['x-ratelimit-limit-requests-day'] as string, 10);

    // Free tier: ~60K TPM. Paid (PAYG): ~2M+ TPM.
    // Cerebras only offers free and pay-as-you-go — no monthly subscription.
    const tier: BillingTier = (tpmLimit && tpmLimit > 100_000) ? 'paygo' : 'free';

    let exhausted = false;
    let utilization: number | undefined;
    if (limitDaily && !isNaN(remainingDaily)) {
      utilization = Math.round(((limitDaily - remainingDaily) / limitDaily) * 100);
      exhausted = remainingDaily <= 0;
    }

    return { tier, exhausted, utilization };
  } catch (err: any) {
    // 429 means quota exhausted
    if (err?.statusCode === 429) {
      return { tier: 'free', exhausted: true, utilization: 100 };
    }
    // 401/403 means bad key
    if (err?.statusCode === 401 || err?.statusCode === 403) {
      return { tier: 'unavailable', exhausted: false };
    }
    // Network error — assume free tier (key exists but can't verify)
    return { tier: 'free', exhausted: false };
  }
}

// ── Cursor detection ─────────────────────────────────────────────────────

function getCursorDbPath(): string {
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'linux':
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'win32':
      return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    default:
      return '';
  }
}

function detectCursorTier(): BillingTier {
  const dbPath = getCursorDbPath();
  if (!dbPath || !existsSync(dbPath)) return 'unavailable';

  // The DB exists — Cursor is installed. Try to read subscription tier
  // by spawning sqlite3 (available on macOS/Linux by default).
  try {
    const result = execFileSync('sqlite3', [
      dbPath,
      "SELECT value FROM ItemTable WHERE key = 'cursorAuth/stripeMembershipType'",
    ], { timeout: 5000, encoding: 'utf-8' }).trim();

    if (result === 'pro' || result === 'business') return 'subscription';
    if (result === 'free' || result === '') return 'free';
    // Unknown tier — conservatively treat as free
    return 'free';
  } catch {
    // sqlite3 not available or DB locked — Cursor is installed but tier unknown
    return 'free';
  }
}

// ── Main entry point ─────────────────────────────────────────────────────

/**
 * Detect which harnesses the user has subscriptions to and return them
 * sorted by preference.
 *
 * Preference order:
 *   1. Monthly subscription (with Cerebras preferred if it has a paid account)
 *   2. Pay-as-you-go
 *   3. Free tier
 *   4. Unavailable (filtered out)
 *
 * Within each tier, agents with exhausted quota are demoted to the next
 * tier down (subscription → paygo, paygo → free).
 */
export async function detectSubscriptions(
  opts: SubscriptionCheckOptions = {},
): Promise<HarnessSubscription[]> {
  const { checkQuota = false } = opts;

  // Run all detections in parallel
  const [claude, codex, cerebras, cursor] = await Promise.all([
    detectClaudeSubscription(checkQuota),
    detectCodexSubscription(checkQuota),
    detectCerebrasSubscription(checkQuota),
    detectCursorSubscription(),
  ]);

  const all = [claude, codex, cerebras, cursor];

  // Apply failure tracking: demote agents with recent quota failures
  for (const sub of all) {
    if (hasRecentQuotaFailure(sub.agentType)) {
      sub.quotaExhausted = true;
    }
  }

  return rankSubscriptions(all);
}

async function detectClaudeSubscription(checkQuota: boolean): Promise<HarnessSubscription> {
  const tier = detectClaudeTier();
  const sub: HarnessSubscription = { agentType: 'claude', tier };

  if (checkQuota && tier === 'subscription') {
    const quota = await checkClaudeQuota();
    if (quota) {
      sub.quotaExhausted = quota.exhausted;
      sub.utilization = quota.utilization;
    }
  }

  return sub;
}

async function detectCodexSubscription(checkQuota: boolean): Promise<HarnessSubscription> {
  const tier = detectCodexTier();
  const sub: HarnessSubscription = { agentType: 'codex', tier };

  if (checkQuota && tier !== 'unavailable') {
    const quota = await checkCodexQuota();
    if (quota) {
      sub.quotaExhausted = quota.exhausted;
      sub.utilization = quota.utilization;
    }
  }

  return sub;
}

async function detectCerebrasSubscription(checkQuota: boolean): Promise<HarnessSubscription> {
  const apiKey = detectCerebrasKey();
  if (!apiKey) return { agentType: 'opencode', tier: 'unavailable', provider: 'cerebras' };

  if (checkQuota) {
    // The probe both determines tier AND checks quota
    const result = await probeCerebrasTier(apiKey);
    return {
      agentType: 'opencode',
      tier: result.tier,
      provider: 'cerebras',
      quotaExhausted: result.exhausted,
      utilization: result.utilization,
    };
  }

  // Without quota check, we can't distinguish free from paid without a probe.
  // Do the probe anyway since it's needed for tier detection.
  const result = await probeCerebrasTier(apiKey);
  return { agentType: 'opencode', tier: result.tier, provider: 'cerebras' };
}

async function detectCursorSubscription(): Promise<HarnessSubscription> {
  return { agentType: 'cursor', tier: detectCursorTier() };
}

/**
 * Return agent types sorted by preference, filtering out unavailable ones.
 */
function rankSubscriptions(subs: HarnessSubscription[]): HarnessSubscription[] {
  const tierRank: Record<BillingTier, number> = {
    subscription: 0,
    paygo: 1,
    free: 2,
    unavailable: 3,
  };

  return subs
    .filter((s) => s.tier !== 'unavailable')
    .map((s) => {
      // If quota is exhausted on a subscription, treat as paygo for ranking
      if (s.quotaExhausted && s.tier === 'subscription') {
        return { ...s, effectiveTier: 'paygo' as BillingTier };
      }
      if (s.quotaExhausted && s.tier === 'paygo') {
        return { ...s, effectiveTier: 'free' as BillingTier };
      }
      return { ...s, effectiveTier: s.tier };
    })
    .sort((a, b) => {
      const rankA = tierRank[a.effectiveTier];
      const rankB = tierRank[b.effectiveTier];
      if (rankA !== rankB) return rankA - rankB;

      // Within the same effective tier, prefer Cerebras (opencode) if it
      // has a paid account
      const cerebrasBoostA = a.agentType === 'opencode' && (a.tier === 'paygo' || a.tier === 'subscription') ? -1 : 0;
      const cerebrasBoostB = b.agentType === 'opencode' && (b.tier === 'paygo' || b.tier === 'subscription') ? -1 : 0;
      return cerebrasBoostA - cerebrasBoostB;
    })
    .map(({ effectiveTier: _, ...rest }) => rest);
}

/**
 * Convenience: return just the sorted agent types.
 */
export async function getPreferredAgentTypes(
  opts: SubscriptionCheckOptions = {},
): Promise<AgentType[]> {
  const subs = await detectSubscriptions(opts);
  return subs.map((s) => s.agentType);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

function httpGet(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpsRequest(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            const err: any = new Error(`HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            reject(err);
          } else {
            resolve(Buffer.concat(chunks).toString('utf-8'));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function httpPostWithHeaders(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpsRequest(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const respHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') respHeaders[k] = v;
          }
          if (res.statusCode && res.statusCode >= 400) {
            const err: any = new Error(`HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.headers = respHeaders;
            reject(err);
          } else {
            resolve({ headers: respHeaders, body: Buffer.concat(chunks).toString('utf-8') });
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}
