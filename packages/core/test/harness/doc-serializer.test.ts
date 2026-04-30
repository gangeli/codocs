import { describe, it, expect } from 'vitest';
import { DocSerializer } from '../../src/harness/doc-serializer.js';

/** Create a manually-resolvable promise. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('DocSerializer', () => {
  it('runs tasks for the same document one at a time', async () => {
    const ser = new DocSerializer();
    const order: string[] = [];
    const d1 = deferred<void>();
    const d2 = deferred<void>();

    const p1 = ser.run('doc-A', async () => {
      order.push('a-start');
      await d1.promise;
      order.push('a-end');
    });
    const p2 = ser.run('doc-A', async () => {
      order.push('b-start');
      await d2.promise;
      order.push('b-end');
    });

    // Let the microtask queue flush — only the first should have started.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['a-start']);

    d1.resolve();
    await p1;
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);

    d2.resolve();
    await p2;
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('runs tasks for different documents in parallel', async () => {
    const ser = new DocSerializer();
    const order: string[] = [];
    const dA = deferred<void>();
    const dB = deferred<void>();

    const pA = ser.run('doc-A', async () => {
      order.push('A-start');
      await dA.promise;
      order.push('A-end');
    });
    const pB = ser.run('doc-B', async () => {
      order.push('B-start');
      await dB.promise;
      order.push('B-end');
    });

    await Promise.resolve();
    await Promise.resolve();
    // Both should have started concurrently.
    expect(order).toEqual(['A-start', 'B-start']);

    dB.resolve();
    await pB;
    dA.resolve();
    await pA;
  });

  it('continues running subsequent tasks after a rejection', async () => {
    const ser = new DocSerializer();
    const order: string[] = [];

    const p1 = ser.run('doc-A', async () => {
      order.push('a');
      throw new Error('boom');
    });
    const p2 = ser.run('doc-A', async () => {
      order.push('b');
    });

    await expect(p1).rejects.toThrow('boom');
    await p2;
    expect(order).toEqual(['a', 'b']);
  });

  it('clears the lock after the chain settles', async () => {
    const ser = new DocSerializer();
    expect(ser.isBusy('doc-A')).toBe(false);

    const p = ser.run('doc-A', async () => {});
    expect(ser.isBusy('doc-A')).toBe(true);
    await p;
    // Allow the cleanup microtask to run.
    await Promise.resolve();
    await Promise.resolve();
    expect(ser.isBusy('doc-A')).toBe(false);
  });

  it('returns the task result', async () => {
    const ser = new DocSerializer();
    const result = await ser.run('doc-A', async () => 42);
    expect(result).toBe(42);
  });
});
