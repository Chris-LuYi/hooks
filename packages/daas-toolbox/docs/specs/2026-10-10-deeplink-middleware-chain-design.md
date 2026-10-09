# Deeplink middleware chain — design

- **Date:** 2026-10-10
- **Status:** Draft, awaiting review
- **Branch:** `daas-hooks`
- **Supersedes:** in `2026-10-09-daas-toolbox-deeplink-design.md`, the `handle` API, the "Replace"
  duplicate rule, the `(params, ctx)` handler signature, and §4 rules 4, 5 and 10. Timeout,
  abort, the global singleton and errors carry over unchanged.

## 1. Goal

Let **several MFEs register handlers on the same deeplink**. The handlers run as an ordered
**middleware chain** in the onion style (`await next(ctx)`): each handler can transform the
payload on the way in and the result on the way out, and the final value goes back to the
caller. The host can **register global handlers** (logger, tracker) that wrap every deeplink,
and can **track registration status** for every deeplink.

### Decisions made during brainstorming

| Topic | Decision |
| --- | --- |
| Composition model | Onion middleware `(ctx, next) => …`; `await next(ctx)` continues the chain (Koa-style) |
| API names | `registerHandler(key, handler, options)` and `registerGlobalHandler(handler, options)`, each returning `unregister()` |
| Recommended MFE path | `useDeeplinkHandler(key, handler, options)`, which unregisters automatically on unmount |
| Plain functions stay public | For the host (boot-time global handlers), non-React code, tests, and MFEs on a different React version than the host (ADR-0004 reasoning) |
| Duplicates | `owner` is **required**. Registering again with the same owner replaces that owner's handler (dev warning), so a re-running side effect never stacks duplicates |
| Order | Explicit numeric `order` per handler (lower = outer); ties fall back to registration order |
| Partial chain | No handlers → wait until the timeout. One or more → run with whatever is present |
| Global handlers | `registerGlobalHandler` wraps every key's chain; always outermost; meant for the host |
| Observe events | Not needed |
| Host tracking | Read-only `inspect()` + `subscribe()` |

### Non-goals

