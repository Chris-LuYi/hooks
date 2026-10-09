import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DeeplinkTimeoutError } from '../errors';
import { createDeeplinkRegistry } from '../registry';
import type { DeeplinkHandlerContext } from '../types';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('timeout', () => {
  test('rejects with phase "waiting" when no handler registers in time', async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke('k', undefined, { timeout: 500 });
    const assertion = expect(p).rejects.toMatchObject({
      name: 'DeeplinkTimeoutError',
      key: 'k',
      phase: 'waiting',
      timeout: 500,
    });
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  test('defaults to 10000 ms', async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke('k');
    let rejected = false;
    p.catch(() => {
      rejected = true;
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(rejected).toBe(true);
    await expect(p).rejects.toBeInstanceOf(DeeplinkTimeoutError);
  });

  test('rejects with phase "running" and aborts ctx.signal when the handler is too slow', async () => {
    const reg = createDeeplinkRegistry();
    let seen: DeeplinkHandlerContext | undefined;
    reg.handle('k', (_params, ctx) => {
      seen = ctx;
      return new Promise<never>(() => {});
    });
    const p = reg.invoke('k', undefined, { timeout: 500 });
    const assertion = expect(p).rejects.toMatchObject({ phase: 'running' });
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(seen?.signal.aborted).toBe(true);
    expect(seen?.signal.reason).toBeInstanceOf(DeeplinkTimeoutError);
  });

  test('Infinity never times out', async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke('k', undefined, { timeout: Infinity });
    // past the 2^31-1 ms setTimeout cap, so a clamped timer would have fired
    await vi.advanceTimersByTimeAsync(2 ** 31);
    reg.handle('k', () => 'eventually');
    await expect(p).resolves.toBe('eventually');
  });

  test('a timeout above the setTimeout limit does not fire early', async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke('k', undefined, { timeout: 2 ** 31 });
    await vi.advanceTimersByTimeAsync(60 * 1000);
    reg.handle('k', () => 'ok');
    await expect(p).resolves.toBe('ok');
  });

  test('timeout 0 still lets an already-registered handler answer', async () => {
    const reg = createDeeplinkRegistry();
    reg.handle('k', () => 'fast');
    await expect(reg.invoke('k', undefined, { timeout: 0 })).resolves.toBe('fast');
  });

  test('a result arriving after the timeout is ignored', async () => {
    const reg = createDeeplinkRegistry();
    let release: (value: string) => void = () => {};
    reg.handle(
      'k',
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const p = reg.invoke('k', undefined, { timeout: 100 });
    const assertion = expect(p).rejects.toBeInstanceOf(DeeplinkTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    release('too late');
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).rejects.toBeInstanceOf(DeeplinkTimeoutError);
  });

  test('a call that timed out while waiting is never delivered to a later handler', async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke('k', undefined, { timeout: 100 });
    const assertion = expect(p).rejects.toBeInstanceOf(DeeplinkTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    const handler = vi.fn();
    reg.handle('k', handler);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();
  });

  test.each([Number.NaN, -1, '100'])('timeout %s throws TypeError synchronously', (timeout) => {
    const reg = createDeeplinkRegistry();
    expect(() => reg.invoke('k', undefined, { timeout: timeout as number })).toThrow(
      `[daas-toolbox] deeplink timeout must be a non-negative number or Infinity, got ${String(timeout)}`,
    );
  });

  test('settling clears the timer', async () => {
    const reg = createDeeplinkRegistry();
    reg.handle('k', () => 'ok');
    await reg.invoke('k', undefined, { timeout: 500 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('caller abort', () => {
  test('an already-aborted signal rejects with its reason and never runs the handler', async () => {
    const reg = createDeeplinkRegistry();
    const handler = vi.fn();
    reg.handle('k', handler);
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(reg.invoke('k', undefined, { signal: controller.signal })).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('aborting while waiting removes the call from the queue', async () => {
    const reg = createDeeplinkRegistry();
    const controller = new AbortController();
    const p = reg.invoke('k', undefined, { signal: controller.signal });
    const reason = new Error('cancel');
    controller.abort(reason);
    await expect(p).rejects.toBe(reason);
    const handler = vi.fn();
    reg.handle('k', handler);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();
  });

  test('aborting one waiting call leaves the other waiting calls queued', async () => {
    const reg = createDeeplinkRegistry();
    const controller = new AbortController();
    const aborted = reg.invoke('k', { n: 1 }, { signal: controller.signal });
    const kept = reg.invoke('k', { n: 2 });
    controller.abort(new Error('cancel'));
    await expect(aborted).rejects.toThrow('cancel');
    reg.handle('k', (params) => params?.n);
    await expect(kept).resolves.toBe(2);
  });

  test('aborting while running aborts ctx.signal and rejects with the reason', async () => {
    const reg = createDeeplinkRegistry();
    let seen: DeeplinkHandlerContext | undefined;
    reg.handle('k', (_params, ctx) => {
      seen = ctx;
      return new Promise<never>(() => {});
    });
    const controller = new AbortController();
    const p = reg.invoke('k', undefined, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    const reason = new Error('user left');
    controller.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(seen?.signal.aborted).toBe(true);
    expect(seen?.signal.reason).toBe(reason);
  });

  test('settling removes the abort listener', async () => {
    const reg = createDeeplinkRegistry();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    reg.handle('k', () => 'ok');
    await reg.invoke('k', undefined, { signal: controller.signal });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
