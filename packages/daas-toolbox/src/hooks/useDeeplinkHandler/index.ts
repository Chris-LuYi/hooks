import { useEffect } from 'react';
import { deeplink } from '../../deeplink';
import type {
  DeeplinkContractMap,
  DeeplinkHandler,
  TypedDeeplinkHandler,
  TypedDeeplinkRegistry,
} from '../../deeplink/types';
import useLatest from '../useLatest';

/** The part of a registry this hook needs; both `deeplink` and typed facades provide it at runtime. */
interface HandleTarget {
  handle(key: string, handler: DeeplinkHandler<unknown>): () => void;
}

type UntypedArgs = [key: string, handler: DeeplinkHandler<unknown>];
type TypedArgs = [registry: HandleTarget, key: string, handler: DeeplinkHandler<unknown>];

/**
 * Register a deeplink handler for the lifetime of the component.
 *
 * Registers once per `key` and always calls the latest `handler`, so re-renders never
 * re-register. Calls made before the effect runs are queued by the registry until it does.
 * Disposes on unmount or when `key` changes. Safe under React StrictMode.
 *
 * @example
 * useDeeplinkHandler('orders.open', async (params, { signal }) => {
 *   const order = await api.getOrder(params?.id as string, { signal });
 *   openOrderDrawer(order);
 *   return { opened: true };
 * });
 */
function useDeeplinkHandler<TResult>(key: string, handler: DeeplinkHandler<TResult>): void;
/**
 * Typed form: params and return value are checked against the contract of a registry created by
 * `createAppDeeplinks<M>()`.
 *
 * @example
 * const dl = createAppDeeplinks<AppDeeplinks>();
 * useDeeplinkHandler(dl, 'orders.open', async ({ id }) => ({ opened: true }));
 */
function useDeeplinkHandler<M extends DeeplinkContractMap<M>, K extends keyof M & string>(
  registry: TypedDeeplinkRegistry<M>,
  key: K,
  handler: TypedDeeplinkHandler<M[K]>,
): void;
function useDeeplinkHandler(...args: UntypedArgs | TypedArgs): void {
  const [registry, key, handler]: TypedArgs = args.length === 2 ? [deeplink, ...args] : args;
  const handlerRef = useLatest(handler);

  // biome-ignore lint/correctness/useExhaustiveDependencies: handlerRef is a stable ref; re-registering on every handler change is exactly what this hook avoids
  useEffect(
    () => registry.handle(key, (params, ctx) => handlerRef.current(params, ctx)),
    [registry, key],
  );
}

export default useDeeplinkHandler;
