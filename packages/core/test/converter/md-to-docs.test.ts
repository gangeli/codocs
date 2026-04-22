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
    // There must be EXACTLY one strikethrough request in this fixture:
    // only the `[x]` item carries strikethrough. Using `.filter(...)`
    // with `.toHaveLength(1)` instead of `.find(...)` catches the case
    // where the writer accidentally emits a strikethrough for unchecked
    // items too (which would silently be the first match and slip past
    // the range checks).
    const strikeReqs = requests.filter(
      (r) => r.updateTextStyle?.textStyle?.strikethrough === true,
    );
    expect(strikeReqs).toHaveLength(1);
    const range = strikeReqs[0].updateTextStyle!.range!;
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
    expect(requests[0].updateParagraphStyle).toBeDefined();
    expect(requests[0].updateParagraphStyle!.range!.startIndex).toBe(1);
    expect(requests[0].updateParagraphStyle!.range!.endIndex).toBe(49);
    expect(
      requests[0].updateParagraphStyle!.paragraphStyle!.namedStyleType,
    ).toBe('NORMAL_TEXT');
    const expectedFields =
      'namedStyleType,direction,alignment,' +
      'indentStart,indentEnd,indentFirstLine,' +
      'spaceAbove,spaceBelow,lineSpacing,spacingMode,' +
      'keepWithNext,keepLinesTogether,avoidWidowAndOrphan';
    expect(requests[0].updateParagraphStyle!.fields).toBe(expectedFields);
    const fieldList = expectedFields.split(',');
    expect(fieldList).toContain('namedStyleType');
    expect(fieldList).toContain('direction');
    expect(fieldList).toContain('alignment');
    expect(fieldList).toContain('indentStart');
    expect(fieldList).toContain('indentEnd');
    expect(fieldList).toContain('indentFirstLine');
    expect(fieldList).toContain('spaceAbove');
    expect(fieldList).toContain('spaceBelow');
    expect(fieldList).toContain('lineSpacing');
    expect(fieldList).toContain('spacingMode');
    expect(fieldList).toContain('keepWithNext');
    expect(fieldList).toContain('keepLinesTogether');
    expect(fieldList).toContain('avoidWidowAndOrphan');
    expect(fieldList).not.toContain('headingId');
    expect(fieldList).not.toContain('shading');
    expect(fieldList).not.toContain('pageBreakBefore');
    expect(fieldList).not.toContain('borderTop');
    expect(fieldList).not.toContain('borderBottom');
    expect(fieldList).not.toContain('borderLeft');
    expect(fieldList).not.toContain('borderRight');
    expect(fieldList).not.toContain('tabStops');

    expect(requests[1].deleteParagraphBullets).toBeDefined();
    expect(requests[1].deleteParagraphBullets!.range!.startIndex).toBe(1);
    expect(requests[1].deleteParagraphBullets!.range!.endIndex).toBe(49);

    expect(requests[2].deleteContentRange).toBeDefined();
    expect(requests[2].deleteContentRange!.range!.startIndex).toBe(1);
    expect(requests[2].deleteContentRange!.range!.endIndex).toBe(49);

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

  it('emits a reset block when the doc has one non-empty paragraph (endIndex=3)', () => {
    // endIndex === 3 means a single 1-character paragraph exists
    // (content from [1, 2) plus trailing newline at [2, 3)). The reset
    // block MUST fire with range [1, 2) so the anchor paragraph is
    // cleared of prior styling/bullets before the new content goes in.
    const { requests } = markdownToDocsRequests('Hello', 1, true, 3);
    const resetStyle = requests.find(
      (r) =>
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType ===
          'NORMAL_TEXT' &&
        r.updateParagraphStyle?.range?.startIndex === 1 &&
        r.updateParagraphStyle?.range?.endIndex === 2,
    );
    expect(resetStyle).toBeDefined();
    const bulletReset = requests.find(
      (r) =>
        r.deleteParagraphBullets?.range?.startIndex === 1 &&
        r.deleteParagraphBullets?.range?.endIndex === 2,
    );
    expect(bulletReset).toBeDefined();
    const contentDelete = requests.find(
      (r) =>
        r.deleteContentRange?.range?.startIndex === 1 &&
        r.deleteContentRange?.range?.endIndex === 2,
    );
    expect(contentDelete).toBeDefined();
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

  it('3x3 table cell inserts use correct indices (row stride = 2*C + 1)', () => {
    // Inserts emit in reverse row-major order, so each inserted cell sees
    // zero preceding content. Index = tableStart + 3 + row * (2*C + 1) + 2*col
    // with tableStart = 2 (table inserted at index 1, +1 table-header offset).
    // For C = 3: row stride = 7.
    //   Row 0:  5,  7,  9
    //   Row 1: 12, 14, 16
    //   Row 2: 19, 21, 23
    // A regression where stride = 2*C (=6) would place row 1 at 11 and row 2
    // at 17 — caught directly by these assertions.
    const md = '| a | b | c |\n| - | - | - |\n| d | e | f |\n| g | h | i |';
    const { requests } = markdownToDocsRequests(md, 1);

    const cellInserts = requests.filter((r) => r.insertText);
    const cellByText = (t: string) => cellInserts.find((r) => r.insertText!.text === t);

    expect(cellByText('a')!.insertText!.location!.index).toBe(5);
    expect(cellByText('b')!.insertText!.location!.index).toBe(7);
    expect(cellByText('c')!.insertText!.location!.index).toBe(9);
    expect(cellByText('d')!.insertText!.location!.index).toBe(12);
    expect(cellByText('e')!.insertText!.location!.index).toBe(14);
    expect(cellByText('f')!.insertText!.location!.index).toBe(16);
    expect(cellByText('g')!.insertText!.location!.index).toBe(19);
    expect(cellByText('h')!.insertText!.location!.index).toBe(21);
    expect(cellByText('i')!.insertText!.location!.index).toBe(23);
  });

  it('converts a markdown table to an insertTable request', () => {
    const md = '| Name | Value |\n| --- | --- |\n| foo | 42 |';
    const { requests } = markdownToDocsRequests(md);

    const tableReq = requests.find((r) => r.insertTable);
    expect(tableReq).toBeDefined();
    expect(tableReq!.insertTable!.rows).toBe(2);
    expect(tableReq!.insertTable!.columns).toBe(2);
    expect(tableReq!.insertTable!.location!.index).toBe(1);
    const tableStart = tableReq!.insertTable!.location!.index! + 1;

    const cellInserts = requests.filter(
      (r) => r.insertText && r.insertText !== tableReq?.insertText,
    );
    const cellTexts = cellInserts.map((r) => r.insertText!.text);
    expect(cellTexts).toContain('Name');
    expect(cellTexts).toContain('Value');
    expect(cellTexts).toContain('foo');
    expect(cellTexts).toContain('42');

    const MIN_COL_WIDTH_PT = 60;
    const SHORT_VALUE_THRESHOLD = 10;
    const THICK_MAGNITUDE = 2;
    const THIN_MAGNITUDE = 1;
    const R = 2;
    const C = 2;
    const rows = [
      ['Name', 'Value'],
      ['foo', '42'],
    ];
    const cellIndex = (row: number, col: number): number => {
      let idx = tableStart + 3 + row * (2 * C + 1) + 2 * col;
      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < C; c++) {
          if (r < row || (r === row && c < col)) {
            idx += (rows[r][c] ?? '').length;
          }
        }
      }
      return idx;
    };

    const cellStyleReqs = requests.filter((r) => r.updateTableCellStyle);

    const topRuleReq = cellStyleReqs.find(
      (r) =>
        r.updateTableCellStyle!.fields === 'borderTop' &&
        r.updateTableCellStyle!.tableCellStyle?.borderTop?.width?.magnitude ===
          THICK_MAGNITUDE &&
        r.updateTableCellStyle!.tableRange!.tableCellLocation!.rowIndex === 0,
    );
    expect(topRuleReq).toBeDefined();
    expect(topRuleReq!.updateTableCellStyle!.tableRange!.rowSpan).toBe(1);
    expect(topRuleReq!.updateTableCellStyle!.tableRange!.columnSpan).toBe(C);

    const thinHeaderRuleReq = cellStyleReqs.find(
      (r) =>
        r.updateTableCellStyle!.fields === 'borderBottom' &&
        r.updateTableCellStyle!.tableCellStyle?.borderBottom?.width?.magnitude ===
          THIN_MAGNITUDE &&
        r.updateTableCellStyle!.tableRange!.tableCellLocation!.rowIndex === 0,
    );
    expect(thinHeaderRuleReq).toBeDefined();
    expect(thinHeaderRuleReq!.updateTableCellStyle!.tableRange!.rowSpan).toBe(1);
    expect(thinHeaderRuleReq!.updateTableCellStyle!.tableRange!.columnSpan).toBe(
      C,
    );

    const bottomRuleReq = cellStyleReqs.find(
      (r) =>
        r.updateTableCellStyle!.fields === 'borderBottom' &&
        r.updateTableCellStyle!.tableCellStyle?.borderBottom?.width?.magnitude ===
          THICK_MAGNITUDE &&
        r.updateTableCellStyle!.tableRange!.tableCellLocation!.rowIndex ===
          R - 1,
    );
    expect(bottomRuleReq).toBeDefined();
    expect(bottomRuleReq!.updateTableCellStyle!.tableRange!.rowSpan).toBe(1);
    expect(bottomRuleReq!.updateTableCellStyle!.tableRange!.columnSpan).toBe(C);

    const vertSuppressReq = cellStyleReqs.find(
      (r) =>
        r.updateTableCellStyle!.fields === 'borderLeft,borderRight' &&
        r.updateTableCellStyle!.tableCellStyle?.borderLeft?.width?.magnitude ===
          0 &&
        r.updateTableCellStyle!.tableCellStyle?.borderRight?.width?.magnitude ===
          0,
    );
    expect(vertSuppressReq).toBeDefined();
    expect(vertSuppressReq!.updateTableCellStyle!.tableRange!.rowSpan).toBe(R);
    expect(vertSuppressReq!.updateTableCellStyle!.tableRange!.columnSpan).toBe(
      C,
    );

    const innerTopSuppressReq = cellStyleReqs.find(
      (r) =>
        r.updateTableCellStyle!.fields === 'borderTop' &&
        r.updateTableCellStyle!.tableCellStyle?.borderTop?.width?.magnitude ===
          0 &&
        r.updateTableCellStyle!.tableRange!.tableCellLocation!.rowIndex === 1,
    );
    expect(innerTopSuppressReq).toBeDefined();

    const innerBottomSuppressReq = cellStyleReqs.find(
      (r) =>
        r.updateTableCellStyle!.fields === 'borderBottom' &&
        r.updateTableCellStyle!.tableCellStyle?.borderBottom?.width?.magnitude ===
          0 &&
        r.updateTableCellStyle!.tableRange!.tableCellLocation!.rowIndex === 0 &&
        r.updateTableCellStyle!.tableRange!.rowSpan === R - 1,
    );
    expect(innerBottomSuppressReq).toBeDefined();

    const nameCellIdx = cellIndex(0, 0);
    const valueCellIdx = cellIndex(0, 1);
    const boldReqs = requests.filter(
      (r) => r.updateTextStyle?.textStyle?.bold === true,
    );
    const nameBold = boldReqs.find(
      (r) =>
        r.updateTextStyle!.range!.startIndex === nameCellIdx &&
        r.updateTextStyle!.range!.endIndex === nameCellIdx + 'Name'.length,
    );
    const valueBold = boldReqs.find(
      (r) =>
        r.updateTextStyle!.range!.startIndex === valueCellIdx &&
        r.updateTextStyle!.range!.endIndex === valueCellIdx + 'Value'.length,
    );
    expect(nameBold).toBeDefined();
    expect(valueBold).toBeDefined();
    expect(boldReqs).toHaveLength(2);

    const colWidthReqs = requests.filter((r) => r.updateTableColumnProperties);
    expect(colWidthReqs).toHaveLength(C);
    for (const w of colWidthReqs) {
      const mag = w.updateTableColumnProperties!.tableColumnProperties!.width!
        .magnitude!;
      expect(mag).toBeGreaterThanOrEqual(MIN_COL_WIDTH_PT);
    }

    for (let c = 0; c < C; c++) {
      const isShort = rows.every(
        (row) => (row[c] ?? '').length <= SHORT_VALUE_THRESHOLD,
      );
      if (!isShort) continue;
      for (let r = 0; r < R; r++) {
        const cellContentIndex = cellIndex(r, c);
        const cellText = rows[r][c];
        const centerReq = requests.find(
          (req) =>
            req.updateParagraphStyle?.paragraphStyle?.alignment === 'CENTER' &&
            req.updateParagraphStyle.range?.startIndex === cellContentIndex &&
            req.updateParagraphStyle.range?.endIndex ===
              cellContentIndex + cellText.length + 1,
        );
        expect(centerReq).toBeDefined();
      }
    }
  });

  it(
    'applies inline formatting (bold) inside a table cell at the cell range',
    () => {
      const md = '| A | B |\n| - | - |\n| **bold** | 42 |';
      const { requests } = markdownToDocsRequests(md, 1);

      // Find the data-cell insert carrying "bold" text.
      const boldCellInsert = requests.find(
        (r) => r.insertText && r.insertText.text === 'bold',
      );
      expect(boldCellInsert).toBeDefined();
      const insertIdx = boldCellInsert!.insertText!.location!.index!;
      const earlierCellsTextLen = 'A'.length + 'B'.length;
      const expectedCellStart = insertIdx + earlierCellsTextLen;
      const expectedCellEnd = expectedCellStart + 'bold'.length;

      // There are three bold requests in this fixture: the two header
      // cells (A, B — each 1-char range) and the data-cell "bold"
      // (4-char range). We want the one whose range length is 4.
      const dataBold = requests.find(
        (r) =>
          r.updateTextStyle?.textStyle?.bold === true &&
          r.updateTextStyle!.range!.endIndex! -
            r.updateTextStyle!.range!.startIndex! ===
            4,
      );
      expect(dataBold).toBeDefined();
      const range = dataBold!.updateTextStyle!.range!;
      expect(range.startIndex).toBe(expectedCellStart);
      expect(range.endIndex).toBe(expectedCellEnd);

      // Header-row bold requests (for "A" and "B") must have ranges
      // DISTINCT from each other and from the data-cell "bold" range.
      // Collect every bold-true request, assert there are exactly
      // three, and assert all three start indices are unique.
      const allBolds = requests.filter(
        (r) => r.updateTextStyle?.textStyle?.bold === true,
      );
      expect(allBolds).toHaveLength(3);
      const boldStarts = allBolds.map(
        (r) => r.updateTextStyle!.range!.startIndex!,
      );
      expect(new Set(boldStarts).size).toBe(3);

      // The three bold ranges must have lengths {1, 1, 4}: two 1-char
      // header cells ("A","B") and one 4-char data cell ("bold"). No
      // bold request with length 2 (matching the non-bold "42" cell)
      // can exist.
      const boldLens = allBolds
        .map(
          (r) =>
            r.updateTextStyle!.range!.endIndex! -
            r.updateTextStyle!.range!.startIndex!,
        )
        .sort();
      expect(boldLens).toEqual([1, 1, 4]);
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

    const normalStyles = requests.filter(
      (r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'NORMAL_TEXT',
    );
    expect(normalStyles).toHaveLength(1);
    // One paragraph inserted at index 1 with `md.length` content chars;
    // the paragraph's paragraph-style range covers [1, 1 + length + 1) =
    // start of the inserted text through (and including) the paragraph's
    // implicit terminator newline.
    const range = normalStyles[0].updateParagraphStyle!.range!;
    expect(range.startIndex).toBe(1);
    expect(range.endIndex).toBe(1 + md.length + 1);
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

    // Exact index computation. "Before\n" (length 7) is inserted at
    // index 1, so the table's insertTable lands at 1 + 7 = 8.
    // insertTable at N pushes content right by 1, so tableStart = 9.
    // Table structure size for R=2, C=2 is 2 + R + 2*R*C = 12.
    // Cell text lengths sum to |A|+|B|+|1|+|2| = 4.
    // afterIdx = tableInsertIdx + tableStructureSize + totalCellText + 1
    //          = 8 + 12 + 4 + 1 = 25.
    const beforeIdx = beforeInsert!.insertText!.location!.index!;
    const tableIdx = tableReq!.insertTable!.location!.index!;
    const afterIdx = afterInsert!.insertText!.location!.index!;

    expect(beforeIdx).toBe(1);
    expect(tableIdx).toBe(1 + 'Before\n'.length);

    const R = 2;
    const C = 2;
    const tableStructureSize = 2 + R + 2 * R * C;
    const totalCellText = 'A'.length + 'B'.length + '1'.length + '2'.length;
    const expectedAfterIdx = tableIdx + tableStructureSize + totalCellText + 1;
    expect(expectedAfterIdx).toBe(25);
    expect(afterIdx).toBe(expectedAfterIdx);
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

    // The cell must have a coloured left border (the visual "quote bar")
    // of exactly 3pt gray (0.6,0.6,0.6), plus invisible top/right/bottom
    // borders.
    const cellStyle = requests.find((r) => r.updateTableCellStyle);
    expect(cellStyle).toBeDefined();
    const style = cellStyle!.updateTableCellStyle!.tableCellStyle!;
    expect(style.borderLeft!.width!.magnitude).toBe(3);
    expect(style.borderLeft!.color!.color!.rgbColor).toEqual({
      red: 0.6,
      green: 0.6,
      blue: 0.6,
    });
    expect(style.borderTop!.width!.magnitude).toBe(0);
    expect(style.borderRight!.width!.magnitude).toBe(0);
    expect(style.borderBottom!.width!.magnitude).toBe(0);
  });

  // ── Horizontal rule ────────────────────────────────────────────

  it('converts a horizontal rule to a visible divider line in the inserted text', () => {
    // HR is rendered as an em-dash run so the visual break survives in
    // plain-text readbacks; the surrounding paragraphs keep NORMAL_TEXT
    // paragraph style. The HR paragraph itself ALSO gets NORMAL_TEXT so
    // it doesn't inherit whatever style came before the insertion point.
    const md = 'Before\n\n---\n\nAfter';
    const { text, requests } = markdownToDocsRequests(md, 1);

    // Exactly one insertText request carries all three paragraphs.
    const insert = requests.find((r) => r.insertText);
    expect(insert).toBeDefined();
    expect(insert!.insertText!.text).toBe('Before\n———\nAfter');

    // Three NORMAL_TEXT requests — one for "Before", one for the HR body
    // ("———\n"), and one for "After".
    const normals = requests.filter(
      (r) =>
        r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'NORMAL_TEXT',
    );
    expect(normals).toHaveLength(3);

    // The HR's NORMAL_TEXT range must cover the "———\n" body. The
    // insertText starts at index 1, "Before\n" is 7 chars, so the HR
    // range is [8, 12) (4 chars: three em-dashes plus \n).
    const hrStart = 1 + 'Before\n'.length;
    const hrEnd = hrStart + '———\n'.length;
    const hrNormal = normals.find(
      (r) =>
        r.updateParagraphStyle!.range!.startIndex === hrStart &&
        r.updateParagraphStyle!.range!.endIndex === hrEnd,
    );
    expect(hrNormal).toBeDefined();
    expect(hrNormal!.updateParagraphStyle!.fields).toBe('namedStyleType');
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
    expect(a.requests).toEqual(b.requests);
  });

  it('is deterministic: markdownToDocsRequestsAsync with a mocked drive produces identical requests on repeated calls', async () => {
    // Non-image markdown: the mermaid/image path doesn't fire, so the async
    // output should be fully deterministic (mirrors the sync determinism
    // above). If the mermaid path is ever added to this fixture and this
    // test starts to flake, the mermaid branch has hash/timestamp
    // nondeterminism — isolate it by splitting the fixture.
    const md =
      '# Title\n\nBody with **bold** and *italic* and `code`.\n\n' +
      '- one\n- two\n\n' +
      '1. first\n2. second\n\n' +
      '| A | B |\n| - | - |\n| 1 | 2 |\n\n' +
      'After.';
    const driveApi = { uploadTempImage: vi.fn() } as any;
    const a = await markdownToDocsRequestsAsync(md, 1, false, undefined, {
      driveApi,
      documentId: 'doc-1',
    });
    const b = await markdownToDocsRequestsAsync(md, 1, false, undefined, {
      driveApi,
      documentId: 'doc-1',
    });
    expect(a.text).toBe(b.text);
    expect(a.requests).toEqual(b.requests);
    expect(a.tempDriveFileIds).toEqual(b.tempDriveFileIds);
    expect(a.mermaidImages).toEqual(b.mermaidImages);
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

  it('async path is deterministic for a mermaid block (mocked renderer)', async () => {
    // The mermaid path is the most likely source of non-determinism in the
    // async pipeline because it involves hashing/uploading image bytes.
    // Mock the renderer so we're testing pipeline determinism, not mermaid-cli.
    const md =
      '# T\n\n' +
      '```mermaid\ngraph TD; A-->B\n```\n\n' +
      'Text between.\n\n' +
      '```mermaid\ngraph LR; X-->Y\n```\n';
    const mermaidMod = await import('../../src/converter/mermaid-renderer.js');
    let counter = 0;
    const renderSpy = vi
      .spyOn(mermaidMod, 'renderMermaidToPng')
      .mockImplementation(async () => {
        counter++;
        // Return the SAME bytes regardless of call order so both runs agree.
        return { png: Buffer.from([0x89, 0x50, 0x4e, 0x47]), width: 100, height: 50 };
      });
    let uploadCounter = 0;
    const driveApi = {
      uploadTempImage: vi.fn(async () => {
        uploadCounter++;
        return {
          fileId: `FID_${uploadCounter}`,
          downloadUrl: `https://drive.google.com/uc?id=FID_${uploadCounter}`,
        };
      }),
    } as any;

    try {
      const a = await markdownToDocsRequestsAsync(md, 1, false, undefined, {
        driveApi,
        documentId: 'doc-1',
      });
      // Reset counters so run B uses the same starting IDs as run A did.
      uploadCounter = 0;
      counter = 0;
      const b = await markdownToDocsRequestsAsync(md, 1, false, undefined, {
        driveApi,
        documentId: 'doc-1',
      });
      expect(a.text).toBe(b.text);
      expect(a.requests).toEqual(b.requests);
      expect(a.tempDriveFileIds).toEqual(b.tempDriveFileIds);
      expect(a.mermaidImages).toEqual(b.mermaidImages);
    } finally {
      renderSpy.mockRestore();
    }
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
