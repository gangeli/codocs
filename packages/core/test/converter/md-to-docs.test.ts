import { describe, it, expect, vi } from 'vitest';
import { markdownToDocsRequests, markdownToDocsRequestsAsync } from '../../src/converter/md-to-docs.js';

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

    // Range correctness: "My Title" is inserted at index 1 (length 8), so the
    // paragraph-style range should cover the heading plus its implicit
    // paragraph-terminator newline: [1, 1 + 8 + 1) = [1, 10).
    const range = paraStyle!.updateParagraphStyle!.range!;
    expect(range.startIndex).toBe(1);
    expect(range.endIndex).toBe(10);
  });

  it('converts h2 and h3', () => {
    const { text, requests } = markdownToDocsRequests('## Sub\n\n### Sub-sub');
    expect(text).toBe('Sub\nSub-sub');

    const paraStyles = requests.filter((r) => r.updateParagraphStyle);
    const types = paraStyles.map(
      (r) => r.updateParagraphStyle!.paragraphStyle!.namedStyleType,
    );
    expect(types).toContain('HEADING_2');
    expect(types).toContain('HEADING_3');

    // Range correctness: H2 covers "Sub\n" at [1, 5); H3 covers "Sub-sub"
    // (plus its implicit paragraph terminator) at [5, 13).
    const h2 = paraStyles.find(
      (r) => r.updateParagraphStyle!.paragraphStyle!.namedStyleType === 'HEADING_2',
    )!;
    const h3 = paraStyles.find(
      (r) => r.updateParagraphStyle!.paragraphStyle!.namedStyleType === 'HEADING_3',
    )!;
    expect(h2.updateParagraphStyle!.range!.startIndex).toBe(1);
    expect(h2.updateParagraphStyle!.range!.endIndex).toBe(5);
    expect(h3.updateParagraphStyle!.range!.startIndex).toBe(5);
    expect(h3.updateParagraphStyle!.range!.endIndex).toBe(13);
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
    // Range correctness: "italic" starts at offset 6 in the plain text; with
    // insertion at index 1 that's [7, 13). Length must be exactly 6.
    const range = italicStyle!.updateTextStyle!.range!;
    expect(range.startIndex).toBe(7);
    expect(range.endIndex).toBe(13);
    expect(range.endIndex! - range.startIndex!).toBe('italic'.length);
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
    // Range correctness: the Courier range must cover exactly "foo()" — 5
    // characters at text offset 4, i.e. [5, 10) with insertion at index 1.
    const range = codeStyle!.updateTextStyle!.range!;
    expect(range.startIndex).toBe(5);
    expect(range.endIndex).toBe(10);
    expect(range.endIndex! - range.startIndex!).toBe('foo()'.length);
  });

  it('converts a code block', () => {
    const md = '```\nconst x = 1;\n```';
    const { text, requests } = markdownToDocsRequests(md);
    expect(text).toBe('const x = 1;');

    // Courier font style must cover the entire code content (plus its
    // implicit paragraph terminator): "const x = 1;" is 12 chars at index 1,
    // so the range is [1, 14).
    const fontReq = requests.find(
      (r) =>
        r.updateTextStyle?.textStyle?.weightedFontFamily?.fontFamily ===
        'Courier New',
    );
    expect(fontReq).toBeDefined();
    const fontRange = fontReq!.updateTextStyle!.range!;
    expect(fontRange.startIndex).toBe(1);
    expect(fontRange.endIndex).toBe(14);

    // Shading paragraph-style request must cover the same range.
    const shadingReq = requests.find(
      (r) => r.updateParagraphStyle?.paragraphStyle?.shading,
    );
    expect(shadingReq).toBeDefined();
    const shadingRange = shadingReq!.updateParagraphStyle!.range!;
    expect(shadingRange.startIndex).toBe(1);
    expect(shadingRange.endIndex).toBe(14);

    // The code block paragraph must NOT be styled as a heading. Any
    // updateParagraphStyle request whose range overlaps the code block must
    // either have no namedStyleType (current behavior: only `shading`) or
    // explicitly be NORMAL_TEXT.
    const overlapping = requests.filter(
      (r) =>
        r.updateParagraphStyle &&
        r.updateParagraphStyle.range!.startIndex! < 14 &&
        r.updateParagraphStyle.range!.endIndex! > 1,
    );
    for (const ps of overlapping) {
      const nst = ps.updateParagraphStyle!.paragraphStyle!.namedStyleType;
      if (nst !== undefined) {
        expect(nst).toBe('NORMAL_TEXT');
      }
    }
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
    // Range correctness: link covers exactly "click here" — 10 chars at the
    // insertion offset, so [1, 11).
    const range = linkStyle!.updateTextStyle!.range!;
    expect(range.startIndex).toBe(1);
    expect(range.endIndex).toBe(11);
    expect(range.endIndex! - range.startIndex!).toBe('click here'.length);
  });

  it('converts an unordered list', () => {
    const md = '- item one\n- item two\n- item three';
    const { text, requests } = markdownToDocsRequests(md);
    expect(text).toContain('item one');
    expect(text).toContain('item two');
    expect(text).toContain('item three');

    // Each item must appear as a separate paragraph: the inserted text
    // joins them with exactly one newline per paragraph break (no blank
    // lines between bullet items).
    const insert = requests.find((r) => r.insertText);
    expect(insert!.insertText!.text).toBe('item one\nitem two\nitem three');

    const bulletReqs = requests.filter((r) => r.createParagraphBullets);
    expect(bulletReqs.length).toBeGreaterThan(0);
    expect(
      bulletReqs[0].createParagraphBullets!.bulletPreset,
    ).toBe('BULLET_DISC_CIRCLE_SQUARE');

    // The bullet range must span all three items. Inserted text length is
    // "item one\nitem two\nitem three" = 28 chars at index 1; paragraph
    // terminator gives an additional +1 for the last item, so the range
    // should cover [1, 1 + 28) = [1, 29).
    const range = bulletReqs[0].createParagraphBullets!.range!;
    expect(range.startIndex).toBe(1);
    expect(range.endIndex).toBe(29);
  });

  it('converts an ordered list', () => {
    const md = '1. first\n2. second';
    const { text, requests } = markdownToDocsRequests(md);
    expect(text).toBe('first\nsecond');

    const bulletReqs = requests.filter((r) => r.createParagraphBullets);
    expect(bulletReqs.length).toBeGreaterThan(0);
    expect(
      bulletReqs[0].createParagraphBullets!.bulletPreset,
    ).toBe('NUMBERED_DECIMAL_NESTED');

    // Bullet range covers both items: "first\nsecond" is 12 chars at index 1,
    // so [1, 13).
    const range = bulletReqs[0].createParagraphBullets!.range!;
    expect(range.startIndex).toBe(1);
    expect(range.endIndex).toBe(13);
  });

  it('converts a task list (checkboxes) with BULLET_CHECKBOX preset', () => {
    const md = '- [ ] unchecked item\n- [x] checked item\n- [ ] another unchecked';
    const { text, requests } = markdownToDocsRequests(md);
    expect(text).toContain('unchecked item');
    expect(text).toContain('checked item');
    // Adjacent same-preset item ranges are merged into a single request
    // (multiple requests for the same preset would flatten nesting).
    const bulletReqs = requests.filter((r) => r.createParagraphBullets);
    expect(bulletReqs.length).toBe(1);
    expect(bulletReqs[0].createParagraphBullets!.bulletPreset).toBe('BULLET_CHECKBOX');

    // The [x] item — "checked item" — must carry a strikethrough
    // text-style request covering "checked item" plus the list-item
    // paragraph terminator. Docs represents a checked checkbox by
    // striking through the list-item paragraph, and the range the
    // emitter uses is inclusive of the paragraph's '\n' — expected end
    // is 1 + checkedStart + len + 1. The range must NOT cover the
    // preceding "unchecked item" or the following "another unchecked".
    const strikeReq = requests.find(
      (r) => r.updateTextStyle?.textStyle?.strikethrough === true,
    );
    expect(strikeReq).toBeDefined();
    const range = strikeReq!.updateTextStyle!.range!;
    const plain = 'unchecked item\nchecked item\nanother unchecked';
    const checkedStart = plain.indexOf('checked item', plain.indexOf('\n'));
    expect(range.startIndex).toBe(1 + checkedStart);
    expect(range.endIndex).toBe(1 + checkedStart + 'checked item'.length + 1);
  });

  it('uses regular bullet preset for non-checkbox list items', () => {
    const md = '- regular item\n- another item';
    const { requests } = markdownToDocsRequests(md);
    const bulletReqs = requests.filter((r) => r.createParagraphBullets);
    for (const req of bulletReqs) {
      expect(req.createParagraphBullets!.bulletPreset).toBe('BULLET_DISC_CIRCLE_SQUARE');
    }
  });

  it('prepends reset + delete requests when clearFirst is true', () => {
    const { requests } = markdownToDocsRequests('Hello', 1, true, 50);
    // The reset trio must come BEFORE any insertText — anything else
    // would either wipe the just-inserted text or fail to clear the
    // residual style/bullet state on the surviving anchor paragraph.
    // Order within the trio: paragraph-style reset, bullet clear,
    // content delete. (Order of style/bullet doesn't strictly matter
    // for indices, but the documented contract pins it.)
    expect(requests[0].updateParagraphStyle).toBeDefined();
    expect(requests[0].updateParagraphStyle!.range!.startIndex).toBe(1);
    expect(requests[0].updateParagraphStyle!.range!.endIndex).toBe(49);
    expect(
      requests[0].updateParagraphStyle!.paragraphStyle!.namedStyleType,
    ).toBe('NORMAL_TEXT');
    // Field mask must include namedStyleType (the most common leak)
    // and the bullet/heading-related properties.
    const fields = requests[0].updateParagraphStyle!.fields ?? '';
    expect(fields).toContain('namedStyleType');
    expect(fields).toContain('headingId');
    expect(fields).toContain('alignment');
    expect(fields).toContain('indentStart');

    expect(requests[1].deleteParagraphBullets).toBeDefined();
    expect(requests[1].deleteParagraphBullets!.range!.startIndex).toBe(1);
    expect(requests[1].deleteParagraphBullets!.range!.endIndex).toBe(49);

    expect(requests[2].deleteContentRange).toBeDefined();
    expect(requests[2].deleteContentRange!.range!.startIndex).toBe(1);
    expect(requests[2].deleteContentRange!.range!.endIndex).toBe(49);

    // Exactly one delete request — no stray duplicates.
    const deleteReqs = requests.filter((r) => r.deleteContentRange);
    expect(deleteReqs).toHaveLength(1);
    const bulletClears = requests.filter((r) => r.deleteParagraphBullets);
    expect(bulletClears).toHaveLength(1);
  });

  it('emits no reset block when the doc is essentially empty', () => {
    // endIndex === 2 means the doc has only the implicit anchor
    // newline — nothing to clear, and a degenerate [1, 1] range would
    // be rejected by the API. The reset block must not fire.
    const { requests } = markdownToDocsRequests('Hello', 1, true, 2);
    expect(requests.find((r) => r.deleteContentRange)).toBeUndefined();
    expect(requests.find((r) => r.deleteParagraphBullets)).toBeUndefined();
    expect(
      requests.find(
        (r) =>
          r.updateParagraphStyle?.paragraphStyle?.namedStyleType ===
            'NORMAL_TEXT' &&
          r.updateParagraphStyle?.range?.startIndex === 1 &&
          r.updateParagraphStyle?.range?.endIndex === 1,
      ),
    ).toBeUndefined();
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
    const { text, requests } = markdownToDocsRequests(md);
    expect(text).toContain('First paragraph.');
    expect(text).toContain('Second paragraph.');

    // They must appear as two distinct paragraphs. In the Docs API a
    // paragraph break is a single "\n" inside insertText — Docs itself
    // implicitly appends the paragraph terminator. A CommonMark blank line
    // between the two paragraphs should still collapse to exactly one "\n"
    // in the inserted text (two distinct paragraphs, no blank-paragraph
    // between them).
    const insert = requests.find((r) => r.insertText);
    expect(insert!.insertText!.text).toBe('First paragraph.\nSecond paragraph.');

    // And there should be exactly one "\n" separating the two in the insert.
    const parts = insert!.insertText!.text!.split('\n');
    expect(parts).toEqual(['First paragraph.', 'Second paragraph.']);

    // Each paragraph must get its own NORMAL_TEXT paragraph-style request.
    const normals = requests.filter(
      (r) =>
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'NORMAL_TEXT',
    );
    expect(normals.length).toBe(2);
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

  it(
    'applies inline formatting (bold) inside a table cell at the cell range',
    () => {
      // A 2x2 table at index 1 with "**bold**" in cell (1,0). The insertText
      // for that cell lands at the cell's start index; the bold range must
      // fall entirely within the inserted-text span for that cell — NOT in
      // the header row and NOT in a neighboring cell.
      const md = '| A | B |\n| - | - |\n| **bold** | 42 |';
      const { requests } = markdownToDocsRequests(md, 1);

      // Find the data-cell insert carrying "bold" text.
      const boldCellInsert = requests.find(
        (r) => r.insertText && r.insertText.text === 'bold',
      );
      expect(boldCellInsert).toBeDefined();
      const cellStart = boldCellInsert!.insertText!.location!.index!;
      const cellEnd = cellStart + 'bold'.length;

      // There are two bold requests in this fixture: the header "A"/"B"
      // cells (each 1-char range) and the data-cell "bold" (4-char range).
      // We want the one that lands on the data cell, i.e. whose range length
      // is 4. TODAY this returns undefined — the data-cell bold request is
      // never emitted.
      const dataBold = requests.find(
        (r) =>
          r.updateTextStyle?.textStyle?.bold === true &&
          r.updateTextStyle!.range!.endIndex! -
            r.updateTextStyle!.range!.startIndex! ===
            4,
      );
      expect(dataBold).toBeDefined();
      const range = dataBold!.updateTextStyle!.range!;
      expect(range.startIndex).toBe(cellStart);
      expect(range.endIndex).toBe(cellEnd);
    },
  );

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

    // Bullet items are paragraphs — both must get NORMAL_TEXT. Exactly
    // two NORMAL_TEXT requests (one per item), plus exactly one
    // HEADING_1 for the section title.
    const paraStyles = requests.filter((r) => r.updateParagraphStyle);
    const normalStyles = paraStyles.filter(
      (r) => r.updateParagraphStyle!.paragraphStyle!.namedStyleType === 'NORMAL_TEXT',
    );
    expect(normalStyles).toHaveLength(2);
    const headingStyles = paraStyles.filter(
      (r) => r.updateParagraphStyle!.paragraphStyle!.namedStyleType === 'HEADING_1',
    );
    expect(headingStyles).toHaveLength(1);
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

    // Heading range and normal-text range must line up with the offset:
    // inserted text is "Title\nBody." (11 chars). The heading covers
    // "Title\n" at [100, 106); the normal paragraph covers "Body." plus
    // its implicit paragraph terminator at [106, 112).
    const heading = requests.find(
      (r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'HEADING_1',
    );
    const normal = requests.find(
      (r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'NORMAL_TEXT',
    );
    expect(heading).toBeDefined();
    expect(normal).toBeDefined();
    expect(heading!.updateParagraphStyle!.range!.startIndex).toBe(100);
    expect(heading!.updateParagraphStyle!.range!.endIndex).toBe(100 + 'Title\n'.length);
    expect(normal!.updateParagraphStyle!.range!.startIndex).toBe(100 + 'Title\n'.length);
    expect(normal!.updateParagraphStyle!.range!.endIndex).toBe(100 + 'Title\nBody.'.length + 1);
  });

  it('converts text before and after a table', () => {
    const md = 'Before\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nAfter';
    const { text, requests } = markdownToDocsRequests(md);

    // Text segments should contain surrounding text
    expect(text).toContain('Before');
    expect(text).toContain('After');

    // Find the two bookend inserts unambiguously by their text content.
    const beforeInsert = requests.find(
      (r) => r.insertText && r.insertText.text!.startsWith('Before'),
    );
    const afterInsert = requests.find(
      (r) => r.insertText && r.insertText.text === 'After',
    );
    const tableReq = requests.find((r) => r.insertTable);

    expect(beforeInsert).toBeDefined();
    expect(afterInsert).toBeDefined();
    expect(tableReq).toBeDefined();

    // The "Before" insert must land at an index strictly less than both the
    // table location AND the "After" insert. Similarly the "After" insert
    // must come strictly after the table. This is tighter than the old
    // `>= 2` check, which merely counted requests.
    const beforeIdx = beforeInsert!.insertText!.location!.index!;
    const tableIdx = tableReq!.insertTable!.location!.index!;
    const afterIdx = afterInsert!.insertText!.location!.index!;

    expect(beforeIdx).toBeLessThan(tableIdx);
    expect(tableIdx).toBeLessThan(afterIdx);
    expect(beforeIdx).toBeLessThan(afterIdx);
  });

  // ── Unicode range correctness ───────────────────────────────────

  it('bold range over text containing an emoji (🎉) accounts for UTF-16 surrogate pair', () => {
    // Plain-text form: "Party is 🎉 on now". In UTF-16, 🎉 is a surrogate
    // pair of length 2; Google Docs indices use UTF-16 code units. The bold
    // span covers "is 🎉 on" (7 visible chars, 8 UTF-16 code units).
    const md = 'Party **is 🎉 on** now';
    const { text, requests } = markdownToDocsRequests(md);
    expect(text).toBe('Party is 🎉 on now');

    const boldReq = requests.find(
      (r) => r.updateTextStyle?.textStyle?.bold === true,
    );
    expect(boldReq).toBeDefined();

    const range = boldReq!.updateTextStyle!.range!;
    const boldText = 'is 🎉 on';
    const utf16Len = boldText.length; // JS .length is UTF-16 code units
    expect(range.endIndex! - range.startIndex!).toBe(utf16Len);

    // And the range must sit at the text offset of "is 🎉 on" inside the
    // inserted plain text, offset by the insertion index of 1.
    const plain = 'Party is 🎉 on now';
    const boldStart = plain.indexOf(boldText);
    expect(range.startIndex).toBe(1 + boldStart);
    expect(range.endIndex).toBe(1 + boldStart + utf16Len);
  });

  it('bold range over CJK text uses correct indices', () => {
    // CJK characters are single UTF-16 code units; 你好世界 is 4 code units.
    const md = 'Chinese **你好世界** here';
    const { text, requests } = markdownToDocsRequests(md);
    expect(text).toBe('Chinese 你好世界 here');

    const boldReq = requests.find(
      (r) => r.updateTextStyle?.textStyle?.bold === true,
    );
    expect(boldReq).toBeDefined();

    const range = boldReq!.updateTextStyle!.range!;
    expect(range.endIndex! - range.startIndex!).toBe('你好世界'.length);

    const plain = 'Chinese 你好世界 here';
    const boldStart = plain.indexOf('你好世界');
    expect(range.startIndex).toBe(1 + boldStart);
    expect(range.endIndex).toBe(1 + boldStart + '你好世界'.length);
  });

  // ── Nested list ─────────────────────────────────────────────────

  it('emits a 2-level nested bullet list as a single bullet request with tab-indented inner items', () => {
    // Nesting is conveyed to Docs by tab prefixes on the inserted text
    // (combined with a single createParagraphBullets over the whole list);
    // multiple createParagraphBullets requests would flatten nesting.
    const md = '- outer\n  - inner';
    const { text, requests } = markdownToDocsRequests(md);

    // Inner item is prefixed with a tab for level-1 nesting.
    expect(text).toBe('outer\n\tinner');

    const bulletReqs = requests.filter((r) => r.createParagraphBullets);
    expect(bulletReqs).toHaveLength(1);
    expect(bulletReqs[0].createParagraphBullets!.bulletPreset).toBe(
      'BULLET_DISC_CIRCLE_SQUARE',
    );

    // Bullet range must cover both items: "outer\n\tinner" is 12 chars at
    // index 1, so [1, 13).
    const range = bulletReqs[0].createParagraphBullets!.range!;
    expect(range.startIndex).toBe(1);
    expect(range.endIndex).toBe(13);
  });

  // ── Blockquote ──────────────────────────────────────────────────

  it('converts a blockquote to a single-cell table with NORMAL_TEXT paragraph style on the quote', () => {
    const md = '> quoted text';
    const { text, requests } = markdownToDocsRequests(md);
    expect(text).toBe('quoted text');

    // Blockquotes are implemented as a 1x1 table with a coloured left border
    // containing the quote text.
    const tableReq = requests.find((r) => r.insertTable);
    expect(tableReq).toBeDefined();
    expect(tableReq!.insertTable!.rows).toBe(1);
    expect(tableReq!.insertTable!.columns).toBe(1);

    // The quote-cell paragraph must be NORMAL_TEXT (not a heading or other
    // named style).
    const quotePara = requests.find(
      (r) =>
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'NORMAL_TEXT',
    );
    expect(quotePara).toBeDefined();

    // The cell must have a coloured left border (the visual "quote bar").
    const cellStyle = requests.find((r) => r.updateTableCellStyle);
    expect(cellStyle).toBeDefined();
    expect(
      cellStyle!.updateTableCellStyle!.tableCellStyle!.borderLeft,
    ).toBeDefined();
  });

  // ── Horizontal rule ────────────────────────────────────────────

  it('converts a horizontal rule to a visible divider line in the inserted text', () => {
    // HR is rendered as an em-dash run so the visual break survives in
    // plain-text readbacks; the surrounding paragraphs keep NORMAL_TEXT
    // paragraph style.
    const md = 'Before\n\n---\n\nAfter';
    const { text, requests } = markdownToDocsRequests(md);

    // Exactly one insertText request carries all three paragraphs.
    const insert = requests.find((r) => r.insertText);
    expect(insert).toBeDefined();
    expect(insert!.insertText!.text).toBe('Before\n———\nAfter');

    // Exactly two NORMAL_TEXT requests — one for "Before" and one for
    // "After". The HR's em-dash paragraph carries no paragraph-style
    // request today (which is fine: its text is inserted inside the
    // same insertText as the two surrounding paragraphs).
    const normals = requests.filter(
      (r) =>
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'NORMAL_TEXT',
    );
    expect(normals).toHaveLength(2);
  });

  // ── Determinism ────────────────────────────────────────────────

  it('is deterministic: same markdown produces identical requests on repeated calls', () => {
    const md =
      '# Title\n\nBody with **bold** and *italic* and `code`.\n\n' +
      '- one\n- two\n\n' +
      '1. first\n2. second\n\n' +
      '| A | B |\n| - | - |\n| 1 | 2 |\n\n' +
      'After.';
    const a = markdownToDocsRequests(md);
    const b = markdownToDocsRequests(md);
    expect(a.text).toBe(b.text);
    expect(JSON.stringify(a.requests)).toBe(JSON.stringify(b.requests));
  });

  // ── Image embedding ──────────────────────────────────────────

  it('sync path silently drops inline images (async path is required for embedding)', () => {
    const md = 'Before.\n\n![logo](https://example.com/logo.png)\n\nAfter.';
    const { requests } = markdownToDocsRequests(md);
    expect(requests.find((r) => r.insertInlineImage)).toBeUndefined();
  });

  it('async path silently skips unsupported-format images (e.g. .ico) so the batch does not fail', async () => {
    // Real Anthropic favicon is an ICO — image-size probes it successfully
    // but Google Docs only accepts PNG/JPEG/GIF. Skip, don't break the batch.
    const md = 'Before.\n\n![favicon](data:image/x-icon;base64,AAABAAEAEBAAAAAAAABoBQAAFgAAACgAAAAQAAAAIAAAAAEACAAAAAAAAAEAAAAAAAAAAAAAAAEAAAAAAAAAAAAA)\n\nAfter.';
    // Use a trivially-shaped ICO header via data URL. fetch() in Node
    // supports data: URLs so the probe runs without network.
    const driveApi = { uploadTempImage: vi.fn() } as any;

    const result = await markdownToDocsRequestsAsync(md, 1, false, undefined, {
      driveApi,
      documentId: 'doc-1',
    });

    expect(result.requests.find((r) => r.insertInlineImage)).toBeUndefined();
    // Surrounding text must still be inserted.
    const textInserts = result.requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText!.text!)
      .join('');
    expect(textInserts).toContain('Before.');
    expect(textInserts).toContain('After.');
  });

  it('async path embeds a remote image via insertInlineImage with the original URL', async () => {
    // Point the probe at an unreachable URL so we don't hit the network; the
    // fallback skips sizing and still emits the insert request.
    const md = 'Before.\n\n![logo](https://unreachable.invalid/logo.png)\n\nAfter.';
    const driveApi = { uploadTempImage: vi.fn() } as any;

    const result = await markdownToDocsRequestsAsync(md, 1, false, undefined, {
      driveApi,
      documentId: 'doc-1',
    });

    const img = result.requests.find((r) => r.insertInlineImage);
    expect(img).toBeDefined();
    expect(img!.insertInlineImage!.uri).toBe('https://unreachable.invalid/logo.png');
    expect(driveApi.uploadTempImage).not.toHaveBeenCalled();
    expect(result.tempDriveFileIds).toEqual([]);
    expect(result.mermaidImages).toEqual([]);
  });

  it('async path passes the mermaid Drive fileId through so readback can disambiguate', async () => {
    const md = '```mermaid\ngraph TD; A-->B\n```\n';
    // Spy that captures what uploadTempImage returns. Render is mocked too so
    // we don't depend on a real mermaid/resvg binary in unit tests.
    const fakeDrive = {
      uploadTempImage: vi.fn(async (_buf: Buffer, name: string) => ({
        fileId: 'DRIVE_ID_123',
        downloadUrl: `https://drive.google.com/uc?id=DRIVE_ID_123&name=${name}`,
      })),
    } as any;

    const mermaidMod = await import('../../src/converter/mermaid-renderer.js');
    const renderSpy = vi.spyOn(mermaidMod, 'renderMermaidToPng').mockResolvedValue({
      png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      width: 800,
      height: 400,
    });

    try {
      const result = await markdownToDocsRequestsAsync(md, 1, false, undefined, {
        driveApi: fakeDrive,
        documentId: 'doc-1',
      });

      expect(result.mermaidImages).toHaveLength(1);
      expect(result.mermaidImages[0].fileId).toBe('DRIVE_ID_123');
      expect(result.tempDriveFileIds).toEqual(['DRIVE_ID_123']);

      const img = result.requests.find((r) => r.insertInlineImage);
      expect(img).toBeDefined();
      expect(img!.insertInlineImage!.uri).toContain('id=DRIVE_ID_123');
      expect(img!.insertInlineImage!.objectSize!.width!.unit).toBe('PT');
    } finally {
      renderSpy.mockRestore();
    }
  });
});
