import { getGlobalRegistry } from "./global";
import type {
  DeeplinkContractMap,
  DeeplinkHandler,
  DeeplinkRegistry,
  TypedDeeplinkRegistry,
  UntypedDeeplinks,
} from "./types";

/** One facade per registry, so `createAppDeeplinks()` is identity-stable (safe in render and hook deps). */
const facades = new WeakMap<DeeplinkRegistry, TypedDeeplinkRegistry<UntypedDeeplinks>>();

/**
 * Typed facade over a deeplink registry (the shared global one by default). Mirrors daas-sdk
 * `createAppEvents<T>()`: MFEs import the contract map **type-only**, so there is no runtime
 * coupling between them. Typed and untyped callers share the same registry.
 *
 * @example
 * import type { AppDeeplinks } from '@company/contracts';
 * const dl = createAppDeeplinks<AppDeeplinks>();
 * const res = await dl.invoke('orders.open', { id: '42' }); // res: { opened: boolean }
 */
export function createAppDeeplinks<M extends DeeplinkContractMap<M> = UntypedDeeplinks>(
  registry: DeeplinkRegistry = getGlobalRegistry(),
): TypedDeeplinkRegistry<M> {
  let facade = facades.get(registry);
  if (!facade) {
    facade = {
      // Contract types exist only at compile time; typed and untyped handlers are identical at runtime.
      registerHandler: (key, handler, options) =>
        registry.registerHandler(key, handler as unknown as DeeplinkHandler, options),
      invoke: (key, params, options) => registry.invoke(key, params as Record<string, unknown> | undefined, options),
      has: (key) => registry.has(key),
      registerGlobalHandler: (handler, options) => registry.registerGlobalHandler(handler, options),
      inspect: () => registry.inspect(),
      subscribe: (listener) => registry.subscribe(listener),
    };
    facades.set(registry, facade);
  }
  // Safe: the facade has no per-M state; M only narrows the compile-time signatures.
  return facade as unknown as TypedDeeplinkRegistry<M>;
}
