/** Options accepted by `deeplink.invoke`. Mirrors the open shape of daas-sdk `NavigateOptions`. */
export interface DeeplinkInvokeOptions {
  /**
   * Milliseconds from `invoke()` until the call settles, covering both waiting for a handler
   * and running it. `Infinity` disables the timeout.
   * @default 10000
   */
  timeout?: number;
  /** Caller-side cancellation. Aborting rejects the call with `signal.reason`. */
  signal?: AbortSignal;
  /** Any extra caller options are passed to the handler untouched. */
  [key: string]: unknown;
}

/** Second argument passed to every deeplink handler. */
export interface DeeplinkHandlerContext {
  /** The options object the caller passed (`{}` when omitted). */
  options: DeeplinkInvokeOptions;
  /** Aborted when the call times out or the caller aborts. Pass it to `fetch` and similar APIs. */
  signal: AbortSignal;
}

/** Params passed by the caller; same shape as daas-sdk `navigate` params. */
export type DeeplinkParams = Record<string, unknown> | undefined;

/**
 * Handles one deeplink key. May be sync or async; its return value (or rejection) is what
 * `deeplink.invoke` resolves (or rejects) with.
 */
export type DeeplinkHandler<TResult = unknown> = (
  params: DeeplinkParams,
  ctx: DeeplinkHandlerContext,
) => TResult | Promise<TResult>;

/**
 * Where a timed-out call was:
 * - `'waiting'`: no handler had received it yet (owner MFE not loaded, or not handling this key)
 * - `'running'`: a handler received it but did not settle in time
 */
export type DeeplinkPhase = 'waiting' | 'running';

/** A deeplink handler registry. Use the shared `deeplink` instance; create your own only in tests. */
export interface DeeplinkRegistry {
  /**
   * Register `handler` for `key`, replacing any existing handler.
   * @returns a disposer that removes this registration only if it is still the current one
   */
  handle<TResult>(key: string, handler: DeeplinkHandler<TResult>): () => void;
  /**
   * Invoke the handler for `key`, waiting for one to register if needed.
   * @example
   * const res = await deeplink.invoke<{ opened: boolean }>('orders.open', { id: '42' });
   */
  invoke<TResult = unknown>(
    key: string,
    params?: Record<string, unknown>,
    options?: DeeplinkInvokeOptions,
  ): Promise<TResult>;
  /** Whether a handler is currently registered for `key`. */
  has(key: string): boolean;
}
