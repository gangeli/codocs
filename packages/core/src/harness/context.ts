/**
 * Temp file management for agent editing workflow.
 *
 * Creates files inside a `.codocs/` directory within the current working
 * directory so the agent process (which runs in cwd) has file access.
 *
 * Layout:
 *   .codocs/
 *     {agentName}-{uuid}.md        — the file the agent edits
 *     .{agentName}-{uuid}-base.md  — untouched snapshot for 3-way merge
 *     .gitignore                   — excludes everything in .codocs/
 */

import { writeFile, unlink, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

export interface TempContext {
  /** Path the agent should edit. */
  editPath: string;
  /** Untouched base snapshot for 3-way merge. */
  basePath: string;
}

/**
 * Ensure `.codocs/` exists with a `.gitignore` that excludes everything.
 */
async function ensureCodocsDir(): Promise<string> {
  const dir = join(process.cwd(), '.codocs');
  await mkdir(dir, { recursive: true });

  const gitignorePath = join(dir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    await writeFile(gitignorePath, '*\n', 'utf-8');
  }

  return dir;
}

/**
 * Create uniquely-named working files for an agent task.
 *
 * Each invocation gets its own UUID so multiple agents / concurrent
 * tasks don't collide.
 */
export async function writeTempContext(
  markdown: string,
  documentId: string,
  agentName: string,
): Promise<TempContext> {
  const dir = await ensureCodocsDir();
  const id = randomUUID().slice(0, 8);
  const safeName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');

  const editPath = join(dir, `${safeName}-${id}.md`);
  const basePath = join(dir, `.${safeName}-${id}-base.md`);

  await Promise.all([
    writeFile(editPath, markdown, 'utf-8'),
    writeFile(basePath, markdown, 'utf-8'),
  ]);

  return { editPath, basePath };
}

/**
 * Clean up working files after the agent workflow completes.
 */
export async function cleanupTempFiles(...paths: string[]): Promise<void> {
  await Promise.all(
    paths.map((p) => unlink(p).catch(() => {})),
  );
}
