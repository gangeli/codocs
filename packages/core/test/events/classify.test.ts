import { describe, it, expect } from 'vitest';
import { classifyComment } from '../../src/events/classify.js';
import type { drive_v3 } from 'googleapis';

function makeComment(overrides?: Partial<drive_v3.Schema$Comment>): drive_v3.Schema$Comment {
  return {
    id: 'comment-1',
    content: 'Hello',
    author: { displayName: 'Human User', emailAddress: 'human@example.com' },
    replies: [],
    ...overrides,
  };
}

const BOT_EMAILS = ['codocs-bot@codocs-492718.iam.gserviceaccount.com'];

describe('classifyComment', () => {
  it('classifies a root comment from a human as human', () => {
    const result = classifyComment(makeComment(), { botEmails: BOT_EMAILS });
    expect(result.type).toBe('human');
    expect(result).toEqual({ type: 'human', author: 'Human User' });
  });

  it('classifies a root comment from a bot as bot', () => {
    const result = classifyComment(
      makeComment({ author: { displayName: 'Codocs Bot', emailAddress: BOT_EMAILS[0] } }),
      { botEmails: BOT_EMAILS },
    );
    expect(result.type).toBe('bot');
  });

  it('classifies based on the last non-action reply, not the root comment', () => {
    const comment = makeComment({
      author: { displayName: 'Human', emailAddress: 'human@example.com' },
      replies: [
        { id: 'r1', content: '🤔', author: { displayName: 'Bot', emailAddress: BOT_EMAILS[0] } },
      ],
    });
    const result = classifyComment(comment, { botEmails: BOT_EMAILS });
    expect(result.type).toBe('bot');
  });

  it('classifies as human when the last reply is from a human', () => {
    const comment = makeComment({
      replies: [
        { id: 'r1', content: '🤔', author: { displayName: 'Bot', emailAddress: BOT_EMAILS[0] } },
        { id: 'r2', content: 'Actually, change it', author: { displayName: 'Human', emailAddress: 'human@example.com' } },
      ],
    });
    const result = classifyComment(comment, { botEmails: BOT_EMAILS });
    expect(result.type).toBe('human');
    expect(result).toEqual({ type: 'human', author: 'Human' });
  });

  it('ignores action replies (resolve/reopen) when finding the last message', () => {
    const comment = makeComment({
      replies: [
        { id: 'r1', content: 'Done', author: { displayName: 'Bot', emailAddress: BOT_EMAILS[0] } },
        { id: 'r2', content: 'Resolved', action: 'resolve', author: { displayName: 'Human', emailAddress: 'human@example.com' } },
      ],
    });
    // Last non-action reply is from the bot
    const result = classifyComment(comment, { botEmails: BOT_EMAILS });
    expect(result.type).toBe('bot');
  });

  it('returns unknown when no email is available', () => {
    const comment = makeComment({ author: { displayName: 'Anonymous' } });
    const result = classifyComment(comment, { botEmails: BOT_EMAILS });
    expect(result.type).toBe('unknown');
  });

  it('classifies as human when botEmails list is empty', () => {
    const result = classifyComment(makeComment(), { botEmails: [] });
    expect(result.type).toBe('human');
  });
});
