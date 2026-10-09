import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDeeplinkRegistry } from '../registry';

const own = { owner: 'test' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('inspect', () => {
  test('an empty registry reports nothing', () => {
    expect(createDeeplinkRegistry().inspect()).toEqual({ global: [], keys: [] });
  });

  test('lists global and key handlers in execution order, keys sorted', () => {
    const reg = createDeeplinkRegistry();
    reg.registerGlobalHandler(() => 1, { owner: 'log', order: 5 });
    reg.registerGlobalHandler(() => 1, { owner: 'trace' });
    reg.registerHandler('zeta', () => 1, { owner: 'z' });
    reg.registerHandler('alpha', () => 1, { owner: 'orders', order: 50 });
    reg.registerHandler('alpha', () => 1, { owner: 'auth', order: 10 });
    expect(reg.inspect()).toEqual({
      global: [
        { owner: 'trace', order: 0 },
        { owner: 'log', order: 5 },
      ],
      keys: [
        {
          key: 'alpha',
          steps: [
            { owner: 'auth', order: 10 },
            { owner: 'orders', order: 50 },
          ],
          waiting: 0,
        },
        { key: 'zeta', steps: [{ owner: 'z', order: 0 }], waiting: 0 },
      ],
    });
  });

  test('counts waiting calls and drops keys with nothing left', async () => {
    const reg = createDeeplinkRegistry();
    const controller = new AbortController();
    const p1 = reg.invoke('pending.key', undefined, { signal: controller.signal });
    const p2 = reg.invoke('pending.key');
    expect(reg.inspect().keys).toEqual([{ key: 'pending.key', steps: [], waiting: 2 }]);
    controller.abort(new Error('x'));
    await expect(p1).rejects.toThrow('x');
    expect(reg.inspect().keys).toEqual([{ key: 'pending.key', steps: [], waiting: 1 }]);
    const unregister = reg.registerHandler('pending.key', () => 'ok', own);
    await expect(p2).resolves.toBe('ok');
    expect(reg.inspect().keys).toEqual([
      { key: 'pending.key', steps: [{ owner: 'test', order: 0 }], waiting: 0 },
    ]);
    unregister();
    expect(reg.inspect().keys).toEqual([]);
  });

  test('never exposes params or results', async () => {
    const reg = createDeeplinkRegistry();
    reg.registerHandler('k', () => ({ token: 'result-secret' }), own);
    const p = reg.invoke('k', { password: 'param-secret' });
    const during = JSON.stringify(reg.inspect());
    await p;
    expect(during).not.toContain('secret');
    expect(JSON.stringify(reg.inspect())).not.toContain('secret');
  });

  test('returns a fresh snapshot every time', () => {
    const reg = createDeeplinkRegistry();
    const first = reg.inspect();
    first.global.push({ owner: 'x', order: 1 });
    expect(reg.inspect().global).toEqual([]);
  });
});

describe('subscribe', () => {
  test('fires once per change to handlers or waiting counts', async () => {
    const reg = createDeeplinkRegistry();
    let count = 0;
    reg.subscribe(() => {
      count += 1;
    });
    const p = reg.invoke('k'); // waiting 0 → 1
    expect(count).toBe(1);
    const unregister = reg.registerHandler('k', () => 'ok', own); // handler registered
    expect(count).toBe(2);
    await expect(p).resolves.toBe('ok'); // batch flush: waiting 1 → 0
    expect(count).toBe(3);
    await reg.invoke('k'); // ran at once: nothing changed
    expect(count).toBe(3);
    const unregisterG = reg.registerGlobalHandler((_ctx, next) => next(), { owner: 'g' }); // 4
    unregisterG(); // 5
    unregisterG(); // no-op
    unregister(); // 6
    unregister(); // no-op
    expect(count).toBe(6);
    const controller = new AbortController();
    const p2 = reg.invoke('x', undefined, { signal: controller.signal }); // waiting 0 → 1
    controller.abort(new Error('stop')); // waiting 1 → 0
    await expect(p2).rejects.toThrow('stop');
    expect(count).toBe(8);
  });

  test('a listener reading inspect() sees the change already applied', () => {
    const reg = createDeeplinkRegistry();
    const seen: number[] = [];
    reg.subscribe(() => seen.push(reg.inspect().keys.length));
    reg.registerHandler('a', () => 1, own);
    reg.registerHandler('b', () => 1, own);
    expect(seen).toEqual([1, 2]);
  });

  test('a throwing listener is isolated and reported in dev', async () => {
    const reg = createDeeplinkRegistry();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('listener');
    reg.subscribe(() => {
      throw boom;
    });
    const second = vi.fn();
    reg.subscribe(second);
    expect(() => reg.registerHandler('k', () => 'ok', own)).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('[daas-toolbox] deeplink subscriber threw', boom);
    await expect(reg.invoke('k')).resolves.toBe('ok');
  });

  test('a waiting call aborted by a subscriber during the flush never runs its handler', async () => {
    const reg = createDeeplinkRegistry();
    const controller = new AbortController();
    const p = reg.invoke('k', undefined, { signal: controller.signal });
    const assertion = expect(p).rejects.toThrow('stop');
    reg.subscribe(() => {
      const status = reg.inspect().keys.find((s) => s.key === 'k');
      if (status?.waiting === 0) controller.abort(new Error('stop'));
    });
    const handler = vi.fn(() => 'ran');
    reg.registerHandler('k', handler, own);
    await assertion;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  test('unsubscribe stops notifications and is idempotent', () => {
    const reg = createDeeplinkRegistry();
    const listener = vi.fn();
    const unsubscribe = reg.subscribe(listener);
    reg.registerHandler('a', () => 1, own);
    unsubscribe();
    unsubscribe();
    reg.registerHandler('b', () => 1, own);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
