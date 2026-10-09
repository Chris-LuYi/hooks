# @daas/toolbox

DaaS toolbox: pure TypeScript source, copied by hand into the SDK. Not published to npm.
No runtime dependencies besides `react` (≥16.8).

```
src/
  hooks/      vendored subset of ahooks 3.10.1 (MIT) + useDeeplinkHandler
  deeplink/   cross-MFE deeplink handler registry
  utils/      shared helpers
```

## Hooks

| Hook | Notes |
| --- | --- |
| `useRequest` | All built-in plugins (auto-run, cache, debounce, throttle, polling, retry, loading delay, refresh on focus). Also exports `clearCache`, `CancelledError`, `isCancelledError`. |
| `useHistoryTravel` | |
| `useMount` | |
| `useWhyDidYouUpdate` | |
| `useDeeplinkHandler` | Registers a deeplink handler for the component's lifetime (see below). |

Internal helpers (`useMemoizedFn`, `useLatest`, `useUpdate`, `useUnmount`, `useCreation`,
`useUpdateEffect`, `createUpdateEffect`) are kept because the hooks above depend on them.

Differences from upstream ahooks: `lodash/debounce` and `lodash/throttle` are replaced by
`src/utils/debounce.ts`, and `src/utils/isDev.ts` no longer needs `@types/node`.

## Deeplink handlers

Lets one MFE handle a deeplink key and lets any other MFE invoke it and get the result back.
Keys match the `deeplink` string used by daas-sdk `navigate(deeplink, params, options)`.

```ts
import { deeplink, isDeeplinkTimeoutError, useDeeplinkHandler } from './toolbox';

// Owner MFE: register for the component's lifetime
useDeeplinkHandler('orders.open', async (params, { signal }) => {
  const order = await api.getOrder(params?.id as string, { signal });
  openOrderDrawer(order);
  return { opened: true };
});

// Any MFE: invoke and await the result
try {
  const res = await deeplink.invoke<{ opened: boolean }>('orders.open', { id: '42' });
} catch (e) {
  if (isDeeplinkTimeoutError(e) && e.phase === 'waiting') {
    // the owner MFE never registered a handler (not loaded?)
  }
}
```

Behavior:

- **One handler per key; the latest registration wins.** A dev warning is logged when a
  handler is replaced. Name keys `<mfe>.<action>` to avoid collisions.
- **Calls wait for a handler.** An `invoke` made before the owner registers is queued and
  delivered once it does.
- **Timeout:** `options.timeout` (default `10000` ms) covers both the wait and the run.
  `Infinity` disables it. The rejection is a `DeeplinkTimeoutError` with `phase: 'waiting' | 'running'`.
- **Cancellation:** pass `options.signal` to cancel from the caller. Handlers receive
  `ctx.signal`, which is aborted on timeout or caller abort; forward it to `fetch` and similar APIs.
- **Errors** thrown by the handler reach the caller unchanged.
- **One registry per page:** it is stored at `globalThis[Symbol.for('daas-toolbox/deeplink')]`,
  so it stays shared even if an MFE bundles its own copy of the toolbox.
- Outside React, use `deeplink.handle(key, handler)`, which returns a disposer.

## Copying into an SDK

Copy `src/` and `LICENSE` (required by ahooks' MIT license). You can skip `**/__tests__/`
and `src/utils/testingHelpers.ts`. The target tsconfig needs `strict`-compatible settings and
the `DOM` lib.

## Checks

```bash
pnpm --filter @daas/toolbox tsc
pnpm --filter @daas/toolbox test
```
