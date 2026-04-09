import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { docsToMarkdown } from '../../src/converter/docs-to-md.js';

function loadFixture(name: string) {
  const path = new URL(`../fixtures/${name}`, import.meta.url).pathname;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('docsToMarkdown', () => {
  it('converts a simple document with heading, bold, and italic', () => {
    const doc = loadFixture('simple-doc.json');
    const md = docsToMarkdown(doc);

    expect(md).toContain('# My Title');
    expect(md).toContain('**bold**');
    expect(md).toContain('*italic*');
    expect(md).toContain('Hello **bold** world.');
  });

  it('converts a document with bullet list', () => {
    const doc = loadFixture('list-doc.json');
    const md = docsToMarkdown(doc);

    expect(md).toContain('- Item one');
    expect(md).toContain('- Item two');
    expect(md).toContain('- Item three');
  });

  it('filters content by agent', () => {
    const doc = loadFixture('attributed-doc.json');

    const plannerMd = docsToMarkdown(doc, { agentFilter: 'planner' });
    expect(plannerMd).toContain("Planner's section");
    expect(plannerMd).toContain('written by planner');
    expect(plannerMd).not.toContain("Coder's section");

    const coderMd = docsToMarkdown(doc, { agentFilter: 'coder' });
    expect(coderMd).toContain("Coder's section");
    expect(coderMd).toContain('written by coder');
    expect(coderMd).not.toContain("Planner's section");
  });

  it('includes attribution markers when requested', () => {
    const doc = loadFixture('attributed-doc.json');
    const md = docsToMarkdown(doc, { includeAttribution: true });

    expect(md).toContain('<!-- agent:planner -->');
    expect(md).toContain('<!-- agent:coder -->');
  });

  it('handles empty document', () => {
    const doc = {
      documentId: 'empty',
      title: 'Empty',
      body: { content: [] },
      namedRanges: {},
      lists: {},
      inlineObjects: {},
    };
    const md = docsToMarkdown(doc);
    expect(md).toBe('\n');
  });

  it('returns empty for unknown agent filter', () => {
    const doc = loadFixture('attributed-doc.json');
    const md = docsToMarkdown(doc, { agentFilter: 'unknown-agent' });
    expect(md.trim()).toBe('');
  });
});
