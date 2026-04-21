/**
 * Fetch a remote image URL, measure its dimensions, and tell the caller
 * whether the format is one Google Docs can embed.
 *
 * Returns `null` on total probe failure (unreachable URL, non-200,
 * unparseable bytes). The Docs API only accepts PNG/JPEG/GIF — anything
 * else (ICO, SVG, WebP, BMP, …) is reported with `supported: false` so
 * md-to-docs can drop the insert instead of failing the whole batch.
 */

import { imageSize } from 'image-size';

const DOCS_SUPPORTED_FORMATS = new Set(['png', 'jpg', 'gif']);

export interface RemoteImageInfo {
  /** Natural width in pixels. */
  width: number;
  /** Natural height in pixels. */
  height: number;
  /** Image format as detected from bytes (e.g. 'png', 'jpg', 'ico', 'svg'). */
  format: string;
  /** True iff the format is one of PNG/JPEG/GIF — Docs API's supported set. */
  supported: boolean;
}

export async function probeRemoteImage(url: string): Promise<RemoteImageInfo | null> {
  let buf: Uint8Array;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    buf = new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }

  try {
    const info = imageSize(buf);
    if (!info.width || !info.height) return null;
    const format = String(info.type ?? '').toLowerCase();
    return {
      width: info.width,
      height: info.height,
      format,
      supported: DOCS_SUPPORTED_FORMATS.has(format),
    };
  } catch {
    return null;
  }
}
