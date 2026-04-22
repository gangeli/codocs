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

  it('returns human when email is missing but displayName is present', () => {
    const comment = makeComment({ author: { displayName: 'Anonymous' } });
    const result = classifyComment(comment, { botEmails: BOT_EMAILS });
    expect(result.type).toBe('human');
  });

  it('returns unknown when both email and displayName are missing', () => {
    const comment = makeComment({ author: {} });
    const result = classifyComment(comment, { botEmails: BOT_EMAILS });
    expect(result.type).toBe('unknown');
  });

  it('classifies as human when botEmails list is empty', () => {
    const result = classifyComment(makeComment(), { botEmails: [] });
    expect(result.type).toBe('human');
  });

  it('classifies as bot by display name when email is unavailable', () => {
    // When fetching comments via a service account, other users' emailAddress
    // may be undefined. The classifier should fall back to display name matching.
    const comment = makeComment({
      replies: [
        // The bot's email shows as its displayName, but emailAddress is missing
        { id: 'r1', content: '🤔', author: { displayName: BOT_EMAILS[0] } },
      ],
    });
    const result = classifyComment(comment, { botEmails: BOT_EMAILS });
    expect(result.type).toBe('bot');
  });

  it('classifies as bot by short name when only local part matches', () => {
    const comment = makeComment({
      replies: [
        { id: 'r1', content: 'Done', author: { displayName: 'codocs-bot' } },
      ],
    });
    const result = classifyComment(comment, { botEmails: BOT_EMAILS });
    expect(result.type).toBe('bot');
  });

  // Regression: when codocs replies using the user's own OAuth credentials
  // (no service account), the reply's author IS the user — identical to a
  // human reply. Without tracking our own reply IDs, the listener would
  // re-process the reply as a fresh human comment, triggering an infinite
  // loop of the bot replying to itself.
  it('classifies as bot when the last reply ID matches a tracked own-reply', () => {
    const comment = makeComment({
      // The user posted the root comment...
      author: { displayName: 'Gabor', emailAddress: 'user@example.com' },
      replies: [
        // ...and codocs posted the thinking emoji using the user's OAuth
        // credentials, so the author looks identical to the human author.
        { id: 'reply-self-1', content: '🤔', author: { displayName: 'Gabor', emailAddress: 'user@example.com' } },
      ],
    });
    const ownReplyIds = new Set(['reply-self-1']);
    const result = classifyComment(comment, { botEmails: [], ownReplyIds });
    expect(result.type).toBe('bot');
  });

  it('ignores ownReplyIds that do not match the last reply', () => {
    const comment = makeComment({
      author: { displayName: 'Gabor', emailAddress: 'user@example.com' },
      replies: [
        { id: 'reply-human', content: 'Please fix it', author: { displayName: 'Gabor', emailAddress: 'user@example.com' } },
      ],
    });
    const ownReplyIds = new Set(['some-other-reply']);
    const result = classifyComment(comment, { botEmails: [], ownReplyIds });
    expect(result.type).toBe('human');
  });

  it('treats tracked own-reply as bot even when email/name also match botEmails', () => {
    const comment = makeComment({
      replies: [
        { id: 'reply-self-1', content: 'hi', author: { displayName: 'Codocs Bot', emailAddress: BOT_EMAILS[0] } },
      ],
    });
    const ownReplyIds = new Set(['reply-self-1']);
    const result = classifyComment(comment, { botEmails: BOT_EMAILS, ownReplyIds });
    expect(result.type).toBe('bot');
  });

  it('does not classify a root comment as bot even if its id is in ownReplyIds', () => {
    const comment = makeComment({
      id: 'comment-1',
      author: { displayName: 'Gabor', emailAddress: 'user@example.com' },
      replies: [],
    });
    const ownReplyIds = new Set(['comment-1']);
    const result = classifyComment(comment, { botEmails: [], ownReplyIds });
    expect(result.type).toBe('human');
    expect(result).toEqual({ type: 'human', author: 'Gabor' });
  });

  it('classifies as bot using botDisplayNames option', () => {
    const comment = makeComment({
      author: { displayName: 'my-bot', emailAddress: 'notabot@example.com' },
    });
    const result = classifyComment(comment, {
      botEmails: [],
      botDisplayNames: ['my-bot'],
    });
    expect(result.type).toBe('bot');
    expect(result).toEqual({ type: 'bot', author: 'my-bot' });
  });

  it('falls back to root comment when all replies are actions', () => {
    const comment = makeComment({
      author: { displayName: 'Codocs Bot', emailAddress: BOT_EMAILS[0] },
      replies: [
        { id: 'r1', content: '', action: 'resolve', author: { displayName: 'Human', emailAddress: 'human@example.com' } },
        { id: 'r2', content: '', action: 'reopen', author: { displayName: 'Human', emailAddress: 'human@example.com' } },
        { id: 'r3', content: '', action: 'resolve', author: { displayName: 'Human', emailAddress: 'human@example.com' } },
      ],
    });
    const result = classifyComment(comment, { botEmails: BOT_EMAILS });
    expect(result.type).toBe('bot');
    expect(result).toEqual({ type: 'bot', author: 'Codocs Bot' });
  });

  it('bot result falls back to email for author when displayName is missing', () => {
    const comment = makeComment({
      author: { emailAddress: BOT_EMAILS[0] },
    });
    const result = classifyComment(comment, { botEmails: BOT_EMAILS });
    expect(result).toEqual({ type: 'bot', author: BOT_EMAILS[0] });
  });

  it('matches bot email case-insensitively', () => {
    const comment = makeComment({
      author: { displayName: 'Codocs Bot', emailAddress: 'HUMAN@example.com' },
    });
    const result = classifyComment(comment, { botEmails: ['human@example.com'] });
    expect(result.type).toBe('bot');
  });
});
