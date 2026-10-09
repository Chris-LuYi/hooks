import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDeeplinkRegistry } from '../registry';
import type { DeeplinkHandlerContext } from '../types';

/** Lets pending microtasks and 0 ms timers run (real timers in this file). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('happy path', () => {
  test('resolves with the result of a registered async handler', async () => {
    const reg = createDeeplinkRegistry();
    reg.handle('orders.open', async () => ({ opened: true }));
    await expect(reg.invoke('orders.open')).resolves.toEqual({ opened: true });
  });

  test('resolves with the return value of a sync handler', async () => {
    const reg = createDeeplinkRegistry();
    reg.handle('k', () => 42);
    await expect(reg.invoke('k')).resolves.toBe(42);
  });

  test('passes params and the exact caller options object to the handler', async () => {
    const reg = createDeeplinkRegistry();
    const handler = vi.fn((_params: unknown, _ctx: DeeplinkHandlerContext) => 'ok');
    reg.handle('k', handler);
    const options = { timeout: 5000, tab: 'items' };
    await reg.invoke('k', { id: 42 }, options);
    const [params, ctx] = handler.mock.calls[0];
    expect(params).toEqual({ id: 42 });
    expect(ctx.options).toBe(options);
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.signal.aborted).toBe(false);
  });

  test('passes undefined params and {} options when omitted', async () => {
    const reg = createDeeplinkRegistry();
    const handler = vi.fn((_params: unknown, _ctx: DeeplinkHandlerContext) => 'ok');
    reg.handle('k', handler);
    await reg.invoke('k');
    const [params, ctx] = handler.mock.calls[0];
    expect(params).toBeUndefined();
    expect(ctx.options).toEqual({});
  });
});

describe('waiting for a handler', () => {
  test('a call made before the handler registers resolves once it does', async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke('k', { id: 1 });
    const handler = vi.fn(() => 'late');
    await flush();
    expect(handler).not.toHaveBeenCalled();
    reg.handle('k', handler);
    await expect(p).resolves.toBe('late');
    expect(handler).toHaveBeenCalledWith({ id: 1 }, expect.anything());
  });

  test('several waiting calls are delivered in arrival order', async () => {
    const reg = createDeeplinkRegistry();
    const order: unknown[] = [];
    const calls = [reg.invoke('k', { n: 1 }), reg.invoke('k', { n: 2 }), reg.invoke('k', { n: 3 })];
    reg.handle('k', (params) => {
      order.push(params?.n);
      return params?.n;
    });
    await expect(Promise.all(calls)).resolves.toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test('a handler for another key does not receive waiting calls', async () => {
    const reg = createDeeplinkRegistry();
    const pB = reg.invoke('b');
    const aHandler = vi.fn(() => 'a');
    reg.handle('a', aHandler);
    await flush();
    expect(aHandler).not.toHaveBeenCalled();
    reg.handle('b', () => 'b');
    await expect(pB).resolves.toBe('b');
  });
});

describe('errors', () => {
  test('a sync throw becomes a rejection with the same error object', async () => {
    const reg = createDeeplinkRegistry();
    const boom = new Error('boom');
    reg.handle('k', () => {
      throw boom;
    });
    await expect(reg.invoke('k')).rejects.toBe(boom);
  });

  test('an async rejection is passed through unchanged', async () => {
    const reg = createDeeplinkRegistry();
    class ValidationError extends Error {}
    const err = new ValidationError('bad');
    reg.handle('k', async () => {
      throw err;
    });
    await expect(reg.invoke('k')).rejects.toBe(err);
  });

  test('one queued call failing does not stop the other queued calls', async () => {
    const reg = createDeeplinkRegistry();
    const p1 = reg.invoke('k', { fail: true });
    const p2 = reg.invoke('k', { fail: false });
    reg.handle('k', (params) => {
      if (params?.fail) throw new Error('first');
      return 'second';
    });
    await expect(p1).rejects.toThrow('first');
    await expect(p2).resolves.toBe('second');
  });

  test('an empty key throws TypeError from handle and invoke', () => {
    const reg = createDeeplinkRegistry();
    const msg = '[daas-toolbox] deeplink key must be a non-empty string, got an empty string';
    expect(() => reg.handle('', () => 1)).toThrow(new TypeError(msg));
    expect(() => reg.invoke('')).toThrow(new TypeError(msg));
  });

  test.each([42, undefined, null])('a %s key throws TypeError naming its type', (key) => {
    const reg = createDeeplinkRegistry();
    expect(() => reg.handle(key as unknown as string, () => 1)).toThrow(TypeError);
    expect(() => reg.invoke(key as unknown as string)).toThrow(
      `deeplink key must be a non-empty string, got ${typeof key}`,
    );
  });
});

describe('replace', () => {
  test('a new handler receives new calls', async () => {
    const reg = createDeeplinkRegistry();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reg.handle('k', () => 'old');
    reg.handle('k', () => 'new');
    await expect(reg.invoke('k')).resolves.toBe('new');
  });

  test('a call already running finishes on the handler that started it', async () => {
    const reg = createDeeplinkRegistry();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let release: (value: string) => void = () => {};
    reg.handle(
      'k',
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const p = reg.invoke('k');
    await flush();
    reg.handle('k', () => 'new');
    release('old');
    await expect(p).resolves.toBe('old');
    await expect(reg.invoke('k')).resolves.toBe('new');
  });

  test('replacing logs a dev warning; the first registration does not', () => {
    const reg = createDeeplinkRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reg.handle('orders.open', () => 1);
    expect(warn).not.toHaveBeenCalled();
    reg.handle('orders.open', () => 2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[daas-toolbox] deeplink "orders.open" handler replaced');
  });
});

describe('dispose', () => {
  test('after dispose, new calls wait for the next registration', async () => {
    const reg = createDeeplinkRegistry();
    const off = reg.handle('k', () => 'first');
    off();
    expect(reg.has('k')).toBe(false);
    const p = reg.invoke('k');
    reg.handle('k', () => 'second');
    await expect(p).resolves.toBe('second');
  });

  test('a stale disposer does not remove a newer handler', async () => {
    const reg = createDeeplinkRegistry();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const offOld = reg.handle('k', () => 'old');
    reg.handle('k', () => 'new');
    offOld();
    expect(reg.has('k')).toBe(true);
    await expect(reg.invoke('k')).resolves.toBe('new');
  });

  test('the same function registered twice: the first disposer leaves the second registration', () => {
    const reg = createDeeplinkRegistry();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = () => 'same';
    const off1 = reg.handle('k', fn);
    const off2 = reg.handle('k', fn);
    off1();
    expect(reg.has('k')).toBe(true);
    off2();
    expect(reg.has('k')).toBe(false);
  });

  test('calling a disposer twice is a no-op', () => {
    const reg = createDeeplinkRegistry();
    const off = reg.handle('k', () => 1);
    off();
    reg.handle('k', () => 2);
    off();
    expect(reg.has('k')).toBe(true);
  });

  test('a call already running still settles after its handler is disposed', async () => {
    const reg = createDeeplinkRegistry();
    let release: (value: string) => void = () => {};
    const off = reg.handle(
      'k',
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const p = reg.invoke('k');
    await flush();
    off();
    release('done');
    await expect(p).resolves.toBe('done');
  });
});

describe('has', () => {
  test('reflects whether a handler is registered', () => {
    const reg = createDeeplinkRegistry();
    expect(reg.has('k')).toBe(false);
    const off = reg.handle('k', () => 1);
    expect(reg.has('k')).toBe(true);
    off();
    expect(reg.has('k')).toBe(false);
  });
});
