/**
 * Resolve in-document heading links after a markdown insert.
 *
 * Google Docs auto-generates a `paragraphStyle.headingId` on every heading
 * at insertion time — the client cannot set these IDs directly. So links
 * targeting headings (markdown `#slug` anchors or `§N` section references)
 * must be applied in a second batchUpdate after the doc is re-fetched.
 */

import type { docs_v1 } from 'googleapis';
import type { AbsoluteHeadingLinkRef } from './md-to-docs.js';
import { slugifyHeading, extractSectionNumber } from './heading-slug.js';
import { namedStyleToHeadingDepth } from './style-map.js';

/**
 * Build a lookup from GitHub-style slug and leading section number to the
 * Google Docs auto-generated `headingId` for every heading in the body.
 */
export function buildHeadingIdMap(body: docs_v1.Schema$Body | undefined): {
  bySlug: Map<string, string>;
  bySection: Map<string, string>;
} {
  const bySlug = new Map<string, string>();
  const bySection = new Map<string, string>();
  if (!body?.content) return { bySlug, bySection };

  for (const element of body.content) {
    const para = element.paragraph;
    if (!para) continue;
    if (!namedStyleToHeadingDepth(para.paragraphStyle?.namedStyleType)) continue;
    const headingId = para.paragraphStyle?.headingId;
    if (!headingId) continue;

    let text = '';
    for (const el of para.elements ?? []) {
      if (el.textRun?.content) text += el.textRun.content;
    }
    text = text.replace(/\n$/, '');
    const slug = slugifyHeading(text);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, headingId);
    const section = extractSectionNumber(text);
    if (section && !bySection.has(section)) bySection.set(section, headingId);
  }

  return { bySlug, bySection };
}

/**
 * Given pending heading-target link ranges and a resolved slug→headingId
 * map, produce the updateTextStyle requests for the second batchUpdate.
 * Unresolvable targets are silently skipped (the text stays plain).
 */
export function resolveHeadingLinkRequests(
  links: AbsoluteHeadingLinkRef[],
  idMap: { bySlug: Map<string, string>; bySection: Map<string, string> },
): docs_v1.Schema$Request[] {
  const out: docs_v1.Schema$Request[] = [];
  for (const link of links) {
    const headingId =
      link.target.kind === 'slug'
        ? idMap.bySlug.get(link.target.value)
        : idMap.bySection.get(link.target.value);
    if (!headingId) continue;
    out.push({
      updateTextStyle: {
        range: { startIndex: link.startIndex, endIndex: link.endIndex },
        textStyle: { link: { headingId } },
        fields: 'link',
      },
    });
  }
  return out;
}
