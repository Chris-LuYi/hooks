import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDeeplinkRegistry } from '../registry';
import type { DeeplinkHandler, DeeplinkRegisterOptions, DeeplinkStepInfo } from '../types';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function tracer(trace: string[], name: string): DeeplinkHandler {
  return async (_ctx, next) => {
    trace.push(`${name}-in`);
    const res = await next();
    trace.push(`${name}-out`);
    return res;
  };
}

const own = { owner: 'test' };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('global handlers', () => {
  test('wrap every key', async () => {
    const reg = createDeeplinkRegistry();
    const keys: string[] = [];
    reg.registerGlobalHandler(
      (ctx, next) => {
        keys.push(ctx.key);
        return next();
      },
      { owner: 'log' },
    );
    reg.registerHandler('a', () => 'A', own);
    reg.registerHandler('b', () => 'B', own);
    await expect(reg.invoke('a')).resolves.toBe('A');
    await expect(reg.invoke('b')).resolves.toBe('B');
    expect(keys).toEqual(['a', 'b']);
  });

  test('are outermost even when a key handler has a lower order', async () => {
    const reg = createDeeplinkRegistry();
    const trace: string[] = [];
    reg.registerGlobalHandler(tracer(trace, 'g'), { owner: 'g', order: 100 });
    reg.registerHandler('k', tracer(trace, 'k'), { owner: 'k', order: -1000 });
    await reg.invoke('k');
    expect(trace).toEqual(['g-in', 'k-in', 'k-out', 'g-out']);
  });

  test('are sorted by their own order, ties by registration', async () => {
    const reg = createDeeplinkRegistry();
    const trace: string[] = [];
    reg.registerGlobalHandler(tracer(trace, 'g2'), { owner: 'g2', order: 2 });
    reg.registerGlobalHandler(tracer(trace, 'g1a'), { owner: 'g1a', order: 1 });
    reg.registerGlobalHandler(tracer(trace, 'g1b'), { owner: 'g1b', order: 1 });
    reg.registerHandler('k', () => 'x', own);
    await reg.invoke('k');
    expect(trace).toEqual(['g1a-in', 'g1b-in', 'g2-in', 'g2-out', 'g1b-out', 'g1a-out']);
  });

  test('the same owner replaces its global handler and warns in dev', async () => {
    const reg = createDeeplinkRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const trace: string[] = [];
    const unregisterOld = reg.registerGlobalHandler(tracer(trace, 'old'), { owner: 'logger' });
    reg.registerGlobalHandler(tracer(trace, 'new'), { owner: 'logger' });
    expect(warn).toHaveBeenCalledWith('[daas-toolbox] global handler from owner "logger" replaced');
    unregisterOld();
    reg.registerHandler('k', () => 'x', own);
    await reg.invoke('k');
    expect(trace).toEqual(['new-in', 'new-out']);
  });

  test('a global owner and a key-handler owner with the same name are independent', async () => {
    const reg = createDeeplinkRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reg.registerHandler('k', () => 'key-handler', { owner: 'shared' });
    reg.registerGlobalHandler((_ctx, next) => next(), { owner: 'shared' });
    expect(reg.has('k')).toBe(true);
    await expect(reg.invoke('k')).resolves.toBe('key-handler');
    expect(warn).not.toHaveBeenCalled();
  });

  test('global handlers alone do not satisfy the wait rule', async () => {
    vi.useFakeTimers();
    const reg = createDeeplinkRegistry();
    reg.registerGlobalHandler((_ctx, next) => next(), { owner: 'log' });
    expect(reg.has('k')).toBe(false);
    const p = reg.invoke('k', undefined, { timeout: 100 });
    const assertion = expect(p).rejects.toMatchObject({
      name: 'DeeplinkTimeoutError',
      phase: 'waiting',
    });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  test('registerGlobalHandler does not start waiting calls', async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke('k');
    let settled = false;
    p.then(() => {
      settled = true;
    });
    reg.registerGlobalHandler((_ctx, next) => next(), { owner: 'log' });
    await flush();
    expect(settled).toBe(false);
    reg.registerHandler('k', () => 'ok', own);
    await expect(p).resolves.toBe('ok');
  });

  test('registering or unregistering one while a call runs does not change that call', async () => {
    const reg = createDeeplinkRegistry();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const trace: string[] = [];
    const unregisterG = reg.registerGlobalHandler(tracer(trace, 'g1'), { owner: 'g1' });
    reg.registerHandler(
      'k',
      async () => {
        await gate;
        return 'done';
      },
      own,
    );
    const p = reg.invoke('k');
    await flush();
    reg.registerGlobalHandler(tracer(trace, 'late'), { owner: 'late' });
    unregisterG();
    release();
    await expect(p).resolves.toBe('done');
    expect(trace).toEqual(['g1-in', 'g1-out']);
  });

  test('step info covers the combined chain and flags global handlers', async () => {
    const reg = createDeeplinkRegistry();
    const infos: DeeplinkStepInfo[] = [];
    reg.registerGlobalHandler(
      (ctx, next) => {
        infos.push(ctx.step);
        return next();
      },
      { owner: 'log' },
    );
    reg.registerHandler(
      'k',
      (ctx) => {
        infos.push(ctx.step);
        return 'x';
      },
      { owner: 'orders' },
    );
    await reg.invoke('k');
    expect(infos).toEqual([
      { index: 0, count: 2, owner: 'log', global: true },
      { index: 1, count: 2, owner: 'orders', global: false },
    ]);
  });

  test('a global handler can recover from a key handler error', async () => {
    const reg = createDeeplinkRegistry();
    reg.registerGlobalHandler(
      async (_ctx, next) => {
        try {
          return await next();
        } catch {
          return 'fallback';
        }
      },
      { owner: 'guard' },
    );
    reg.registerHandler(
      'k',
      () => {
        throw new Error('inner');
      },
      own,
    );
    await expect(reg.invoke('k')).resolves.toBe('fallback');
  });

  test('unregister removes it; a second unregister is a no-op', async () => {
    const reg = createDeeplinkRegistry();
    const trace: string[] = [];
    const unregister = reg.registerGlobalHandler(tracer(trace, 'g'), { owner: 'g' });
    unregister();
    unregister();
    reg.registerHandler('k', () => 'x', own);
    await reg.invoke('k');
    expect(trace).toEqual([]);
  });

  test('registerGlobalHandler validates its arguments', () => {
    const reg = createDeeplinkRegistry();
    expect(() => reg.registerGlobalHandler('x' as unknown as DeeplinkHandler, own)).toThrow(
      new TypeError('[daas-toolbox] deeplink handler must be a function'),
    );
    expect(() => reg.registerGlobalHandler(() => 1, { owner: 'o', order: Number.NaN })).toThrow(
      new TypeError('[daas-toolbox] deeplink order must be a finite number, got NaN'),
    );
    expect(() => reg.registerGlobalHandler(() => 1, { owner: '' })).toThrow(
      new TypeError('[daas-toolbox] deeplink owner must be a non-empty string'),
    );
    expect(() =>
      reg.registerGlobalHandler(() => 1, undefined as unknown as DeeplinkRegisterOptions),
    ).toThrow(new TypeError('[daas-toolbox] deeplink owner must be a non-empty string'));
  });
});
