import { google, type drive_v3 } from 'googleapis';
import { Readable } from 'node:stream';

export class DriveApi {
  private drive: drive_v3.Drive;

  constructor(auth: unknown) {
    this.drive = google.drive({ version: 'v3', auth: auth as any });
  }

  /** Create a comment on a file. Returns the comment ID. */
  async createComment(
    fileId: string,
    content: string,
    anchor?: string,
  ): Promise<string> {
    const res = await this.drive.comments.create({
      fileId,
      fields: 'id',
      requestBody: {
        content,
        ...(anchor ? { anchor } : {}),
      },
    });
    return res.data.id!;
  }

  /** List all comments on a file. */
  async listComments(fileId: string): Promise<drive_v3.Schema$Comment[]> {
    const comments: drive_v3.Schema$Comment[] = [];
    let pageToken: string | undefined;

    do {
      const res = await this.drive.comments.list({
        fileId,
        fields: 'comments(id,content,author,quotedFileContent,resolved,createdTime),nextPageToken',
        pageToken,
      });
      if (res.data.comments) {
        comments.push(...res.data.comments);
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return comments;
  }

  /** Get a single comment by ID, including its reply thread. */
  async getComment(fileId: string, commentId: string): Promise<drive_v3.Schema$Comment> {
    const res = await this.drive.comments.get({
      fileId,
      commentId,
      fields: 'id,content,author,quotedFileContent,resolved,createdTime,replies(id,content,author,createdTime,action)',
      includeDeleted: false,
    });
    return res.data;
  }

  /** Find a folder by name under a parent (or root). Returns folder ID or null. */
  async findFolder(name: string, parentId?: string): Promise<string | null> {
    const parent = parentId ?? 'root';
    const res = await this.drive.files.list({
      q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parent}' in parents and trashed=false`,
      fields: 'files(id)',
      spaces: 'drive',
    });
    return res.data.files?.[0]?.id ?? null;
  }

  /** Create a folder. Returns the folder ID. */
  async createFolder(name: string, parentId?: string): Promise<string> {
    const res = await this.drive.files.create({
      fields: 'id',
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        ...(parentId ? { parents: [parentId] } : {}),
      },
    });
    return res.data.id!;
  }

  /** Find or create a folder by name. Returns the folder ID. */
  async findOrCreateFolder(name: string, parentId?: string): Promise<string> {
    const existing = await this.findFolder(name, parentId);
    if (existing) return existing;
    return this.createFolder(name, parentId);
  }

  /** Move a file into a folder. */
  async moveToFolder(fileId: string, folderId: string): Promise<void> {
    // Get current parents to remove them
    const file = await this.drive.files.get({
      fileId,
      fields: 'parents',
    });
    const previousParents = (file.data.parents ?? []).join(',');

    await this.drive.files.update({
      fileId,
      addParents: folderId,
      removeParents: previousParents,
      fields: 'id',
    });
  }

  /** Reply to a comment with text content. Returns the reply ID. */
  async replyToComment(fileId: string, commentId: string, content: string): Promise<string> {
    const res = await this.drive.replies.create({
      fileId,
      commentId,
      fields: 'id',
      requestBody: { content },
    });
    return res.data.id!;
  }

  /** Delete a reply. */
  async deleteReply(fileId: string, commentId: string, replyId: string): Promise<void> {
    await this.drive.replies.delete({ fileId, commentId, replyId });
  }

  /** Update an existing reply's content. */
  async updateReply(fileId: string, commentId: string, replyId: string, content: string): Promise<void> {
    await this.drive.replies.update({
      fileId,
      commentId,
      replyId,
      fields: 'id',
      requestBody: { content },
    });
  }

  /** Resolve a comment by creating a "resolve" reply. */
  async resolveComment(fileId: string, commentId: string): Promise<void> {
    await this.drive.replies.create({
      fileId,
      commentId,
      fields: 'id',
      requestBody: {
        action: 'resolve',
        content: 'Resolved',
      },
    });
  }

  // ── Temp image upload/cleanup for Mermaid diagrams ──────────

