/**
 * Render Mermaid diagram source to PNG.
 *
 * Uses beautiful-mermaid (pure Node, no browser) for SVG generation
 * and @resvg/resvg-js (Rust-based) for SVG→PNG rasterization.
 *
 * Dependencies are loaded lazily via dynamic import to avoid issues
 * with ESM-only packages in CJS contexts (e.g., tsx scripts).
 */

import { createHash } from 'node:crypto';

export interface MermaidRenderResult {
  /** PNG image data. */
  png: Buffer;
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
}

/** SHA-256 hash of mermaid source (first 16 hex chars), used as a lookup key. */
export function hashMermaidSource(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

/**
 * Render a Mermaid diagram to PNG.
 *
 * @param source - Mermaid diagram source (e.g., "graph TD\n  A-->B")
 * @returns PNG buffer and dimensions
 * @throws If the mermaid source is invalid or rendering fails
 */
export async function renderMermaidToPng(source: string): Promise<MermaidRenderResult> {
  const { renderMermaidSVG } = await import('beautiful-mermaid');
  const { Resvg } = await import('@resvg/resvg-js');

  const svg = renderMermaidSVG(source);

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
  });

  const rendered = resvg.render();
  const png = rendered.asPng();

  return {
    png,
    width: rendered.width,
    height: rendered.height,
  };
}
