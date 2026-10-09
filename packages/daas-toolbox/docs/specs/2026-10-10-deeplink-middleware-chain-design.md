# Deeplink middleware chain — design

- **Date:** 2026-10-10
- **Status:** Draft, awaiting review
- **Branch:** `daas-hooks`
- **Supersedes:** in `2026-10-09-daas-toolbox-deeplink-design.md`, the "Replace" duplicate rule,
  the `(params, ctx)` handler signature, and §4 rules 4, 5 and 10. Timeout, abort, the global
  singleton and errors carry over unchanged.

## 1. Goal

Let **several MFEs inject handlers into the same deeplink**. The handlers run as an ordered
**middleware chain** in the onion style (`await next(ctx)`): each step can transform the payload
on the way in and the result on the way out, and the final value goes back to the caller. The
host can **inject global middleware** (logger, tracker) that wraps every deeplink, and can
**track injection status** for every deeplink.

### Decisions made during brainstorming

| Topic | Decision |
| --- | --- |
| Composition model | Onion middleware `(ctx, next) => …`; `await next(ctx)` continues the chain (Koa-style) |
| Order | Explicit numeric `order` per step (lower = outer); ties fall back to injection order |
| Same owner injects twice | Replaces its own step (dev warning); steps without an `owner` never replace |
| Partial chain | No steps → wait until the timeout. One or more steps → run with whatever is present |
| Global middleware | `use(middleware, options?)` wraps every key's chain; always outermost; mostly host logger/tracker |
| Observe events | Not needed |
| Who may inject | Any MFE; no claim token |
| Host tracking | Read-only `inspect()` + `subscribe()` |

### Non-goals

