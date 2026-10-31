# @daas-sdk/toolbox

DaaS toolbox: pure TypeScript source, copied by hand into the SDK. Not published to npm.
No runtime dependencies besides `react` (≥16.8).

```
src/
  hooks/      vendored subset of ahooks 3.11.0 (MIT) + useDeeplinkHandler
  deeplink/   cross-MFE deeplink handler registry
  utils/      shared helpers
```

## Hooks

| Hook | Notes |
| --- | --- |
| `useRequest` | All built-in plugins (auto-run, cache, debounce, throttle, polling, retry, loading delay, refresh on focus). Also exports `clearCache`, `CancelledError`, `isCancelledError`. |
| `useHistoryTravel` | |
| `useMount` | |
| `usePrevious` | Also exports the `ShouldUpdateFunc` type. |
| `useCreation` | |
| `useWhyDidYouUpdate` | |
| `useDeeplinkHandler` | Registers a deeplink handler for the component's lifetime (see below). |

Internal helpers (`useMemoizedFn`, `useLatest`, `useUpdate`, `useUnmount`, `useUpdateEffect`,
`createUpdateEffect`) are kept because the hooks above depend on them.

Differences from upstream ahooks: `lodash/debounce` and `lodash/throttle` are replaced by
`src/utils/debounce.ts`, and `src/utils/isDev.ts` no longer needs `@types/node`.

## Deeplink handler chains

> Full guide: [`docs/deeplink-guide.md`](docs/deeplink-guide.md). Runnable sample (host + 4 MFEs,
> tested end to end): [`example/deeplink/`](example/deeplink/).

Several MFEs can register **handlers** on the same deeplink key. A call runs them as an onion:
each handler can change the payload on the way in (`next(ctx)`) and the result on the way out,
and the caller receives the final value. Keys match the `deeplink` string used by daas-sdk
`navigate(deeplink, params, options)`.

### Registering in an MFE: use the hook

`useDeeplinkHandler` is the recommended way for MFEs: it unregisters automatically when the
component unmounts.

```ts
import { deeplink, isDeeplinkTimeoutError, useDeeplinkHandler } from './toolbox';

// auth MFE: outermost gate, enriches the payload
useDeeplinkHandler('orders.open', (ctx, next) => {
  if (!hasRole('orders:view')) throw new ForbiddenError();
  return next({ ...ctx, params: { ...(ctx.params as object), userId: currentUser.id } });
}, { owner: 'auth', order: 10 });

// orders MFE: produces the result (doesn't call next)
useDeeplinkHandler('orders.open', async (ctx) => {
  const { id, userId } = ctx.params as { id: string; userId: string };
  return openOrder(id, userId, { signal: ctx.signal });
}, { owner: 'orders', order: 500 });

// any MFE
try {
  const res = await deeplink.invoke('orders.open', { id: '42' });
} catch (e) {
  if (isDeeplinkTimeoutError(e) && e.phase === 'waiting') {
    // no MFE has registered a handler for this key yet
  }
}
```

### Registering outside React: `registerHandler`

```ts
const unregister = deeplink.registerHandler('orders.open', handler, { owner: 'orders' });
// …when the module or app shuts down
unregister();
```

Use it for host code, non-React modules, tests, and **MFEs whose React version differs from
the toolbox's shared copy**: a hook from the shared toolbox runs on the host's React and fails
with "invalid hook call" there. In a side effect, return `unregister` as the cleanup.

### `owner` and duplicates

`owner` is required. Registering again with the same owner **replaces** that owner's handler
(dev warning: `handler from owner "orders" replaced`), so a side effect that re-runs without
cleanup never stacks duplicate handlers, and the warning points at the leak. Use the MFE name,
or `<mfe>:<purpose>` when one MFE registers several handlers on a key.

### Handlers

- **Order:** lower `order` runs first (outermost), and ties keep registration order. Suggested
  bands: gates 0–99, enrichers 100–199, producers 500+.
- **`return next(ctx)`** continues the chain. Forgetting `return` hands `undefined` to the
  outer handlers. After the last handler, `next()` resolves to the current `params`, so a chain
  made only of transforms returns the transformed payload.
- **Short-circuit** by returning without calling `next` (mocks, caches, producers). **Throw** to
  reject the call (gates). Calling `next()` twice rejects.
- `ctx.input` is the caller's original params, `ctx.state` is shared by every handler of the
  call, and `ctx.signal` is aborted on timeout or caller abort.

### Calls

- **No handler registered yet:** the call waits until one is, or until `options.timeout`
  (default `10000` ms; `Infinity` disables it) rejects it with `DeeplinkTimeoutError`
  (`phase: 'waiting'`).
- **At least one handler registered:** the call runs right away with the handlers present. A
  gate whose MFE isn't mounted yet is skipped, so logic that must always run belongs in the
  producing handler.
- Handlers registered in the same tick (for example, sibling MFEs mounting together) all join a
  call that was waiting.
- Each call uses the chain as it was when the call started.

### Global handlers (host)

```ts
// host boot: wraps every deeplink, always outside the key handlers
deeplink.registerGlobalHandler(async (ctx, next) => {
  const t = Date.now();
  try {
    return await next();
  } finally {
    logger.info('deeplink', { key: ctx.key, ms: Date.now() - t, step: ctx.step });
  }
}, { owner: 'host-logger' });
```

Global handlers never count as "a handler registered" (a call with only global handlers still
waits), and `has(key)` ignores them. They are meant for the host. A buggy global handler
affects every deeplink on the page.

### Tracking registration status

```ts
deeplink.inspect();
// { global: [{ owner: 'host-logger', order: 0 }],
//   keys: [{ key: 'orders.open', waiting: 0,
//            steps: [{ owner: 'auth', order: 10 }, { owner: 'orders', order: 500 }] }] }

const unsubscribe = deeplink.subscribe(() => renderPanel(deeplink.inspect()));
```

`inspect()` never contains params or results. `subscribe` fires after every registration,
unregistration, replacement or waiting-count change.

### Typed deeplinks

Declare contracts once, in a module MFEs import **type-only** (the daas-sdk
`createAppEvents<T>()` pattern):

```ts
export interface AppDeeplinks {
  'orders.open': { params: { id: string }; result: { opened: boolean } };
  'auth.reauth': { result: { token: string } }; // no params: invoke('auth.reauth')
}

const dl = createAppDeeplinks<AppDeeplinks>();
useDeeplinkHandler(dl, 'orders.open', (ctx) => ({ opened: ctx.input.id === '42' }), {
  owner: 'orders',
  order: 500,
});
const res = await dl.invoke('orders.open', { id: '42' }); // res: { opened: boolean }
```

Only the ends of the chain are typed: `ctx.input` is the contract's params, and `invoke`
returns the contract's result. `ctx.params` and `next()`'s result are `unknown`, because a
handler can't know its position in the chain. Types are checked at build time, not at runtime.

## Copying into an SDK

Copy `src/` and `THIRD_PARTY_NOTICES.md`. The notices file is required by the MIT licenses of
ahooks and lodash: keep it next to the copied code and include it in the SDK's published package
or its combined third-party notices, because bundlers strip license comments.

You can skip `example/`, `**/__tests__/` and `src/utils/testingHelpers.ts`. The target tsconfig
needs `strict`-compatible settings and the `DOM` lib.

## Checks

```bash
pnpm --filter @daas-sdk/toolbox tsc
pnpm --filter @daas-sdk/toolbox test
```
