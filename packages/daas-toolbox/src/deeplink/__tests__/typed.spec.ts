import { describe, expect, expectTypeOf, test } from 'vitest';
import { deeplink } from '../index';
import { createDeeplinkRegistry } from '../registry';
import { createAppDeeplinks } from '../typed';
import type { DeeplinkHandlerContext } from '../types';

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

describe('createAppDeeplinks (runtime)', () => {
  test('a typed invoke reaches the typed handler and returns its result', async () => {
    const dl = createAppDeeplinks<TestDeeplinks>(createDeeplinkRegistry());
    dl.handle('orders.open', async ({ id }) => ({ opened: id === '42' }));
    await expect(dl.invoke('orders.open', { id: '42' })).resolves.toEqual({ opened: true });
  });

  test('params can be omitted when the contract allows it', async () => {
    const dl = createAppDeeplinks<TestDeeplinks>(createDeeplinkRegistry());
    dl.handle('auth.reauth', () => ({ token: 't' }));
    dl.handle('ui.ping', () => 'pong');
    await expect(dl.invoke('auth.reauth')).resolves.toEqual({ token: 't' });
    await expect(dl.invoke('ui.ping')).resolves.toBe('pong');
  });

  test('options and ctx pass through to the handler', async () => {
    const dl = createAppDeeplinks<TestDeeplinks>(createDeeplinkRegistry());
    let seen: DeeplinkHandlerContext | undefined;
    dl.handle('ui.ping', (_params, ctx) => {
      seen = ctx;
      return 'pong';
    });
    const options = { timeout: 1000, source: 'test' };
    await dl.invoke('ui.ping', undefined, options);
    expect(seen?.options).toBe(options);
  });

  test('has reflects registration', () => {
    const dl = createAppDeeplinks<TestDeeplinks>(createDeeplinkRegistry());
    expect(dl.has('ui.ping')).toBe(false);
    const off = dl.handle('ui.ping', () => 'pong');
    expect(dl.has('ui.ping')).toBe(true);
    off();
    expect(dl.has('ui.ping')).toBe(false);
  });

  test('typed and untyped callers share the global registry by default', async () => {
    const dl = createAppDeeplinks<TestDeeplinks>();
    const off = dl.handle('ui.ping', () => 'pong');
    await expect(deeplink.invoke('ui.ping')).resolves.toBe('pong');
    off();
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

      dl.handle('orders.open', (p, ctx) => {
        expectTypeOf(p).toEqualTypeOf<OrderParams>();
        expectTypeOf(ctx).toEqualTypeOf<DeeplinkHandlerContext>();
        return { opened: true };
      });
      // @ts-expect-error result does not match the contract
      dl.handle('orders.open', () => ({ opened: 'yes' }));

      // untyped fallback: any string key, unknown result
      const loose = createAppDeeplinks();
      expectTypeOf(loose.invoke('anything', { a: 1 })).resolves.toBeUnknown();
    };
    expect(typeChecks).toBeTypeOf('function');
  });
});
