import { describe, it, expect, vi } from 'vitest';
import { DriveApi } from '../../src/client/drive-api.js';

function createMockAuth() {
  return {} as any;
}

/**
 * Build a DriveApi instance with a mocked `google.drive()` under the hood.
 * Callers provide per-test method stubs.
 */
function createDriveApi(stubs: Record<string, any>): DriveApi {
  const api = new DriveApi(createMockAuth());
  // Reach into the private `drive` field and patch methods
  const drive = (api as any).drive;

  if (stubs.permissionsList) {
    drive.permissions.list = stubs.permissionsList;
  }
  if (stubs.permissionsDelete) {
    drive.permissions.delete = stubs.permissionsDelete;
  }
  if (stubs.permissionsCreate) {
    drive.permissions.create = stubs.permissionsCreate;
  }
  if (stubs.filesGet) {
    drive.files.get = stubs.filesGet;
  }
  if (stubs.filesList) {
    drive.files.list = stubs.filesList;
  }
  if (stubs.repliesCreate) {
    drive.replies.create = stubs.repliesCreate;
  }
  if (stubs.commentsList) {
    drive.comments.list = stubs.commentsList;
  }
  return api;
}

describe('DriveApi.removePermission', () => {
  it('finds and deletes the matching permission', async () => {
    const deleteFn = vi.fn(async () => {});
    const listFn = vi.fn(async () => ({
      data: {
        permissions: [
          { id: 'perm-1', emailAddress: 'other@example.com' },
          { id: 'perm-2', emailAddress: 'bot@project.iam.gserviceaccount.com' },
        ],
      },
    }));
    const api = createDriveApi({
      permissionsList: listFn,
      permissionsDelete: deleteFn,
    });

    await api.removePermission('doc-1', 'bot@project.iam.gserviceaccount.com');

    expect(listFn).toHaveBeenCalledTimes(1);
    expect(listFn).toHaveBeenCalledWith({
      fileId: 'doc-1',
      fields: 'permissions(id,emailAddress)',
    });
    expect(deleteFn).toHaveBeenCalledTimes(1);
    expect(deleteFn).toHaveBeenCalledWith({
      fileId: 'doc-1',
      permissionId: 'perm-2',
    });
  });

  it('does nothing when no matching permission exists', async () => {
    const deleteFn = vi.fn(async () => {});
    const api = createDriveApi({
      permissionsList: vi.fn(async () => ({
        data: { permissions: [{ id: 'perm-1', emailAddress: 'other@example.com' }] },
      })),
      permissionsDelete: deleteFn,
    });

    await api.removePermission('doc-1', 'bot@project.iam.gserviceaccount.com');

    expect(deleteFn).not.toHaveBeenCalled();
  });

  it('matches email case-insensitively', async () => {
    const deleteFn = vi.fn(async () => {});
    const api = createDriveApi({
      permissionsList: vi.fn(async () => ({
        data: {
          permissions: [{ id: 'perm-1', emailAddress: 'Bot@Project.iam.gserviceaccount.com' }],
        },
      })),
      permissionsDelete: deleteFn,
    });

    await api.removePermission('doc-1', 'bot@project.iam.gserviceaccount.com');

    expect(deleteFn).toHaveBeenCalledWith({
      fileId: 'doc-1',
      permissionId: 'perm-1',
    });
  });

  it('swallows 404 on delete (already removed)', async () => {
    const deleteFn = vi.fn(async () => {
      const err: any = new Error('Not found');
      err.code = 404;
      throw err;
    });
    const api = createDriveApi({
      permissionsList: vi.fn(async () => ({
        data: { permissions: [{ id: 'perm-1', emailAddress: 'bot@example.com' }] },
      })),
      permissionsDelete: deleteFn,
    });

    // Should not throw
    await expect(api.removePermission('doc-1', 'bot@example.com')).resolves.toBeUndefined();
    expect(deleteFn).toHaveBeenCalled();
  });

  it('rethrows non-404 errors on delete', async () => {
    const deleteFn = vi.fn(async () => {
      const err: any = new Error('Server error');
      err.code = 500;
      throw err;
    });
    const api = createDriveApi({
      permissionsList: vi.fn(async () => ({
        data: { permissions: [{ id: 'perm-1', emailAddress: 'bot@example.com' }] },
      })),
      permissionsDelete: deleteFn,
    });

    await expect(api.removePermission('doc-1', 'bot@example.com')).rejects.toThrow('Server error');
    expect(deleteFn).toHaveBeenCalled();
  });
});

describe('DriveApi.canAccess', () => {
  it('returns true when the file is accessible', async () => {
    const api = createDriveApi({
      filesGet: vi.fn(async () => ({ data: { id: 'doc-1' } })),
    });

    expect(await api.canAccess('doc-1')).toBe(true);
  });

  it('returns false on 403', async () => {
    const api = createDriveApi({
      filesGet: vi.fn(async () => {
        const err: any = new Error('Forbidden');
        err.code = 403;
        throw err;
      }),
    });

    expect(await api.canAccess('doc-1')).toBe(false);
  });

  it('returns false on 404', async () => {
    const api = createDriveApi({
      filesGet: vi.fn(async () => {
        const err: any = new Error('Not found');
        err.code = 404;
        throw err;
      }),
    });

    expect(await api.canAccess('doc-1')).toBe(false);
  });

  it('rethrows unexpected errors', async () => {
    const api = createDriveApi({
      filesGet: vi.fn(async () => {
        const err: any = new Error('Server error');
        err.code = 500;
        throw err;
      }),
    });

    await expect(api.canAccess('doc-1')).rejects.toThrow('Server error');
  });
});