  /**
   * Upload an image buffer to Drive as a temporary file for insertInlineImage.
   * Sets "anyone with link" read access so the Docs API can fetch it.
   * The caller MUST delete the file after the batchUpdate completes.
   */
  async uploadTempImage(
    buffer: Buffer,
    filename: string,
  ): Promise<{ fileId: string; downloadUrl: string }> {
    const folderId = await this.findOrCreateFolder('codocs-tmp');

    const res = await this.drive.files.create({
      fields: 'id',
      requestBody: {
        name: filename,
        mimeType: 'image/png',
        parents: [folderId],
      },
      media: {
        mimeType: 'image/png',
        body: Readable.from(buffer),
      },
    });

    const fileId = res.data.id!;

    // Make publicly readable so Docs API backend can fetch it
    await this.drive.permissions.create({
      fileId,
      requestBody: { type: 'anyone', role: 'reader' },
    });

    return {
      fileId,
      downloadUrl: `https://drive.google.com/uc?id=${fileId}`,
    };
  }

  /** Delete a Drive file by ID. Swallows 404 (already deleted). */
  async deleteFile(fileId: string): Promise<void> {
    try {
      await this.drive.files.delete({ fileId });
    } catch (err: any) {
      if (err.code !== 404) throw err;
    }
  }

  /**
   * Delete orphaned temp files older than maxAgeMs from the codocs-tmp folder.
   * Returns the number of files deleted.
   */
  async cleanupOrphanedTempFiles(maxAgeMs: number = 5 * 60 * 1000): Promise<number> {
    const folderId = await this.findFolder('codocs-tmp');
    if (!folderId) return 0;

    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const res = await this.drive.files.list({
      q: `'${folderId}' in parents and createdTime < '${cutoff}' and trashed=false`,
      fields: 'files(id)',
      spaces: 'drive',
    });

    const files = res.data.files ?? [];
    let deleted = 0;
    for (const file of files) {
      try {
        await this.drive.files.delete({ fileId: file.id! });
        deleted++;
      } catch {
        // Best-effort cleanup
      }
    }
    return deleted;
  }

  // ── App properties (cross-machine server lock) ─────────────

  /**
   * Read appProperties from a file. Returns an empty object if none set.
   * appProperties are scoped to the OAuth client ID, so different apps
   * won't collide.
   */
  async getAppProperties(fileId: string): Promise<Record<string, string>> {
    const res = await this.drive.files.get({
      fileId,
      fields: 'appProperties',
    });
    return (res.data.appProperties as Record<string, string>) ?? {};
  }

  /**
   * Set (merge) appProperties on a file.
   * To delete a key, set its value to null.
   */
  async setAppProperties(
    fileId: string,
    properties: Record<string, string | null>,
  ): Promise<void> {
    await this.drive.files.update({
      fileId,
      requestBody: { appProperties: properties as any },
    });
  }

  /**
   * Share a file with an email address. Idempotent — silently succeeds
   * if the permission already exists.
   *
   * @param role - 'commenter', 'reader', or 'writer'
   */
  async ensureShared(
    fileId: string,
    email: string,
    role: 'commenter' | 'reader' | 'writer' = 'commenter',
  ): Promise<void> {
    try {
      await this.drive.permissions.create({
        fileId,
        sendNotificationEmail: false,
        requestBody: {
          type: 'user',
          role,
          emailAddress: email,
        },
      });
    } catch (err: any) {
      // 409 = permission already exists, which is fine
      if (err.code !== 409) throw err;
    }
  }

  /**
   * Remove a permission from a file by email address.
   * Silently succeeds if no matching permission is found.
   */
  async removePermission(fileId: string, email: string): Promise<void> {
    // List permissions to find the one matching the email
    const res = await this.drive.permissions.list({
      fileId,
      fields: 'permissions(id,emailAddress)',
    });
    const perm = res.data.permissions?.find(
      (p) => p.emailAddress?.toLowerCase() === email.toLowerCase(),
    );
    if (!perm?.id) return;

    try {
      await this.drive.permissions.delete({ fileId, permissionId: perm.id });
    } catch (err: any) {
      // 404 = already removed
      if (err.code !== 404) throw err;
    }
  }

  /**
   * Check if the caller has access to a file. Returns true if the
   * file metadata can be fetched, false on 404/403.
   */
  async canAccess(fileId: string): Promise<boolean> {
    try {
      await this.drive.files.get({ fileId, fields: 'id' });
      return true;
    } catch (err: any) {
      if (err.code === 404 || err.code === 403) return false;
      throw err;
    }
  }
}
