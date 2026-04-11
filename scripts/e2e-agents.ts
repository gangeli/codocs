#!/usr/bin/env node
/**
 * End-to-end agent detection test.
 *
 * Detects available agent harnesses, reports subscription tiers and quota
 * status, and validates that the subscription ranking logic works correctly.
 *
 * Usage:
 *   make e2e/agents              # build + run with quota checks (default)
 *   make e2e/agents QUOTA=0      # build + run without quota checks (faster)
 */

import {
  detectSubscriptions,
  getPreferredAgentTypes,
  recordQuotaFailure,
  clearQuotaFailure,
  type HarnessSubscription,
  type AgentType,
} from '../packages/core/src/index.js';

// ── Constants ────────────────────────────────────────────────

const ALL_AGENT_TYPES: AgentType[] = ['claude', 'codex', 'cursor', 'opencode'];

// ── Formatting helpers ───────────────────────────────────────

const TIER_EMOJI: Record<string, string> = {
  subscription: '\u2b50',  // star
  paygo: '\ud83d\udcb3',   // credit card
  free: '\ud83c\udd93',    // free button
  unavailable: '\u2014',   // em dash
};

function tierLabel(tier: string): string {
  return `${TIER_EMOJI[tier] ?? '?'} ${tier}`;
}

function agentLabel(sub: { agentType: AgentType; provider?: string }): string {
  const name = sub.provider ? `${sub.agentType} (${sub.provider})` : sub.agentType;
  return name.padEnd(22);
}

function printSubscription(sub: HarnessSubscription): void {
  const parts = [`  ${agentLabel(sub)} ${tierLabel(sub.tier)}`];
  if (sub.quotaExhausted !== undefined) {
    parts.push(sub.quotaExhausted ? '  QUOTA EXHAUSTED' : '  quota ok');
  }
  if (sub.utilization !== undefined) {
    parts.push(`  (${sub.utilization}% used)`);
  }
  console.log(parts.join(''));
}

function printUnavailable(agentType: AgentType): void {
  const label = agentType === 'opencode' ? `${agentType} (cerebras)` : agentType;
  console.log(`  ${label.padEnd(22)} ${tierLabel('unavailable')}`);
}

// ── Tests ────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  \u2705 ${message}`);
    passed++;
  } else {
    console.log(`  \u274c ${message}`);
    failed++;
  }
}

async function testDetection(checkQuota: boolean): Promise<void> {
  console.log('\n\u2500\u2500 Agent Detection \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

  const subs = await detectSubscriptions({ checkQuota });
  const detectedTypes = new Set(subs.map((s) => s.agentType));
  const missing = ALL_AGENT_TYPES.filter((t) => !detectedTypes.has(t));

  console.log('Harnesses:\n');
  for (const sub of subs) {
    printSubscription(sub);
  }
  for (const agentType of missing) {
    printUnavailable(agentType);
  }

  // Basic invariants
  console.log('\nInvariants:\n');

  assert(subs.length > 0, 'At least one harness detected');

  assert(
    subs.every((s) => s.tier !== 'unavailable'),
    'No unavailable harnesses in results (should be filtered)',
  );

  // Verify ordering: each tier should be >= the previous
  const tierOrder = { subscription: 0, paygo: 1, free: 2, unavailable: 3 };
  let ordered = true;
  for (let i = 1; i < subs.length; i++) {
    const prev = tierOrder[subs[i - 1].tier];
    const curr = tierOrder[subs[i].tier];
    // Exhausted subscriptions get demoted, so the effective ordering may
    // differ from the raw tier — just verify it's not wildly wrong
    if (curr < prev && !subs[i - 1].quotaExhausted) {
      ordered = false;
      break;
    }
  }
  assert(ordered, 'Results are sorted by tier preference');
}

async function testPreferredAgentTypes(checkQuota: boolean): Promise<void> {
  console.log('\n\u2500\u2500 Preferred Agent Types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

  const types = await getPreferredAgentTypes({ checkQuota });

  console.log(`Preference order: ${types.join(' > ')}\n`);

  assert(types.length > 0, 'At least one agent type returned');

  const uniqueTypes = new Set(types);
  assert(uniqueTypes.size === types.length, 'No duplicate agent types');
}

async function testFailureTracking(): Promise<void> {
  console.log('\n\u2500\u2500 Failure Tracking \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

  // Get baseline ordering
  const baseline = await getPreferredAgentTypes();
  if (baseline.length < 2) {
    console.log('  (skipping — need at least 2 agents to test reranking)\n');
    return;
  }

  const top = baseline[0];

  // Record a failure for the top agent
  recordQuotaFailure(top);
  const afterFailure = await detectSubscriptions();
  const topAfterFailure = afterFailure.find((s) => s.agentType === top);

  assert(
    topAfterFailure?.quotaExhausted === true,
    `Top agent "${top}" marked as quota exhausted after failure`,
  );

  // Clear the failure
  clearQuotaFailure(top);
  const afterClear = await getPreferredAgentTypes();

  assert(
    afterClear[0] === baseline[0],
    `Original order restored after clearing failure`,
  );
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const checkQuota = process.argv.includes('--quota');

  console.log('Agent Harness E2E Test');
  console.log(`Mode: ${checkQuota ? 'with quota checks (network requests)' : 'tier detection only (local)'}`);

  await testDetection(checkQuota);
  await testPreferredAgentTypes(checkQuota);
  await testFailureTracking();

  console.log(`\n\u2500\u2500 Results: ${passed} passed, ${failed} failed \u2500\u2500\u2500\n`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
