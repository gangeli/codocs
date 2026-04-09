import { google, type drive_v3 } from 'googleapis';

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

  /** Get a single comment by ID. */
  async getComment(fileId: string, commentId: string): Promise<drive_v3.Schema$Comment> {
    const res = await this.drive.comments.get({
      fileId,
      commentId,
      fields: 'id,content,author,quotedFileContent,resolved,createdTime',
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
}