- Host-declared chains or required owners.
- Observe or lifecycle event streams.
- Typing what passes between steps (`ctx.params` and `next()`'s result are `unknown`).
- Pattern or URL keys, cross-iframe calls, params or result validation (unchanged from the first spec).

## 2. Public API

```ts
/** One step of a deeplink chain. */
export type DeeplinkMiddleware = (
  ctx: DeeplinkCallContext,
  next: DeeplinkNext,
) => unknown | Promise<unknown>;

/** Continue the chain. Pass a new context to change what downstream steps see. */
export type DeeplinkNext = (ctx?: DeeplinkCallContext) => Promise<unknown>;

export interface DeeplinkCallContext {
  /** The invoked key. */
  readonly key: string;
  /** Current payload. Starts as the caller's params; upstream steps may replace it via next(ctx). */
  params: unknown;
  /** The caller's original params; never changed by steps. */
  readonly input: DeeplinkParams;
  /** The options the caller passed (`{}` when omitted). */
  readonly options: DeeplinkInvokeOptions;
  /** Aborted on timeout or caller abort; the same signal for every step of the call. */
  readonly signal: AbortSignal;
  /** Position of the step receiving this context. */
  readonly step: DeeplinkStepInfo;
  /** Scratch space shared by every step of this call. */
  state: Record<string, unknown>;
}

export interface DeeplinkStepInfo {
  /** 0-based position in this call's chain snapshot. */
  index: number;
  /** Number of steps in this call's chain snapshot. */
  count: number;
  /** The step's owner, if it declared one. */
  owner?: string;
  /** Whether this step is global middleware (`use`) rather than a key step (`handle`). */
  global: boolean;
}

export interface DeeplinkHandleOptions {
  /** Identifies the injecting MFE; re-injecting with the same owner replaces that owner's step. */
  owner?: string;
  /** Lower runs first (outermost). @default 0 */
  order?: number;
}

export interface DeeplinkStepStatus {
  owner?: string;
  order: number;
}

export interface DeeplinkStatus {
  key: string;
  /** Steps in execution order. */
  steps: DeeplinkStepStatus[];
  /** Calls currently waiting for a first step. */
  waiting: number;
}

export interface DeeplinkInspection {
  /** Global middleware in execution order. */
  global: DeeplinkStepStatus[];
  /** Keys with at least one step or waiting call, sorted by key. */
  keys: DeeplinkStatus[];
}

export interface DeeplinkRegistry {
  /** Inject a step; returns an identity-safe disposer. */
  handle(key: string, middleware: DeeplinkMiddleware, options?: DeeplinkHandleOptions): () => void;
  /** Run the chain for `key` (waits for a first step if none is injected). */
  invoke<TResult = unknown>(
    key: string,
    params?: Record<string, unknown>,
    options?: DeeplinkInvokeOptions,
  ): Promise<TResult>;
  /** Inject global middleware that wraps every key's chain; returns an identity-safe disposer. */
  use(middleware: DeeplinkMiddleware, options?: DeeplinkHandleOptions): () => void;
  /** Whether at least one key step is injected for `key` (global middleware doesn't count). */
  has(key: string): boolean;
  /** Read-only snapshot of global middleware and of every key with steps or waiting calls. */
  inspect(): DeeplinkInspection;
  /** Called after any change to steps or waiting counts. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}
```

`DeeplinkInvokeOptions`, `DeeplinkParams`, `DeeplinkTimeoutError`, `isDeeplinkTimeoutError`,
`createDeeplinkRegistry` and the global `deeplink` keep their current definitions.
`DeeplinkHandler` and `DeeplinkHandlerContext` are **removed** and replaced by
`DeeplinkMiddleware` and `DeeplinkCallContext`. Nothing has shipped, so the removal is free (§7).

### Example

```ts
// host boot: global logger wrapping every deeplink
deeplink.use(async (ctx, next) => {
  const t = Date.now();
  try {
    return await next();
  } finally {
    logger.info('deeplink', { key: ctx.key, ms: Date.now() - t });
  }
}, { owner: 'host-logger' });
```

```ts
// auth MFE: outermost, gates and enriches the request
deeplink.handle('orders.open', async (ctx, next) => {
  if (!hasRole('orders:view')) throw new ForbiddenError();
  return next({ ...ctx, params: { ...(ctx.params as object), userId: currentUser.id } });
}, { owner: 'auth', order: 10 });

// analytics MFE: times the rest of the chain and tags the response
deeplink.handle('orders.open', async (ctx, next) => {
  const t = Date.now();
  const res = await next();
  track('orders.open', Date.now() - t);
  return { ...(res as object), tracked: true };
}, { owner: 'analytics', order: 20 });

// orders MFE: innermost, produces the result
deeplink.handle('orders.open', (ctx) => loadOrder(ctx.params as { id: string; userId: string }),
  { owner: 'orders', order: 50 });

await deeplink.invoke('orders.open', { id: '42' }); // → { ...order, tracked: true }
```

## 3. Runtime behavior

### Chain

1. **Order.** Steps are sorted by ascending `order`, ties by injection sequence. Index 0 is
   the outermost step: it runs first on the way in and last on the way out.
2. **Same owner replaces.** Injecting with an `owner` that already has a step for this key
   replaces that step, taking the new `order` and the latest injection sequence. The old
   registration's disposer becomes a no-op. When `isDev`, this logs
   `console.warn('[daas-toolbox] deeplink "<key>" step from owner "<owner>" replaced')`. Steps
   without an `owner` never replace each other.
3. **Payload handoff.** `next(newCtx)` passes `newCtx` to the next step, and `next()` passes the
   current context. The runtime sets `step` on the context each step receives; a `step` value
   supplied in `newCtx` is overwritten. `key`, `input`, `options` and `signal` are always the
   call's own values: if a step passes different values, the runtime overwrites them.
4. **End of chain.** `next()` called by the last step resolves to that context's `params`.
   A chain of transform-only steps therefore returns the transformed payload to the caller.
5. **Short-circuit.** A step that returns without calling `next` ends the chain. Its return value
   travels back out through the outer steps. A throw or rejection rejects the call with that
   exact value, passed through unchanged as before.
6. **`next()` twice.** A second call to `next` from the same step returns a rejected promise
   with `Error('[daas-toolbox] deeplink "<key>": next() called multiple times')`. The first
   call still runs.
7. **Sync and async.** Every step runs inside a Promise chain, so a synchronous `throw` becomes
   a rejection. `invoke` throws synchronously only for an invalid key.

### Global middleware

G1. **Always outermost.** A call's chain is `[...global steps, ...key steps]`. Global steps are
    sorted among themselves by the same `order` / injection-sequence rule (rule 1). `step.index`
    and `step.count` cover the full combined chain, and `step.global` tells the two kinds apart.
G2. **Owner replacement** (rule 2) applies within global middleware, separately from key steps.
    The dev warning reads `global middleware from owner "<owner>" replaced`.
G3. **Global steps don't satisfy the wait rule.** Rule 9 counts only key steps: a call with no key
    step waits even if global middleware exists, and `has(key)` ignores global middleware. Global
    middleware never triggers the batch flush (rule 10).
G4. **Snapshot.** Global middleware is part of the call's snapshot when it starts (rule 8). A
    `use()` or dispose mid-run doesn't change calls already running.
G5. **Who calls `use`.** Any code can, but it is meant for the host at boot (README says so). It
    works with or without React. No hook is provided.

### Calls

8. **Snapshot when a call starts running.** The chain is copied the moment the call starts. Steps
   injected later don't join that call. Steps disposed or replaced later still finish it.
9. **Partial chains.** With zero steps the call waits until a step is injected, the timeout
   fires (`DeeplinkTimeoutError`, phase `'waiting'`) or the caller aborts. With one or more
   steps it starts at once with the current chain.
10. **Batch flush.** Waiting calls for a key start **one microtask after** the first injection
    for that key. Every injection in the same synchronous pass (for example, sibling MFE
    effects in one React commit) is therefore part of their snapshot. Calls queued after that
    microtask follow rule 9.
11. **Timeout and abort are unchanged.** One budget covers waiting plus the whole chain, and the
    phase is `'running'` once the call has started. `ctx.signal` is aborted on timeout or
    caller abort, a result that arrives late is dropped, invalid timeouts reject, and every
    settle path cleans up its timer, listener and queue entry.

### Validation (`handle`)

12. Invalid key → `TypeError` (unchanged message).
13. `middleware` not a function → `TypeError('[daas-toolbox] deeplink middleware must be a function')`.
14. `order` given but not a finite number → `TypeError('[daas-toolbox] deeplink order must be a finite number, got <value>')`.
15. `owner` given but not a non-empty string → `TypeError('[daas-toolbox] deeplink owner must be a non-empty string')`.

### Host tracking

16. `inspect()` returns a fresh `{ global, keys }` snapshot each time. `global` lists global
    middleware in execution order. `keys` lists only keys with at least one key step or waiting
    call, sorted by key, with steps in execution order. It never includes params or results.
17. `subscribe(listener)` calls `listener()` synchronously after each change: a key step or global
    middleware injected, disposed or replaced, or a waiting count changing. Each listener runs in a try/catch, so a
    throwing listener doesn't break the registry or other listeners (`console.error` when
    `isDev`). The returned function unsubscribes and is idempotent.

