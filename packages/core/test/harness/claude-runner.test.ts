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
    stdin: { end: vi.fn(), write: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };

  mockChild.on.mockImplementation((event: string, cb: Function) => {
    if (event === 'close') {
      setTimeout(() => cb(exitCode), 0);
    }
  });

  (child_process.spawn as any).mockReturnValue(mockChild);
  return mockChild;
}

function mockSpawnNoClose() {
  const mockChild = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { end: vi.fn(), write: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };
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
    expect(modelIdx).toBeGreaterThan(-1);
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

  it('permissionMode.type=auto emits --permission-mode auto (no allowedTools by default)', async () => {
    mockSpawn();
    const runner = new ClaudeRunner();

    await runner.run('prompt', null, { permissionMode: { type: 'auto' } });

    const spawnCall = (child_process.spawn as any).mock.calls[0];
    const args: string[] = spawnCall[1];
    const permIdx = args.indexOf('--permission-mode');
    expect(permIdx).toBeGreaterThan(-1);
    expect(args[permIdx + 1]).toBe('auto');
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('permissionMode.type=auto with allowedTools appends --allowedTools', async () => {
    mockSpawn();
    const runner = new ClaudeRunner();

    await runner.run('prompt', null, {
      permissionMode: { type: 'auto', allowedTools: ['Edit', 'Write'] },
    });

    const spawnCall = (child_process.spawn as any).mock.calls[0];
    const args: string[] = spawnCall[1];
    const permIdx = args.indexOf('--permission-mode');
    expect(permIdx).toBeGreaterThan(-1);
    expect(args[permIdx + 1]).toBe('auto');
    const allowedIdx = args.indexOf('--allowedTools');
    expect(allowedIdx).toBeGreaterThan(-1);
    expect(args[allowedIdx + 1]).toBe('Edit');
    expect(args[allowedIdx + 2]).toBe('Write');
  });

  it('permissionMode.type=bypass emits --dangerously-skip-permissions', async () => {
    mockSpawn();
    const runner = new ClaudeRunner();

    await runner.run('prompt', null, { permissionMode: { type: 'bypass' } });

    const spawnCall = (child_process.spawn as any).mock.calls[0];
    const args: string[] = spawnCall[1];
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--allowedTools');
  });

  it('permissionMode.type=allowedTools emits --allowedTools and --disallowedTools', async () => {
    mockSpawn();
    const runner = new ClaudeRunner();

    await runner.run('prompt', null, {
      permissionMode: {
        type: 'allowedTools',
        tools: ['Edit', 'Read'],
        disallowedTools: ['Bash'],
      },
    });

    const spawnCall = (child_process.spawn as any).mock.calls[0];
    const args: string[] = spawnCall[1];
    const allowedIdx = args.indexOf('--allowedTools');
    expect(allowedIdx).toBeGreaterThan(-1);
    expect(args[allowedIdx + 1]).toBe('Edit');
    expect(args[allowedIdx + 2]).toBe('Read');
    const disallowedIdx = args.indexOf('--disallowedTools');
    expect(disallowedIdx).toBeGreaterThan(-1);
    expect(args[disallowedIdx + 1]).toBe('Bash');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('forkSession=true with sessionId emits --resume parent, --fork-session, and distinct --session-id', async () => {
    mockSpawn();
    const runner = new ClaudeRunner();

    await runner.run('prompt', 'parent', { forkSession: true });

    const spawnCall = (child_process.spawn as any).mock.calls[0];
    const args: string[] = spawnCall[1];

    const resumeIdx = args.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(args[resumeIdx + 1]).toBe('parent');

    expect(args).toContain('--fork-session');

    const sessionIdIdx = args.indexOf('--session-id');
    expect(sessionIdIdx).toBeGreaterThan(-1);
    const newSessionId = args[sessionIdIdx + 1];
    expect(newSessionId).toBeTruthy();
    expect(newSessionId).not.toBe('parent');
    expect(newSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('killAll() invokes kill() on tracked children', async () => {
    const mockChild = mockSpawnNoClose();
    const runner = new ClaudeRunner();

    const runPromise = runner.run('prompt', null, { agentName: 'alice' });
    await new Promise((r) => setImmediate(r));

    const active = runner.getActiveProcesses();
    expect(active).toHaveLength(1);
    expect(active[0].agentName).toBe('alice');

    const killed = runner.killAll();
    expect(killed).toEqual(['alice']);
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

    const closeCall = (mockChild.on as any).mock.calls.find(
      (c: any[]) => c[0] === 'close',
    );
    if (closeCall) closeCall[1](143);
    await runPromise.catch(() => {});
  });
});
