# @daas/hooks

Vendored subset of [ahooks](https://github.com/alibaba/hooks) **3.10.1** (MIT) for offline use.
Pure TypeScript source with no runtime dependencies besides `react`.

## Hooks

| Hook | Notes |
| --- | --- |
| `useRequest` | All built-in plugins (auto-run, cache, debounce, throttle, polling, retry, loading delay, refresh on focus). Also exports `clearCache`, `CancelledError`, `isCancelledError`. |
| `useHistoryTravel` | |
| `useMount` | |
| `useWhyDidYouUpdate` | |

Internal helpers (`useMemoizedFn`, `useLatest`, `useUpdate`, `useUnmount`, `useCreation`,
`useUpdateEffect`, `createUpdateEffect`) are kept because the hooks above depend on them.

## Differences from upstream

- `lodash/debounce` and `lodash/throttle` replaced by `src/utils/debounce.ts`, a dependency-free port.
- `src/utils/isDev.ts` no longer needs `@types/node` and is guarded against a missing `process` global.

## Copying into an SDK

Copy `src/` (and `LICENSE`, required by MIT) into the SDK, e.g. `sdk/src/hooks/`, then:

```ts
import { useRequest, useMount } from './hooks';
```

You can skip `**/__tests__/` and `src/utils/testingHelpers.ts`; they're only used by tests.
The SDK's tsconfig needs `strict`-compatible settings and the `DOM` lib.

## Checks

```bash
pnpm --filter @daas/hooks tsc
pnpm --filter @daas/hooks test
```
