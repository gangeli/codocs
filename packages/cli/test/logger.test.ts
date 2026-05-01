import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/logger.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'codocs-logger-test-'));
  tmpDirs.push(d);
  return d;
}

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('createLogger', () => {
  it('writes structured ndjson with level + timestamp + msg', async () => {
    const dir = makeTmp();
    const path = join(dir, 'serve.log');
    const log = createLogger({ filePath: path, level: 'debug' });
    log.info('hello', { docId: 'd1' });
    log.error('boom', { code: 'E_X' });
    await log.flush();

    const lines = readLines(path);
    expect(lines).toHaveLength(2);

    expect(lines[0].msg).toBe('hello');
    expect(lines[0].level).toBe(30); // pino info
    expect(lines[0].docId).toBe('d1');
    expect(typeof lines[0].time).toBe('string');
    expect(/^\d{4}-\d{2}-\d{2}T/.test(lines[0].time as string)).toBe(true);

    expect(lines[1].msg).toBe('boom');
    expect(lines[1].level).toBe(50); // pino error
    expect(lines[1].code).toBe('E_X');
  });

  it('honours level: filters debug when level is info', async () => {
    const dir = makeTmp();
    const path = join(dir, 'serve.log');
    const log = createLogger({ filePath: path, level: 'info' });
    log.debug('should be dropped');
    log.info('should land');
    await log.flush();

    const lines = readLines(path);
    expect(lines).toHaveLength(1);
    expect(lines[0].msg).toBe('should land');
  });

  it('creates the parent directory when it does not yet exist', async () => {
    const dir = makeTmp();
    const path = join(dir, 'nested', 'further', 'serve.log');
    const log = createLogger({ filePath: path, level: 'info' });
    log.info('here');
    await log.flush();
    expect(existsSync(path)).toBe(true);
  });

  it('appends to an existing file rather than truncating', async () => {
    const dir = makeTmp();
    const path = join(dir, 'serve.log');

    const log1 = createLogger({ filePath: path, level: 'info' });
    log1.info('first session');
    await log1.flush();

    const log2 = createLogger({ filePath: path, level: 'info' });
    log2.info('second session');
    await log2.flush();

    const lines = readLines(path);
    expect(lines).toHaveLength(2);
    expect(lines[0].msg).toBe('first session');
    expect(lines[1].msg).toBe('second session');
  });

  it('exposes filePath for diagnostics', () => {
    const dir = makeTmp();
    const path = join(dir, 'serve.log');
    const log = createLogger({ filePath: path });
    expect(log.filePath).toBe(path);
  });
});
