import { renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { deeplink } from '../../../deeplink';
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

  test('a call made before mount is delivered once the hook registers', async () => {
    const p = deeplink.invoke('hook.early', { id: 7 });
    const { unmount } = renderHook(() => useDeeplinkHandler('hook.early', (params) => params?.id));
    await expect(p).resolves.toBe(7);
    unmount();
  });
});
