import { describe, it, expect, vi } from 'vitest';
import { addComment, listComments, resolveComment } from '../../src/comments/index.js';

// Mock DriveApi
function createMockDriveApi() {
  return {
    createComment: vi.fn().mockResolvedValue('comment-123'),
    listComments: vi.fn().mockResolvedValue([
      {
        id: 'c1',
        content: '[planner]: Review this section',
        author: { displayName: 'Service Account' },
        quotedFileContent: { value: 'some quoted text' },
        resolved: false,
        createdTime: '2026-04-08T00:00:00Z',
      },
      {
        id: 'c2',
        content: 'Looks good',
        author: { displayName: 'User' },
        quotedFileContent: null,
        resolved: true,
        createdTime: '2026-04-08T01:00:00Z',
      },
    ]),
    resolveComment: vi.fn().mockResolvedValue(undefined),
  };
}

describe('addComment', () => {
  it('creates a comment without agent', async () => {
    const api = createMockDriveApi();
    const id = await addComment(api as any, 'doc-1', {
      content: 'Nice work!',
    });
    expect(id).toBe('comment-123');
    expect(api.createComment).toHaveBeenCalledWith(
      'doc-1',
      'Nice work!',
      undefined,
    );
  });

  it('creates a comment with agent prefix', async () => {
    const api = createMockDriveApi();
    await addComment(api as any, 'doc-1', {
      content: 'Review this',
      agent: { name: 'reviewer' },
    });
    expect(api.createComment).toHaveBeenCalledWith(
      'doc-1',
      '[reviewer]: Review this',
      undefined,
    );
  });

  it('creates a comment with quoted text anchor', async () => {
    const api = createMockDriveApi();
    await addComment(api as any, 'doc-1', {
      content: 'Fix this',
      quotedText: 'buggy code here',
    });
    expect(api.createComment).toHaveBeenCalledWith(
      'doc-1',
      'Fix this',
      JSON.stringify({ r: 0, a: [{ txt: 'buggy code here' }] }),
    );
  });
});

describe('listComments', () => {
  it('maps raw Drive comments to DocComment format', async () => {
    const api = createMockDriveApi();
    const comments = await listComments(api as any, 'doc-1');

    expect(comments).toHaveLength(2);
    expect(comments[0].id).toBe('c1');
    expect(comments[0].content).toBe('[planner]: Review this section');
    expect(comments[0].author).toBe('Service Account');
    expect(comments[0].quotedText).toBe('some quoted text');
    expect(comments[0].resolved).toBe(false);

    expect(comments[1].resolved).toBe(true);
    expect(comments[1].quotedText).toBeUndefined();
  });
});

describe('resolveComment', () => {
  it('calls driveApi.resolveComment', async () => {
    const api = createMockDriveApi();
    await resolveComment(api as any, 'doc-1', 'c1');
    expect(api.resolveComment).toHaveBeenCalledWith('doc-1', 'c1');
  });
});
