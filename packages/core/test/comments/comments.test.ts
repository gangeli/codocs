import { describe, it, expect, vi } from 'vitest';
import { addComment, listComments } from '../../src/comments/index.js';

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

  it('combines agent prefix and quotedText anchor', async () => {
    const api = createMockDriveApi();
    await addComment(api as any, 'doc-1', {
      content: 'hi',
      agent: { name: 'planner' },
      quotedText: 'World',
    });
    expect(api.createComment).toHaveBeenCalledWith(
      'doc-1',
      '[planner]: hi',
      JSON.stringify({ r: 0, a: [{ txt: 'World' }] }),
    );
    const [, content, anchor] = api.createComment.mock.calls[0];
    expect(content).toBe('[planner]: hi');
    expect(JSON.parse(anchor)).toEqual({ r: 0, a: [{ txt: 'World' }] });
  });

  it('escapes special characters in quotedText anchor safely via JSON.stringify', async () => {
    const api = createMockDriveApi();
    const special = '"\n\\';
    await addComment(api as any, 'doc-1', {
      content: 'Check',
      quotedText: special,
    });
    const [, , anchor] = api.createComment.mock.calls[0];
    expect(() => JSON.parse(anchor)).not.toThrow();
    expect(JSON.parse(anchor)).toEqual({ r: 0, a: [{ txt: special }] });
    expect(anchor).toBe(JSON.stringify({ r: 0, a: [{ txt: special }] }));
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

