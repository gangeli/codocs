/**
 * Temp file management for agent editing workflow.
 *
 * Creates two files per task:
 * - editPath: the agent edits this file
 * - basePath: untouched base snapshot for 3-way merge
 */

import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface TempContext {
  /** Path the agent should edit. */
  editPath: string;
  /** Untouched base snapshot for 3-way merge. */
  basePath: string;
}

/**
 * Write the document markdown to temp files for the agent workflow.
 *
 * @returns Paths to the edit file and the base snapshot.
 */
export async function writeTempContext(
  markdown: string,
  documentId: string,
): Promise<TempContext> {
  const timestamp = Date.now();
  const sanitizedId = documentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const baseName = `codocs-${sanitizedId}-${timestamp}`;

  const editPath = join(tmpdir(), `${baseName}.md`);
  const basePath = join(tmpdir(), `${baseName}-base.md`);

  await Promise.all([
    writeFile(editPath, markdown, 'utf-8'),
    writeFile(basePath, markdown, 'utf-8'),
  ]);

  return { editPath, basePath };
}

/**
 * Clean up temp files after the agent workflow completes.
 */
export async function cleanupTempFiles(...paths: string[]): Promise<void> {
  await Promise.all(
    paths.map((p) => unlink(p).catch(() => {})),
  );
}
