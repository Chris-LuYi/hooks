import { useEffect } from 'react';
import { deeplink } from '../../deeplink';
import type {
  DeeplinkContractMap,
  DeeplinkHandler,
  DeeplinkRegisterOptions,
  TypedDeeplinkHandler,
  TypedDeeplinkRegistry,
} from '../../deeplink/types';
import useLatest from '../useLatest';

/** The part of a registry this hook needs; `deeplink` and typed facades both provide it. */
interface RegisterTarget {
  registerHandler(
    key: string,
    handler: DeeplinkHandler,
    options: DeeplinkRegisterOptions,
  ): () => void;
}

type UntypedArgs = [key: string, handler: DeeplinkHandler, options: DeeplinkRegisterOptions];
type TypedArgs = [
  registry: RegisterTarget,
  key: string,
  handler: DeeplinkHandler,
  options: DeeplinkRegisterOptions,
];

/**
 * Register a deeplink handler for the lifetime of the component — the recommended way for MFEs,
 * because it unregisters automatically on unmount.
 *
 * Registers once per `key` / `owner` / `order` and always calls the latest `handler`, so
 * re-renders never re-register. Calls made before the effect runs are queued by the registry
 * until it does. Unregisters on unmount or when `key`, `owner` or `order` changes. Safe under
 * React StrictMode.
 *
 * Use `deeplink.registerHandler` instead outside React, or in an MFE whose React version differs
 * from the toolbox's shared copy.
 *
 * @example
 * useDeeplinkHandler('orders.open', async (ctx) => {
 *   const order = await api.getOrder((ctx.params as { id: string }).id, { signal: ctx.signal });
 *   openOrderDrawer(order);
 *   return { opened: true };
 * }, { owner: 'orders', order: 500 });
 */
function useDeeplinkHandler(
  key: string,
  handler: DeeplinkHandler,
  options: DeeplinkRegisterOptions,
): void;
/**
 * Typed form: `ctx.input` is typed from the contract of a registry created by
 * `createAppDeeplinks<M>()`.
 *
 * @example
 * const dl = createAppDeeplinks<AppDeeplinks>();
 * useDeeplinkHandler(dl, 'orders.open', (ctx) => ({ opened: ctx.input.id === '42' }), {
 *   owner: 'orders',
 * });
 */
function useDeeplinkHandler<M extends DeeplinkContractMap<M>, K extends keyof M & string>(
  registry: TypedDeeplinkRegistry<M>,
  key: K,
  handler: TypedDeeplinkHandler<M[K]>,
  options: DeeplinkRegisterOptions,
): void;
function useDeeplinkHandler(...args: UntypedArgs | TypedArgs): void {
  // A string first argument means the untyped form (the global registry).
  const [registry, key, handler, options]: TypedArgs =
    typeof args[0] === 'string' ? [deeplink, ...(args as UntypedArgs)] : (args as TypedArgs);
  const { owner, order } = options;
  const handlerRef = useLatest(handler);

  // biome-ignore lint/correctness/useExhaustiveDependencies: handlerRef is a stable ref; re-registering on every handler change is exactly what this hook avoids
  useEffect(
    () => registry.registerHandler(key, (ctx, next) => handlerRef.current(ctx, next), { owner, order }),
    [registry, key, owner, order],
  );
}

export default useDeeplinkHandler;