describe('DriveApi.resolveComment', () => {
  it('posts a replies.create with action: resolve', async () => {
    const repliesCreate = vi.fn(async () => ({ data: { id: 'reply-1' } }));
    const api = createDriveApi({ repliesCreate });

    await api.resolveComment('file-1', 'comment-1');

    expect(repliesCreate).toHaveBeenCalledTimes(1);
    const arg = repliesCreate.mock.calls[0][0];
    expect(arg.fileId).toBe('file-1');
    expect(arg.commentId).toBe('comment-1');
    expect(arg.requestBody.action).toBe('resolve');
    expect(arg.requestBody.content).toBe('Resolved');
  });
});

describe('DriveApi.findFolder (escapeDriveQ)', () => {
  it("escapes single quotes in folder names", async () => {
    const filesList = vi.fn(async () => ({ data: { files: [{ id: 'folder-1' }] } }));
    const api = createDriveApi({ filesList });

    await api.findFolder("Bob's Folder");

    expect(filesList).toHaveBeenCalledTimes(1);
    const arg = filesList.mock.calls[0][0];
    expect(arg.q).toContain("name='Bob\\'s Folder'");
  });

  it('escapes backslashes in folder names', async () => {
    const filesList = vi.fn(async () => ({ data: { files: [{ id: 'folder-2' }] } }));
    const api = createDriveApi({ filesList });

    await api.findFolder('path\\to\\folder');

    expect(filesList).toHaveBeenCalledTimes(1);
    const arg = filesList.mock.calls[0][0];
    expect(arg.q).toContain("name='path\\\\to\\\\folder'");
  });

  it('escapes both backslashes and single quotes together', async () => {
    const filesList = vi.fn(async () => ({ data: { files: [] } }));
    const api = createDriveApi({ filesList });

    await api.findFolder("a\\b'c");

    const arg = filesList.mock.calls[0][0];
    expect(arg.q).toContain("name='a\\\\b\\'c'");
  });

  it('returns null when no folder is found', async () => {
    const filesList = vi.fn(async () => ({ data: { files: [] } }));
    const api = createDriveApi({ filesList });

    expect(await api.findFolder('nonexistent')).toBeNull();
  });
});

describe('DriveApi.listComments', () => {
  it('concatenates comments across paginated responses', async () => {
    const commentsList = vi
      .fn()
      .mockImplementationOnce(async () => ({
        data: {
          comments: [
            { id: 'c1', content: 'first' },
            { id: 'c2', content: 'second' },
          ],
          nextPageToken: 'page2',
        },
      }))
      .mockImplementationOnce(async () => ({
        data: {
          comments: [
            { id: 'c3', content: 'third' },
            { id: 'c4', content: 'fourth' },
          ],
        },
      }));
    const api = createDriveApi({ commentsList });

    const result = await api.listComments('file-1');

    expect(commentsList).toHaveBeenCalledTimes(2);
    expect(commentsList.mock.calls[0][0].pageToken).toBeUndefined();
    expect(commentsList.mock.calls[1][0].pageToken).toBe('page2');
    expect(result.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('returns a single page when no nextPageToken', async () => {
    const commentsList = vi.fn(async () => ({
      data: { comments: [{ id: 'c1' }] },
    }));
    const api = createDriveApi({ commentsList });

    const result = await api.listComments('file-1');

    expect(commentsList).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
  });

  it('returns empty array when no comments exist', async () => {
    const commentsList = vi.fn(async () => ({ data: {} }));
    const api = createDriveApi({ commentsList });

    expect(await api.listComments('file-1')).toEqual([]);
    expect(commentsList).toHaveBeenCalledTimes(1);
  });
});

describe('DriveApi.ensureShared', () => {
  it('calls permissions.create with the expected payload', async () => {
    const permissionsCreate = vi.fn(async () => ({ data: { id: 'perm-1' } }));
    const api = createDriveApi({ permissionsCreate });

    await api.ensureShared('file-1', 'user@example.com');

    expect(permissionsCreate).toHaveBeenCalledTimes(1);
    const arg = permissionsCreate.mock.calls[0][0];
    expect(arg.fileId).toBe('file-1');
    expect(arg.sendNotificationEmail).toBe(false);
    expect(arg.requestBody).toEqual({
      type: 'user',
      role: 'commenter',
      emailAddress: 'user@example.com',
    });
  });

  it('honors a custom role', async () => {
    const permissionsCreate = vi.fn(async () => ({ data: { id: 'perm-1' } }));
    const api = createDriveApi({ permissionsCreate });

    await api.ensureShared('file-1', 'user@example.com', 'writer');

    const arg = permissionsCreate.mock.calls[0][0];
    expect(arg.requestBody.role).toBe('writer');
  });

  it('swallows 409 errors (permission already exists)', async () => {
    const permissionsCreate = vi.fn(async () => {
      const err: any = new Error('Conflict');
      err.code = 409;
      throw err;
    });
    const api = createDriveApi({ permissionsCreate });

    await expect(api.ensureShared('file-1', 'user@example.com')).resolves.toBeUndefined();
    expect(permissionsCreate).toHaveBeenCalled();
  });

  it('rethrows non-409 errors', async () => {
    const permissionsCreate = vi.fn(async () => {
      const err: any = new Error('Server error');
      err.code = 500;
      throw err;
    });
    const api = createDriveApi({ permissionsCreate });

    await expect(api.ensureShared('file-1', 'user@example.com')).rejects.toThrow('Server error');
  });
});