## 4. React and typed API

### `useDeeplinkHandler`

```ts
useDeeplinkHandler(key, middleware, options?)                // global registry
useDeeplinkHandler(typedRegistry, key, middleware, options?) // typed form
```

- It keeps the latest `middleware` in a ref and injects one stable wrapper, as today.
- Effect deps are `[registry, key, options?.owner, options?.order]`. Changing the owner or order
  re-injects the step, and re-renders with the same values don't.
- StrictMode is safe through the identity-safe disposer and owner replacement.

### `createAppDeeplinks<M>()`

```ts
export interface TypedDeeplinkCallContext<C> extends DeeplinkCallContext {
  readonly input: DeeplinkParamsOf<C>;
}
export type TypedDeeplinkMiddleware<C> = (
  ctx: TypedDeeplinkCallContext<C>,
  next: DeeplinkNext,
) => unknown | Promise<unknown>;

interface TypedDeeplinkRegistry<M> {
  handle<K>(key: K, middleware: TypedDeeplinkMiddleware<M[K]>, options?: DeeplinkHandleOptions): () => void;
  invoke<K>(key: K, ...args: DeeplinkInvokeArgs<M[K]>): Promise<DeeplinkResultOf<M[K]>>; // unchanged
  use(middleware: DeeplinkMiddleware, options?: DeeplinkHandleOptions): () => void;
  has(key: keyof M & string): boolean;
  inspect(): DeeplinkInspection;
  subscribe(listener: () => void): () => void;
}
```

