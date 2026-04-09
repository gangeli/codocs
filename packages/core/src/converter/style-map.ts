import type { docs_v1 } from 'googleapis';

/** Maps markdown heading depth (1–6) to Google Docs named style. */
export function headingDepthToNamedStyle(
  depth: number,
): docs_v1.Schema$ParagraphStyle['namedStyleType'] {
  const map: Record<number, string> = {
    1: 'HEADING_1',
    2: 'HEADING_2',
    3: 'HEADING_3',
    4: 'HEADING_4',
    5: 'HEADING_5',
    6: 'HEADING_6',
  };
  return map[depth] ?? 'NORMAL_TEXT';
}

/** Maps Google Docs named style to markdown heading depth. Returns 0 for non-headings. */
export function namedStyleToHeadingDepth(
  style: string | null | undefined,
): number {
  const map: Record<string, number> = {
    HEADING_1: 1,
    HEADING_2: 2,
    HEADING_3: 3,
    HEADING_4: 4,
    HEADING_5: 5,
    HEADING_6: 6,
    TITLE: 1,
    SUBTITLE: 2,
  };
  return style ? (map[style] ?? 0) : 0;
}

/** Detect if a font family indicates monospace / code. */
export function isMonospaceFont(fontFamily: string | null | undefined): boolean {
  if (!fontFamily) return false;
  const mono = [
    'courier new',
    'courier',
    'consolas',
    'menlo',
    'monaco',
    'roboto mono',
    'source code pro',
    'fira code',
    'jetbrains mono',
  ];
  return mono.includes(fontFamily.toLowerCase());
}

/** The font family we apply for code in Google Docs. */
export const CODE_FONT_FAMILY = 'Courier New';

/** Background color for code blocks. */
export const CODE_BLOCK_BG: docs_v1.Schema$OptionalColor = {
  color: {
    rgbColor: { red: 0.95, green: 0.95, blue: 0.95 },
  },
};
