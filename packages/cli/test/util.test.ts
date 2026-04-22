import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { truncate, withErrorHandler } from '../src/util.js';

describe('truncate', () => {
  it('returns short text unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates long text with ellipsis', () => {
    expect(truncate('hello world foo bar', 10)).toBe('hello worl...');
  });

  it('replaces newlines with \\n', () => {
    expect(truncate('line1\nline2\nline3', 50)).toBe(
      'line1\\nline2\\nline3',
    );
  });

  it('handles exact boundary', () => {
    expect(truncate('12345', 5)).toBe('12345');
    expect(truncate('123456', 5)).toBe('12345...');
  });

  it('handles empty string', () => {
    expect(truncate('', 10)).toBe('');
  });

  it('handles newlines before truncation', () => {
    expect(truncate('a\nb', 4)).toBe('a\\nb');
  });

  it('returns only ellipsis for maxLen 0', () => {
    expect(truncate('short', 0)).toBe('...');
  });

  it('truncates mid-escaped-newline when expansion pushes past maxLen', () => {
    expect(truncate('line1\nline2', 6)).toBe('line1\\...');
  });
});

describe('withErrorHandler', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('handles 401 status errors with auth message', async () => {
    const wrapped = withErrorHandler(async () => {
      throw new Error('Request failed with 401 Unauthorized');
    });

    await wrapped();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const allOutput = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toMatch(/Authentication failed/);
    expect(allOutput).toMatch(/codocs login/);
  });

  it('handles invalid_grant errors with auth message', async () => {
    const wrapped = withErrorHandler(async () => {
      throw new Error('invalid_grant: Token has been expired or revoked.');
    });

    await wrapped();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const allOutput = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toMatch(/Authentication failed/);
  });

  it('handles 404 errors with doc access message', async () => {
    const wrapped = withErrorHandler(async () => {
      throw new Error('Document not found (404)');
    });

    await wrapped();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const allOutput = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toMatch(/Check the document ID/);
  });

  it('handles generic runtime errors', async () => {
    const wrapped = withErrorHandler(async () => {
      throw new Error('Something totally unexpected happened');
    });

    await wrapped();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const allOutput = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allOutput).toMatch(/Error: Something totally unexpected happened/);
    expect(allOutput).not.toMatch(/Authentication failed/);
    expect(allOutput).not.toMatch(/Check the document ID/);
  });
});
