import { describe, expect, expectTypeOf, test } from 'vitest';
import { deeplink } from '../index';
import { createDeeplinkRegistry } from '../registry';
import { createAppDeeplinks } from '../typed';

interface OrderParams {
  id: string;
  tab?: 'items' | 'history';
}

interface TestDeeplinks {
  'orders.open': { params: OrderParams; result: { opened: boolean } };
  'auth.reauth': { params: undefined; result: { token: string } };
  'ui.ping': { result: string };
  'ui.close': { params?: { force: boolean } };
}

const own = { owner: 'test' };

describe('createAppDeeplinks (runtime)', () => {
  test('a typed invoke runs the chain and returns its result', async () => {
    const dl = createAppDeeplinks<TestDeeplinks>(createDeeplinkRegistry());
    dl.registerHandler('orders.open', async (ctx) => ({ opened: ctx.input.id === '42' }), own);
    await expect(dl.invoke('orders.open', { id: '42' })).resolves.toEqual({ opened: true });
  });

  test('typed handlers chain in order', async () => {
    const dl = createAppDeeplinks<TestDeeplinks>(createDeeplinkRegistry());
    dl.registerHandler(
      'orders.open',
      (ctx) => ({ opened: (ctx.params as OrderParams).tab === 'items' }),
      { owner: 'orders', order: 50 },
    );
    dl.registerHandler(
      'orders.open',
      (ctx, next) => next({ ...ctx, params: { ...ctx.input, tab: 'items' } }),
      { owner: 'tabs', order: 10 },
    );
    await expect(dl.invoke('orders.open', { id: '1' })).resolves.toEqual({ opened: true });
  });

  test('params can be omitted when the contract allows it', async () => {
    const dl = createAppDeeplinks<TestDeeplinks>(createDeeplinkRegistry());
    dl.registerHandler('auth.reauth', () => ({ token: 't' }), own);
    dl.registerHandler('ui.ping', () => 'pong', own);
    await expect(dl.invoke('auth.reauth')).resolves.toEqual({ token: 't' });
    await expect(dl.invoke('ui.ping')).resolves.toBe('pong');
  });

  test('options pass through to the handler', async () => {
    const dl = createAppDeeplinks<TestDeeplinks>(createDeeplinkRegistry());
    let seenOptions: unknown;
    dl.registerHandler(
      'ui.ping',
      (ctx) => {
        seenOptions = ctx.options;
        return 'pong';
      },
      own,
    );
    const options = { timeout: 1000, source: 'test' };
    await dl.invoke('ui.ping', undefined, options);
    expect(seenOptions).toBe(options);
  });

  test('has reflects registration', () => {
    const dl = createAppDeeplinks<TestDeeplinks>(createDeeplinkRegistry());
    expect(dl.has('ui.ping')).toBe(false);
    const unregister = dl.registerHandler('ui.ping', () => 'pong', own);
    expect(dl.has('ui.ping')).toBe(true);
    unregister();
    expect(dl.has('ui.ping')).toBe(false);
  });

  test('typed and untyped callers share the global registry by default', async () => {
    const dl = createAppDeeplinks<TestDeeplinks>();
    const unregister = dl.registerHandler('ui.ping', () => 'pong', own);
    await expect(deeplink.invoke('ui.ping')).resolves.toBe('pong');
    unregister();
  });

  test('returns the same facade for the same registry, so it is safe to call during render', () => {
    const reg = createDeeplinkRegistry();
    expect(createAppDeeplinks<TestDeeplinks>(reg)).toBe(createAppDeeplinks<TestDeeplinks>(reg));
    expect(createAppDeeplinks()).toBe(createAppDeeplinks());
    expect(createAppDeeplinks(reg)).not.toBe(createAppDeeplinks());
  });
});

describe('createAppDeeplinks (types, checked by tsc)', () => {
  test('contract types are enforced and inferred', () => {
    // Never called: these lines only need to type-check (or fail to, under @ts-expect-error).
    const typeChecks = () => {
      const dl = createAppDeeplinks<TestDeeplinks>();

      expectTypeOf(dl.invoke('orders.open', { id: '1' })).resolves.toEqualTypeOf<{
        opened: boolean;
      }>();
      expectTypeOf(dl.invoke('auth.reauth')).resolves.toEqualTypeOf<{ token: string }>();
      expectTypeOf(dl.invoke('ui.ping')).resolves.toEqualTypeOf<string>();
      expectTypeOf(dl.invoke('ui.close')).resolves.toEqualTypeOf<void>();

      // interface-typed params are accepted
      const params: OrderParams = { id: '1' };
      dl.invoke('orders.open', params);

      // @ts-expect-error unknown key
      dl.invoke('orders.opne', { id: '1' });
      // @ts-expect-error misspelled param
      dl.invoke('orders.open', { idd: '1' });
      // @ts-expect-error params are required for this key
      dl.invoke('orders.open');

      dl.registerHandler(
        'orders.open',
        (ctx, next) => {
          expectTypeOf(ctx.input).toEqualTypeOf<OrderParams>();
          expectTypeOf(ctx.params).toBeUnknown();
          expectTypeOf(next).returns.resolves.toBeUnknown();
          return next();
        },
        own,
      );
      dl.registerHandler(
        'auth.reauth',
        (ctx) => {
          expectTypeOf(ctx.input).toEqualTypeOf<undefined>();
          return { token: 't' };
        },
        own,
      );
      // @ts-expect-error unknown key on registerHandler
      dl.registerHandler('orders.opne', () => null, own);
      // @ts-expect-error owner is required
      dl.registerHandler('ui.ping', () => 'pong', {});

      // untyped fallback: any string key, unknown result
      const loose = createAppDeeplinks();
      expectTypeOf(loose.invoke('anything', { a: 1 })).resolves.toBeUnknown();
    };
    expect(typeChecks).toBeTypeOf('function');
  });
});

describe('createAppDeeplinks (global handlers and tracking)', () => {
  test('registerGlobalHandler, inspect and subscribe reach the underlying registry', async () => {
    const reg = createDeeplinkRegistry();
    const dl = createAppDeeplinks<TestDeeplinks>(reg);
    let changes = 0;
    const unsubscribe = dl.subscribe(() => {
      changes += 1;
    });
    const unregisterGlobal = dl.registerGlobalHandler(
      async (_ctx, next) => `[${String(await next())}]`,
      { owner: 'wrap' },
    );
    dl.registerHandler('ui.ping', () => 'pong', { owner: 'ping' });
    await expect(dl.invoke('ui.ping')).resolves.toBe('[pong]');
    expect(dl.inspect()).toEqual(reg.inspect());
    expect(dl.inspect().global).toEqual([{ owner: 'wrap', order: 0 }]);
    expect(changes).toBe(2);
    unregisterGlobal();
    unsubscribe();
  });
});
