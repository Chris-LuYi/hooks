import { useEffect } from 'react';
import { deeplink } from '../../deeplink';
import type { DeeplinkHandler } from '../../deeplink/types';
import useLatest from '../useLatest';

/**
 * Register a deeplink handler for the lifetime of the component.
 *
 * Registers once per `key` and always calls the latest `handler`, so re-renders never
 * re-register (and an invoke arriving mid-render is never missed). Disposes on unmount
 * or when `key` changes. Safe under React StrictMode.
 *
 * @example
 * useDeeplinkHandler('orders.open', async (params, { signal }) => {
 *   const order = await api.getOrder(params?.id as string, { signal });
 *   openOrderDrawer(order);
 *   return { opened: true };
 * });
 */
function useDeeplinkHandler<TResult>(key: string, handler: DeeplinkHandler<TResult>): void {
  const handlerRef = useLatest(handler);

  // biome-ignore lint/correctness/useExhaustiveDependencies: handlerRef is a stable ref; re-registering on every handler change is exactly what this hook avoids
  useEffect(
    () => deeplink.handle<TResult>(key, (params, ctx) => handlerRef.current(params, ctx)),
    [key],
  );
}

export default useDeeplinkHandler;