The contract types only the two ends of the chain: `ctx.input` is the contract's params, and
`invoke` returns the contract's result, trusting the chain to produce it. A step's return value
is not checked against the result type, because a step can't know its position in the chain.

## 5. Testing

The stack is vitest with fake timers where needed. Coverage target: 100% for
`src/deeplink/**` and `src/hooks/useDeeplinkHandler/**`. Existing tests move to the new
signature, and existing timeout, abort, queue and dispose cases keep their intent as one-step
chains.

| Area | Cases |
| --- | --- |
| Order | ascending `order`; ties use injection order; negative and fractional orders |
| Onion | the in/out order trace for 3 steps is `a-in b-in c-in c-out b-out a-out` |
| Payload | `next(newCtx)` changes downstream `params` only; `input` stays the original; `state` is shared; runtime fields can't be overwritten |
| End of chain | a transform-only chain returns the final `params`; `next()` from the last step resolves to `params` |
| Short-circuit | an inner step doesn't call `next` → later steps don't run, and the value travels out through the outer steps |
| Errors | an inner throw propagates through outer steps; an outer try/catch can recover; errors are the same object (`toBe`) |
| `next()` twice | the second call rejects with the multiple-calls error; the first result is still used |
| Owner | same owner replaces its step and warns in dev; the replaced disposer is a no-op; anonymous steps accumulate |
| Partial chain | zero steps waits until the timeout; one step runs at once |
| Global middleware | wraps every key and is outermost even with a lower key `order`; sorted by its own order; owner replace; with global only, the call still waits and times out; `has` ignores global; no flush trigger; snapshot; `step.global` flags |
| Batch flush | 3 injections in the same tick → the waiting call sees all 3; an injection one macrotask later does not join |
| Snapshot | inject or dispose mid-run doesn't change that call's chain |
| Validation | bad middleware, order and owner each throw `TypeError` |
| inspect / subscribe | `{ global, keys }` shape and sorting; waiting counts; listener fires on each change; a throwing listener is isolated; unsubscribe is idempotent |
| Hook | owner/order deps; StrictMode; typed overload |
| Typed (tsc) | `ctx.input` typed; `invoke` result inferred; middleware `ctx.params` is `unknown` |
| Prod mode | the owner-replace warning and the listener `console.error` are silent |

## 6. Files

```
src/deeplink/
  types.ts        middleware, context, options, status types (Handler types removed)
  registry.ts     chain storage, ordering, compose, inspect/subscribe
  compose.ts      NEW: runs a snapshot as an onion; next() guard; end-of-chain rule
  typed.ts        typed facade updated (middleware signature, inspect/subscribe)
src/hooks/useDeeplinkHandler/index.ts   options param + new deps
README.md       deeplink section rewritten for chains
```

`compose.ts` is a pure function, `compose(steps, ctx) => Promise<unknown>`, with no registry
state, so the onion rules (3–7) can be tested in isolation.

## 7. Migration

The first registry has not been copied into any SDK yet, so this is a deliberate breaking change
on the branch:
- `handle(key, (params, ctx) => r)` becomes `handle(key, (ctx) => r)`, reading `ctx.params`.
- The first spec's duplicate rule ("Replace") becomes owner replacement (§3 rule 2).

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| A gate step whose MFE isn't mounted yet is skipped (rule 9, accepted) | Documented: logic that must never be skipped belongs in the step that produces the result |
| MFE teams pick colliding `order` numbers | Ties are deterministic (injection order); `inspect()` shows the real order; README suggests bands (gates 0–99, enrichers 100–199, producers 500+) |
| A step forgets to `return next()` (calls it but drops the result) | The caller gets `undefined`; README calls this out; the onion test shows the pattern |
| A step never settles | The timeout covers the whole chain, and `ctx.signal` lets steps stop |
| A buggy global middleware breaks every deeplink on the page | Meant for the host only (README); `inspect().global` shows who injected what; outer try/finally patterns in the README |
