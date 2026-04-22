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
  if (stubs.filesGet) {
    drive.files.get = stubs.filesGet;
  }
  if (stubs.repliesCreate) {
    drive.replies.create = stubs.repliesCreate;
  }
  return api;
}

describe('DriveApi.removePermission', () => {
  it('finds and deletes the matching permission', async () => {
    const deleteFn = vi.fn(async () => {});
    const api = createDriveApi({
      permissionsList: vi.fn(async () => ({
        data: {
          permissions: [
            { id: 'perm-1', emailAddress: 'other@example.com' },
            { id: 'perm-2', emailAddress: 'bot@project.iam.gserviceaccount.com' },
          ],
        },
      })),
      permissionsDelete: deleteFn,
    });

    await api.removePermission('doc-1', 'bot@project.iam.gserviceaccount.com');

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
  });
});
