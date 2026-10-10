import { getGlobalRegistry } from "./global";

/**
 * The page-wide deeplink registry, shared by every MFE.
 * @example
 * // in components prefer useDeeplinkHandler; outside React:
 * const unregister = deeplink.registerHandler('orders.open', (ctx) => openOrder(ctx.params), {
 *   owner: 'orders',
 * });
 * // any MFE
 * const res = await deeplink.invoke<{ opened: boolean }>('orders.open', { id: '42' });
 */
export const deeplink = getGlobalRegistry();

export { DeeplinkTimeoutError, isDeeplinkTimeoutError } from "./errors";
export { createDeeplinkRegistry } from "./registry";
export { createAppDeeplinks } from "./typed";
export type {
  DeeplinkCallContext,
  DeeplinkContract,
  DeeplinkContractMap,
  DeeplinkHandler,
  DeeplinkInspection,
  DeeplinkInvokeArgs,
  DeeplinkInvokeOptions,
  DeeplinkNext,
  DeeplinkParams,
  DeeplinkParamsOf,
  DeeplinkPhase,
  DeeplinkRegisterOptions,
  DeeplinkRegistry,
  DeeplinkResultOf,
  DeeplinkStatus,
  DeeplinkStepInfo,
  DeeplinkStepStatus,
  TypedDeeplinkCallContext,
  TypedDeeplinkHandler,
  TypedDeeplinkNext,
  TypedDeeplinkRegistry,
  UntypedDeeplinks,
} from "./types";
