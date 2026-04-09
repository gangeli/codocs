import { describe, it, expect } from 'vitest';
import { markdownToDocsRequests } from '../../src/converter/md-to-docs.js';

describe('markdownToDocsRequests', () => {
  it('converts plain text', () => {
    const { text, requests } = markdownToDocsRequests('Hello world');
    expect(text).toBe('Hello world');
    // Should have an insertText request
    const insert = requests.find((r) => r.insertText);
    expect(insert).toBeDefined();
    expect(insert!.insertText!.text).toBe('Hello world');
    expect(insert!.insertText!.location!.index).toBe(1);
  });

  it('converts a heading', () => {
    const { text, requests } = markdownToDocsRequests('# My Title');
    expect(text).toBe('My Title');
    const paraStyle = requests.find((r) => r.updateParagraphStyle);
    expect(paraStyle).toBeDefined();
    expect(
      paraStyle!.updateParagraphStyle!.paragraphStyle!.namedStyleType,
    ).toBe('HEADING_1');
  });

  it('converts h2 and h3', () => {
    const { requests } = markdownToDocsRequests('## Sub\n\n### Sub-sub');
    const paraStyles = requests.filter((r) => r.updateParagraphStyle);
    const types = paraStyles.map(
      (r) => r.updateParagraphStyle!.paragraphStyle!.namedStyleType,
    );
    expect(types).toContain('HEADING_2');
    expect(types).toContain('HEADING_3');
  });

  it('converts bold text', () => {
    const { text, requests } = markdownToDocsRequests('Hello **bold** world');
    expect(text).toBe('Hello bold world');
    const boldStyle = requests.find(
      (r) => r.updateTextStyle?.textStyle?.bold === true,
    );
    expect(boldStyle).toBeDefined();
    // "bold" starts at index 6 in the plain text, offset by insertion index 1
    expect(boldStyle!.updateTextStyle!.range!.startIndex).toBe(7);
    expect(boldStyle!.updateTextStyle!.range!.endIndex).toBe(11);
  });

  it('converts italic text', () => {
    const { text, requests } = markdownToDocsRequests('Hello *italic* world');
    expect(text).toBe('Hello italic world');
    const italicStyle = requests.find(
      (r) => r.updateTextStyle?.textStyle?.italic === true,
    );
    expect(italicStyle).toBeDefined();
  });

  it('converts inline code', () => {
    const { text, requests } = markdownToDocsRequests('Use `foo()` here');
    expect(text).toBe('Use foo() here');
    const codeStyle = requests.find(
      (r) =>
        r.updateTextStyle?.textStyle?.weightedFontFamily?.fontFamily ===
        'Courier New',
    );
    expect(codeStyle).toBeDefined();
  });

  it('converts a code block', () => {
    const md = '```\nconst x = 1;\n```';
    const { text, requests } = markdownToDocsRequests(md);
    expect(text).toContain('const x = 1;');
    // Should have both text style (font) and paragraph style (shading)
    const fontReq = requests.find(
      (r) =>
        r.updateTextStyle?.textStyle?.weightedFontFamily?.fontFamily ===
        'Courier New',
    );
    const shadingReq = requests.find(
      (r) => r.updateParagraphStyle?.paragraphStyle?.shading,
    );
    expect(fontReq).toBeDefined();
    expect(shadingReq).toBeDefined();
  });

  it('converts a link', () => {
    const { text, requests } = markdownToDocsRequests(
      '[click here](https://example.com)',
    );
    expect(text).toBe('click here');
    const linkStyle = requests.find(
      (r) => r.updateTextStyle?.textStyle?.link?.url === 'https://example.com',
    );
    expect(linkStyle).toBeDefined();
  });

  it('converts an unordered list', () => {
    const md = '- item one\n- item two\n- item three';
    const { text, requests } = markdownToDocsRequests(md);
    expect(text).toContain('item one');
    expect(text).toContain('item two');
    const bulletReqs = requests.filter((r) => r.createParagraphBullets);
    expect(bulletReqs.length).toBeGreaterThan(0);
    expect(
      bulletReqs[0].createParagraphBullets!.bulletPreset,
    ).toBe('BULLET_DISC_CIRCLE_SQUARE');
  });

  it('converts an ordered list', () => {
    const md = '1. first\n2. second';
    const { requests } = markdownToDocsRequests(md);
    const bulletReqs = requests.filter((r) => r.createParagraphBullets);
    expect(bulletReqs.length).toBeGreaterThan(0);
    expect(
      bulletReqs[0].createParagraphBullets!.bulletPreset,
    ).toBe('NUMBERED_DECIMAL_NESTED');
  });

  it('prepends a delete request when clearFirst is true', () => {
    const { requests } = markdownToDocsRequests('Hello', 1, true, 50);
    const deleteReq = requests.find((r) => r.deleteContentRange);
    expect(deleteReq).toBeDefined();
    expect(deleteReq!.deleteContentRange!.range!.startIndex).toBe(1);
    expect(deleteReq!.deleteContentRange!.range!.endIndex).toBe(49);
  });

  it('handles empty markdown', () => {
    const { text, requests } = markdownToDocsRequests('');
    expect(text).toBe('');
    // No insertText request for empty content
    const insert = requests.find((r) => r.insertText);
    expect(insert).toBeUndefined();
  });

  it('converts multiple paragraphs', () => {
    const md = 'First paragraph.\n\nSecond paragraph.';
    const { text } = markdownToDocsRequests(md);
    expect(text).toContain('First paragraph.');
    expect(text).toContain('Second paragraph.');
  });

  it('applies custom insertion offset', () => {
    const { requests } = markdownToDocsRequests('Hello', 50);
    const insert = requests.find((r) => r.insertText);
    expect(insert!.insertText!.location!.index).toBe(50);
  });
});
