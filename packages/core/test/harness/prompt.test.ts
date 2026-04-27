import { describe, it, expect } from 'vitest';
import { buildPrompt, buildConflictPrompt } from '../../src/harness/prompt.js';
import type { PromptContext } from '../../src/harness/prompt.js';

const BASE: PromptContext = {
  agentName: 'reviewer',
  commentText: 'Add a section on rate limiting.',
  quotedText: '## API Surface',
  documentId: 'doc-123',
  workingDirectory: '/tmp/work',
  designDocPath: '/tmp/work/doc.md',
  chatMarkerPath: '.codocs-chat-marker.json',
  codeEnabled: true,
};

describe('buildPrompt snapshots', () => {
  it('base: single comment, code enabled, with quoted anchor', async () => {
    await expect(buildPrompt(BASE)).toMatchFileSnapshot(
      './__snapshots__/prompt-base.txt',
    );
  });

  it('no quoted text', async () => {
    await expect(buildPrompt({ ...BASE, quotedText: '' })).toMatchFileSnapshot(
      './__snapshots__/prompt-no-quote.txt',
    );
  });

  it('code disabled', async () => {
    await expect(
      buildPrompt({ ...BASE, codeEnabled: false }),
    ).toMatchFileSnapshot('./__snapshots__/prompt-code-disabled.txt');
  });

  it('follow-up via thread history', async () => {
    await expect(
      buildPrompt({
        ...BASE,
        thread: [
          { author: 'alice', content: 'Earlier: please add a rate limit section.' },
          { author: 'reviewer', content: 'Done — added under API Surface.' },
          { author: 'alice', content: 'Also fix the typo in this section.' },
        ],
        commentText: 'Also fix the typo in this section.',
      }),
    ).toMatchFileSnapshot('./__snapshots__/prompt-followup-thread.txt');
  });

  it('follow-up via existing draft PR', async () => {
    await expect(
      buildPrompt({
        ...BASE,
        existingPR: { number: 42, url: 'https://github.com/o/r/pull/42' },
      }),
    ).toMatchFileSnapshot('./__snapshots__/prompt-followup-pr.txt');
  });
});

describe('buildConflictPrompt snapshot', () => {
  it('basic conflict prompt', async () => {
    await expect(
      buildConflictPrompt(
        '/tmp/work/doc.md',
        '<<<<<<< ours\nfoo\n=======\nbar\n>>>>>>> theirs',
      ),
    ).toMatchFileSnapshot('./__snapshots__/conflict-prompt.txt');
  });
});
