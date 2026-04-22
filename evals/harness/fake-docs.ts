/**
 * Fake Google Docs client used by the eval harness. Extracted from the
 * e2e-comments.ts test runner; behavior is identical. Keeps the doc as
 * a markdown string, builds a minimal Schema$Document on read, and
 * short-circuits batchUpdate by adopting whatever markdown the agent
 * just wrote to `.codocs/design-doc.md` (captured by RecordingRunner).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { docs_v1 } from 'googleapis';
import type {
  AgentRunner,
  AgentRunOptions,
  AgentRunResult,
  ActiveAgent,
  RunnerCapabilities,
} from '@codocs/core';

export function mdToMinimalDoc(markdown: string): docs_v1.Schema$Document {
  const paragraphs = markdown.replace(/\r\n/g, '\n').split(/\n\n+/).filter((p) => p.length > 0);
  const content: docs_v1.Schema$StructuralElement[] = [
    { startIndex: 0, endIndex: 1, sectionBreak: { sectionStyle: { sectionType: 'CONTINUOUS' } } },
  ];
  let idx = 1;
  for (const raw of paragraphs) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(raw);
    let style = 'NORMAL_TEXT';
    let text = raw;
    if (headingMatch) {
      style = `HEADING_${headingMatch[1].length}`;
      text = headingMatch[2];
    }
    const withNewline = text + '\n';
    const end = idx + withNewline.length;
    content.push({
      startIndex: idx,
      endIndex: end,
      paragraph: {
        elements: [{ startIndex: idx, endIndex: end, textRun: { content: withNewline, textStyle: {} } }],
        paragraphStyle: { namedStyleType: style },
      },
    });
    idx = end;
  }
  return { body: { content }, namedRanges: {}, lists: {}, inlineObjects: {} };
}

export interface FakeReply {
  commentId: string;
  content: string;
  replyId: string;
}

export class FakeDocsClient {
  markdown: string;
  replies: FakeReply[] = [];
  batchUpdateCalls: Array<{ docId: string; requests: unknown[] }> = [];
  private replyCounter = 0;
  private runner?: RecordingRunner;

  constructor(initialMarkdown: string) {
    this.markdown = initialMarkdown;
  }

  attachRunner(r: RecordingRunner): void {
    this.runner = r;
  }

  async getDocument(_docId: string): Promise<docs_v1.Schema$Document> {
    return mdToMinimalDoc(this.markdown);
  }

  async getAttributions(): Promise<[]> {
    return [];
  }

  async batchUpdate(docId: string, requests: unknown[]): Promise<void> {
    this.batchUpdateCalls.push({ docId, requests });
    const next = this.runner?.designDocQueue.shift();
    if (next != null) this.markdown = next;
  }

  async replyToComment(_docId: string, commentId: string, content: string): Promise<string> {
    const replyId = `reply-${++this.replyCounter}`;
    this.replies.push({ commentId, content, replyId });
    return replyId;
  }

  async deleteReply(_docId: string, _commentId: string, replyId: string): Promise<void> {
    const idx = this.replies.findIndex((r) => r.replyId === replyId);
    if (idx >= 0) this.replies.splice(idx, 1);
  }

  async updateReply(): Promise<void> { /* unused */ }

  async canAccess(): Promise<boolean> {
    return true;
  }
}

/**
 * Wraps another AgentRunner, captures every working directory the agent
 * touches, and snapshots `.codocs/design-doc.md` after each run so the
 * fake docs client can re-expose it as the new doc state.
 */
export class RecordingRunner implements AgentRunner {
  readonly name = 'recording';
  workingDirectories: string[] = [];
  promptHistory: string[] = [];
  designDocQueue: string[] = [];
  lastDesignDocMarkdown: string | null = null;

  constructor(private inner: AgentRunner) {}

  async run(prompt: string, sessionId: string | null, opts?: AgentRunOptions): Promise<AgentRunResult> {
    if (opts?.workingDirectory) this.workingDirectories.push(opts.workingDirectory);
    this.promptHistory.push(prompt);
    const result = await this.inner.run(prompt, sessionId, opts);
    if (opts?.workingDirectory) {
      const designPath = join(opts.workingDirectory, '.codocs', 'design-doc.md');
      try {
        const md = await readFile(designPath, 'utf-8');
        this.designDocQueue.push(md);
        this.lastDesignDocMarkdown = md;
      } catch { /* file absent on some error paths */ }
    }
    return result;
  }

  getActiveProcesses(): ActiveAgent[] {
    return this.inner.getActiveProcesses();
  }

  killAll(): string[] {
    return this.inner.killAll();
  }

  getCapabilities(): RunnerCapabilities {
    return this.inner.getCapabilities();
  }
}

export function getLastReplyForComment(client: FakeDocsClient, commentId: string): string | null {
  // The orchestrator posts a thinking-emoji placeholder first, then edits
  // it to the final content. We want the latest non-placeholder reply.
  const THINKING = '\u{1F914}';
  const candidates = client.replies.filter((r) => r.commentId === commentId && r.content !== THINKING);
  return candidates.length > 0 ? candidates[candidates.length - 1].content : null;
}
