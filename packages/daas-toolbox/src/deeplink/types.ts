/** Options accepted by `deeplink.invoke`. Mirrors the open shape of daas-sdk `NavigateOptions`. */
export interface DeeplinkInvokeOptions {
  /**
   * Milliseconds from `invoke()` until the call settles, covering both waiting for a first key
   * handler and running the chain. `Infinity` disables the timeout.
   * @default 10000
   */
  timeout?: number;
  /** Caller-side cancellation. Aborting rejects the call with `signal.reason`. */
  signal?: AbortSignal;
  /** Any extra caller options are passed to every handler untouched. */
  [key: string]: unknown;
}

/** Params passed by the caller; same shape as daas-sdk `navigate` params. */
export type DeeplinkParams = Record<string, unknown> | undefined;

/**
 * Where a timed-out call was:
 * - `'waiting'`: no key handler had been registered yet
 * - `'running'`: the chain started but did not settle in time
 */
export type DeeplinkPhase = 'waiting' | 'running';

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

/**
 * One handler in a deeplink chain (onion middleware). `return await next(ctx)` to continue,
 * return a value without calling `next` to short-circuit, or throw to reject the call.
 */
export type DeeplinkHandler = (ctx: DeeplinkCallContext, next: DeeplinkNext) => unknown;

/** Options for `registerHandler` / `registerGlobalHandler` / `useDeeplinkHandler`. */
export interface DeeplinkRegisterOptions {
  /**
   * Required. Identifies the registering MFE (e.g. 'orders', or 'orders:load' when one MFE
   * registers several handlers on a key). Registering again with the same owner replaces that
   * owner's handler, so a re-running side effect never stacks duplicates.
   */
  owner: string;
  /**
   * Lower runs first (outermost); ties keep registration order. Suggested bands: gates 0–99,
   * enrichers 100–199, producers 500+.
   * @default 0
   */
  order?: number;
}

/** One handler as reported by `inspect()`. */
export interface DeeplinkStepStatus {
  owner: string;
  order: number;
}

/** One key as reported by `inspect()`. */
export interface DeeplinkStatus {
  key: string;
  /** Key handlers in execution order. */
  steps: DeeplinkStepStatus[];
  /** Calls currently waiting for a first key handler. */
  waiting: number;
}

/** Snapshot returned by `inspect()`; never contains params or results. */
export interface DeeplinkInspection {
  /** Global handlers in execution order. */
  global: DeeplinkStepStatus[];
  /** Keys with at least one key handler or waiting call, sorted by key. */
  keys: DeeplinkStatus[];
}

/** A deeplink registry. Use the shared `deeplink` instance; create your own only in tests. */
export interface DeeplinkRegistry {
  /**
   * Register a key handler. Handlers run by ascending `order`; the same `owner` replaces its own
   * handler. In React components prefer `useDeeplinkHandler`, which unregisters on unmount.
   * @returns an identity-safe `unregister` that removes only this registration
   */
  registerHandler(
    key: string,
    handler: DeeplinkHandler,
    options: DeeplinkRegisterOptions,
  ): () => void;
  /**
   * Run the chain for `key`, waiting for a first key handler if none is registered.
   * @example
   * const res = await deeplink.invoke<{ opened: boolean }>('orders.open', { id: '42' });
   */
  invoke<TResult = unknown>(
    key: string,
    params?: Record<string, unknown>,
    options?: DeeplinkInvokeOptions,
  ): Promise<TResult>;
  /** Whether at least one key handler is registered for `key` (global handlers don't count). */
  has(key: string): boolean;
}

/**
 * One deeplink's contract: what the caller sends and what the chain returns.
 * Omit `params` (or make it optional / `undefined`) for keys callers may invoke without params;
 * omit `result` for chains that return nothing.
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

/**
 * Handler context for a typed key: `input` is the contract's params; everything else is unchanged.
 * (An `Omit` intersection, because an interface-typed `input` is not assignable to
 * `Record<string, unknown>`.)
 */
export type TypedDeeplinkCallContext<C> = Omit<DeeplinkCallContext, 'input'> & {
  readonly input: DeeplinkParamsOf<C>;
};

/** `next` for a typed handler: accepts the typed context. */
export type TypedDeeplinkNext<C> = (ctx?: TypedDeeplinkCallContext<C>) => Promise<unknown>;

/**
 * A handler for a typed key. Only the chain's ends are typed: `ctx.input` is the contract's params,
 * while `ctx.params` and `next()`'s result are `unknown` (a handler can't know its position).
 */
export type TypedDeeplinkHandler<C> = (
  ctx: TypedDeeplinkCallContext<C>,
  next: TypedDeeplinkNext<C>,
) => unknown;

/**
 * Typed view of a deeplink registry, created by `createAppDeeplinks<M>()`. Same runtime object
 * semantics as `DeeplinkRegistry`; only the types differ.
 */
export interface TypedDeeplinkRegistry<M extends DeeplinkContractMap<M>> {
  /** Register a key handler; `ctx.input` is typed from the contract. */
  registerHandler<K extends keyof M & string>(
    key: K,
    handler: TypedDeeplinkHandler<M[K]>,
    options: DeeplinkRegisterOptions,
  ): () => void;
  /** Invoke `key`; params are checked and the result type is inferred from the contract. */
  invoke<K extends keyof M & string>(
    key: K,
    ...args: DeeplinkInvokeArgs<M[K]>
  ): Promise<DeeplinkResultOf<M[K]>>;
  /** Whether at least one key handler is registered for `key`. */
  has(key: keyof M & string): boolean;
}

/** Contract map used when `createAppDeeplinks()` is called without a type argument. */
export type UntypedDeeplinks = Record<string, { params?: object; result?: unknown }>;
