/**
 * Judge for LLM-graded checks.
 *
 * Design: for a single case, we collect every `{kind: 'judge', ...}` check
 * across all three axes (reply/doc/code) and issue ONE Sonnet call that
 * grades them all at once. This is ~10x cheaper than one call per check
 * and keeps judge behavior consistent within a case.
 *
 * Output contract: the judge returns a JSON object keyed by the caller's
 * stable check IDs (we assign `r0`, `r1`, `d0`, `c0`, … so it can't
 * confuse them) with `{pass: boolean, reason: string}`. Any missing key
 * counts as a failure with `reason: "judge omitted"`.
 *
 * Calibration: changes to the JUDGE_SYSTEM prompt should be verified via
 * the judge-calibration suite (`make eval/judge`) before landing.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Judge } from '../types.js';

export const JUDGE_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Keep the judge prompt boring and explicit. The goal is NOT to get
 * clever reasoning — it's to get consistent yes/no verdicts that agree
 * with a human reading the same rubric.
 */
const JUDGE_SYSTEM = `You are a strict evaluation judge grading AI agent outputs against specific rubrics.

For each grading request you receive, you will be given a list of items. Each item has:
- an \`id\` (short token like "r0", "d2")
- a \`target\` (what kind of artifact the rubric evaluates: "reply", "doc", "diff", or "behavior")
- a \`rubric\` (the criterion to apply)
- optionally a \`truth\` statement (an authoritative claim about what the correct outcome looks like; use it to ground your verdict)
- an \`artifact\` (the actual text you are evaluating)

For EACH item, decide whether the artifact SATISFIES the rubric. Output ONLY a single JSON object with this exact shape, with the \`reason\` field FIRST and the \`pass\` field AFTER it:

{
  "<id>": {"reason": "<1 sentence>", "pass": <boolean>},
  ...
}

Rules:
1. Be strict. If the rubric says "mentions X and Y" and only X is present, that's a fail.
2. If the rubric is vague, prefer PASS when there is clear evidence of the intent and FAIL when there is any doubt.
3. Do not grade anything not asked. If an artifact has other problems unrelated to the rubric, ignore them.
4. "reason" must be one sentence, ≤ 25 words, stating the SPECIFIC observation that drove the verdict.
5. The \`pass\` boolean MUST agree with the conclusion stated in \`reason\`. Decide your reasoning first, then commit to the boolean — never let the boolean contradict the reason.
6. Emit raw JSON only. No preamble, no markdown fences, no trailing prose.`;

export interface JudgeItem {
  id: string;
  judge: Judge;
  artifact: string;
}

export interface JudgeVerdict {
  pass: boolean;
  reason: string;
}

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — required for judge calls');
  }
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

/**
 * Batch-grade a set of judge items in one Sonnet call. Returns a map
 * keyed by the caller's item id.
 */
export async function batchJudge(items: JudgeItem[]): Promise<Record<string, JudgeVerdict>> {
  if (items.length === 0) return {};

  const payload = items.map((it) => ({
    id: it.id,
    target: it.judge.target,
    rubric: it.judge.rubric,
    ...(it.judge.truth ? { truth: it.judge.truth } : {}),
    artifact: it.artifact,
  }));

  const userMessage =
    'Grade the following items. Emit ONLY a JSON object keyed by id.\n\n' +
    JSON.stringify(payload, null, 2);

  const resp = await client().messages.create({
    model: JUDGE_MODEL,
    max_tokens: 2048,
    system: [
      {
        type: 'text',
        text: JUDGE_SYSTEM,
        // Cache the system prompt — it's identical across every judge
        // call so we want the cache to pay off after the first case.
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch (err) {
    throw new Error(
      `judge returned invalid JSON: ${(err as Error).message}\n--- raw ---\n${text.slice(0, 500)}`,
    );
  }

  const out: Record<string, JudgeVerdict> = {};
  for (const it of items) {
    const raw = (parsed as Record<string, unknown>)[it.id];
    if (!raw || typeof raw !== 'object') {
      out[it.id] = { pass: false, reason: 'judge omitted this item' };
      continue;
    }
    const r = raw as { pass?: unknown; reason?: unknown };
    out[it.id] = {
      pass: r.pass === true,
      reason: typeof r.reason === 'string' ? r.reason : '(no reason)',
    };
  }
  return out;
}

function stripFences(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  return trimmed;
}

/**
 * Exposed so the judge-calibration suite can test the exact same prompt
 * path. Do not use this from case scorers — go through batchJudge.
 */
export const _internal = { JUDGE_SYSTEM };
