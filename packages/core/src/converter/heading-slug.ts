/**
 * Slugify a heading's text into a GitHub-style fragment identifier.
 *
 * Lowercase, strip punctuation, collapse whitespace/separator runs into
 * single hyphens. Matches the slug produced by GitHub's Markdown renderer
 * so that `[text](#my-heading)` works both on GitHub and after round-trip
 * through Google Docs.
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/**
 * Extract the leading section number (e.g. "3", "3.5", "3.5.1") from a
 * heading's text, if it begins with one. Supports both `3.` and `3 ` forms.
 */
export function extractSectionNumber(text: string): string | null {
  const m = /^\s*(\d+(?:\.\d+)*)\.?\s/.exec(text);
  return m ? m[1] : null;
}

/**
 * Scan a run of text for `§N`, `§N.M`, ... references, returning each
 * match's offset, length, and the section number. Does not match `§foo`.
 */
export function findSectionReferences(
  text: string,
): Array<{ offset: number; length: number; section: string }> {
  const results: Array<{ offset: number; length: number; section: string }> = [];
  const re = /§(\d+(?:\.\d+)*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push({ offset: m.index, length: m[0].length, section: m[1] });
  }
  return results;
}
