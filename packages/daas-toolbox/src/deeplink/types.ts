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

/**
 * One deeplink's contract: what the caller sends and what the handler returns.
 * Omit `params` (or make it optional / `undefined`) for keys callers may invoke without params;
 * omit `result` for handlers that return nothing.
 */
export interface DeeplinkContract {
  params?: object;
  result?: unknown;
}

/**
 * A map of deeplink key → contract, usually an `interface` in a shared contracts module that MFEs
 * import type-only. Written as a self-referential mapped type so plain interfaces (which have no
 * index signature) satisfy it.
 * @example
 * export interface AppDeeplinks {
 *   'orders.open': { params: { id: string }; result: { opened: boolean } };
 *   'auth.reauth': { result: { token: string } };
 * }
 */
export type DeeplinkContractMap<M> = { [K in keyof M]: DeeplinkContract };

/** The `params` type of a contract (`undefined` when the contract declares none). */
export type DeeplinkParamsOf<C> = 'params' extends keyof C ? C['params' & keyof C] : undefined;

/** The `result` type of a contract (`void` when the contract declares none). */
export type DeeplinkResultOf<C> = 'result' extends keyof C ? C['result' & keyof C] : void;

/** `invoke` arguments after the key: `params` is required unless the contract allows `undefined`. */
export type DeeplinkInvokeArgs<C> = undefined extends DeeplinkParamsOf<C>
  ? [params?: DeeplinkParamsOf<C>, options?: DeeplinkInvokeOptions]
  : [params: DeeplinkParamsOf<C>, options?: DeeplinkInvokeOptions];

/** A handler typed by its contract. */
export type TypedDeeplinkHandler<C> = (
  params: DeeplinkParamsOf<C>,
  ctx: DeeplinkHandlerContext,
) => DeeplinkResultOf<C> | Promise<DeeplinkResultOf<C>>;

/**
 * Typed view of a deeplink registry, created by `createAppDeeplinks<M>()`. Same runtime object
 * semantics as `DeeplinkRegistry`; only the types differ.
 */
export interface TypedDeeplinkRegistry<M extends DeeplinkContractMap<M>> {
  /** Register a handler whose params and return value are checked against the contract. */
  handle<K extends keyof M & string>(key: K, handler: TypedDeeplinkHandler<M[K]>): () => void;
  /** Invoke `key`; params are checked and the result type is inferred from the contract. */
  invoke<K extends keyof M & string>(
    key: K,
    ...args: DeeplinkInvokeArgs<M[K]>
  ): Promise<DeeplinkResultOf<M[K]>>;
  /** Whether a handler is currently registered for `key`. */
  has(key: keyof M & string): boolean;
}

/** Contract map used when `createAppDeeplinks()` is called without a type argument. */
export type UntypedDeeplinks = Record<string, { params?: object; result?: unknown }>;

/** Position of a handler within one call's chain. */
export interface DeeplinkStepInfo {
  /** 0-based position in this call's chain snapshot. */
  index: number;
  /** Number of handlers in this call's chain snapshot. */
  count: number;
  /** The handler's owner. */
  owner: string;
  /** Whether this is a global handler (`registerGlobalHandler`) rather than a key handler. */
  global: boolean;
}

/**
 * Context each handler receives. `key`, `input`, `options`, `signal` and `step` are owned by the
 * runtime: values passed for them through `next(ctx)` are overwritten.
 */
export interface DeeplinkCallContext {
  /** The invoked key. */
  readonly key: string;
  /** Current payload. Starts as the caller's params; upstream handlers may replace it via next(ctx). */
  params: unknown;
  /** The caller's original params; never changed by handlers. */
  readonly input: DeeplinkParams;
  /** The options the caller passed (`{}` when omitted). */
  readonly options: DeeplinkInvokeOptions;
  /** Aborted on timeout or caller abort; the same signal for every handler of the call. */
  readonly signal: AbortSignal;
  /** Position of the handler receiving this context. */
  readonly step: DeeplinkStepInfo;
  /** Scratch space shared by every handler of this call. */
  state: Record<string, unknown>;
}

/**
 * Continue the chain. Pass a new context to change what downstream handlers see. Resolves to
 * what downstream returned; after the last handler, to that context's `params`.
 */
export type DeeplinkNext = (ctx?: DeeplinkCallContext) => Promise<unknown>;
