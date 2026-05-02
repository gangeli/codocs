import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as child_process from 'node:child_process';
import { EventEmitter } from 'node:events';
import { spawnAgent, type TrackedProcess } from '../../src/harness/agents/runner-utils.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

interface FakeChild {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (data: string) => void; end: () => void };
  on: EventEmitter['on'];
  emit: EventEmitter['emit'];
  kill: (signal?: string) => void;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child: FakeChild = {
    stdout,
    stderr,
    stdin: { write: vi.fn(), end: vi.fn() },
    on: ee.on.bind(ee),
    emit: ee.emit.bind(ee),
    kill: vi.fn(),
  };
  return child;
}

describe('spawnAgent output buffering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns stdout/stderr verbatim when under the cap', async () => {
    const child = makeFakeChild();
    (child_process.spawn as any).mockReturnValue(child);

    const active = new Map<string, TrackedProcess>();
    const p = spawnAgent('bin', [], { maxOutputBytes: 1024 }, active);

    child.stdout.emit('data', Buffer.from('hello '));
    child.stdout.emit('data', Buffer.from('world'));
    child.stderr.emit('data', Buffer.from('warn'));
    child.emit('close', 0);

    const result = await p;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world');
    expect(result.stderr).toBe('warn');
    expect(active.size).toBe(0);
  });

  it('drops oldest bytes and prepends a truncation notice when exceeding the cap', async () => {
    const child = makeFakeChild();
    (child_process.spawn as any).mockReturnValue(child);

    const active = new Map<string, TrackedProcess>();
    const p = spawnAgent('bin', [], { maxOutputBytes: 10 }, active);

    // Total = 24 bytes ('aaaa' + 'bbbbbbbb' + 'cccccccccccc'), cap = 10.
    // Expect to keep the trailing 10 bytes: 'b' (2 of 8) + 'cccccccccccc' (no, only last 10 of c+earlier).
    // Actually keeps: last 10 bytes of stream: 'cccccccccc' (last 10 chars of 'cccccccccccc').
    child.stdout.emit('data', Buffer.from('aaaa'));
    child.stdout.emit('data', Buffer.from('bbbbbbbb'));
    child.stdout.emit('data', Buffer.from('cccccccccccc'));
    child.emit('close', 0);

    const result = await p;
    expect(result.stdout.startsWith('[truncated 14 bytes from start of stream]\n')).toBe(true);
    const body = result.stdout.split('\n').slice(1).join('\n');
    expect(body).toBe('cccccccccc');
  });

  it('caps stderr independently of stdout', async () => {
    const child = makeFakeChild();
    (child_process.spawn as any).mockReturnValue(child);

    const active = new Map<string, TrackedProcess>();
    const p = spawnAgent('bin', [], { maxOutputBytes: 4 }, active);

    child.stdout.emit('data', Buffer.from('xyz'));
    child.stderr.emit('data', Buffer.from('123456'));
    child.emit('close', 0);

    const result = await p;
    expect(result.stdout).toBe('xyz');
    expect(result.stderr.startsWith('[truncated 2 bytes from start of stream]\n')).toBe(true);
    expect(result.stderr.split('\n').slice(1).join('\n')).toBe('3456');
  });

  it('handles a single chunk larger than the cap by slicing it', async () => {
    const child = makeFakeChild();
    (child_process.spawn as any).mockReturnValue(child);

    const active = new Map<string, TrackedProcess>();
    const p = spawnAgent('bin', [], { maxOutputBytes: 5 }, active);

    child.stdout.emit('data', Buffer.from('abcdefghij'));
    child.emit('close', 0);

    const result = await p;
    expect(result.stdout.startsWith('[truncated 5 bytes from start of stream]\n')).toBe(true);
    expect(result.stdout.split('\n').slice(1).join('\n')).toBe('fghij');
  });
});
