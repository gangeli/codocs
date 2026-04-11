import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeRunner } from '../../src/harness/agents/claude.js';
import * as child_process from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

function mockSpawn(exitCode = 0, stdout = 'ok') {
  const mockChild = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { end: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };

  // Simulate 'close' event on next tick
  mockChild.on.mockImplementation((event: string, cb: Function) => {
    if (event === 'close') {
      setTimeout(() => cb(exitCode), 0);
    }
  });

  (child_process.spawn as any).mockReturnValue(mockChild);
  return mockChild;
}

describe('ClaudeRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes --model flag when model is specified', async () => {
    mockSpawn();
    const runner = new ClaudeRunner();

    await runner.run('test prompt', null, { model: 'sonnet' });

    const spawnCall = (child_process.spawn as any).mock.calls[0];
    const args: string[] = spawnCall[1];
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe('sonnet');
  });

  it('does not pass --model flag when model is not specified', async () => {
    mockSpawn();
    const runner = new ClaudeRunner();

    await runner.run('test prompt', null);

    const spawnCall = (child_process.spawn as any).mock.calls[0];
    const args: string[] = spawnCall[1];
    expect(args).not.toContain('--model');
  });

  it('passes full model IDs (e.g., claude-sonnet-4-6)', async () => {
    mockSpawn();
    const runner = new ClaudeRunner();

    await runner.run('test prompt', null, { model: 'claude-sonnet-4-6' });

    const spawnCall = (child_process.spawn as any).mock.calls[0];
    const args: string[] = spawnCall[1];
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('claude-sonnet-4-6');
  });

  it('places --model before --resume', async () => {
    mockSpawn();
    const runner = new ClaudeRunner();

    await runner.run('test prompt', 'session-123', { model: 'opus' });

    const spawnCall = (child_process.spawn as any).mock.calls[0];
    const args: string[] = spawnCall[1];
    const modelIdx = args.indexOf('--model');
    const resumeIdx = args.indexOf('--resume');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(modelIdx).toBeLessThan(resumeIdx);
  });
});