- Host-declared chains or required owners.
- Observe or lifecycle event streams.
- Typing what passes between handlers (`ctx.params` and `next()`'s result are `unknown`).
- A hook-only API (see the "Plain functions stay public" decision).
- Pattern or URL keys, cross-iframe calls, params or result validation (unchanged from the first spec).

## 2. Public API

```ts
/** One handler in a deeplink chain. */
export type DeeplinkHandler = (ctx: DeeplinkCallContext, next: DeeplinkNext) => unknown;

/** Continue the chain. Pass a new context to change what downstream handlers see. */
export type DeeplinkNext = (ctx?: DeeplinkCallContext) => Promise<unknown>;

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

export interface DeeplinkRegisterOptions {
  /**
   * Required. Identifies the registering MFE (e.g. 'orders', or 'orders:load' when one MFE
   * registers several handlers on a key). Registering again with the same owner replaces that
   * owner's handler, so a re-running side effect never stacks duplicates.
   */
  owner: string;
  /** Lower runs first (outermost). @default 0 */
  order?: number;
}

export interface DeeplinkStepStatus {
  owner: string;
  order: number;
}

export interface DeeplinkStatus {
  key: string;
  /** Key handlers in execution order. */
  steps: DeeplinkStepStatus[];
  /** Calls currently waiting for a first key handler. */
  waiting: number;
}

export interface DeeplinkInspection {
  /** Global handlers in execution order. */
  global: DeeplinkStepStatus[];
  /** Keys with at least one key handler or waiting call, sorted by key. */
  keys: DeeplinkStatus[];
}

export interface DeeplinkRegistry {
  /** Register a key handler; returns an identity-safe `unregister`. */
  registerHandler(key: string, handler: DeeplinkHandler, options: DeeplinkRegisterOptions): () => void;
  /** Run the chain for `key` (waits for a first key handler if none is registered). */
  invoke<TResult = unknown>(
    key: string,
    params?: Record<string, unknown>,
    options?: DeeplinkInvokeOptions,
  ): Promise<TResult>;
  /** Whether at least one key handler is registered for `key` (global handlers don't count). */
  has(key: string): boolean;
  /** Register a global handler that wraps every key's chain; returns an identity-safe `unregister`. */
  registerGlobalHandler(handler: DeeplinkHandler, options: DeeplinkRegisterOptions): () => void;
  /** Read-only snapshot of global handlers and of every key with handlers or waiting calls. */
  inspect(): DeeplinkInspection;
  /** Called after any change to handlers or waiting counts. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}
```

`DeeplinkInvokeOptions`, `DeeplinkParams`, `DeeplinkTimeoutError`, `isDeeplinkTimeoutError`,
`createDeeplinkRegistry` and the global `deeplink` keep their current definitions. The old
`handle`, `DeeplinkHandler<TResult>` (`(params, ctx)`), `DeeplinkHandlerContext` and
`TypedDeeplinkHandler` are **removed**. Nothing has shipped, so the removal is free (§7).

### Example

```ts
// host boot: global logger wrapping every deeplink
deeplink.registerGlobalHandler(async (ctx, next) => {
  const t = Date.now();
  try {
    return await next();
  } finally {
    logger.info('deeplink', { key: ctx.key, ms: Date.now() - t });
  }
}, { owner: 'host-logger' });

// auth MFE: outermost key handler, gates and enriches the request
useDeeplinkHandler('orders.open', async (ctx, next) => {
  if (!hasRole('orders:view')) throw new ForbiddenError();
  return next({ ...ctx, params: { ...(ctx.params as object), userId: currentUser.id } });
}, { owner: 'auth', order: 10 });

// orders MFE: innermost, produces the result
useDeeplinkHandler('orders.open', (ctx) => loadOrder(ctx.params as { id: string; userId: string }),
  { owner: 'orders', order: 500 });

await deeplink.invoke('orders.open', { id: '42' });
```

## 3. Runtime behavior

### Chain

1. **Order.** Handlers are sorted by ascending `order`, ties by registration sequence. Index 0
   is the outermost: it runs first on the way in and last on the way out.
2. **Same owner replaces.** Registering with an `owner` that already has a handler for this key
   replaces that handler, taking the new `order` and the latest registration sequence. The old
   registration's `unregister` becomes a no-op. When `isDev`, this logs
   `console.warn('[daas-toolbox] deeplink "<key>" handler from owner "<owner>" replaced')`,
   which also flags side effects that re-register without cleanup.
3. **Payload handoff.** `next(newCtx)` passes `newCtx` to the next handler, and `next()` passes
   the current context. The runtime sets `step` on the context each handler receives; a `step`
   value supplied in `newCtx` is overwritten. `key`, `input`, `options` and `signal` are always
   the call's own values: if a handler passes different values, the runtime overwrites them.
4. **End of chain.** `next()` called by the last handler resolves to that context's `params`.
   A chain of transform-only handlers therefore returns the transformed payload to the caller.
5. **Short-circuit.** A handler that returns without calling `next` ends the chain. Its return
   value travels back out through the outer handlers. A throw or rejection rejects the call with
   that exact value, passed through unchanged as before.
6. **`next()` twice.** A second call to `next` from the same handler returns a rejected promise
   with `Error('[daas-toolbox] deeplink "<key>": next() called multiple times')`. The first
   call still runs.
7. **Sync and async.** Every handler runs inside a Promise chain, so a synchronous `throw`
   becomes a rejection. `invoke` throws synchronously only for an invalid key.

### Global handlers

G1. **Always outermost.** A call's chain is `[...global handlers, ...key handlers]`. Global
    handlers are sorted among themselves by the same `order` / registration-sequence rule
    (rule 1). `step.index` and `step.count` cover the full combined chain, and `step.global`
    tells the two kinds apart.
G2. **Owner replacement** (rule 2) applies within global handlers, separately from key handlers.
    The dev warning reads `[daas-toolbox] global handler from owner "<owner>" replaced`.
G3. **Global handlers don't satisfy the wait rule.** Rule 9 counts only key handlers: a call with
    no key handler waits even if global handlers exist, and `has(key)` ignores global handlers.
    Global handlers never trigger the batch flush (rule 10).
G4. **Snapshot.** Global handlers are part of the call's snapshot when it starts (rule 8).
    Registering or unregistering one mid-run doesn't change calls already running.
G5. **Who calls it.** Any code can, but it is meant for the host at boot (README says so). It works
    with or without React. No hook is provided.

### Calls

8. **Snapshot when a call starts running.** The chain is copied the moment the call starts.
   Handlers registered later don't join that call. Handlers unregistered or replaced later
   still finish it.
9. **Partial chains.** With zero key handlers the call waits until one is registered, the
   timeout fires (`DeeplinkTimeoutError`, phase `'waiting'`) or the caller aborts. With one or
   more it starts at once with the current chain.
10. **Batch flush.** Waiting calls for a key start **one microtask after** the first key handler
    is registered. Every registration in the same synchronous pass (for example, sibling MFE
    effects in one React commit) is therefore part of their snapshot. Calls queued after that
    microtask follow rule 9.
11. **Timeout and abort are unchanged.** One budget covers waiting plus the whole chain, and the
    phase is `'running'` once the call has started. `ctx.signal` is aborted on timeout or
    caller abort, a result that arrives late is dropped, invalid timeouts reject, and every
    settle path cleans up its timer, listener and queue entry.

### Validation (`registerHandler`, `registerGlobalHandler`)

12. Invalid key (`registerHandler` only) → `TypeError` (unchanged message).
13. `handler` not a function → `TypeError('[daas-toolbox] deeplink handler must be a function')`.
14. `order` given but not a finite number → `TypeError('[daas-toolbox] deeplink order must be a finite number, got <value>')`.
15. `owner` missing (including missing `options`) or not a non-empty string →
    `TypeError('[daas-toolbox] deeplink owner must be a non-empty string')`.

### Host tracking

16. `inspect()` returns a fresh `{ global, keys }` snapshot each time. `global` lists global
    handlers in execution order. `keys` lists only keys with at least one key handler or waiting
    call, sorted by key, with handlers in execution order. It never includes params or results.
17. `subscribe(listener)` calls `listener()` synchronously after each change: a key or global
    handler registered, unregistered or replaced, or a waiting count changing. Each listener
    runs in a try/catch, so a throwing listener doesn't break the registry or other listeners
    (`console.error` when `isDev`). The returned function unsubscribes and is idempotent.

## 4. React and typed API

### `useDeeplinkHandler` (recommended for MFEs)

```ts
useDeeplinkHandler(key, handler, options)                // global registry
useDeeplinkHandler(typedRegistry, key, handler, options) // typed form
```

- `options` is required (it carries `owner`).
- It keeps the latest `handler` in a ref and registers one stable wrapper.
- Effect deps are `[registry, key, owner, order]`. Changing any of them unregisters and
  re-registers, and re-renders with the same values don't.
- It unregisters on unmount. StrictMode is safe through the identity-safe `unregister` and
  owner replacement.
- The README explains when to use `registerHandler` instead: host code, non-React modules, and
  MFEs on a different React version than the toolbox's shared copy.

### `createAppDeeplinks<M>()`

```ts
export type TypedDeeplinkCallContext<C> = Omit<DeeplinkCallContext, 'input'> & {
  readonly input: DeeplinkParamsOf<C>;
};
export type TypedDeeplinkNext<C> = (ctx?: TypedDeeplinkCallContext<C>) => Promise<unknown>;
export type TypedDeeplinkHandler<C> = (
  ctx: TypedDeeplinkCallContext<C>,
  next: TypedDeeplinkNext<C>,
) => unknown;

interface TypedDeeplinkRegistry<M> {
  registerHandler<K>(key: K, handler: TypedDeeplinkHandler<M[K]>, options: DeeplinkRegisterOptions): () => void;
  invoke<K>(key: K, ...args: DeeplinkInvokeArgs<M[K]>): Promise<DeeplinkResultOf<M[K]>>; // unchanged
  has(key: keyof M & string): boolean;
  registerGlobalHandler(handler: DeeplinkHandler, options: DeeplinkRegisterOptions): () => void;
  inspect(): DeeplinkInspection;
  subscribe(listener: () => void): () => void;
}
```

The contract types only the two ends of the chain: `ctx.input` is the contract's params, and
`invoke` returns the contract's result, trusting the chain to produce it. A handler's return
value is not checked against the result type, because a handler can't know its position in the
chain. (`TypedDeeplinkCallContext` is an `Omit` intersection rather than an `extends` interface,
because an interface-typed `input` is not assignable to `Record<string, unknown>`.)

## 5. Testing

The stack is vitest with fake timers where needed. Coverage target: 100% for
`src/deeplink/**` and `src/hooks/useDeeplinkHandler/**`. Existing tests move to the new names
and signature, and existing timeout, abort, queue and dispose cases keep their intent as
one-handler chains.

| Area | Cases |
| --- | --- |
| Order | ascending `order`; ties use registration order; negative and fractional orders |
| Onion | the in/out order trace for 3 handlers is `a-in b-in c-in c-out b-out a-out` |
| Payload | `next(newCtx)` changes downstream `params` only; `input` stays the original; `state` is shared; runtime fields can't be overwritten |
| End of chain | a transform-only chain returns the final `params`; `next()` from the last handler resolves to `params` |
| Short-circuit | an inner handler doesn't call `next` → later handlers don't run, and the value travels out through the outer handlers |
| Errors | an inner throw propagates through outer handlers; an outer try/catch can recover; errors are the same object (`toBe`) |
| `next()` twice | the second call rejects with the multiple-calls error; the first result is still used |
| Owner | same owner replaces its handler and warns in dev; the replaced `unregister` is a no-op; registering repeatedly (a leaky side effect) leaves one handler; different owners with the same function give separate handlers |
| Partial chain | zero handlers waits until the timeout; one handler runs at once |
| Batch flush | 3 registrations in the same tick → the waiting call sees all 3; one a macrotask later does not join |
| Snapshot | register or unregister mid-run doesn't change that call's chain |
| Global handlers | wrap every key; always outermost; sorted by their own order; owner replace; with globals only, the call still waits; `has` ignores them; no flush trigger; snapshot; `step.global` |
| Validation | bad handler, order and owner (missing, empty, non-string, `options` omitted) each throw `TypeError` |
| inspect / subscribe | `{ global, keys }` shape and sorting; waiting counts; listener fires on each change; a throwing listener is isolated; unsubscribe is idempotent |
| Hook | owner/order passed through; re-register on key, owner or order change, not on re-render; two components chain by order; same owner in two components → one handler; StrictMode; typed overload |
| Typed (tsc) | `ctx.input` typed; `invoke` result inferred; `ctx.params` is `unknown` |
| Prod mode | owner-replace warnings (key and global) and the listener `console.error` are silent |

## 6. Files

```
src/deeplink/
  types.ts        handler, context, register options, status types (old Handler types removed)
  compose.ts      NEW: runs a snapshot as an onion; next() guard; end-of-chain rule
  registry.ts     chain storage, ordering, compose, global handlers, inspect/subscribe
  typed.ts        typed facade updated (names, signature, global/inspect/subscribe)
src/hooks/useDeeplinkHandler/index.ts   required options (owner) + new deps
README.md       deeplink section rewritten: hook-first, plain functions for host/non-React
```

`compose.ts` is a pure function, `compose(steps, ctx) => Promise<unknown>`, with no registry
state, so the onion rules (3–7) can be tested in isolation.

## 7. Migration

The first registry has not been copied into any SDK yet, so this is a deliberate breaking change
on the branch:
- `handle(key, (params, ctx) => r)` becomes `registerHandler(key, (ctx) => r, { owner })`,
  reading `ctx.params`.
- `useDeeplinkHandler(key, handler)` becomes `useDeeplinkHandler(key, handler, { owner })`.
- The first spec's duplicate rule ("Replace") becomes owner replacement (§3 rule 2).

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| A gate handler whose MFE isn't mounted yet is skipped (rule 9, accepted) | Documented: logic that must never be skipped belongs in the handler that produces the result |
| MFE teams pick colliding `order` numbers | Ties are deterministic (registration order); `inspect()` shows the real order; README suggests bands (gates 0–99, enrichers 100–199, producers 500+) |
| Two MFEs pick the same `owner` name on one key and silently replace each other | Dev warning on every replace; README recommends `<mfe>` or `<mfe>:<purpose>` owner names |
| A handler forgets to `return next()` (calls it but drops the result) | The caller gets `undefined`; README calls this out; the onion test shows the pattern |
| A handler never settles | The timeout covers the whole chain, and `ctx.signal` lets handlers stop |
| A buggy global handler breaks every deeplink on the page | Meant for the host only (README); `inspect().global` shows who registered what; README shows try/finally patterns |
