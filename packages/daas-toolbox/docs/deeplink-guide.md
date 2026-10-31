# Deeplink handlers: guide

How MFEs register handlers for a deeplink, how calls run through them, and how the host watches
it all. The runnable sample is in [`example/deeplink/`](../example/deeplink/), and its test
([`example.spec.tsx`](../example/deeplink/__tests__/example.spec.tsx)) runs every scenario in this
guide.

- [1. The model in one picture](#1-the-model-in-one-picture)
- [2. Walkthrough of the sample](#2-walkthrough-of-the-sample)
- [3. Recipes](#3-recipes)
- [4. Rules you need to know](#4-rules-you-need-to-know)
- [5. API reference](#5-api-reference)
- [6. Testing your handlers](#6-testing-your-handlers)
- [7. Troubleshooting](#7-troubleshooting)

---

## 1. The model in one picture

A **deeplink** is a string key, the same key daas-sdk `navigate()` uses, such as `'orders.open'`.
Any number of MFEs can **register a handler** on a key. When some MFE **invokes** the key, the
handlers run as an **onion**:

```
deeplink.invoke('orders.open', { orderId: '42' })
  │
  ▼  host-logger   (global handler, always outermost)
  ▼  auth          order 10    gate: check role, add viewer   ─┐
  ▼  analytics     order 150   pass through                   │ way in
  ▼  orders        order 500   open the order, return result ─┘
  ▲  analytics                 add { tracked: true }          ─┐ way out
  ▲  auth                      (nothing)                       │
  ▲  host-logger               log key, duration, ok          ─┘
  │
caller receives { orderId: '42', status: 'opened', viewer: 'Ada', tracked: true }
```

Each handler is `(ctx, next) => result`:

| Inside a handler | Effect |
| --- | --- |
| `return next(newCtx)` | continue; inner handlers see `newCtx.params` |
| `const r = await next(); return change(r)` | continue, then change the result on the way out |
| `return value` without calling `next` | stop here (producer, mock, cache); `value` goes back out |
| `throw error` | reject the call (gate); the caller gets `error` unchanged |

---

## 2. Walkthrough of the sample

```
example/deeplink/
  contracts.ts      AppDeeplinks contract map (import type-only in real MFEs)
  deeplinks.ts      appDeeplinks = createAppDeeplinks<AppDeeplinks>()
  host.tsx          installDeeplinkLogger (global handler) + DeeplinkStatusPanel
  AuthMfe.tsx       gate      order 10
  AnalyticsMfe.tsx  enricher  order 150
  OrdersMfe.tsx     producer  order 500
  CallerMfe.tsx     invokes the key, shows the result or a timeout message
  App.tsx           a host page mounting the four "MFEs"
```

### 2.1 Contracts: one shared type map

```ts
// contracts.ts
export interface AppDeeplinks {
  'orders.open': { params: { orderId: string }; result: OrderOpenResult };
}

// deeplinks.ts
export const appDeeplinks = createAppDeeplinks<AppDeeplinks>();
```

Callers get checked params and an inferred result type. In production the contracts live in a
shared module that MFEs import with `import type`, so the bundles have no runtime dependency on
each other.

### 2.2 A gate: `AuthMfe.tsx`

```tsx
useDeeplinkHandler(appDeeplinks, 'orders.open', (ctx, next) => {
  if (!user.roles.includes('orders:view')) throw new ForbiddenError();
  return next({ ...ctx, params: { ...ctx.input, viewer: user.name } });
}, { owner: 'auth', order: 10 });
```

- A low `order` puts it outermost, so it runs first.
- `ctx.input` is the caller's original params, typed from the contract.
- `next({ ...ctx, params })` hands an enriched payload to the inner handlers.

### 2.3 An enricher: `AnalyticsMfe.tsx`

```tsx
useDeeplinkHandler(appDeeplinks, 'orders.open', async (ctx, next) => {
  const result = await next();
  onTrack(ctx.key);
  return { ...(result as object), tracked: true };
}, { owner: 'analytics', order: 150 });
```

It does its work **after** `next()`, on the way out, and must `return` the result.

### 2.4 The producer: `OrdersMfe.tsx`

```tsx
useDeeplinkHandler(appDeeplinks, 'orders.open', async (ctx) => {
  const params = ctx.params as AuthorizedOrderParams; // what the gate passed on
  setOpened(params);
  return { orderId: params.orderId, status: 'opened', viewer: params.viewer };
}, { owner: 'orders', order: 500 });
```

The innermost handler doesn't call `next`, and what it returns becomes the result. It reads
`ctx.params` (the payload after the gate) rather than `ctx.input`.

### 2.5 The caller: `CallerMfe.tsx`

```ts
try {
  const result = await appDeeplinks.invoke('orders.open', { orderId: '42' }, { timeout });
} catch (error) {
  if (isDeeplinkTimeoutError(error)) {
    error.phase === 'waiting' // nobody registered the key in time
    error.phase === 'running' // the chain started but was too slow
  }
}
```

The caller doesn't know which MFEs are involved. It only knows the key and the contract.

### 2.6 The host: `host.tsx`

```ts
// boot code, no React needed
deeplink.registerGlobalHandler(async (ctx, next) => {
  const start = Date.now();
  let ok = false;
  try {
    const result = await next();
    ok = true;
    return result;
  } finally {
    log({ key: ctx.key, ok, ms: Date.now() - start, trail: ctx.state.trail });
  }
}, { owner: 'host-logger' });
```

```tsx
// status panel
useEffect(() => deeplink.subscribe(() => setStatus(deeplink.inspect())), []);
// renders: orders.open: auth(10) → analytics(150) → orders(500)
```

### 2.7 What the sample's test proves

| Scenario | Outcome |
| --- | --- |
| All MFEs mounted | `{ orderId, status, viewer: 'Ada', tracked: true }`; trail `auth → analytics → orders` |
| User without the role | `Forbidden…`; the order drawer never opens; the host logs `ok: false` |
| Analytics not mounted | the chain runs with what's there, so there's no `tracked` flag |
| Invoked before any MFE mounted | the call waits (status panel shows "1 waiting"), then runs the full chain once they mount |
| No MFE ever mounts | `timeout: 50` → "no MFE handles orders.open yet" (`phase: 'waiting'`) |
| Sample unmounted | `inspect()` is empty again, because the hooks unregister everything |

Run it with: `npx vitest run example`.

---

## 3. Recipes

**Transform only (no producer).** If the last handler calls `next()`, the chain returns the
current payload. That's useful for "normalize and pass back" keys:

```ts
registerHandler('profile.normalize', (ctx, next) =>
  next({ ...ctx, params: normalize(ctx.params) }), { owner: 'profile' });
await deeplink.invoke('profile.normalize', raw); // → normalized payload
```

**Mock in a test or Storybook.** Register a producer that returns a fixed value:

```ts
const unregister = deeplink.registerHandler('orders.open', () => fakeResult,
  { owner: 'storybook-mock', order: 500 });
```

**Cancel from the caller.**

```ts
const controller = new AbortController();
const pending = deeplink.invoke('orders.open', { orderId: '42' }, { signal: controller.signal });
controller.abort(); // pending rejects with the abort reason; handlers see ctx.signal.aborted
```

**Pass the signal into real work.** A timeout or abort then cancels the request too:

```ts
async (ctx) => (await fetch(`/api/orders/${id}`, { signal: ctx.signal })).json()
```

**Share data between handlers of one call** with `ctx.state`, as the sample's `trail` does:

```ts
ctx.state.startedAt = Date.now();
```

**Register outside React.** Use this for host code, non-React modules, or an MFE on a different
React version than the shared toolbox:

```ts
const unregister = deeplink.registerHandler('orders.open', handler, { owner: 'orders' });
// in a framework effect / lifecycle: return or call unregister on teardown
```

---

## 4. Rules you need to know

1. **`owner` is required, and it's the identity of a registration.** Registering again with the
   same owner on the same key **replaces** the earlier handler, and a dev warning says so. A
   side effect that re-runs without cleanup therefore never stacks duplicates. Use the MFE name,
   or `<mfe>:<purpose>` when one MFE registers several handlers on one key. Two *components*
   sharing an owner replace each other, so give them distinct owners.
2. **`order` decides the position.** Lower runs first (outermost), and ties keep registration
   order. Suggested bands: gates **0–99**, enrichers **100–199**, producers **500+**. Check the
   real order any time with `deeplink.inspect()`.
3. **`return next(...)`.** Calling `next()` without returning its result gives `undefined` to
   the outer handlers. Calling `next()` twice rejects the second call.
4. **Partial chains run.** If at least one key handler is registered, a call runs with whatever
   is registered right now. A gate whose MFE hasn't mounted yet is **skipped**, so put logic
   that must always run inside the producer.
5. **No handler means wait.** A call with no key handler waits until one registers or until the
   timeout (default 10 s). Handlers registered in the same tick, for example sibling MFEs
   mounting together, all join a waiting call.
6. **A snapshot per call.** Each call uses the chain as it was when the call started.
   Registering or unregistering during a call doesn't affect it.
7. **Global handlers are for the host.** They always wrap the key handlers, never count as
   "registered" for rule 5, and affect every deeplink on the page, so keep them small and wrap
   them in `try/finally`.
8. **Types cover only the ends of the chain.** `ctx.input` and `invoke`'s result are typed from
   the contract. `ctx.params` and `next()`'s result are `unknown`, because a handler can't know
   its position. A reusable handler typed as plain `DeeplinkHandler` can't be passed to the
   typed `appDeeplinks.registerHandler`. Register it through the untyped `deeplink` instead.

---

## 5. API reference

```ts
import {
  deeplink,              // the page-wide registry
  createAppDeeplinks,    // typed facade: createAppDeeplinks<AppDeeplinks>()
  createDeeplinkRegistry,// isolated registry (tests)
  useDeeplinkHandler,    // React: register for the component's lifetime
  DeeplinkTimeoutError, isDeeplinkTimeoutError,
} from './toolbox';
```

| Call | Returns | Notes |
| --- | --- | --- |
| `registerHandler(key, handler, { owner, order? })` | `unregister()` | key handler; same owner replaces |
| `registerGlobalHandler(handler, { owner, order? })` | `unregister()` | wraps every key; host |
| `invoke(key, params?, { timeout?, signal?, ...extra })` | `Promise<result>` | `extra` reaches handlers as `ctx.options` |
| `has(key)` | `boolean` | key handlers only |
| `inspect()` | `{ global, keys }` | owners, orders and waiting counts; never params or results |
| `subscribe(listener)` | `unsubscribe()` | fires after every registration change or waiting-count change |
| `useDeeplinkHandler(key, handler, { owner, order? })` | `void` | unregisters on unmount; re-registers if key, owner or order change |
| `useDeeplinkHandler(appDeeplinks, key, handler, options)` | `void` | typed form |

`ctx` fields: `key`, `params` (current payload), `input` (original params), `options`, `signal`,
`state` (shared scratch space), `step` (`{ index, count, owner, global }`).

---

## 6. Testing your handlers

Use an isolated registry, so tests don't share the page-wide one:

```ts
const reg = createDeeplinkRegistry();
const dl = createAppDeeplinks<AppDeeplinks>(reg);
dl.registerHandler('orders.open', myGate, { owner: 'auth', order: 10 });
dl.registerHandler('orders.open', () => fakeOrder, { owner: 'mock', order: 500 });
await expect(dl.invoke('orders.open', { orderId: '1' })).rejects.toThrow('Forbidden');
```

For components, render them and assert on the page, as
[`example.spec.tsx`](../example/deeplink/__tests__/example.spec.tsx) does. Remember to
`cleanup()` after each test so the hooks unregister.

---

## 7. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `DeeplinkTimeoutError`, `phase: 'waiting'` | No MFE registered a handler for the key (not mounted, wrong key, or only global handlers). Check `inspect().keys`. |
| `DeeplinkTimeoutError`, `phase: 'running'` | A handler didn't settle in time. Pass `ctx.signal` to slow work, or raise `timeout`. |
| Dev warning `handler from owner "x" replaced` | The same owner registered twice: a side effect without cleanup, or two components sharing an owner. |
| Caller gets `undefined` | A handler called `next()` but didn't `return` its result. |
| Gate didn't run | Its MFE wasn't mounted when the call started (partial chain, rule 4). |
| `TypeError: deeplink owner must be a non-empty string` | `owner` is missing from the options. |
| "Invalid hook call" in one MFE | That MFE's React differs from the shared toolbox's. Use `deeplink.registerHandler` there. |
