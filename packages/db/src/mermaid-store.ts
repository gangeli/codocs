import type { Database } from 'sql.js';
import { createHash } from 'node:crypto';

export interface MermaidMapping {
  documentId: string;
  sourceHash: string;
  mermaidSource: string;
}

/** SHA-256 hash of mermaid source (first 16 hex chars), used as a lookup key. */
export function hashMermaidSource(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

export class MermaidStore {
  constructor(private db: Database) {}

  /** Save a mermaid source mapping (upsert). */
  save(documentId: string, mermaidSource: string): string {
    const sourceHash = hashMermaidSource(mermaidSource);
    this.db.run(
      `INSERT INTO mermaid_mappings (document_id, source_hash, mermaid_source)
       VALUES (?, ?, ?)
       ON CONFLICT (document_id, source_hash) DO UPDATE SET mermaid_source = excluded.mermaid_source`,
      [documentId, sourceHash, mermaidSource],
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
