import { renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAppDeeplinks, deeplink } from '../../../deeplink';
import useDeeplinkHandler from '../index';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDeeplinkHandler', () => {
  test('registers on mount and disposes on unmount', async () => {
    const { unmount } = renderHook(() => useDeeplinkHandler('hook.mount', () => 'ok'));
    expect(deeplink.has('hook.mount')).toBe(true);
    await expect(deeplink.invoke('hook.mount')).resolves.toBe('ok');
    unmount();
    expect(deeplink.has('hook.mount')).toBe(false);
  });

  test('uses the latest handler closure without re-registering', async () => {
    const handle = vi.spyOn(deeplink, 'handle');
    const { rerender, unmount } = renderHook(
      ({ value }) => useDeeplinkHandler('hook.latest', () => value),
      { initialProps: { value: 1 } },
    );
    rerender({ value: 2 });
    await expect(deeplink.invoke('hook.latest')).resolves.toBe(2);
    expect(handle).toHaveBeenCalledTimes(1);
    unmount();
  });

  test('changing the key disposes the old key and registers the new one', () => {
    const { rerender, unmount } = renderHook(({ k }) => useDeeplinkHandler(k, () => k), {
      initialProps: { k: 'hook.key.a' },
    });
    expect(deeplink.has('hook.key.a')).toBe(true);
    rerender({ k: 'hook.key.b' });
    expect(deeplink.has('hook.key.a')).toBe(false);
    expect(deeplink.has('hook.key.b')).toBe(true);
    unmount();
    expect(deeplink.has('hook.key.b')).toBe(false);
  });

  test('StrictMode double-mount leaves exactly one live handler and no replace warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { unmount } = renderHook(() => useDeeplinkHandler('hook.strict', () => 'strict'), {
      wrapper: StrictMode,
    });
    expect(deeplink.has('hook.strict')).toBe(true);
    await expect(deeplink.invoke('hook.strict')).resolves.toBe('strict');
    expect(warn).not.toHaveBeenCalled();
    unmount();
    expect(deeplink.has('hook.strict')).toBe(false);
  });

  test('accepts a typed registry and infers params from its contract', async () => {
    interface HookDeeplinks {
      'hook.typed': { params: { n: number }; result: number };
    }
    const dl = createAppDeeplinks<HookDeeplinks>();
    const { unmount } = renderHook(() => useDeeplinkHandler(dl, 'hook.typed', ({ n }) => n * 2));
    await expect(dl.invoke('hook.typed', { n: 21 })).resolves.toBe(42);
    unmount();
    expect(dl.has('hook.typed')).toBe(false);
  });

  test('a call made before mount is delivered once the hook registers', async () => {
    const p = deeplink.invoke('hook.early', { id: 7 });
    const { unmount } = renderHook(() => useDeeplinkHandler('hook.early', (params) => params?.id));
    await expect(p).resolves.toBe(7);
    unmount();
  });
});
