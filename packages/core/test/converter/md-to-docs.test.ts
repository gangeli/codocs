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

  it('table cell inserts use correct indices (tableStart + 1 offset)', () => {
    // Google Docs insertTable at index N creates the table structure starting
    // at N+1. Cell content indices must be relative to N+1, not N.
    // A 2x2 table inserted at index 1 should have:
    //   Cell(0,0) at 1+1+3+0 = 5
    //   Cell(0,1) at 1+1+3+2 = 7
    //   Cell(1,0) at 1+1+3+5 = 10
    //   Cell(1,1) at 1+1+3+7 = 12
    const md = '| A | B |\n| - | - |\n| C | D |';
    const { requests } = markdownToDocsRequests(md, 1);

    const cellInserts = requests.filter((r) => r.insertText);
    const cellByText = (t: string) => cellInserts.find((r) => r.insertText!.text === t);

    expect(cellByText('A')!.insertText!.location!.index).toBe(5);
    expect(cellByText('B')!.insertText!.location!.index).toBe(7);
    expect(cellByText('C')!.insertText!.location!.index).toBe(10);
    expect(cellByText('D')!.insertText!.location!.index).toBe(12);
  });

  it('converts a markdown table to an insertTable request', () => {
    const md = '| Name | Value |\n| --- | --- |\n| foo | 42 |';
    const { requests } = markdownToDocsRequests(md);

    // Should have an insertTable request
    const tableReq = requests.find((r) => r.insertTable);
    expect(tableReq).toBeDefined();
    expect(tableReq!.insertTable!.rows).toBe(2);
    expect(tableReq!.insertTable!.columns).toBe(2);
    expect(tableReq!.insertTable!.location!.index).toBe(1);

    // Should have insertText requests for cell content
    const cellInserts = requests.filter(
      (r) => r.insertText && r.insertText !== tableReq?.insertText,
    );
    const cellTexts = cellInserts.map((r) => r.insertText!.text);
    expect(cellTexts).toContain('Name');
    expect(cellTexts).toContain('Value');
    expect(cellTexts).toContain('foo');
    expect(cellTexts).toContain('42');

    // Should have header row styling (bold + background)
    const boldReq = requests.find(
      (r) => r.updateTextStyle?.textStyle?.bold === true,
    );
    expect(boldReq).toBeDefined();

    const headerBgReq = requests.find((r) => r.updateTableCellStyle);
    expect(headerBgReq).toBeDefined();
    expect(
      headerBgReq!.updateTableCellStyle!.tableRange!.tableCellLocation!.rowIndex,
    ).toBe(0);

    // Should have column width requests
    const colWidthReqs = requests.filter((r) => r.updateTableColumnProperties);
    expect(colWidthReqs).toHaveLength(2);
  });

  // ── Style inheritance / reset tests ───────────────────────────

  it('resets paragraph style to NORMAL_TEXT after a heading', () => {
    const md = '# Title\n\nNormal paragraph here.';
    const { requests } = markdownToDocsRequests(md);

    const paraStyles = requests.filter((r) => r.updateParagraphStyle);
    const types = paraStyles.map(
      (r) => r.updateParagraphStyle!.paragraphStyle!.namedStyleType,
    );

    // Should have HEADING_1 for the title AND NORMAL_TEXT for the paragraph
    expect(types).toContain('HEADING_1');
    expect(types).toContain('NORMAL_TEXT');
  });

  it('every non-heading paragraph gets NORMAL_TEXT style', () => {
    const md = '## Heading\n\nParagraph one.\n\nParagraph two.\n\n### Another\n\nParagraph three.';
    const { requests } = markdownToDocsRequests(md);

    const paraStyles = requests.filter((r) => r.updateParagraphStyle);
    const normalCount = paraStyles.filter(
      (r) => r.updateParagraphStyle!.paragraphStyle!.namedStyleType === 'NORMAL_TEXT',
    ).length;

    // Three normal paragraphs should each get NORMAL_TEXT
    expect(normalCount).toBe(3);
  });

  it('NORMAL_TEXT range does not overlap heading range', () => {
    const md = '# Title\n\nBody text.';
    const { requests } = markdownToDocsRequests(md);

    const paraStyles = requests.filter((r) => r.updateParagraphStyle);
    const heading = paraStyles.find(
      (r) => r.updateParagraphStyle!.paragraphStyle!.namedStyleType === 'HEADING_1',
    );
    const normal = paraStyles.find(
      (r) => r.updateParagraphStyle!.paragraphStyle!.namedStyleType === 'NORMAL_TEXT',
    );

    expect(heading).toBeDefined();
    expect(normal).toBeDefined();

    const headingEnd = heading!.updateParagraphStyle!.range!.endIndex!;
    const normalStart = normal!.updateParagraphStyle!.range!.startIndex!;

    // Normal paragraph should start at or after the heading ends
    expect(normalStart).toBeGreaterThanOrEqual(headingEnd);
  });

  it('plain text without headings still gets NORMAL_TEXT style', () => {
    const md = 'Just a simple paragraph.';
    const { requests } = markdownToDocsRequests(md);

    const normalStyle = requests.find(
      (r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'NORMAL_TEXT',
    );
    expect(normalStyle).toBeDefined();
  });

  it('list items get NORMAL_TEXT so they do not inherit heading style', () => {
    const md = '# Section\n\n- item one\n- item two';
    const { requests } = markdownToDocsRequests(md);

    // Bullet items are paragraphs — should get NORMAL_TEXT
    const paraStyles = requests.filter((r) => r.updateParagraphStyle);
    const normalStyles = paraStyles.filter(
      (r) => r.updateParagraphStyle!.paragraphStyle!.namedStyleType === 'NORMAL_TEXT',
    );
    // At least 2 NORMAL_TEXT for the two list items
    expect(normalStyles.length).toBeGreaterThanOrEqual(2);
  });

  it('bold/italic inside a paragraph does not bleed to adjacent text', () => {
    const md = 'normal **bold** normal';
    const { text, requests } = markdownToDocsRequests(md);
    expect(text).toBe('normal bold normal');

    const boldStyle = requests.find(
      (r) => r.updateTextStyle?.textStyle?.bold === true,
    );
    expect(boldStyle).toBeDefined();

    // Bold should only cover "bold" (indices 7-11 at insertion offset 1)
    const start = boldStyle!.updateTextStyle!.range!.startIndex!;
    const end = boldStyle!.updateTextStyle!.range!.endIndex!;
    expect(end - start).toBe(4); // "bold" is 4 chars
  });

  it('insertion at non-default offset applies correct ranges', () => {
    const md = '# Title\n\nBody.';
    const { requests } = markdownToDocsRequests(md, 100);

    const insert = requests.find((r) => r.insertText);
    expect(insert!.insertText!.location!.index).toBe(100);

    // All paragraph style ranges should be offset by 100
    const paraStyles = requests.filter((r) => r.updateParagraphStyle);
    for (const ps of paraStyles) {
      expect(ps.updateParagraphStyle!.range!.startIndex!).toBeGreaterThanOrEqual(100);
    }
  });

  it('converts text before and after a table', () => {
    const md = 'Before\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nAfter';
    const { text, requests } = markdownToDocsRequests(md);

    // Text segments should contain surrounding text
    expect(text).toContain('Before');
    expect(text).toContain('After');

    // Should have both insertText (for text) and insertTable (for table)
    const textInserts = requests.filter(
      (r) => r.insertText && !r.insertTable,
    );
    const tableInserts = requests.filter((r) => r.insertTable);
    expect(textInserts.length).toBeGreaterThanOrEqual(2); // "Before\n" + cell inserts + "After"
    expect(tableInserts).toHaveLength(1);
  });
});
