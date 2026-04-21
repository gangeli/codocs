import type { Database } from 'sql.js';
import { createHash } from 'node:crypto';

export interface MermaidMapping {
  documentId: string;
  sourceHash: string;
  mermaidSource: string;
  driveFileId: string | null;
}

/** SHA-256 hash of mermaid source (first 16 hex chars), used as a lookup key. */
export function hashMermaidSource(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

export class MermaidStore {
  constructor(private db: Database) {}

  /**
   * Save a mermaid source mapping (upsert).
   *
   * `driveFileId` is the Drive file ID that was used as the
   * insertInlineImage URI. Readback extracts the fileId from the inline
   * object's sourceUri and looks up the source here — this is what lets
   * us distinguish mermaid-rendered images from user-supplied ones in
   * mixed documents.
   */
  save(documentId: string, mermaidSource: string, driveFileId?: string): string {
    const sourceHash = hashMermaidSource(mermaidSource);
    this.db.run(
      `INSERT INTO mermaid_mappings (document_id, source_hash, mermaid_source, drive_file_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (document_id, source_hash) DO UPDATE SET
         mermaid_source = excluded.mermaid_source,
         drive_file_id = excluded.drive_file_id`,
      [documentId, sourceHash, mermaidSource, driveFileId ?? null],
    );
    return sourceHash;
  }

  /** Look up mermaid source by hash. */
  getByHash(documentId: string, sourceHash: string): string | null {
    const stmt = this.db.prepare(
      'SELECT mermaid_source FROM mermaid_mappings WHERE document_id = ? AND source_hash = ?',
    );
    stmt.bind([documentId, sourceHash]);
    if (stmt.step()) {
      const value = stmt.getAsObject().mermaid_source as string;
      stmt.free();
      return value;
    }
    stmt.free();
    return null;
  }

  /** Look up mermaid source by Drive file ID (the id embedded in insertInlineImage's uri). */
  getByDriveFileId(documentId: string, driveFileId: string): string | null {
    const stmt = this.db.prepare(
      'SELECT mermaid_source FROM mermaid_mappings WHERE document_id = ? AND drive_file_id = ?',
    );
    stmt.bind([documentId, driveFileId]);
    if (stmt.step()) {
      const value = stmt.getAsObject().mermaid_source as string;
      stmt.free();
      return value;
    }
    stmt.free();
    return null;
  }

  /** Get fileId→source map for a document (rows without a fileId are omitted). */
  getFileIdMap(documentId: string): Map<string, string> {
    const stmt = this.db.prepare(
      `SELECT drive_file_id, mermaid_source FROM mermaid_mappings
       WHERE document_id = ? AND drive_file_id IS NOT NULL`,
    );
    stmt.bind([documentId]);
    const result = new Map<string, string>();
    while (stmt.step()) {
      const row = stmt.getAsObject() as { drive_file_id: string; mermaid_source: string };
      result.set(row.drive_file_id, row.mermaid_source);
    }
    stmt.free();
    return result;
  }

  /** Get all mermaid mappings for a document as a hash→source map. */
  getAllForDocument(documentId: string): Map<string, string> {
    const stmt = this.db.prepare(
      'SELECT source_hash, mermaid_source FROM mermaid_mappings WHERE document_id = ?',
    );
    stmt.bind([documentId]);
    const result = new Map<string, string>();
    while (stmt.step()) {
      const row = stmt.getAsObject() as { source_hash: string; mermaid_source: string };
      result.set(row.source_hash, row.mermaid_source);
    }
    stmt.free();
    return result;
  }
}
