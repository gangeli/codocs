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

  const svg = inlineSvgColors(renderMermaidSVG(source));

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

// ── CSS variable resolution ────────────────────────────────────
//
// beautiful-mermaid emits SVG that uses CSS custom properties and
// `color-mix()` for theming. resvg doesn't resolve either, so fills and
// strokes fall back to black. We parse the declarations out of the SVG's
// root style attribute and its <style> block, resolve them to concrete
// hex colors, then substitute `var(--x)` references in the body.

export function inlineSvgColors(svg: string): string {
  const declarations = new Map<string, string>();

  const rootStyle = svg.match(/<svg\b[^>]*\sstyle="([^"]*)"/);
  if (rootStyle) extractDeclarations(rootStyle[1], declarations);

  const styleBlock = svg.match(/<style\b[^>]*>([\s\S]*?)<\/style>/);
  if (styleBlock) {
    const svgRule = styleBlock[1].match(/\bsvg\s*\{([^}]*)\}/);
    if (svgRule) extractDeclarations(svgRule[1], declarations);
  }

  const resolved = new Map<string, string>();
  for (let pass = 0; pass < 10; pass++) {
    let progress = false;
    for (const [name, expr] of declarations) {
      if (resolved.has(name)) continue;
      const v = resolveExpression(expr, resolved);
      if (v !== null) {
        resolved.set(name, v);
        progress = true;
      }
    }
    if (!progress) break;
  }

  return replaceVarRefs(svg, resolved);
}

function extractDeclarations(text: string, out: Map<string, string>): void {
  const re = /--([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.set(m[1], m[2].trim());
  }
}

function resolveExpression(expr: string, resolved: Map<string, string>): string | null {
  expr = expr.trim();

  if (/^#[0-9a-fA-F]{3,8}$/.test(expr)) return expr.toUpperCase();

  if (expr.startsWith('var(') && expr.endsWith(')')) {
    const parts = splitTopLevel(expr.slice(4, -1), ',');
    const name = parts[0].replace(/^--/, '').trim();
    if (resolved.has(name)) return resolved.get(name)!;
    if (parts.length > 1) return resolveExpression(parts.slice(1).join(','), resolved);
    return null;
  }

  if (expr.startsWith('color-mix(') && expr.endsWith(')')) {
    const parts = splitTopLevel(expr.slice(10, -1), ',');
    if (parts.length < 3 || !/\bin\s+srgb\b/.test(parts[0])) return null;
    const first = parsePercentColor(parts[1]);
    const second = parsePercentColor(parts[2]);
    if (!first || !second) return null;
    const c1 = resolveExpression(first.color, resolved);
    const c2 = resolveExpression(second.color, resolved);
    if (c1 === null || c2 === null) return null;
    const p1 = first.pct ?? (second.pct !== null ? 100 - second.pct : 50);
    const p2 = second.pct ?? 100 - p1;
    return mixHex(c1, p1, c2, p2);
  }

  return null;
}

function parsePercentColor(s: string): { color: string; pct: number | null } | null {
  const m = s.trim().match(/^(.+?)(?:\s+(\d+(?:\.\d+)?)\s*%)?$/);
  if (!m) return null;
  return { color: m[1].trim(), pct: m[2] ? parseFloat(m[2]) : null };
}

function splitTopLevel(s: string, delim: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === delim && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim());
}

function replaceVarRefs(svg: string, resolved: Map<string, string>): string {
  let out = '';
  let i = 0;
  while (i < svg.length) {
    const at = svg.indexOf('var(', i);
    if (at === -1) {
      out += svg.slice(i);
      break;
    }
    out += svg.slice(i, at);
    let depth = 1;
    let j = at + 4;
    while (j < svg.length && depth > 0) {
      if (svg[j] === '(') depth++;
      else if (svg[j] === ')') depth--;
      if (depth === 0) break;
      j++;
    }
    if (depth !== 0) {
      out += svg.slice(at);
      break;
    }
    const expr = svg.slice(at, j + 1);
    const r = resolveExpression(expr, resolved);
    out += r !== null ? r : expr;
    i = j + 1;
  }
  return out;
}

function mixHex(c1: string, p1: number, c2: string, p2: number): string {
  const total = p1 + p2 || 1;
  const w1 = p1 / total;
  const w2 = p2 / total;
  const a = parseHex(c1);
  const b = parseHex(c2);
  const r = Math.round(a.r * w1 + b.r * w2);
  const g = Math.round(a.g * w1 + b.g * w2);
  const bl = Math.round(a.b * w1 + b.b * w2);
  return (
    '#' + [r, g, bl].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0').toUpperCase()).join('')
  );
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}
