import { getGlobalRegistry } from './global';

/**
 * The page-wide deeplink handler registry, shared by every MFE.
 * @example
 * // owner MFE
 * const off = deeplink.handle('orders.open', async (params) => ({ opened: true }));
 * // any MFE
 * const res = await deeplink.invoke<{ opened: boolean }>('orders.open', { id: '42' });
 */
export const deeplink = getGlobalRegistry();

export { DeeplinkTimeoutError, isDeeplinkTimeoutError } from './errors';
export { createDeeplinkRegistry } from './registry';
export type {
  DeeplinkHandler,
  DeeplinkHandlerContext,
  DeeplinkInvokeOptions,
  DeeplinkParams,
  DeeplinkPhase,
  DeeplinkRegistry,
} from './types';
