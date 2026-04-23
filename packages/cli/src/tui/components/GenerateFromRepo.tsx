import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';

interface Props {
  /** Short status text rendered inside the page header. */
  message?: string;
  /** Raw source text used to seed the rain characters. */
  codeSamples?: string;
}

type Cell = {
  ch: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
};

const FALLBACK_SAMPLE =
  'const let return import export function interface type async await ' +
  '=> () {} [] ; . , : ?? ?. === !== null true false number string void ' +
  'new this class extends implements default from as public private readonly';

function mulberry32(seed: number) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildPool(src: string | undefined): string[] {
  const source = src && src.length > 100 ? src : FALLBACK_SAMPLE;
  const out: string[] = [];
  for (const c of source) {
    const code = c.charCodeAt(0);
    // Printable ASCII, excluding space so rain is visible, and excluding
    // chars that would disrupt column alignment.
    if (code >= 33 && code < 127) out.push(c);
  }
  return out.length ? out : ['.', ':', '=', '>', '<', '/', '*', '+', '-'];
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

export function GenerateFromRepo({
  message = 'Generating document from codebase',
  codeSamples,
}: Props) {
  const { stdout } = useStdout();
  const cols = Math.max(50, Math.min(stdout?.columns ?? 80, 180));
  const rows = Math.max(14, Math.min(stdout?.rows ?? 24, 60));

  const pool = useMemo(() => buildPool(codeSamples), [codeSamples]);
  const startRef = useRef(Date.now());

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 90);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const elapsedMs = now - startRef.current;
  const elapsedSec = elapsedMs / 1000;
  const timeStr = fmtTime(elapsedMs);

  // Per-column rain specs, deterministic on column index so the rain
  // pattern is stable across renders.
  const colSpecs = useMemo(() => {
    return Array.from({ length: cols }, (_, x) => {
      const rng = mulberry32(x * 2654435761 + 17);
      const speed = 3 + rng() * 10; // rows per second
      const len = 4 + Math.floor(rng() * 8);
      // Extra empty time in the cycle so the rain breathes.
      const period = Math.floor((rows + len * 2) * 1.8);
      const phase = rng() * period;
      const charSeed = Math.floor(rng() * 1e9);
      return { speed, len, phase, period, charSeed };
    });
  }, [cols, rows]);

  // Page geometry (centered).
  const panelW = Math.min(64, Math.max(44, Math.floor(cols * 0.72)));
  const panelH = Math.min(20, Math.max(12, Math.floor(rows * 0.78)));
  const panelX = Math.floor((cols - panelW) / 2);
  const panelY = Math.floor((rows - panelH) / 2);
  const innerW = panelW - 4; // 2-char side margin

  // Document progression.
  const lineDurMs = 420;
  const titleY = panelY + 2;
  const docTop = panelY + 4;
  const docBot = panelY + panelH - 4; // reserve blank + timer rows
  const docHeight = Math.max(1, docBot - docTop + 1);
  const bodyLeft = panelX + 2;

  const globalLine = elapsedMs / lineDurMs;
  const firstVisibleLine = Math.max(0, Math.floor(globalLine) - docHeight + 1);

  function lineWidth(i: number): number {
    const rng = mulberry32(i * 2246822519 + 101);
    const min = Math.max(6, Math.floor(innerW * 0.35));
    const max = innerW;
    // Occasionally produce a short "paragraph-ending" line.
    const short = rng() < 0.18;
    if (short) return min + Math.floor(rng() * (innerW * 0.35));
    return min + Math.floor(rng() * (max - min));
  }

  // Build the frame grid: rain first, then the page on top.
  const grid: Cell[][] = [];
  for (let y = 0; y < rows; y++) {
    const row: Cell[] = new Array(cols);
    for (let x = 0; x < cols; x++) {
      const spec = colSpecs[x];
      const raw = (elapsedSec * spec.speed + spec.phase) % spec.period;
      const head = Math.floor(raw) - spec.len;
      const depth = head - y;
      if (depth >= 0 && depth < spec.len) {
        const idx = Math.abs(spec.charSeed + y * 97 + x * 31) % pool.length;
        const ch = pool[idx];
        if (depth === 0) {
          row[x] = { ch, color: 'cyan', bold: true };
        } else if (depth <= 2) {
          row[x] = { ch, color: 'cyan' };
        } else {
          row[x] = { ch, color: 'gray', dim: true };
        }
      } else {
        row[x] = { ch: ' ' };
      }
    }
    grid.push(row);
  }

  const setCell = (x: number, y: number, cell: Cell) => {
    if (y >= 0 && y < rows && x >= 0 && x < cols) grid[y][x] = cell;
  };

  // Carve out the page — clear rain behind it so the paper looks solid.
  for (let y = panelY; y < panelY + panelH; y++) {
    for (let x = panelX; x < panelX + panelW; x++) {
      setCell(x, y, { ch: ' ' });
    }
  }

  // Rounded border.
  for (let x = panelX + 1; x < panelX + panelW - 1; x++) {
    setCell(x, panelY, { ch: '─', color: 'cyan' });
    setCell(x, panelY + panelH - 1, { ch: '─', color: 'cyan' });
  }
  for (let y = panelY + 1; y < panelY + panelH - 1; y++) {
    setCell(panelX, y, { ch: '│', color: 'cyan' });
    setCell(panelX + panelW - 1, y, { ch: '│', color: 'cyan' });
  }
  setCell(panelX, panelY, { ch: '╭', color: 'cyan' });
  setCell(panelX + panelW - 1, panelY, { ch: '╮', color: 'cyan' });
  setCell(panelX, panelY + panelH - 1, { ch: '╰', color: 'cyan' });
  setCell(panelX + panelW - 1, panelY + panelH - 1, { ch: '╯', color: 'cyan' });

  // Title — plain ASCII so it lines up on the character grid.
  const title = message;
  let tx = panelX + 2;
  for (const ch of title) {
    if (tx >= panelX + panelW - 2) break;
    setCell(tx, titleY, { ch, bold: true });
    tx++;
  }
  // Faint horizontal rule under the title.
  for (let x = panelX + 2; x < panelX + panelW - 2; x++) {
    setCell(x, panelY + 3, { ch: '─', color: 'gray', dim: true });
  }

  // Document ink lines — scroll upward once the page is full.
  const currentGlobal = Math.floor(globalLine);
  for (let dy = 0; dy < docHeight; dy++) {
    const y = docTop + dy;
    const lineIdx = firstVisibleLine + dy;
    if (lineIdx > currentGlobal) break;
    const w = lineWidth(lineIdx);

    if (lineIdx < currentGlobal) {
      for (let i = 0; i < w; i++) {
        setCell(bodyLeft + i, y, { ch: '▓', color: 'cyan', dim: true });
      }
    } else {
      const progress = globalLine - lineIdx; // 0..1
      const drawn = Math.floor(w * progress);
      for (let i = 0; i < drawn; i++) {
        setCell(bodyLeft + i, y, { ch: '▓', color: 'cyan' });
      }
      const blinkOn = Math.floor(elapsedMs / 380) % 2 === 0;
      if (blinkOn && drawn < innerW) {
        setCell(bodyLeft + drawn, y, { ch: '▌', color: 'white', bold: true });
      }
    }
  }

  // Timer — bottom-right of the page body, inside the border.
  const timerY = panelY + panelH - 2;
  const timerEnd = panelX + panelW - 3; // one char padding from border
  const timerStart = timerEnd - timeStr.length + 1;
  for (let i = 0; i < timeStr.length; i++) {
    setCell(timerStart + i, timerY, {
      ch: timeStr[i],
      color: 'gray',
      dim: true,
    });
  }

  return (
    <Box flexDirection="column">
      {grid.map((row, y) => (
        <RowText key={y} cells={row} />
      ))}
    </Box>
  );
}

function RowText({ cells }: { cells: Cell[] }) {
  type Run = { text: string; color?: string; dim: boolean; bold: boolean };
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (const c of cells) {
    const dim = c.dim ?? false;
    const bold = c.bold ?? false;
    if (cur && cur.color === c.color && cur.dim === dim && cur.bold === bold) {
      cur.text += c.ch;
    } else {
      cur = { text: c.ch, color: c.color, dim, bold };
      runs.push(cur);
    }
  }
  return (
    <Text>
      {runs.map((r, i) => (
        <Text
          key={i}
          color={r.color}
          dimColor={r.dim || undefined}
          bold={r.bold || undefined}
        >
          {r.text}
        </Text>
      ))}
    </Text>
  );
}
